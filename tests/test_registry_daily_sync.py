# -*- coding: utf-8 -*-
"""
registry_daily_sync.py(05日次 ↔ レジストリ互換同期)の単体テスト。本番DB・本番CSVには触れない。
実行: python -m unittest tests.test_registry_daily_sync -v
"""
from __future__ import annotations

import csv
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import monex_registry as regmod  # noqa: E402
import registry_daily_sync as sync  # noqa: E402


def write_csv(path: Path, header: list[str], rows: list[list[str]]) -> None:
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
        w.writerow(header)
        for r in rows:
            w.writerow(r)


def read_csv(path: Path) -> list[dict]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


class DailySyncTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dsync05_"))
        self.db = self.tmp / "reg.sqlite3"
        self.raw = self.tmp / "raw"
        self.raw.mkdir()
        self.saved_raw = regmod.RAW_DIR
        regmod.RAW_DIR = self.raw
        self.saved_log = sync.LOG_PATH
        sync.LOG_PATH = self.tmp / "run_log.txt"
        self.target = self.tmp / "target_codes.csv"
        write_csv(self.target, ["code", "name", "source"], [["7203", "トヨタ", ""], ["6758", "ソニー", ""], ["9999", "手動", "manual"]])

    def tearDown(self):
        regmod.RAW_DIR = self.saved_raw
        sync.LOG_PATH = self.saved_log
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_first_run_imports_and_does_not_change_target(self):
        before = self.target.read_bytes()
        s = sync.sync_before_fetch(self.target, self.db)
        self.assertEqual(s["registered_daily"], 3)
        self.assertEqual(s["appended_from_registry"], [])
        self.assertEqual(s["daily_total"], 3)
        self.assertEqual(self.target.read_bytes(), before)  # 追記が無ければファイルは触らない
        with regmod.Registry(self.db, raw_dir=self.raw) as reg:
            self.assertEqual(sorted(reg.daily_codes()), ["6758", "7203", "9999"])
            self.assertEqual({u["reason"] for u in reg.get_usages("9999")}, {"05_manual_paste"})

    def test_on_demand_never_added_to_target(self):
        with regmod.Registry(self.db, raw_dir=self.raw) as reg:
            reg.set_usage("5803", "111", mode="on_demand")
            reg.set_usage("1234", "109", mode="on_demand")
            reg.deactivate_usage("1234", "109")  # inactive
        s = sync.sync_before_fetch(self.target, self.db, auto_import=False)
        self.assertEqual(s["appended_from_registry"], [])
        self.assertEqual([r["code"] for r in read_csv(self.target)], ["7203", "6758", "9999"])
        self.assertEqual(s["daily_total"], 3)
        self.assertEqual(s["on_demand_total"], 1)
        self.assertEqual(s["inactive_total"], 1)

    def test_pinned_and_other_project_daily_appended_with_source_registry(self):
        with regmod.Registry(self.db, raw_dir=self.raw) as reg:
            reg.set_pinned("5803", True)
            reg.set_usage("4062", "111", mode="daily", name="信越化学")
        s = sync.sync_before_fetch(self.target, self.db, auto_import=False)
        self.assertEqual(sorted(s["appended_from_registry"]), ["4062", "5803"])
        rows = read_csv(self.target)
        self.assertEqual([r["code"] for r in rows], ["7203", "6758", "9999", "4062", "5803"])
        self.assertEqual({r["source"] for r in rows[3:]}, {"registry"})
        self.assertEqual(rows[3]["name"], "信越化学")
        # 既存行の形式(引用・BOM・列)が維持される
        self.assertTrue(self.target.read_bytes().startswith("﻿".encode("utf-8")))
        self.assertIn(b'"7203","\xe3\x83\x88', self.target.read_bytes())
        # 2回目は冪等(既に含まれているので追記なし)
        s2 = sync.sync_before_fetch(self.target, self.db, auto_import=False)
        self.assertEqual(s2["appended_from_registry"], [])
        self.assertEqual(len(read_csv(self.target)), 5)

    def test_code_dropped_from_target_becomes_inactive_but_keeps_raw(self):
        (self.raw / "9999.txt").write_text("9999 手動\n", encoding="utf-8")
        sync.sync_before_fetch(self.target, self.db)
        write_csv(self.target, ["code", "name", "source"], [["7203", "トヨタ", ""], ["6758", "ソニー", ""]])
        s = sync.sync_before_fetch(self.target, self.db, auto_import=False)
        self.assertEqual(s["deactivated_05"], ["9999"])
        with regmod.Registry(self.db, raw_dir=self.raw) as reg:
            st = reg.get_stock("9999")
            self.assertEqual(st["effective_update_mode"], "inactive")
            self.assertEqual(st["raw_present"], 1)
            self.assertTrue((self.raw / "9999.txt").exists())
            self.assertEqual(len(reg.get_usages("9999")), 1)  # 利用履歴は残る

    def test_after_fetch_sync(self):
        sync.sync_before_fetch(self.target, self.db)
        (self.raw / "7203.txt").write_text("7203 トヨタ\n" * 10, encoding="utf-8")
        fs = self.tmp / "fetch_status.csv"
        hdr = ["code", "name", "fetched_at", "data_as_of", "source_update_date", "fetch_status", "stale_flag", "retry_count", "error_type", "error_message", "stop_reason"]
        write_csv(fs, hdr, [["7203", "トヨタ", "2026-09-04 15:00:00", "2026/03", "", "success", "false", "0", "", "", ""],
                            ["6758", "ソニー", "2026-09-04 15:00:10", "", "", "failed", "true", "3", "auth_error", "authentication page detected", "認証エラー"]])
        s = sync.sync_after_fetch(fs, self.db)
        self.assertEqual((s["success"], s["other"]), (1, 1))
        with regmod.Registry(self.db, raw_dir=self.raw) as reg:
            st = reg.get_stock("7203")
            self.assertEqual((st["fetch_status"], st["data_as_of"], st["raw_present"]), ("success", "2026/03", 1))
            self.assertTrue(st["raw_hash"].startswith("sha256:"))
            st2 = reg.get_stock("6758")
            self.assertEqual(st2["fetch_status"], "failed")
            self.assertIn("auth_error", st2["last_error"])
            self.assertEqual(st2["effective_update_mode"], "daily")  # 失敗しても daily 対象のまま

    def test_empty_target_raises(self):
        write_csv(self.target, ["code", "name", "source"], [])
        with self.assertRaises(RuntimeError):
            sync.sync_before_fetch(self.target, self.db)


if __name__ == "__main__":
    unittest.main()
