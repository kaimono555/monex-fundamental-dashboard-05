#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
取得済み Monex 財務RAW(data/raw/{code}.txt|.html)を、既存05パーサで「その1銘柄だけ」解析する薄いラッパー。

背景(2026-09-05):
  05日次(fetch_target_financials.ps1)は取得直後に parse_financials.ps1 / parse_financials_extended.ps1 を
  呼ぶが、共通RAW取得センター経由(request_monex_raw.py: 111/109/104-3 からの on-demand 要求)には
  解析工程が無く、RAW取得成功でも data/output/{code}_financials.csv が生成されず、05詳細画面が
  「データが見つかりません」になっていた(例: 4275 カーリット)。

設計原則:
  * 解析ロジックは複製しない。既存の parse_financials.ps1 / parse_financials_extended.ps1 を
    fetch_target_financials.ps1 と同じ引数で subprocess 実行するだけ。
  * 「解析する」≠「毎日取得する」≠「05ランキング対象にする」。
    このモジュールは registry(stocks / project_usage / fetch_log)・target_codes.csv・
    fundamentals.csv・fundamental_scores.csv を一切書き換えない(registry は backfill 候補抽出の読み取りのみ)。
  * 解析状態は data/parse_status.csv で管理する(SQLite schema は変更しない)。
  * 出力は一時ディレクトリ(data/tmp_parse/)へ書かせてから os.replace で正本へ原子的に置換する。
    → 既存パーサ本体(Export-Csv 直書き)を変更せずに、ビューアが書き込み途中のCSVを読む事故を防ぐ。
    パーサ失敗時は正本(前回CSV)を一切触らない。
  * 同一銘柄の多重解析防止: 銘柄単位ロック(data/locks/parse_{code}.lock、monex_fetch_lock と同一プロトコル)
    を取り、ロック取得後に raw_hash と parse_status.csv で再判定する。
  * 対象は page_type=zaimu の財務RAWのみ。topix_news(data/raw_topix)は対象外。

使い方:
  python scripts/parse_monex_raw.py --codes 4275,4568            # 指定銘柄(既存RAWから。Monexへはアクセスしない)
  python scripts/parse_monex_raw.py --backfill [--dry-run]        # registry登録済み・正常zaimu RAWあり・05解析なし の銘柄だけ
  python scripts/parse_monex_raw.py --codes 4275 --force          # 解析済みでも再解析
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from monex_fetch_lock import LockTimeout, MonexFetchLock  # noqa: E402
from monex_registry import CODE_RE, Registry, normalize_code, sha256_file  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = PROJECT_ROOT / "scripts"
DATA_DIR = PROJECT_ROOT / "data"
LOGS_DIR = PROJECT_ROOT / "logs"
RAW_DIR = DATA_DIR / "raw"
OUTPUT_DIR = DATA_DIR / "output"
EXTENDED_DIR = DATA_DIR / "output_extended"
TMP_PARSE_DIR = DATA_DIR / "tmp_parse"
LOCK_DIR = DATA_DIR / "locks"
PARSE_STATUS_CSV = DATA_DIR / "parse_status.csv"
PARSE_LOG = LOGS_DIR / "run_log_ondemand.txt"
PARSE_PS1 = SCRIPTS_DIR / "parse_financials.ps1"
PARSE_EXT_PS1 = SCRIPTS_DIR / "parse_financials_extended.ps1"

STATUS_COLS = ["code", "status", "parsed_at", "raw_hash", "financials_rows", "extended_status", "error", "source"]


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _log(msg: str, log_path: Optional[Path] = None) -> None:
    p = log_path or PARSE_LOG
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a", encoding="utf-8") as f:
            f.write(f"[{now_str()}] {msg}\n")
    except OSError:
        pass


# ---------------------------------------------------------------------- parse_status.csv

def read_parse_status(path: Optional[Path] = None) -> dict[str, dict]:
    p = path or PARSE_STATUS_CSV
    if not p.is_file():
        return {}
    out: dict[str, dict] = {}
    with open(p, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            code = (row.get("code") or "").strip().upper()
            if code:
                out[code] = {c: (row.get(c) or "") for c in STATUS_COLS}
    return out


def _write_parse_status(rows: dict[str, dict], path: Optional[Path] = None) -> None:
    p = path or PARSE_STATUS_CSV
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + f".tmp{os.getpid()}")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=STATUS_COLS, lineterminator="\n")
        w.writeheader()
        for code in sorted(rows):
            w.writerow({c: rows[code].get(c, "") for c in STATUS_COLS})
    os.replace(tmp, p)


