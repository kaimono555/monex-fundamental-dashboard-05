# -*- coding: utf-8 -*-
"""
取得済みMonex財務RAWの05解析補完(scripts/parse_monex_raw.py + request_monex_raw.py の parse 連携)の単体テスト。
Playwright/ブラウザ/Monexは使わない(fetcher・PowerShellパーサ runner を差し替える)。
本番 data/raw・data/output・data/output_extended・parse_status.csv・本番DBには触れない
(tests.test_request_monex_raw._Env が一時ディレクトリへ差し替える)。

実行: python -m unittest tests.test_parse_monex_raw -v
"""
from __future__ import annotations

import hashlib
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

import monex_registry as regmod  # noqa: E402
import parse_monex_raw as pm  # noqa: E402
import request_monex_raw as req  # noqa: E402

from tests.test_request_monex_raw import _Env, fake_fetcher_factory, fake_parser_runner, make_good_text  # noqa: E402

DATA = ROOT / "data"
INVARIANT_FILES = [DATA / "target_codes.csv", DATA / "fundamentals.csv", DATA / "fundamental_scores.csv",
                   DATA / "stock_registry.sqlite3", DATA / "stock_registry_view.csv", DATA / "stock_registry_usage_view.csv"]


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else "missing"


def fake_topix_fetcher(codes, tmp_dir, *, allow_interactive_login=False, **_):
    d = tmp_dir / "raw_topix"
    d.mkdir(parents=True, exist_ok=True)
    rows = {}
    for c in codes:
        (d / f"{c}.txt").write_text(f"銘柄スカウター\n{c} テスト社\n業績ニュース\n", encoding="utf-8")
        (d / f"{c}.html").write_text("<html>news</html>", encoding="utf-8")
        (d / f"{c}_news.json").write_text(json.dumps({"fetched_at": "2026-09-05 10:00:00", "news": []}), encoding="utf-8")
        rows[c] = {"code": c, "fetch_status": "success", "stock_name": "テスト社", "news_count": 0}
    return 0, rows


