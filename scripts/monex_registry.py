#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
05 共通銘柄レジストリ(銘柄スカウターRAW取得センター)。

目的:
  「RAWを保存しているか」と「毎日更新するか」を完全に分離して管理する。
  05・109・104-3・111 がそれぞれ独立した利用状態(project_usage)を持ち、
  銘柄全体の effective_update_mode はそれらから機械的に決定する。

保存形式:
  SQLite (Python標準ライブラリ sqlite3 のみ。追加パッケージ不要)
  data/stock_registry.sqlite3
  人間確認用ビュー: data/stock_registry_view.csv / data/stock_registry_usage_view.csv
  (ビューCSVは書き出し専用。複数Projectが直接書き換える設計にはしない。
   レジストリへの書き込み責任は05側(このモジュール経由)に集約する)

effective_update_mode の決定(優先順位):
  1. pinned=1                              -> daily
  2. いずれかのProjectが active かつ daily  -> daily
  3. いずれかのProjectが active かつ on_demand -> on_demand
  4. それ以外                               -> inactive

  あるProjectがinactiveへ変更しても、他Projectの利用状態は消さない。
  inactive になってもRAW・最終取得日時・過去利用Projectは残す(物理削除は別操作・本モジュール対象外)。

CLI:
  python scripts/monex_registry.py import-existing        既存05データ(target_codes/raw/fetch_status)を初期登録
  python scripts/monex_registry.py show <code>
  python scripts/monex_registry.py list [--mode daily|on_demand|inactive]
  python scripts/monex_registry.py daily-codes
  python scripts/monex_registry.py set-usage --project 111 --codes 5803,4062 --mode on_demand [--inactive] [--reason ..] [--run-id ..]
  python scripts/monex_registry.py pin <code> / unpin <code>
  python scripts/monex_registry.py export-view
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
DEFAULT_DB_PATH = DATA_DIR / "stock_registry.sqlite3"
VIEW_CSV_PATH = DATA_DIR / "stock_registry_view.csv"
USAGE_VIEW_CSV_PATH = DATA_DIR / "stock_registry_usage_view.csv"
TARGET_CODES_PATH = DATA_DIR / "target_codes.csv"
FETCH_STATUS_PATH = DATA_DIR / "fetch_status.csv"