def record_parse_status(code: str, *, status: str, raw_hash: str = "", financials_rows: str | int = "",
                        extended_status: str = "", error: str = "", source: str = "", path: Optional[Path] = None) -> dict:
    """1銘柄分の解析状態を parse_status.csv へマージ保存する(原子的置換)。"""
    code = normalize_code(code)
    rows = read_parse_status(path)
    rows[code] = {"code": code, "status": status, "parsed_at": now_str(), "raw_hash": raw_hash,
                  "financials_rows": str(financials_rows), "extended_status": extended_status,
                  "error": (error or "")[:500], "source": source}
    _write_parse_status(rows, path)
    return rows[code]


# ---------------------------------------------------------------------- 判定

def financials_csv_path(code: str, output_dir: Optional[Path] = None) -> Path:
    return (output_dir or OUTPUT_DIR) / f"{code}_financials.csv"


def is_parsed(code: str, raw_hash: str = "", *, raw_dir: Optional[Path] = None, output_dir: Optional[Path] = None,
              status_path: Optional[Path] = None) -> bool:
    """この銘柄の 05 銘柄別解析データが「現在のRAWに対して」存在するか。
    - {code}_financials.csv が無ければ False
    - parse_status.csv に status=success かつ同じ raw_hash の記録があれば True(本ラッパー経由の解析)
    - それ以外は CSV の更新時刻 >= RAW(.txt) の更新時刻なら True(05日次で解析済み)"""
    code = normalize_code(code)
    fin = financials_csv_path(code, output_dir)
    if not fin.is_file():
        return False
    row = read_parse_status(status_path).get(code)
    if row and row.get("status") == "success" and raw_hash and row.get("raw_hash") == raw_hash:
        return True
    txt = (raw_dir or RAW_DIR) / f"{code}.txt"
    if not txt.is_file():
        return True  # RAWが無いのにCSVがある(手動貼付等)場合は解析対象外 = 済み扱い
    return fin.stat().st_mtime >= txt.stat().st_mtime


# ---------------------------------------------------------------------- 実行