class ParseViaRequestTestCase(unittest.TestCase):
    """request_monex_raw.request_raw → parse 連携。"""

    def setUp(self):
        self.env = _Env()
        self.calls: list[str] = []

        def counting_runner(code, raw_dir, out_dir, ext_dir, log_path):
            self.calls.append(code)
            return fake_parser_runner(code, raw_dir, out_dir, ext_dir, log_path)

        pm.DEFAULT_RUNNER = counting_runner
        self.invariants = {p: _sha(p) for p in INVARIANT_FILES}

    def tearDown(self):
        # 本番の対象リスト・ランキング・registry がテストで一切変化していないこと
        for p, h in self.invariants.items():
            self.assertEqual(_sha(p), h, f"production file changed by test: {p}")
        self.env.close()

    def _req(self, codes, **kw):
        kw.setdefault("reason", "test")
        kw.setdefault("run_id", f"t_{time.time_ns()}")
        return req.request_raw(kw.pop("project", "104-3"), codes, db_path=self.env.db, **kw)

    def _out(self, code):
        return pm.OUTPUT_DIR / f"{code}_financials.csv"

    # 1. zaimu RAW取得成功 → parse実行 → 銘柄別解析データ保存
    def test_zaimu_fetch_success_triggers_parse(self):
        good = make_good_text("4275", "カーリット")
        out = self._req(["4275"], fetcher=fake_fetcher_factory({"4275": ("success", good)}))
        self.assertTrue(out["ok"], out)
        r = out["results"][0]
        self.assertEqual(r["status"], "fetched")
        self.assertEqual(r["parse_status"], "parsed")
        self.assertEqual(self.calls, ["4275"])
        self.assertTrue(self._out("4275").is_file())
        self.assertTrue((pm.EXTENDED_DIR / "4275_cashflow.csv").is_file())
        st = pm.read_parse_status()["4275"]
        self.assertEqual(st["status"], "success")
        self.assertEqual(st["raw_hash"], r["raw_hash"])
        self.assertEqual(st["source"], "request:104-3")
        self.assertFalse((pm.TMP_PARSE_DIR).exists() and any(pm.TMP_PARSE_DIR.iterdir()))

    # 2. fresh RAWあり + 解析なし → Monex再取得せず parse だけ実行
    def test_fresh_raw_without_parsed_data_is_parsed_without_fetch(self):
        good = make_good_text("4275", "カーリット")
        self._req(["4275"], fetcher=fake_fetcher_factory({"4275": ("success", good)}), parse=False)
        self.assertFalse(self._out("4275").exists())
        self.assertEqual(self.calls, [])
        fetch_calls = []
        out = self._req(["4275"], fetcher=fake_fetcher_factory({}, calls=fetch_calls), max_age_hours=24)
        r = out["results"][0]
        self.assertEqual(fetch_calls, [])  # Monexへアクセスしない
        self.assertEqual(r["status"], "fresh")
        self.assertEqual(r["parse_status"], "parsed")
        self.assertEqual(self.calls, ["4275"])
        self.assertTrue(self._out("4275").is_file())

    # 3. fresh RAWあり + 解析あり → 再parseしない
    def test_fresh_raw_with_parsed_data_skips_reparse(self):
        good = make_good_text("4275", "カーリット")
        self._req(["4275"], fetcher=fake_fetcher_factory({"4275": ("success", good)}))
        self.assertEqual(self.calls, ["4275"])
        mtime = self._out("4275").stat().st_mtime_ns
        out = self._req(["4275"], fetcher=fake_fetcher_factory({}), max_age_hours=24, project="111")
        r = out["results"][0]
        self.assertEqual(r["status"], "fresh")
        self.assertEqual(r["parse_status"], "exists")
        self.assertEqual(self.calls, ["4275"])  # runner は呼ばれていない
        self.assertEqual(self._out("4275").stat().st_mtime_ns, mtime)

    # 3b. RAWが更新(再取得)されたら解析も更新される(raw_hash 不一致)
    def test_refetched_raw_is_reparsed(self):
        good = make_good_text("4275", "カーリット")
        self._req(["4275"], fetcher=fake_fetcher_factory({"4275": ("success", good)}))
        good2 = good + "\n更新\n"
        out = self._req(["4275"], fetcher=fake_fetcher_factory({"4275": ("success", good2)}), max_age_hours=0)
        self.assertEqual(out["results"][0]["status"], "fetched")
        self.assertEqual(out["results"][0]["parse_status"], "parsed")
        self.assertEqual(self.calls, ["4275", "4275"])
        self.assertEqual(pm.read_parse_status()["4275"]["raw_hash"], out["results"][0]["raw_hash"])

    # 4. topix_news → 財務parserは発火しない
    def test_topix_news_does_not_parse(self):
        out = self._req(["8306"], fetcher=fake_topix_fetcher, page_type="topix_news", project="109")
        self.assertTrue(out["ok"], out)
        r = out["results"][0]
        self.assertEqual(r["status"], "fetched")
        self.assertEqual(r["parse_status"], "")
        self.assertEqual(self.calls, [])
        self.assertFalse(self._out("8306").exists())
        self.assertFalse(pm.PARSE_STATUS_CSV.exists())
        with regmod.Registry(self.env.db, raw_dir=self.env.raw) as reg:
            self.assertEqual(reg.daily_codes(), [])
            self.assertEqual(reg.get_stock("8306")["effective_update_mode"], "on_demand")

    # 5. parse失敗 → RAW保持・RAW取得成功(fetch_status=success / status=fetched / exit 0)は維持・前回CSVも維持
    def test_parse_failure_keeps_raw_and_fetch_success(self):
        pm.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        old_csv = self._out("4275")
        old_csv.write_text("old,csv\n", encoding="utf-8")
        old_mtime = time.time() - 3600
        os.utime(old_csv, (old_mtime, old_mtime))  # RAWより古い → 再解析対象

        def failing_runner(code, raw_dir, out_dir, ext_dir, log_path):
            self.calls.append(code)
            return {"rc": 1, "ext_rc": None, "stderr": "PARSER_SCHEMA_MISMATCH"}

        pm.DEFAULT_RUNNER = failing_runner
        good = make_good_text("4275", "カーリット")
        out = self._req(["4275"], fetcher=fake_fetcher_factory({"4275": ("success", good)}))
        r = out["results"][0]
        self.assertTrue(out["ok"])  # parse失敗はRAW取得成功に影響しない
        self.assertEqual(out["exit_code"], req.EXIT_OK)
        self.assertEqual(r["status"], "fetched")
        self.assertEqual(r["parse_status"], "error")
        self.assertIn("PARSER_SCHEMA_MISMATCH", r["parse_error"])
        self.assertEqual((self.env.raw / "4275.txt").read_text(encoding="utf-8"), good)  # RAW保持
        self.assertEqual(old_csv.read_text(encoding="utf-8"), "old,csv\n")  # 前回CSV維持
        st = pm.read_parse_status()["4275"]
        self.assertEqual(st["status"], "error")
        with regmod.Registry(self.env.db, raw_dir=self.env.raw) as reg:
            s = reg.get_stock("4275")
            self.assertEqual(s["fetch_status"], "success")  # RAW取得success を error で上書きしない
            self.assertEqual(s["last_error"], "")

    # 6. parseしても daily へ昇格しない / usage・mode 不変
    def test_parse_does_not_promote_to_daily(self):
        good = make_good_text("4275", "カーリット")
        out = self._req(["4275"], fetcher=fake_fetcher_factory({"4275": ("success", good)}))
        self.assertEqual(out["results"][0]["parse_status"], "parsed")
        with regmod.Registry(self.env.db, raw_dir=self.env.raw) as reg:
            self.assertEqual(reg.daily_codes(), [])
            s = reg.get_stock("4275")
            self.assertEqual(s["effective_update_mode"], "on_demand")
            self.assertEqual(s["pinned"], 0)
            usages = reg.get_usages("4275")
            self.assertEqual([(u["project"], u["active"], u["requested_mode"]) for u in usages], [("104-3", 1, "on_demand")])
            # fetch_log に parse は記録しない(従来どおりMonex取得関連のみ)
            actions = {row["action"] for row in reg.recent_logs(100)}
            self.assertNotIn("parse", actions)

    # 7. parseしても本番 target_codes.csv / fundamentals / fundamental_scores は不変(tearDown で検証) + 一時DBは本番DBではない
    def test_parse_does_not_touch_target_codes(self):
        good = make_good_text("4275", "カーリット")
        self._req(["4275"], fetcher=fake_fetcher_factory({"4275": ("success", good)}))
        self.assertTrue(self._out("4275").is_file())
        self.assertNotEqual(self.env.db, regmod.DEFAULT_DB_PATH)
        # tearDown が INVARIANT_FILES の hash 不変を検証する

    # 8. 英数字コード 285A が壊れない(小文字入力も正規化)
    def test_alnum_code_285A(self):
        good = make_good_text("285A", "キオクシア")
        out = self._req(["285a"], fetcher=fake_fetcher_factory({"285A": ("success", good)}))
        r = out["results"][0]
        self.assertEqual(r["code"], "285A")
        self.assertEqual(r["parse_status"], "parsed")
        self.assertTrue(self._out("285A").is_file())
        self.assertIn("285A", pm.read_parse_status())
        self.assertEqual(self.calls, ["285A"])