MODES = ("daily", "on_demand", "inactive")
CODE_RE = re.compile(r"^[0-9][0-9A-Za-z]{3,4}$")
SCHEMA_VERSION = 1

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS stocks (
  code TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  effective_update_mode TEXT NOT NULL DEFAULT 'inactive',
  raw_present INTEGER NOT NULL DEFAULT 0,
  raw_path TEXT DEFAULT '',
  raw_html_path TEXT DEFAULT '',
  raw_hash TEXT DEFAULT '',
  last_fetch TEXT DEFAULT '',
  fetch_status TEXT DEFAULT '',
  data_as_of TEXT DEFAULT '',
  monex_data_updated_at TEXT DEFAULT '',
  last_error TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_usage (
  code TEXT NOT NULL,
  project TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  requested_mode TEXT NOT NULL DEFAULT 'on_demand',
  last_required TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  run_id TEXT DEFAULT '',
  lease_expires_at TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (code, project)
);
CREATE TABLE IF NOT EXISTS fetch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  project TEXT DEFAULT '',
  code TEXT DEFAULT '',
  run_id TEXT DEFAULT '',
  action TEXT NOT NULL,
  status TEXT DEFAULT '',
  detail TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_usage_project ON project_usage(project, active);
CREATE INDEX IF NOT EXISTS idx_fetch_log_code ON fetch_log(code, ts);
"""


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def normalize_code(code: str) -> str:
    c = str(code or "").strip().upper()
    if not CODE_RE.match(c):
        raise ValueError(f"invalid stock code: {code!r}")
    return c


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


class Registry:
    """SQLite銘柄レジストリ。with 文で使うと自動closeする。"""

    def __init__(self, db_path: Path | str | None = None, raw_dir: Path | str | None = None):
        # 既定値は呼び出し時にモジュール変数を参照する(テストでの差し替えを有効にするため、def時に束縛しない)
        self.db_path = Path(db_path) if db_path else DEFAULT_DB_PATH
        self.raw_dir = Path(raw_dir) if raw_dir else RAW_DIR
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.db_path), timeout=30, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA busy_timeout=30000")
        self._init_schema()

    # -- lifecycle -----------------------------------------------------
    def __enter__(self) -> "Registry":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def close(self) -> None:
        try:
            self.conn.close()
        except Exception:  # noqa: BLE001
            pass

    def _init_schema(self) -> None:
        self.conn.executescript(SCHEMA_SQL)
        cur = self.conn.execute("SELECT value FROM meta WHERE key='schema_version'")
        row = cur.fetchone()
        if row is None:
            self.conn.execute("INSERT INTO meta(key,value) VALUES('schema_version',?)", (str(SCHEMA_VERSION),))
            self.conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('created_at',?)", (now_str(),))

    def _tx(self):
        return _Tx(self.conn)

    # -- stocks -------------------------------------------------------------
    def get_stock(self, code: str) -> Optional[dict]:
        code = normalize_code(code)
        row = self.conn.execute("SELECT * FROM stocks WHERE code=?", (code,)).fetchone()
        return dict(row) if row else None

    def ensure_stock(self, code: str, name: str = "") -> dict:
        code = normalize_code(code)
        ts = now_str()
        with self._tx():
            row = self.conn.execute("SELECT * FROM stocks WHERE code=?", (code,)).fetchone()
            if row is None:
                self.conn.execute(
                    "INSERT INTO stocks(code,name,created_at,updated_at) VALUES(?,?,?,?)",
                    (code, name or "", ts, ts),
                )
            elif name and not row["name"]:
                self.conn.execute("UPDATE stocks SET name=?, updated_at=? WHERE code=?", (name, ts, code))
        return self.get_stock(code)  # type: ignore[return-value]

    def set_pinned(self, code: str, pinned: bool, reason: str = "") -> dict:
        code = normalize_code(code)
        self.ensure_stock(code)
        with self._tx():
            self.conn.execute("UPDATE stocks SET pinned=?, updated_at=? WHERE code=?", (1 if pinned else 0, now_str(), code))
            self._recompute_effective_locked(code)
            self._log_locked("", code, "", "pin" if pinned else "unpin", "ok", reason)
        return self.get_stock(code)  # type: ignore[return-value]

    def update_fetch_result(self, code: str, *, status: str, fetched_at: str = "", raw_path: Path | str | None = None,
                            raw_html_path: Path | str | None = None, raw_hash: str = "", data_as_of: str = "",
                            monex_data_updated_at: str = "", error: str = "", project: str = "", run_id: str = "") -> dict:
        """取得結果を反映する。status='error' の場合は fetch_status/last_error のみ更新し、
        raw_* / last_fetch(前回正常RAWの情報)は絶対に上書きしない。"""
        code = normalize_code(code)
        self.ensure_stock(code)
        ts = now_str()
        with self._tx():
            if status == "success":
                self.conn.execute(
                    """UPDATE stocks SET last_fetch=?, fetch_status='success', raw_present=1,
                       raw_path=COALESCE(?, raw_path), raw_html_path=COALESCE(?, raw_html_path),
                       raw_hash=CASE WHEN ?<>'' THEN ? ELSE raw_hash END,
                       data_as_of=CASE WHEN ?<>'' THEN ? ELSE data_as_of END,
                       monex_data_updated_at=CASE WHEN ?<>'' THEN ? ELSE monex_data_updated_at END,
                       last_error='', updated_at=? WHERE code=?""",
                    (fetched_at or ts, str(raw_path) if raw_path else None, str(raw_html_path) if raw_html_path else None,
                     raw_hash, raw_hash, data_as_of, data_as_of, monex_data_updated_at, monex_data_updated_at, ts, code),
                )
            else:
                self.conn.execute(
                    "UPDATE stocks SET fetch_status=?, last_error=?, updated_at=? WHERE code=?",
                    (status or "error", error or "", ts, code),
                )
            self._log_locked(project, code, run_id, "fetch", status, error or "")
        return self.get_stock(code)  # type: ignore[return-value]

    def refresh_raw_presence(self, code: str) -> dict:
        """data/raw/{code}.txt の有無・hashを実ファイルから再確認して反映する(削除はしない)。"""
        code = normalize_code(code)
        self.ensure_stock(code)
        txt = self.raw_dir / f"{code}.txt"
        html = self.raw_dir / f"{code}.html"
        present = txt.is_file()
        with self._tx():
            if present:
                self.conn.execute(
                    "UPDATE stocks SET raw_present=1, raw_path=?, raw_html_path=?, raw_hash=?, updated_at=? WHERE code=?",
                    (str(txt), str(html) if html.is_file() else "", sha256_file(txt), now_str(), code),
                )
            else:
                self.conn.execute("UPDATE stocks SET raw_present=0, updated_at=? WHERE code=?", (now_str(), code))
        return self.get_stock(code)  # type: ignore[return-value]

    # -- usage ------------------------------------------------------------
    def set_usage(self, code: str, project: str, *, active: bool = True, mode: str = "on_demand", reason: str = "",
                  run_id: str = "", lease_expires_at: str = "", name: str = "") -> dict:
        """Project単位の利用状態を登録・更新する。デフォルトは active/on_demand。
        依頼だけで daily に昇格させない(mode='daily' は明示指定が必要)。"""
        code = normalize_code(code)
        project = str(project or "").strip()
        if not project:
            raise ValueError("project is required")
        if mode not in MODES:
            raise ValueError(f"invalid mode: {mode}")
        if mode == "inactive":
            active = False
        self.ensure_stock(code, name)
        ts = now_str()
        with self._tx():
            row = self.conn.execute("SELECT * FROM project_usage WHERE code=? AND project=?", (code, project)).fetchone()
            requested_mode = mode if mode != "inactive" else (row["requested_mode"] if row else "on_demand")
            if row is None:
                self.conn.execute(
                    """INSERT INTO project_usage(code,project,active,requested_mode,last_required,reason,run_id,
                       lease_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                    (code, project, 1 if active else 0, requested_mode, ts if active else "", reason, run_id,
                     lease_expires_at, ts, ts),
                )
            else:
                self.conn.execute(
                    """UPDATE project_usage SET active=?, requested_mode=?,
                       last_required=CASE WHEN ? THEN ? ELSE last_required END,
                       reason=CASE WHEN ?<>'' THEN ? ELSE reason END,
                       run_id=CASE WHEN ?<>'' THEN ? ELSE run_id END,
                       lease_expires_at=?, updated_at=? WHERE code=? AND project=?""",
                    (1 if active else 0, requested_mode, 1 if active else 0, ts, reason, reason, run_id, run_id,
                     lease_expires_at, ts, code, project),
                )
            self._recompute_effective_locked(code)
            self._log_locked(project, code, run_id, "set_usage", ("active:" if active else "inactive:") + requested_mode, reason)
        return self.get_stock(code)  # type: ignore[return-value]

    def deactivate_usage(self, code: str, project: str, reason: str = "", run_id: str = "") -> dict:
        return self.set_usage(code, project, active=False, mode="inactive", reason=reason, run_id=run_id)

    def deactivate_project_except(self, project: str, keep_codes: Iterable[str], reason: str = "", run_id: str = "") -> list[str]:
        """project の active な利用のうち keep_codes 以外を inactive にする(他Projectの状態は触らない)。"""
        keep = {normalize_code(c) for c in keep_codes}
        rows = self.conn.execute("SELECT code FROM project_usage WHERE project=? AND active=1", (project,)).fetchall()
        changed = []
        for r in rows:
            if r["code"] not in keep:
                self.deactivate_usage(r["code"], project, reason=reason, run_id=run_id)
                changed.append(r["code"])
        return changed

    def get_usages(self, code: str) -> list[dict]:
        code = normalize_code(code)
        rows = self.conn.execute("SELECT * FROM project_usage WHERE code=? ORDER BY project", (code,)).fetchall()
        return [dict(r) for r in rows]

    def list_project_codes(self, project: str, active_only: bool = True) -> list[str]:
        q = "SELECT code FROM project_usage WHERE project=?" + (" AND active=1" if active_only else "") + " ORDER BY code"
        return [r["code"] for r in self.conn.execute(q, (project,)).fetchall()]

    # -- effective mode -----------------------------------------------------
    def compute_effective_mode(self, code: str) -> str:
        code = normalize_code(code)
        st = self.conn.execute("SELECT pinned FROM stocks WHERE code=?", (code,)).fetchone()
        if st is None:
            return "inactive"
        if st["pinned"]:
            return "daily"
        rows = self.conn.execute(
            "SELECT requested_mode FROM project_usage WHERE code=? AND active=1", (code,)).fetchall()
        modes = {r["requested_mode"] for r in rows}
        if "daily" in modes:
            return "daily"
        if "on_demand" in modes:
            return "on_demand"
        return "inactive"

    def _recompute_effective_locked(self, code: str) -> str:
        mode = self.compute_effective_mode(code)
        self.conn.execute("UPDATE stocks SET effective_update_mode=?, updated_at=? WHERE code=?", (mode, now_str(), code))
        return mode

    def recompute_all(self) -> None:
        with self._tx():
            for r in self.conn.execute("SELECT code FROM stocks").fetchall():
                self._recompute_effective_locked(r["code"])

    def list_stocks(self, mode: Optional[str] = None) -> list[dict]:
        if mode:
            rows = self.conn.execute("SELECT * FROM stocks WHERE effective_update_mode=? ORDER BY code", (mode,)).fetchall()
        else:
            rows = self.conn.execute("SELECT * FROM stocks ORDER BY code").fetchall()
        return [dict(r) for r in rows]

    def daily_codes(self) -> list[str]:
        return [r["code"] for r in self.list_stocks("daily")]

    # -- log ------------------------------------------------------------
    def _log_locked(self, project: str, code: str, run_id: str, action: str, status: str, detail: str) -> None:
        self.conn.execute(
            "INSERT INTO fetch_log(ts,project,code,run_id,action,status,detail) VALUES(?,?,?,?,?,?,?)",
            (now_str(), project or "", code or "", run_id or "", action, status or "", (detail or "")[:2000]),
        )

    def log(self, project: str, code: str, run_id: str, action: str, status: str, detail: str = "") -> None:
        with self._tx():
            self._log_locked(project, code, run_id, action, status, detail)

    def recent_logs(self, limit: int = 50) -> list[dict]:
        rows = self.conn.execute("SELECT * FROM fetch_log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]

    # -- import / view ------------------------------------------------------
    def import_existing(self, target_codes_path: Path | str = TARGET_CODES_PATH,
                        fetch_status_path: Path | str = FETCH_STATUS_PATH, project: str = "05") -> dict:
        """既存05データを初期登録する(非破壊: 既存ファイルは読み取りのみ)。
        - target_codes.csv の銘柄 -> project=05 daily(現行の日次運用対象そのまま)
        - data/raw/*.txt の銘柄  -> stocks に登録(RAW有り)。target外なら usage は登録しない(=inactive、RAW保持)
        - fetch_status.csv       -> last_fetch / data_as_of / fetch_status を反映
        """
        target_codes_path = Path(target_codes_path)
        fetch_status_path = Path(fetch_status_path)
        summary = {"targets": 0, "raw_files": 0, "fetch_status_rows": 0, "stocks_total": 0, "daily_total": 0}

        if target_codes_path.is_file():
            with open(target_codes_path, encoding="utf-8-sig", newline="") as f:
                for row in csv.DictReader(f):
                    code = (row.get("code") or "").strip()
                    if not code:
                        continue
                    source = (row.get("source") or "").strip()
                    reason = {"": "04_follow_candidates", "manual": "05_manual_paste", "09_holding": "09_holding"}.get(source, source)
                    self.set_usage(code, project, active=True, mode="daily", reason=reason, name=(row.get("name") or "").strip())
                    summary["targets"] += 1

        if self.raw_dir.is_dir():
            for p in sorted(self.raw_dir.glob("*.txt")):
                code = p.stem
                if not CODE_RE.match(code):
                    continue
                self.ensure_stock(code)
                self.refresh_raw_presence(code)
                summary["raw_files"] += 1

        if fetch_status_path.is_file():
            with open(fetch_status_path, encoding="utf-8-sig", newline="") as f:
                for row in csv.DictReader(f):
                    code = (row.get("code") or "").strip()
                    if not code or not CODE_RE.match(code):
                        continue
                    st = (row.get("fetch_status") or "").strip()
                    ts = now_str()
                    with self._tx():
                        self.ensure_stock(code, (row.get("name") or "").strip())
                        if st == "success":
                            self.conn.execute(
                                """UPDATE stocks SET last_fetch=?, fetch_status='success', data_as_of=?, last_error='', updated_at=?
                                   WHERE code=?""",
                                ((row.get("fetched_at") or "").strip(), (row.get("data_as_of") or "").strip(), ts, code))
                        else:
                            self.conn.execute(
                                "UPDATE stocks SET fetch_status=?, last_error=?, updated_at=? WHERE code=?",
                                (st or "unknown", (row.get("error_message") or "").strip(), ts, code))
                    summary["fetch_status_rows"] += 1

        self.recompute_all()
        with self._tx():
            self._log_locked(project, "", "", "import_existing", "ok", json.dumps(summary, ensure_ascii=False))
            self.conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('imported_at',?)", (now_str(),))
        summary["stocks_total"] = len(self.list_stocks())
        summary["daily_total"] = len(self.daily_codes())
        return summary

    def export_view(self, view_path: Path | str = VIEW_CSV_PATH, usage_view_path: Path | str = USAGE_VIEW_CSV_PATH) -> tuple[Path, Path]:
        """人間確認用CSV(書き出し専用)。"""
        view_path = Path(view_path)
        usage_view_path = Path(usage_view_path)
        stocks = self.list_stocks()
        usages = self.conn.execute("SELECT * FROM project_usage ORDER BY code, project").fetchall()
        by_code: dict[str, list[sqlite3.Row]] = {}
        for u in usages:
            by_code.setdefault(u["code"], []).append(u)

        cols = ["code", "name", "pinned", "effective_update_mode", "active_projects", "raw_present", "raw_path",
                "raw_hash", "last_fetch", "fetch_status", "data_as_of", "monex_data_updated_at", "last_error",
                "created_at", "updated_at"]
        _write_csv_atomic(view_path, cols, [
            {**s, "active_projects": ";".join(f"{u['project']}:{u['requested_mode']}" for u in by_code.get(s["code"], []) if u["active"])}
            for s in stocks
        ])
        ucols = ["code", "project", "active", "requested_mode", "last_required", "reason", "run_id", "lease_expires_at",
                 "created_at", "updated_at"]
        _write_csv_atomic(usage_view_path, ucols, [dict(u) for u in usages])
        return view_path, usage_view_path


class _Tx:
    """BEGIN IMMEDIATE ... COMMIT/ROLLBACK。ネスト時は外側に委ねる。"""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self.owner = False

    def __enter__(self):
        if not self.conn.in_transaction:
            self.conn.execute("BEGIN IMMEDIATE")
            self.owner = True
        return self

    def __exit__(self, exc_type, exc, tb):
        if not self.owner:
            return False
        if exc_type is None:
            self.conn.execute("COMMIT")
        else:
            self.conn.execute("ROLLBACK")
        return False


def _write_csv_atomic(path: Path, cols: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore", quoting=csv.QUOTE_ALL)
        w.writeheader()
        for r in rows:
            w.writerow({c: ("" if r.get(c) is None else r.get(c)) for c in cols})
    os.replace(tmp, path)


# ---------------------------------------------------------------------- CLI

def _print_json(obj) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="05 共通銘柄レジストリ CLI")
    ap.add_argument("--db", default=str(DEFAULT_DB_PATH))
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("import-existing", help="既存05データを初期登録(非破壊)")
    p = sub.add_parser("show"); p.add_argument("code")
    p = sub.add_parser("list"); p.add_argument("--mode", choices=MODES)
    sub.add_parser("daily-codes")
    p = sub.add_parser("set-usage")
    p.add_argument("--project", required=True)
    p.add_argument("--codes", required=True)
    p.add_argument("--mode", default="on_demand", choices=MODES)
    p.add_argument("--inactive", action="store_true")
    p.add_argument("--reason", default="")
    p.add_argument("--run-id", default="")
    p = sub.add_parser("pin"); p.add_argument("code"); p.add_argument("--reason", default="")
    p = sub.add_parser("unpin"); p.add_argument("code"); p.add_argument("--reason", default="")
    sub.add_parser("export-view")
    p = sub.add_parser("logs"); p.add_argument("--limit", type=int, default=30)
    args = ap.parse_args(argv)

    with Registry(args.db) as reg:
        if args.cmd == "import-existing":
            _print_json(reg.import_existing())
            reg.export_view()
        elif args.cmd == "show":
            st = reg.get_stock(args.code)
            _print_json({"stock": st, "usages": reg.get_usages(args.code) if st else []})
        elif args.cmd == "list":
            _print_json(reg.list_stocks(args.mode))
        elif args.cmd == "daily-codes":
            print("\n".join(reg.daily_codes()))
        elif args.cmd == "set-usage":
            out = []
            for c in [x.strip() for x in args.codes.split(",") if x.strip()]:
                st = reg.set_usage(c, args.project, active=not args.inactive,
                                   mode="inactive" if args.inactive else args.mode,
                                   reason=args.reason, run_id=args.run_id)
                out.append({"code": c, "effective_update_mode": st["effective_update_mode"]})
            reg.export_view()
            _print_json(out)
        elif args.cmd == "pin":
            _print_json(reg.set_pinned(args.code, True, args.reason)); reg.export_view()
        elif args.cmd == "unpin":
            _print_json(reg.set_pinned(args.code, False, args.reason)); reg.export_view()
        elif args.cmd == "export-view":
            v, u = reg.export_view(); print(v); print(u)
        elif args.cmd == "logs":
            _print_json(reg.recent_logs(args.limit))
    return 0


if __name__ == "__main__":
    sys.exit(main())