def run_powershell_parsers(code: str, raw_dir: Path, out_dir: Path, ext_dir: Path, log_path: Path) -> dict:
    """既存パーサを fetch_target_financials.ps1 と同じ引数で実行する(唯一の実行経路)。
    戻り値: {"rc": 通期パーサ終了コード, "ext_rc": 拡張パーサ終了コード(通期失敗時は None), "stderr": ...}"""
    base = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]
    cmd = base + [str(PARSE_PS1), "-BCode", code, "-RawDir", str(raw_dir), "-OutputDir", str(out_dir), "-LogPath", str(log_path)]
    try:
        p = subprocess.run(cmd, cwd=str(PROJECT_ROOT), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
        rc = p.returncode
        err = (p.stderr or "")[:500]
    except (subprocess.TimeoutExpired, OSError) as e:
        return {"rc": 1, "ext_rc": None, "stderr": f"{type(e).__name__}: {e}"}
    if rc != 0:
        return {"rc": rc, "ext_rc": None, "stderr": err}
    cmd2 = base + [str(PARSE_EXT_PS1), "-BCode", code, "-RawDir", str(raw_dir), "-OutputDir", str(ext_dir),
                   "-LogPath", str(log_path.with_name("run_log_extended.txt")), "-DataAsOf", now_str()]
    try:
        p2 = subprocess.run(cmd2, cwd=str(PROJECT_ROOT), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
        ext_rc: Optional[int] = p2.returncode
    except (subprocess.TimeoutExpired, OSError):
        ext_rc = 1
    return {"rc": 0, "ext_rc": ext_rc, "stderr": err}


DEFAULT_RUNNER: Callable[..., dict] = run_powershell_parsers


def _atomic_replace(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + f".tmp{os.getpid()}")
    shutil.copyfile(src, tmp)
    os.replace(tmp, dst)


def _count_csv_rows(p: Path) -> int:
    with open(p, encoding="utf-8-sig", newline="") as f:
        return max(0, sum(1 for _ in csv.reader(f)) - 1)


def parse_zaimu_raw(code: str, *, raw_dir: Optional[Path] = None, output_dir: Optional[Path] = None,
                    extended_dir: Optional[Path] = None, runner: Optional[Callable[..., dict]] = None,
                    source: str = "manual", log_path: Optional[Path] = None, lock_wait_sec: int = 120,
                    force: bool = False, status_path: Optional[Path] = None) -> dict:
    """既存RAWからその1銘柄だけ解析し、成功時のみ正本(data/output, data/output_extended)へ原子的に反映する。
    Monexへはアクセスしない。registry / target_codes.csv / fundamentals.csv / fundamental_scores.csv は変更しない。
    戻り値 status: "exists"(現在のRAWに対する解析済みデータあり・再解析なし) / "parsed" / "error" / "raw_missing" / "lock_timeout"
    """
    raw_dir = raw_dir or RAW_DIR
    output_dir = output_dir or OUTPUT_DIR
    extended_dir = extended_dir or EXTENDED_DIR
    log_path = log_path or PARSE_LOG
    run = runner or DEFAULT_RUNNER
    code = normalize_code(code)
    r = {"code": code, "status": "", "raw_hash": "", "financials_csv": "", "financials_rows": 0,
         "extended_status": "", "error": "", "source": source, "parsed_at": ""}
    txt = raw_dir / f"{code}.txt"
    if not txt.is_file():
        r.update(status="raw_missing", error=f"raw text not found: {txt}")
        return r
    raw_hash = sha256_file(txt)
    r["raw_hash"] = raw_hash
    lock_path = LOCK_DIR / f"parse_{code}.lock"
    try:
        with MonexFetchLock(owner=f"parse_monex_raw:{source}", wait_sec=lock_wait_sec, poll_sec=0.5, path=lock_path):
            # ロック取得後に再判定: 直前に別要求(111/109/104-3同時要求等)が同じRAWを解析済みなら二重実行しない
            if not force and is_parsed(code, raw_hash, raw_dir=raw_dir, output_dir=output_dir, status_path=status_path):
                r.update(status="exists", financials_csv=str(financials_csv_path(code, output_dir)))
                return r
            tmp = TMP_PARSE_DIR / f"{code}_{os.getpid()}_{time.time_ns()}"
            tmp_out, tmp_ext = tmp / "output", tmp / "output_extended"
            tmp_out.mkdir(parents=True, exist_ok=True)
            tmp_ext.mkdir(parents=True, exist_ok=True)
            try:
                _log(f"parse start code={code} source={source} raw_hash={raw_hash[:23]}", log_path)
                res = run(code, raw_dir, tmp_out, tmp_ext, log_path)
                fin_tmp = tmp_out / f"{code}_financials.csv"
                if int(res.get("rc", 1)) != 0 or not fin_tmp.is_file():
                    err = f"parse_financials failed rc={res.get('rc')} {res.get('stderr', '')}".strip()
                    r.update(status="error", error=err)
                    record_parse_status(code, status="error", raw_hash=raw_hash, error=err, source=source, path=status_path)
                    _log(f"parse FAILED code={code} (existing output kept) error={err}", log_path)
                    return r
                # 成功: 通期CSV → 正本へ原子的置換。拡張CSVは生成できた分だけ反映(既存と同じ非致命扱い)。
                _atomic_replace(fin_tmp, financials_csv_path(code, output_dir))
                promoted_ext = 0
                for p in sorted(tmp_ext.glob(f"{code}_*.csv")):
                    _atomic_replace(p, extended_dir / p.name)
                    promoted_ext += 1
                ext_rc = res.get("ext_rc")
                ext_status = "success" if ext_rc == 0 else ("partial" if promoted_ext else "failed")
                rows = _count_csv_rows(financials_csv_path(code, output_dir))
                st = record_parse_status(code, status="success", raw_hash=raw_hash, financials_rows=rows,
                                         extended_status=ext_status, source=source, path=status_path)
                r.update(status="parsed", financials_csv=str(financials_csv_path(code, output_dir)), financials_rows=rows,
                         extended_status=ext_status, parsed_at=st["parsed_at"])
                _log(f"parse OK code={code} rows={rows} extended={ext_status}({promoted_ext} files)", log_path)
                return r
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
    except LockTimeout as e:
        r.update(status="lock_timeout", error=str(e))
        _log(f"parse lock timeout code={code}: {e}", log_path)
        return r


# ---------------------------------------------------------------------- backfill

def backfill_candidates(*, db_path: Optional[Path] = None, raw_dir: Optional[Path] = None, output_dir: Optional[Path] = None,
                        status_path: Optional[Path] = None, validate: Optional[Callable[[str, Path, Optional[Path]], dict]] = None) -> dict:
    """registry登録済み・fetch_status=success・raw_present=1・正常zaimu RAWあり・05解析なし の銘柄を抽出する(読み取りのみ)。
    registry未登録の孤立RAW(data/raw にあるが stocks に無い)は対象外として別枠で返す(登録も削除もしない)。"""
    raw_dir = raw_dir or RAW_DIR
    if validate is None:
        from request_monex_raw import run_validate  # 遅延import(循環回避)
        validate = lambda c, t, h: run_validate(c, t, h)  # noqa: E731
    out = {"registered_raw_ok": [], "already_parsed": [], "need_parse": [], "invalid_raw": [], "orphan_raw": [], "not_success": []}
    with Registry(db_path) as reg:  # 読み取りのみ(stocks/project_usage/fetch_log は書かない)
        stocks = reg.list_stocks()
    registered = {s["code"] for s in stocks}
    for s in stocks:
        code = s["code"]
        txt = raw_dir / f"{code}.txt"
        if not (s.get("raw_present") and txt.is_file()):
            continue
        if s.get("fetch_status") != "success":
            out["not_success"].append({"code": code, "fetch_status": s.get("fetch_status")})
            continue
        html = raw_dir / f"{code}.html"
        v = validate(code, txt, html if html.is_file() else None)
        if not v.get("ok"):
            out["invalid_raw"].append({"code": code, "reason": v.get("reason", "")})
            continue
        out["registered_raw_ok"].append(code)
        if is_parsed(code, sha256_file(txt), raw_dir=raw_dir, output_dir=output_dir, status_path=status_path):
            out["already_parsed"].append(code)
        else:
            out["need_parse"].append({"code": code, "name": v.get("stock_name") or s.get("name") or "",
                                      "effective_update_mode": s.get("effective_update_mode")})
    for p in sorted(raw_dir.glob("*.txt")):
        if CODE_RE.match(p.stem) and p.stem not in registered:
            out["orphan_raw"].append(p.stem)
    return out


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="取得済みMonex財務RAWを既存05パーサで1銘柄ずつ解析する(Monexへはアクセスしない)")
    ap.add_argument("--codes", default="", help="カンマ区切りの証券コード")
    ap.add_argument("--backfill", action="store_true", help="registry登録済み・正常zaimu RAWあり・05解析なし の銘柄をすべて解析")
    ap.add_argument("--dry-run", action="store_true", help="対象の抽出だけ行い解析しない")
    ap.add_argument("--force", action="store_true", help="解析済みでも再解析する")
    ap.add_argument("--source", default="manual")
    ap.add_argument("--json-out", default="")
    ap.add_argument("--db", default=os.environ.get("MONEX_REGISTRY_DB", ""), help="registry DB(テスト用。通常は省略)")
    args = ap.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

    db_path = Path(args.db) if args.db else None
    result: dict = {"started_at": now_str(), "results": []}
    codes: list[str] = []
    if args.backfill:
        cand = backfill_candidates(db_path=db_path)
        result["backfill"] = {k: cand[k] for k in cand}
        codes = [c["code"] for c in cand["need_parse"]]
    if args.codes:
        for c in args.codes.split(","):
            c = c.strip()
            if c and c not in codes:
                codes.append(c)
    result["target_codes"] = codes
    if not args.dry_run:
        for c in codes:
            try:
                result["results"].append(parse_zaimu_raw(c, source=args.source, force=args.force))
            except ValueError as e:
                result["results"].append({"code": c, "status": "error", "error": str(e)})
    result["summary"] = {}
    for r in result["results"]:
        result["summary"][r["status"]] = result["summary"].get(r["status"], 0) + 1
    result["ended_at"] = now_str()
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.json_out:
        Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json_out).write_text(text, encoding="utf-8")
    print(text)
    return 0 if all(r["status"] in ("parsed", "exists") for r in result["results"]) else 2


if __name__ == "__main__":
    sys.exit(main())