class ParseModuleTestCase(unittest.TestCase):
    """parse_monex_raw 単体(ロック・バックフィル抽出・実パーサ)。"""

    def setUp(self):
        self.env = _Env()
        self.invariants = {p: _sha(p) for p in INVARIANT_FILES}

    def tearDown(self):
        for p, h in self.invariants.items():
            self.assertEqual(_sha(p), h, f"production file changed by test: {p}")
        self.env.close()

    # 同一銘柄をほぼ同時に解析要求しても runner は1回だけ(銘柄単位ロック + raw_hash 再判定)
    def test_concurrent_parse_same_code_runs_once(self):
        (self.env.raw / "4275.txt").write_text(make_good_text("4275"), encoding="utf-8")
        calls = []
        lock = threading.Lock()

        def slow_runner(code, raw_dir, out_dir, ext_dir, log_path):
            with lock:
                calls.append(code)
            time.sleep(0.4)
            return fake_parser_runner(code, raw_dir, out_dir, ext_dir, log_path)

        results = []

        def worker(src):
            results.append(pm.parse_zaimu_raw("4275", runner=slow_runner, source=src))

        ts = [threading.Thread(target=worker, args=(f"req{i}",)) for i in range(3)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(calls, ["4275"])
        self.assertEqual(sorted(r["status"] for r in results), ["exists", "exists", "parsed"])
        self.assertFalse((pm.LOCK_DIR / "parse_4275.lock").exists())

    # RAWが無ければ raw_missing(何も書かない)
    def test_raw_missing(self):
        r = pm.parse_zaimu_raw("9999", runner=fake_parser_runner)
        self.assertEqual(r["status"], "raw_missing")
        self.assertFalse(pm.PARSE_STATUS_CSV.exists())

    # backfill 候補: registry登録済み・success・正常RAW・未解析 のみ。孤立RAWは別枠、解析済みは除外、errorは除外
    def test_backfill_candidates(self):
        for c in ("4275", "4568", "6367", "4519"):
            (self.env.raw / f"{c}.txt").write_text(make_good_text(c), encoding="utf-8")
        with regmod.Registry(self.env.db, raw_dir=self.env.raw) as reg:
            for c in ("4275", "4568"):
                reg.update_fetch_result(c, status="success", raw_path=self.env.raw / f"{c}.txt", raw_hash=regmod.sha256_file(self.env.raw / f"{c}.txt"))
            reg.update_fetch_result("6367", status="success", raw_path=self.env.raw / "6367.txt")
            reg.update_fetch_result("6367", status="error", error="simulated")  # RAWはあるが直近取得は error
            reg.set_usage("7203", "05", mode="daily")  # registry登録のみ・RAW無し
        # 4568 は解析済み(CSV が RAW より新しい)
        pm.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        (pm.OUTPUT_DIR / "4568_financials.csv").write_text("x\n", encoding="utf-8")
        cand = pm.backfill_candidates(db_path=self.env.db, validate=lambda c, t, h: {"ok": True, "stock_name": f"N{c}"})
        self.assertEqual([c["code"] for c in cand["need_parse"]], ["4275"])
        self.assertEqual(cand["already_parsed"], ["4568"])
        self.assertEqual(cand["orphan_raw"], ["4519"])
        self.assertEqual([x["code"] for x in cand["not_success"]], ["6367"])
        self.assertEqual(cand["registered_raw_ok"], ["4275", "4568"])
        # daily-codes / usage は抽出で変化しない
        with regmod.Registry(self.env.db, raw_dir=self.env.raw) as reg:
            self.assertEqual(reg.daily_codes(), ["7203"])

    # 実パーサ(PowerShell)を本番RAWに対して一時出力先で実行できる(4275 / 285A)。本番 data/output には書かない。
    def test_real_powershell_parser_on_real_raw(self):
        if shutil.which("powershell") is None:
            self.skipTest("powershell not available")
        for code in ("4275", "285A"):
            real = ROOT / "data" / "raw" / f"{code}.txt"
            if not real.is_file():
                self.skipTest(f"real raw missing: {real}")
            shutil.copyfile(real, self.env.raw / f"{code}.txt")
            html = ROOT / "data" / "raw" / f"{code}.html"
            if html.is_file():
                shutil.copyfile(html, self.env.raw / f"{code}.html")
            r = pm.parse_zaimu_raw(code, runner=pm.run_powershell_parsers, source="test")
            self.assertEqual(r["status"], "parsed", r)
            self.assertGreater(r["financials_rows"], 0)
            self.assertTrue((pm.OUTPUT_DIR / f"{code}_financials.csv").is_file())
            self.assertTrue((pm.EXTENDED_DIR / f"{code}_latest_indicators.csv").is_file())
            self.assertEqual(pm.read_parse_status()[code]["status"], "success")


if __name__ == "__main__":
    unittest.main()
