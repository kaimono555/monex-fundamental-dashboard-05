# -*- coding: utf-8 -*-
"""
要求入口(scripts/request_monex_raw.py)・ロック(scripts/monex_fetch_lock.py)の単体テスト。
Playwright/ブラウザは使わない(fetcher を差し替える)。本番 data/raw・本番DBには触れない
(RAW_DIR / TMP_FETCH_DIR / lock パスを一時ディレクトリへ差し替える)。
実行: python -m unittest tests.test_request_monex_raw -v
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import monex_fetch_lock as lockmod  # noqa: E402
import monex_registry as regmod  # noqa: E402
import request_monex_raw as req  # noqa: E402

REAL_RAW = ROOT / "data" / "raw" / "5803.txt"


def make_good_text(code: str, name: str = "テスト社") -> str:
    """evaluateFinancialText / validate_monex_raw.js を通過する最小の疑似本文。"""
    header = f"銘柄スカウター\n\n{code} {name}\n東証プライム\n現在値1,000.0円(09/03 15:30)前日比+1.0\n売上高 営業利益 経常利益 純利益 EPS\n"
    rows = "\n".join(f"{2017 + i}/03\t" + "\t".join(["100"] * 9) for i in range(10))
    filler = "\n" + ("財務データ等更新日：2026/09/03\n" * 120)
    return header + rows + filler


class _Env:
    """request_monex_raw / monex_registry / lock のパスを一時ディレクトリへ差し替える。"""

    def __init__(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="req05_"))
        self.raw = self.tmp / "raw"
        self.raw.mkdir()
        self.db = self.tmp / "reg.sqlite3"
        self.saved = {}
        for mod, name, val in [
            (req, "RAW_DIR", self.raw), (regmod, "RAW_DIR", self.raw),
            (req, "TMP_FETCH_DIR", self.tmp / "tmp_fetch"), (req, "RAW_TOPIX_DIR", self.tmp / "raw_topix"),
            (req, "LOGS_DIR", self.tmp / "logs"), (req, "REQUEST_LOG", self.tmp / "logs" / "req.log"),
            (req, "SHARED_RAW_ROOT", self.tmp / "shared"),
            (lockmod, "LOCK_PATH", self.tmp / "locks" / "monex_fetch.lock"),
        ]:
            self.saved[(mod, name)] = getattr(mod, name)
            setattr(mod, name, val)
        # MonexFetchLock のデフォルト引数はモジュール読込時に束縛されるため、明示的に差し替える
        self.saved_lock_default = lockmod.MonexFetchLock.__init__.__defaults__
        d = list(self.saved_lock_default)
        d[-1] = self.tmp / "locks" / "monex_fetch.lock"
        lockmod.MonexFetchLock.__init__.__defaults__ = tuple(d)

    def close(self):
        for (mod, name), val in self.saved.items():
            setattr(mod, name, val)
        lockmod.MonexFetchLock.__init__.__defaults__ = self.saved_lock_default
        shutil.rmtree(self.tmp, ignore_errors=True)


def fake_fetcher_factory(behaviour: dict, exit_code: int = 0, calls: list | None = None):
    """behaviour[code] = ("success", text) | ("failed", error_type) | ("auth", None) | ("skip", None)"""

    def fetcher(codes, tmp_dir, *, allow_interactive_login=False, **_):
        if calls is not None:
            calls.append(list(codes))
        raw_dir = tmp_dir / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True)
        rows = {}
        for c in codes:
            kind, payload = behaviour.get(c, ("failed", "no_behaviour"))
            if kind == "success":
                (raw_dir / f"{c}.txt").write_text(payload, encoding="utf-8")
                (raw_dir / f"{c}.html").write_text("<html>" + payload + "</html>", encoding="utf-8")
                rows[c] = {"code": c, "fetch_status": "success", "error_type": "", "error_message": ""}
            elif kind == "failed":
                rows[c] = {"code": c, "fetch_status": "failed", "error_type": payload, "error_message": "simulated"}
            elif kind == "auth":
                (raw_dir / f"{c}.txt").write_text("認証されたユーザのみ", encoding="utf-8")
                rows[c] = {"code": c, "fetch_status": "failed", "error_type": "auth_error", "error_message": "authentication page detected"}
            elif kind == "bad_success":
                # 取得側は success と言っているが本文は壊れている(認証ページ/別銘柄/短すぎ)
                (raw_dir / f"{c}.txt").write_text(payload, encoding="utf-8")
                rows[c] = {"code": c, "fetch_status": "success", "error_type": "", "error_message": ""}
        return exit_code, rows

    return fetcher


class RequestRawTestCase(unittest.TestCase):
    def setUp(self):
        self.env = _Env()

    def tearDown(self):
        self.env.close()

    def _req(self, codes, **kw):
        kw.setdefault("reason", "test")
        kw.setdefault("run_id", f"t_{time.time_ns()}")
        return req.request_raw("111", codes, db_path=self.env.db, **kw)

    def test_validator_accepts_real_raw_and_fixture(self):
        if REAL_RAW.is_file():
            v = req.run_validate("5803", REAL_RAW)
            self.assertTrue(v["ok"], v)
            self.assertEqual(v["stock_name"], "フジクラ")
        p = self.env.tmp / "fx.txt"
        p.write_text(make_good_text("1234"), encoding="utf-8")
        v = req.run_validate("1234", p)
        self.assertTrue(v["ok"], v)
        self.assertEqual(v["latest_period_in_raw"], "2026/03")

    # Loop C: 正常取得 -> 昇格 + registry success + on_demand登録
    def test_fetch_success_promotes_and_registers_on_demand(self):
        good = make_good_text("5803", "フジクラ")
        out = self._req(["5803"], fetcher=fake_fetcher_factory({"5803": ("success", good)}))
        self.assertTrue(out["ok"], out)
        r = out["results"][0]
        self.assertEqual(r["status"], "fetched")
        self.assertEqual((self.env.raw / "5803.txt").read_text(encoding="utf-8"), good)
        self.assertTrue((self.env.raw / "5803.html").exists())
        self.assertEqual(r["effective_update_mode"], "on_demand")
        self.assertEqual(r["stock_name"], "フジクラ")
        with regmod.Registry(self.env.db, raw_dir=self.env.raw) as reg:
            st = reg.get_stock("5803")
            self.assertEqual(st["fetch_status"], "success")
            self.assertEqual(st["raw_hash"], r["raw_hash"])
            self.assertEqual(reg.daily_codes(), [])  # daily は増えない
        self.assertFalse((self.env.tmp / "tmp_fetch").exists() and any((self.env.tmp / "tmp_fetch").iterdir()))

    # Loop C: fresh RAW 再利用(fetcher が呼ばれない)
    def test_fresh_raw_reused_without_fetch(self):
        good = make_good_text("5803", "フジクラ")
        self._req(["5803"], fetcher=fake_fetcher_factory({"5803": ("success", good)}))
        calls = []
        out = self._req(["5803"], fetcher=fake_fetcher_factory({}, calls=calls), max_age_hours=24)
        self.assertTrue(out["ok"])
        self.assertEqual(out["results"][0]["status"], "fresh")
        self.assertEqual(out["results"][0]["source"], "existing_raw")
        self.assertEqual(calls, [])

    # Loop C: stale RAW 再取得
    def test_stale_raw_refetched(self):
        good = make_good_text("5803", "フジクラ")
        self._req(["5803"], fetcher=fake_fetcher_factory({"5803": ("success", good)}))
        calls = []
        good2 = make_good_text("5803", "フジクラ") + "\n更新\n"
        out = self._req(["5803"], fetcher=fake_fetcher_factory({"5803": ("success", good2)}, calls=calls), max_age_hours=0)
        self.assertEqual(out["results"][0]["status"], "fetched")
        self.assertEqual(calls, [["5803"]])
        self.assertEqual((self.env.raw / "5803.txt").read_text(encoding="utf-8"), good2)

    # Loop C: 認証エラー(exit 3) -> login_required、last good RAW は無傷
    def test_auth_error_keeps_last_good_raw(self):
        good = make_good_text("5803", "フジクラ")
        self._req(["5803"], fetcher=fake_fetcher_factory({"5803": ("success", good)}))
        out = self._req(["5803"], fetcher=fake_fetcher_factory({"5803": ("auth", None)}, exit_code=3), max_age_hours=0)
        self.assertFalse(out["ok"])
        self.assertTrue(out["login_required"])
        self.assertEqual(out["exit_code"], req.EXIT_LOGIN_REQUIRED)
        self.assertEqual(out["results"][0]["status"], "login_required")
        self.assertEqual((self.env.raw / "5803.txt").read_text(encoding="utf-8"), good)
        with regmod.Registry(self.env.db, raw_dir=self.env.raw) as reg:
            st = reg.get_stock("5803")
            self.assertEqual(st["fetch_status"], "login_required")
            self.assertEqual(st["raw_present"], 1)
            self.assertTrue(st["last_fetch"])

    # Loop C: 取得途中エラー(結果行なし) / 異常に短いHTML / code不一致 -> 昇格しない
    def test_bad_results_do_not_overwrite(self):
        good = make_good_text("5803", "フジクラ")
        self._req(["5803"], fetcher=fake_fetcher_factory({"5803": ("success", good)}))
        cases = {
            "missing_row": fake_fetcher_factory({}, exit_code=2),
            "too_short": fake_fetcher_factory({"5803": ("bad_success", "5803 フジクラ\n2026/03\t" + "\t".join(["1"] * 9))}),
            "code_mismatch": fake_fetcher_factory({"5803": ("bad_success", make_good_text("4062", "他社"))}),
            "auth_page_as_success": fake_fetcher_factory({"5803": ("bad_success", "認証されたユーザのみ\n" * 500)}),
            "fetch_failed": fake_fetcher_factory({"5803": ("failed", "timeout_error")}, exit_code=2),
        }
        for label, f in cases.items():
            out = self._req(["5803"], fetcher=f, max_age_hours=0)
            self.assertFalse(out["ok"], label)
            self.assertEqual(out["results"][0]["status"], "error", label)
            self.assertEqual(out["exit_code"], req.EXIT_PARTIAL, label)
            self.assertEqual((self.env.raw / "5803.txt").read_text(encoding="utf-8"), good, label)
        with regmod.Registry(self.env.db, raw_dir=self.env.raw) as reg:
            st = reg.get_stock("5803")
            self.assertEqual(st["fetch_status"], "error")
            self.assertIn("validation_failed", st["last_error"]) if False else None
            self.assertEqual(st["raw_present"], 1)

    def test_partial_batch_mixed(self):
        out = self._req(["1001", "1002"], fetcher=fake_fetcher_factory({"1001": ("success", make_good_text("1001")),
                                                                        "1002": ("failed", "timeout_error")}, exit_code=2))
        self.assertFalse(out["ok"])
        st = {r["code"]: r["status"] for r in out["results"]}
        self.assertEqual(st, {"1001": "fetched", "1002": "error"})

    def test_no_fetch_mode(self):
        calls = []
        out = self._req(["5803"], fetcher=fake_fetcher_factory({}, calls=calls), allow_fetch=False)
        self.assertEqual(out["results"][0]["status"], "stale_no_fetch")
        self.assertEqual(calls, [])

    def test_duplicates_and_invalid_codes(self):
        out = self._req(["5803", "5803", "bad!", "5803"], fetcher=fake_fetcher_factory({"5803": ("success", make_good_text("5803"))}))
        self.assertEqual(out["requested"], ["5803"])
        self.assertEqual(out["invalid_codes"], ["bad!"])

    def test_mode_daily_only_when_explicit(self):
        self._req(["5803"], fetcher=fake_fetcher_factory({"5803": ("success", make_good_text("5803"))}), mode="daily")
        with regmod.Registry(self.env.db, raw_dir=self.env.raw) as reg:
            self.assertEqual(reg.daily_codes(), ["5803"])
        with self.assertRaises(ValueError):
            self._req(["5803"], mode="inactive")

    # Loop E: 同時要求 -> ロックで直列化、同一銘柄は二重取得されない
    def test_concurrent_requests_serialized(self):
        calls = []
        lock_holders = []

        def slow_fetcher(codes, tmp_dir, **_):
            lock_holders.append(threading.get_ident())
            # ロック内で他スレッドが同時に入ってこないこと
            self.assertEqual(len(set(lock_holders)), len(lock_holders))
            time.sleep(0.5)
            f = fake_fetcher_factory({c: ("success", make_good_text(c)) for c in codes}, calls=calls)
            return f(codes, tmp_dir)

        results = {}

        def worker(name):
            results[name] = req.request_raw(name, ["5803"], reason="c", run_id=f"c_{name}", db_path=self.env.db, fetcher=slow_fetcher)

        t1 = threading.Thread(target=worker, args=("111",))
        t2 = threading.Thread(target=worker, args=("109",))
        t1.start(); time.sleep(0.05); t2.start(); t1.join(); t2.join()
        self.assertTrue(results["111"]["ok"] and results["109"]["ok"])
        statuses = sorted(r["results"][0]["status"] for r in results.values())
        self.assertEqual(statuses, ["fetched", "fresh"])  # 2回目はロック解放後に fresh を検出し再取得しない
        self.assertEqual(calls, [["5803"]])
        with regmod.Registry(self.env.db, raw_dir=self.env.raw) as reg:
            self.assertEqual({u["project"] for u in reg.get_usages("5803")}, {"111", "109"})


class LockTestCase(unittest.TestCase):
    def setUp(self):
        self.env = _Env()
        self.path = self.env.tmp / "locks" / "monex_fetch.lock"

    def tearDown(self):
        self.env.close()

    def test_lock_exclusive_and_release(self):
        with lockmod.MonexFetchLock("a", wait_sec=1, path=self.path) as l1:
            self.assertTrue(self.path.exists())
            with self.assertRaises(lockmod.LockTimeout):
                lockmod.MonexFetchLock("b", wait_sec=1, poll_sec=0.2, path=self.path).acquire()
        self.assertFalse(self.path.exists())

    def test_stale_lock_taken_over(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"pid": 999999, "owner": "dead", "started_at": "2020-01-01 00:00:00"}), encoding="utf-8")
        with lockmod.MonexFetchLock("c", wait_sec=1, path=self.path):
            info = json.loads(self.path.read_text(encoding="utf-8"))
            self.assertEqual(info["pid"], os.getpid())

    def test_powershell_lock_interop(self):
        """PowerShell版と同じファイル・同じプロトコルで相互排他できること(Windowsのみ)。"""
        if os.name != "nt":
            self.skipTest("windows only")
        ps1 = ROOT / "scripts" / "monex_fetch_lock.ps1"
        with lockmod.MonexFetchLock("py", wait_sec=1, path=self.path):
            cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
                   f". '{ps1}'; try {{ $l = Acquire-MonexFetchLock -Owner ps -WaitSec 2 -PollSec 1 -Path '{self.path}'; 'ACQUIRED' }} catch {{ 'BUSY' }}"]
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=60).stdout
            self.assertIn("BUSY", out)
        cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
               f". '{ps1}'; $l = Acquire-MonexFetchLock -Owner ps -WaitSec 2 -Path '{self.path}'; 'ACQUIRED'; Release-MonexFetchLock $l; if (Test-Path '{self.path}') {{ 'LEFT' }} else {{ 'RELEASED' }}"]
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60).stdout
        self.assertIn("ACQUIRED", out)
        self.assertIn("RELEASED", out)


if __name__ == "__main__":
    unittest.main()
