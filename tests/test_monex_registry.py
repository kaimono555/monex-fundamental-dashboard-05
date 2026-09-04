# -*- coding: utf-8 -*-
"""
共通レジストリ(scripts/monex_registry.py)の単体テスト。本番DB・本番RAWには触れない(全て一時ディレクトリ)。
実行: python -m unittest tests.test_monex_registry -v   (05プロジェクトルートで)
"""
from __future__ import annotations

import csv
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from monex_registry import Registry  # noqa: E402


class RegistryTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="reg05_"))
        self.raw = self.tmp / "raw"
        self.raw.mkdir()
        self.reg = Registry(self.tmp / "r.sqlite3", raw_dir=self.raw)

    def tearDown(self):
        self.reg.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _daily(self):
        return set(self.reg.daily_codes())

    # Loop B ケース1: 新規111銘柄をon_demand登録 -> daily銘柄数が増えない
    def test_case1_on_demand_does_not_increase_daily(self):
        self.reg.set_usage("7203", "05", mode="daily", reason="04")
        before = self._daily()
        st = self.reg.set_usage("5803", "111", mode="on_demand", reason="theme")
        self.assertEqual(st["effective_update_mode"], "on_demand")
        self.assertEqual(self._daily(), before)
        self.assertEqual(self.reg.get_stock("5803")["effective_update_mode"], "on_demand")

    # ケース2: 109もon_demand登録し、111をinactive -> on_demand のまま
    def test_case2_other_project_keeps_on_demand(self):
        self.reg.set_usage("5803", "111", mode="on_demand")
        self.reg.set_usage("5803", "109", mode="on_demand")
        st = self.reg.deactivate_usage("5803", "111")
        self.assertEqual(st["effective_update_mode"], "on_demand")
        usages = {u["project"]: u for u in self.reg.get_usages("5803")}
        self.assertEqual(usages["111"]["active"], 0)
        self.assertEqual(usages["109"]["active"], 1)
        # 111の利用履歴(last_required/reason)は消えていない
        self.assertTrue(usages["111"]["created_at"])

    # ケース3: 109もinactive -> inactive。RAWは残る
    def test_case3_all_inactive_keeps_raw(self):
        (self.raw / "5803.txt").write_text("5803 テスト\n", encoding="utf-8")
        self.reg.set_usage("5803", "111", mode="on_demand")
        self.reg.set_usage("5803", "109", mode="on_demand")
        self.reg.refresh_raw_presence("5803")
        self.reg.deactivate_usage("5803", "111")
        st = self.reg.deactivate_usage("5803", "109")
        self.assertEqual(st["effective_update_mode"], "inactive")
        self.assertEqual(st["raw_present"], 1)
        self.assertTrue((self.raw / "5803.txt").exists())
        self.assertEqual(len(self.reg.get_usages("5803")), 2)  # 過去利用Projectは残る

    # ケース4: pinned=true -> daily
    def test_case4_pinned_is_daily(self):
        self.reg.set_usage("5803", "111", mode="on_demand")
        st = self.reg.set_pinned("5803", True)
        self.assertEqual(st["effective_update_mode"], "daily")
        self.assertIn("5803", self._daily())

    # ケース5: pinned解除 -> Project要求に応じて on_demand / inactive に戻る
    def test_case5_unpin_falls_back(self):
        self.reg.set_usage("5803", "111", mode="on_demand")
        self.reg.set_pinned("5803", True)
        st = self.reg.set_pinned("5803", False)
        self.assertEqual(st["effective_update_mode"], "on_demand")
        self.reg.deactivate_usage("5803", "111")
        self.reg.set_pinned("5803", True)
        st = self.reg.set_pinned("5803", False)
        self.assertEqual(st["effective_update_mode"], "inactive")

    def test_daily_request_wins_over_on_demand(self):
        self.reg.set_usage("5803", "111", mode="on_demand")
        self.reg.set_usage("5803", "05", mode="daily")
        self.assertEqual(self.reg.get_stock("5803")["effective_update_mode"], "daily")
        self.reg.deactivate_usage("5803", "05")
        self.assertEqual(self.reg.get_stock("5803")["effective_update_mode"], "on_demand")

    def test_deactivate_project_except(self):
        for c in ["1001", "1002", "1003"]:
            self.reg.set_usage(c, "111", mode="on_demand")
        self.reg.set_usage("1002", "109", mode="on_demand")
        changed = self.reg.deactivate_project_except("111", ["1001"], reason="not_passed")
        self.assertEqual(sorted(changed), ["1002", "1003"])
        self.assertEqual(self.reg.get_stock("1001")["effective_update_mode"], "on_demand")
        self.assertEqual(self.reg.get_stock("1002")["effective_update_mode"], "on_demand")  # 109が使用中
        self.assertEqual(self.reg.get_stock("1003")["effective_update_mode"], "inactive")

    # last good RAW 保護: error は raw_* / last_fetch を上書きしない
    def test_update_fetch_result_error_keeps_last_good(self):
        (self.raw / "5803.txt").write_text("x" * 10, encoding="utf-8")
        self.reg.update_fetch_result("5803", status="success", fetched_at="2026-09-01 10:00:00", raw_path=self.raw / "5803.txt",
                                     raw_hash="sha256:aaa", data_as_of="2026/03")
        st = self.reg.update_fetch_result("5803", status="error", error="auth_error")
        self.assertEqual(st["fetch_status"], "error")
        self.assertEqual(st["last_error"], "auth_error")
        self.assertEqual(st["last_fetch"], "2026-09-01 10:00:00")
        self.assertEqual(st["raw_hash"], "sha256:aaa")
        self.assertEqual(st["raw_present"], 1)
        self.assertEqual(st["data_as_of"], "2026/03")

    def test_invalid_code_rejected(self):
        with self.assertRaises(ValueError):
            self.reg.set_usage("../evil", "111")
        with self.assertRaises(ValueError):
            self.reg.set_usage("5803", "111", mode="weird")

    def test_import_existing_and_view(self):
        tc = self.tmp / "target_codes.csv"
        with open(tc, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f, quoting=csv.QUOTE_ALL)
            w.writerow(["code", "name", "source"])
            w.writerow(["7203", "トヨタ", ""])
            w.writerow(["9999", "手動", "manual"])
        (self.raw / "7203.txt").write_text("7203 トヨタ\n", encoding="utf-8")
        (self.raw / "1234.txt").write_text("1234 旧RAW\n", encoding="utf-8")  # targetに無いRAW
        fs_ = self.tmp / "fetch_status.csv"
        with open(fs_, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f, quoting=csv.QUOTE_ALL)
            w.writerow(["code", "name", "fetched_at", "data_as_of", "source_update_date", "fetch_status", "stale_flag", "retry_count", "error_type", "error_message", "stop_reason"])
            w.writerow(["7203", "トヨタ", "2026-09-03 15:00:00", "2026/03", "", "success", "false", "0", "", "", ""])
            w.writerow(["9999", "手動", "2026-09-03 15:00:00", "", "", "failed", "true", "3", "auth_error", "x", ""])
        summary = self.reg.import_existing(tc, fs_)
        self.assertEqual(summary["targets"], 2)
        self.assertEqual(sorted(self.reg.daily_codes()), ["7203", "9999"])
        st = self.reg.get_stock("1234")
        self.assertEqual(st["effective_update_mode"], "inactive")
        self.assertEqual(st["raw_present"], 1)
        self.assertEqual(self.reg.get_stock("7203")["data_as_of"], "2026/03")
        self.assertEqual(self.reg.get_stock("9999")["fetch_status"], "failed")
        self.assertEqual({u["reason"] for u in self.reg.get_usages("9999")}, {"05_manual_paste"})
        v, u = self.reg.export_view(self.tmp / "view.csv", self.tmp / "usage.csv")
        with open(v, encoding="utf-8-sig", newline="") as f:
            rows = list(csv.DictReader(f))
        self.assertEqual(len(rows), 3)
        r7203 = next(r for r in rows if r["code"] == "7203")
        self.assertEqual(r7203["active_projects"], "05:daily")

    def test_reopen_persists(self):
        self.reg.set_usage("5803", "111", mode="on_demand")
        self.reg.close()
        reg2 = Registry(self.tmp / "r.sqlite3", raw_dir=self.raw)
        try:
            self.assertEqual(reg2.get_stock("5803")["effective_update_mode"], "on_demand")
        finally:
            reg2.close()


if __name__ == "__main__":
    unittest.main()
