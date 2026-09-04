#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
05日次パイプライン(run_project.ps1)と共通レジストリの互換同期。

方針(2026-09-04 共通RAW取得センター化 Phase 1/6):
  - 日次対象の決定元は従来どおり 04 follow_candidates → target_codes.csv(+09保有・手動貼付追記)。
    run_project.ps1 の既存ロジックは変えない。
  - このスクリプトは target_codes.csv 確定直後に呼ばれ、
      (1) target_codes.csv の銘柄を project=05 / daily / active としてレジストリへ反映
      (2) 以前は05 dailyだったが今回 target_codes に無い銘柄の 05 利用を inactive にする
          (RAW・他Projectの利用状態は残す)
      (3) レジストリ上 effective_update_mode=daily なのに target_codes.csv に無い銘柄
          (pinned=true、または他Projectが daily 要求)を source="registry" として target_codes.csv 末尾に追記
    を行う。on_demand / inactive の銘柄は絶対に target_codes.csv へ追加しない(daily 対象が意図せず増えない)。
  - --after-fetch: fetch_status.csv の結果(成功/失敗・fetched_at・data_as_of)をレジストリへ反映する。
    失敗時も RAW 情報(raw_path/raw_hash/last_fetch)は上書きしない。
  - どちらのモードも失敗しても日次処理を止めない(呼び出し側で非致命扱い)。

使い方:
  python scripts/registry_daily_sync.py --target-codes data/target_codes.csv
  python scripts/registry_daily_sync.py --after-fetch --fetch-status data/fetch_status.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from monex_registry import (  # noqa: E402
    CODE_RE, DEFAULT_DB_PATH, FETCH_STATUS_PATH, TARGET_CODES_PATH, Registry, normalize_code,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
LOG_PATH = PROJECT_ROOT / "logs" / "run_log.txt"
DAILY_PROJECT = "05"
SOURCE_REASON = {"": "04_follow_candidates", "manual": "05_manual_paste", "09_holding": "09_holding", "registry": "registry_daily"}


def write_run_log(msg: str) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] [registry] {msg}\n")


def read_target_codes(path: Path) -> list[dict]:
    rows = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            code = (row.get("code") or "").strip()
            if code:
                rows.append({"code": code, "name": (row.get("name") or "").strip(), "source": (row.get("source") or "").strip()})
    return rows


def write_target_codes(path: Path, rows: list[dict]) -> None:
    """既存形式(UTF-8 BOM・全セル引用・列 code,name,source)で原子的に書き戻す。"""
    tmp = path.with_suffix(".csv.tmp")
    with open(tmp, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["code", "name", "source"], quoting=csv.QUOTE_ALL, lineterminator="\r\n")
        w.writeheader()
        for r in rows:
            w.writerow({"code": r["code"], "name": r.get("name", ""), "source": r.get("source", "")})
    os.replace(tmp, path)


def sync_before_fetch(target_codes_path: Path, db_path: Path = DEFAULT_DB_PATH, auto_import: bool = True) -> dict:
    summary = {"target_in": 0, "registered_daily": 0, "deactivated_05": [], "appended_from_registry": [], "target_out": 0,
               "daily_total": 0, "on_demand_total": 0, "inactive_total": 0}
    rows = read_target_codes(target_codes_path)
    summary["target_in"] = len(rows)
    if not rows:
        raise RuntimeError(f"target_codes.csv is empty: {target_codes_path}")

    with Registry(db_path) as reg:
        if auto_import and not reg.list_stocks():
            # レジストリが空(初回)なら既存05データから初期登録する(非破壊)
            imp = reg.import_existing(target_codes_path=target_codes_path)
            write_run_log(f"registry initialized from existing data: {json.dumps(imp, ensure_ascii=False)}")

        codes_in_target: list[str] = []
        for r in rows:
            try:
                code = normalize_code(r["code"])
            except ValueError:
                write_run_log(f"skip invalid code in target_codes: {r['code']!r}")
                continue
            codes_in_target.append(code)
            reg.set_usage(code, DAILY_PROJECT, active=True, mode="daily",
                          reason=SOURCE_REASON.get(r["source"], r["source"] or "04_follow_candidates"), name=r["name"])
            summary["registered_daily"] += 1

        # 今回の target に無い 05 daily 利用は inactive(RAW・他Project利用は保持)
        summary["deactivated_05"] = reg.deactivate_project_except(DAILY_PROJECT, codes_in_target, reason="not_in_target_codes_today")

        # レジストリ由来の daily(pinned / 他Projectのdaily要求)を target_codes.csv へ追記
        target_set = set(codes_in_target)
        appended = []
        for st in reg.list_stocks("daily"):
            if st["code"] in target_set:
                continue
            rows.append({"code": st["code"], "name": st.get("name") or "", "source": "registry"})
            appended.append(st["code"])
        if appended:
            # 既存行の source 列が無い場合(04ハンドオフ直後)も揃える
            write_target_codes(target_codes_path, rows)
        summary["appended_from_registry"] = appended
        summary["target_out"] = len(rows)
        summary["daily_total"] = len(reg.daily_codes())
        summary["on_demand_total"] = len(reg.list_stocks("on_demand"))
        summary["inactive_total"] = len(reg.list_stocks("inactive"))
        reg.log(DAILY_PROJECT, "", "", "daily_sync_before_fetch", "ok", json.dumps(summary, ensure_ascii=False))
        reg.export_view()
    write_run_log(f"daily sync before fetch: {json.dumps(summary, ensure_ascii=False)}")
    return summary


def sync_after_fetch(fetch_status_path: Path, db_path: Path = DEFAULT_DB_PATH) -> dict:
    summary = {"rows": 0, "success": 0, "other": 0}
    with Registry(db_path) as reg, open(fetch_status_path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            code = (row.get("code") or "").strip()
            if not code or not CODE_RE.match(code):
                continue
            summary["rows"] += 1
            st = (row.get("fetch_status") or "").strip()
            if st == "success":
                reg.refresh_raw_presence(code)
                reg.update_fetch_result(code, status="success", fetched_at=(row.get("fetched_at") or "").strip(),
                                        data_as_of=(row.get("data_as_of") or "").strip(), project=DAILY_PROJECT, run_id="daily")
                if row.get("name"):
                    reg.ensure_stock(code, row["name"].strip())
                summary["success"] += 1
            else:
                reg.update_fetch_result(code, status=st or "error",
                                        error=f"{row.get('error_type', '')}: {row.get('error_message', '')}".strip(": "),
                                        project=DAILY_PROJECT, run_id="daily")
                summary["other"] += 1
        reg.log(DAILY_PROJECT, "", "daily", "daily_sync_after_fetch", "ok", json.dumps(summary, ensure_ascii=False))
        reg.export_view()
    write_run_log(f"daily sync after fetch: {json.dumps(summary, ensure_ascii=False)}")
    return summary


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="05 日次 ↔ レジストリ互換同期")
    ap.add_argument("--db", default=str(DEFAULT_DB_PATH))
    ap.add_argument("--target-codes", default=str(TARGET_CODES_PATH))
    ap.add_argument("--fetch-status", default=str(FETCH_STATUS_PATH))
    ap.add_argument("--after-fetch", action="store_true")
    args = ap.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    try:
        if args.after_fetch:
            out = sync_after_fetch(Path(args.fetch_status), Path(args.db))
        else:
            out = sync_before_fetch(Path(args.target_codes), Path(args.db))
        print(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception as e:  # noqa: BLE001
        write_run_log(f"daily sync FAILED (non-fatal for pipeline): {type(e).__name__}: {e}")
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
