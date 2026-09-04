#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
05 共通「銘柄スカウターRAW取得センター」の要求入口。

109 / 104-3 / 111 は自分でマネックス銘柄スカウターを取得せず、このスクリプトへ
「この銘柄のRAWが必要」と依頼する。マネックスへのログイン・ブラウザ操作・RAW取得・
レジストリ更新は05がここで一元管理する。

基本フロー:
  1. レジストリに Project 利用状態を登録(デフォルト on_demand。依頼だけで daily に昇格させない)
  2. 既存RAW(data/raw/{code}.txt)の有無・鮮度(max_age_hours)・本文検証
  3. 十分新しいRAWがあれば再取得せずそのまま返す(status=fresh)
  4. 無い/古い銘柄だけ、05専用プロファイル(CDP:9222)で既存の取得処理
     (playwright_batch_fetch_financials.js)を実行。ロック(monex_fetch_lock)で直列化
  5. 取得結果は一時ディレクトリ(data/tmp_fetch/{run_id}/)へ保存し、
     validate_monex_raw.js(認証エラー/銘柄コード一致/財務マーカー/本文長)を通過したものだけ
     data/raw/{code}.txt|.html へ原子的に昇格(status=fetched)
  6. 失敗時は前回正常RAWを一切触らず、registry の fetch_status=error / last_error のみ更新
  7. 結果JSONを標準出力へ返す

ページ種別(--page-type):
  zaimu      : 財務ページ(sa=report_zaimu)。05日次と同じRAW。既定。
  topix_news : 業績ニュースページ(sa=report_topix)。109向け。data/raw_topix/{code}.* と
               {code}_news.json(ヘッダー指標+ニュース行)を保存。

使い方:
  python scripts/request_monex_raw.py --project 111 --codes 5803,4062 --reason theme_analysis \
      --run-id 2026-09-04_theme --max-age-hours 24
  終了コード: 0=全件OK(fresh/fetched) / 2=一部または全部失敗 / 3=ログイン更新が必要 / 4=ロック待ちタイムアウト / 1=致命的エラー

Python から:
  from request_monex_raw import request_raw
  result = request_raw(project="111", codes=["5803"], reason="...", run_id="...")
"""
from __future__ import annotations

import argparse
import hashlib
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
from monex_registry import CODE_RE, RAW_DIR, Registry, normalize_code, sha256_file  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = PROJECT_ROOT / "scripts"
DATA_DIR = PROJECT_ROOT / "data"
LOGS_DIR = PROJECT_ROOT / "logs"
TMP_FETCH_DIR = DATA_DIR / "tmp_fetch"
RAW_TOPIX_DIR = DATA_DIR / "raw_topix"
SHARED_RAW_ROOT = PROJECT_ROOT.parent / "_shared_monex_raw"
USER_DATA_DIR = DATA_DIR / "playwright-profile" / "monex-login-profile"
BATCH_FETCH_JS = SCRIPTS_DIR / "playwright_batch_fetch_financials.js"
TOPIX_FETCH_JS = SCRIPTS_DIR / "playwright_fetch_monex_topix_news.js"
VALIDATE_JS = SCRIPTS_DIR / "validate_monex_raw.js"
REQUEST_LOG = LOGS_DIR / "request_monex_raw.log"
ONDEMAND_RUN_LOG = LOGS_DIR / "run_log_ondemand.txt"

PAGE_TYPES = ("zaimu", "topix_news")
EXIT_OK, EXIT_FATAL, EXIT_PARTIAL, EXIT_LOGIN_REQUIRED, EXIT_LOCK_TIMEOUT = 0, 1, 2, 3, 4


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log(msg: str) -> None:
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    with open(REQUEST_LOG, "a", encoding="utf-8") as f:
        f.write(f"[{now_str()}] {msg}\n")


def find_chrome_executable() -> str:
    """fetch_target_financials.ps1 の Get-ChromeExecutable と同じ探索順(同じChrome本体で同じプロファイルを開く)。"""
    for env in ("ProgramFiles", "ProgramFiles(x86)"):
        base = os.environ.get(env)
        if base:
            p = Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe"
            if p.is_file():
                return str(p)
    return ""


def parse_ts(s: str) -> Optional[datetime]:
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s[:19], fmt)
        except (ValueError, TypeError):
            continue
    return None


def age_hours(ts: Optional[datetime]) -> Optional[float]:
    if ts is None:
        return None
    return round((datetime.now() - ts).total_seconds() / 3600.0, 2)


def run_validate(code: str, text_path: Path, html_path: Optional[Path] = None, min_chars: int = 3000) -> dict:
    cmd = ["node", str(VALIDATE_JS), "--code", code, "--text", str(text_path), "--min-chars", str(min_chars)]
    if html_path and html_path.is_file():
        cmd += ["--html", str(html_path)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=60)
    except (subprocess.TimeoutExpired, OSError) as e:
        return {"code": code, "ok": False, "reason": f"validator_error:{e}"}
    line = (proc.stdout or "").strip().splitlines()
    if not line:
        return {"code": code, "ok": False, "reason": f"validator_no_output rc={proc.returncode} stderr={(proc.stderr or '')[:300]}"}
    try:
        return json.loads(line[-1])
    except json.JSONDecodeError:
        return {"code": code, "ok": False, "reason": f"validator_unparseable:{line[-1][:200]}"}


def atomic_copy(src: Path, dst: Path) -> None:
    """同一ディレクトリ内の一時ファイルへコピーしてから os.replace(原子的置換)。失敗時は dst を触らない。"""
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + f".tmp{os.getpid()}")
    shutil.copyfile(src, tmp)
    os.replace(tmp, dst)


def shared_raw_status(code: str) -> dict:
    d = SHARED_RAW_ROOT / code
    latest = d / "latest.json"
    if not latest.is_file():
        return {"present": False}
    try:
        meta = json.loads(latest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"present": False, "error": "latest_json_unreadable"}
    txt = d / str(meta.get("raw_text_file") or "")
    return {"present": txt.is_file(), "path": str(txt) if txt.is_file() else "", "hash": meta.get("raw_text_hash") or "",
            "captured_at": meta.get("captured_at") or ""}


# ---------------------------------------------------------------------- fetchers

FetcherResult = dict  # {code: {"fetch_status": "success"|"failed", "error_type": str, "error_message": str}}


def default_zaimu_fetcher(codes: list[str], tmp_dir: Path, *, allow_interactive_login: bool = False,
                          log_path: Path = ONDEMAND_RUN_LOG, max_retries: int = 3) -> tuple[int, FetcherResult]:
    """既存 playwright_batch_fetch_financials.js をそのまま使う(raw-dir を一時ディレクトリへ向けるだけ)。
    戻り値: (exit_code, {code: result_row})。exit 3 = ログイン未確立。"""
    raw_dir = tmp_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    results_path = tmp_dir / "fetch_results.csv"
    chrome = find_chrome_executable()
    cmd = ["node", str(BATCH_FETCH_JS),
           "--codes", ",".join(codes),
           "--user-data-dir", str(USER_DATA_DIR),
           "--raw-dir", str(raw_dir),
           "--log-path", str(log_path),
           "--results-path", str(results_path),
           "--max-retries", str(max_retries),
           "--retry-delay-ms", "5000",
           "--request-delay-ms", "1500",
           "--allow-interactive-login", "true" if allow_interactive_login else "false"]
    if chrome:
        cmd += ["--chrome-executable", chrome]
    timeout = 180 + 90 * len(codes) + (300 if allow_interactive_login else 0)
    try:
        proc = subprocess.run(cmd, cwd=str(PROJECT_ROOT), capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=timeout)
        rc = proc.returncode
    except subprocess.TimeoutExpired:
        log(f"zaimu fetcher timeout after {timeout}s codes={codes}")
        rc = 1
    rows: FetcherResult = {}
    if results_path.is_file():
        import csv
        with open(results_path, encoding="utf-8-sig", newline="") as f:
            for row in csv.DictReader(f):
                rows[str(row.get("code") or "").strip().upper()] = row
    return rc, rows


def default_topix_fetcher(codes: list[str], tmp_dir: Path, *, allow_interactive_login: bool = False,
                          log_path: Path = ONDEMAND_RUN_LOG, max_retries: int = 2) -> tuple[int, FetcherResult]:
    out_dir = tmp_dir / "raw_topix"
    out_dir.mkdir(parents=True, exist_ok=True)
    results_path = tmp_dir / "topix_results.json"
    chrome = find_chrome_executable()
    cmd = ["node", str(TOPIX_FETCH_JS),
           "--codes", ",".join(codes),
           "--user-data-dir", str(USER_DATA_DIR),
           "--out-dir", str(out_dir),
           "--log-path", str(log_path),
           "--results-path", str(results_path),
           "--max-retries", str(max_retries)]
    if chrome:
        cmd += ["--chrome-executable", chrome]
    timeout = 180 + 90 * len(codes)
    try:
        proc = subprocess.run(cmd, cwd=str(PROJECT_ROOT), capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=timeout)
        rc = proc.returncode
    except subprocess.TimeoutExpired:
        log(f"topix fetcher timeout after {timeout}s codes={codes}")
        rc = 1
    rows: FetcherResult = {}
    if results_path.is_file():
        try:
            data = json.loads(results_path.read_text(encoding="utf-8"))
            for r in data.get("results", []):
                rows[str(r.get("code") or "").upper()] = r
        except (OSError, json.JSONDecodeError):
            pass
    return rc, rows


# ---------------------------------------------------------------------- core

def _existing_raw_info(code: str, page_type: str) -> tuple[Optional[Path], Optional[Path], Optional[datetime]]:
    if page_type == "zaimu":
        txt, html = RAW_DIR / f"{code}.txt", RAW_DIR / f"{code}.html"
    else:
        txt, html = RAW_TOPIX_DIR / f"{code}.txt", RAW_TOPIX_DIR / f"{code}.html"
    if not txt.is_file():
        return None, None, None
    return txt, (html if html.is_file() else None), datetime.fromtimestamp(txt.stat().st_mtime)


def _topix_news_json(code: str) -> Path:
    return RAW_TOPIX_DIR / f"{code}_news.json"


def _mark_if_fresh(reg: Registry, project: str, run_id: str, code: str, page_type: str, max_age_hours: float, r: dict) -> bool:
    """既存RAWが十分新しく本文検証も通るなら r を status=fresh で埋めて True。max_age_hours<=0 は常に再取得。"""
    if max_age_hours <= 0:
        return False
    st = reg.get_stock(code) or {}
    txt, html, mtime = _existing_raw_info(code, page_type)
    if txt is None:
        return False
    if page_type == "zaimu":
        last_fetch = parse_ts(st.get("last_fetch") or "") or mtime
    else:
        last_fetch = mtime
        nj = _topix_news_json(code)
        if nj.is_file():
            try:
                last_fetch = parse_ts(json.loads(nj.read_text(encoding="utf-8")).get("fetched_at", "")) or mtime
            except (OSError, json.JSONDecodeError, AttributeError):
                pass
    ah = age_hours(last_fetch)
    if ah is None or ah > max_age_hours:
        return False
    if page_type == "zaimu":
        v = run_validate(code, txt, html)
    else:
        v = {"ok": _topix_news_json(code).is_file(), "reason": "news_json_missing"}
    if not v.get("ok"):
        log(f"existing raw for {code} failed validation ({v.get('reason')}); will refetch")
        return False
    r.update(status="fresh", raw_path=str(txt), raw_html_path=str(html or ""), fetched_at=last_fetch.strftime("%Y-%m-%d %H:%M:%S"),
             age_hours=ah, source="existing_raw", raw_hash=sha256_file(txt),
             stock_name=v.get("stock_name") or r.get("stock_name") or "", latest_period_in_raw=v.get("latest_period_in_raw", ""),
             monex_data_updated_at=v.get("monex_data_updated_at", ""))
    if page_type == "zaimu":
        r["shared_raw_path"] = shared_raw_status(code).get("path", "")
    else:
        r["news_json_path"] = str(_topix_news_json(code))
    reg.log(project, code, run_id, f"request_{page_type}", "fresh", f"age_hours={ah}")
    return True


def request_raw(project: str, codes: list[str], *, reason: str = "", run_id: str = "", max_age_hours: float = 24.0,
                mode: str = "on_demand", page_type: str = "zaimu", allow_fetch: bool = True,
                allow_interactive_login: bool = False, lock_wait_sec: int = 900, db_path: Optional[Path] = None,
                fetcher: Optional[Callable[..., tuple[int, FetcherResult]]] = None, keep_tmp: bool = False,
                register_usage: bool = True) -> dict:
    if page_type not in PAGE_TYPES:
        raise ValueError(f"invalid page_type: {page_type}")
    if mode not in ("on_demand", "daily"):
        raise ValueError("mode must be on_demand or daily (inactive is set via monex_registry set-usage --inactive)")
    project = str(project or "").strip()
    if not project:
        raise ValueError("project is required")
    run_id = run_id or f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{project}_{page_type}"

    norm: list[str] = []
    invalid: list[str] = []
    for c in codes:
        try:
            nc = normalize_code(c)
        except ValueError:
            invalid.append(str(c))
            continue
        if nc not in norm:
            norm.append(nc)

    out = {"ok": False, "project": project, "run_id": run_id, "page_type": page_type, "mode": mode,
           "max_age_hours": max_age_hours, "requested": norm, "invalid_codes": invalid, "results": [],
           "login_required": False, "lock_wait_sec": 0.0, "started_at": now_str(), "ended_at": "", "exit_code": EXIT_OK}
    log(f"START run_id={run_id} project={project} page_type={page_type} mode={mode} codes={norm} max_age_hours={max_age_hours} reason={reason}")

    reg_kwargs = {"db_path": db_path} if db_path else {}
    with Registry(**reg_kwargs) as reg:
        if not reg.list_stocks() and (DATA_DIR / "target_codes.csv").is_file() and db_path is None:
            # 初回利用: 既存05データ(target_codes / raw / fetch_status)を非破壊で初期登録してから受け付ける
            imp = reg.import_existing()
            log(f"registry initialized from existing 05 data: {json.dumps(imp, ensure_ascii=False)}")
        results: dict[str, dict] = {}
        need_fetch: list[str] = []
        for code in norm:
            if register_usage:
                st = reg.set_usage(code, project, active=True, mode=mode, reason=reason, run_id=run_id)
            else:
                st = reg.ensure_stock(code)
            r = {"code": code, "status": "", "raw_path": "", "raw_html_path": "", "shared_raw_path": "", "news_json_path": "",
                 "fetched_at": "", "raw_hash": "", "age_hours": None, "source": "", "effective_update_mode": st["effective_update_mode"],
                 "stock_name": st.get("name") or "", "latest_period_in_raw": "", "monex_data_updated_at": "", "error": ""}
            results[code] = r
            if _mark_if_fresh(reg, project, run_id, code, page_type, max_age_hours, r):
                continue
            need_fetch.append(code)

        if need_fetch and not allow_fetch:
            for code in need_fetch:
                results[code].update(status="stale_no_fetch", error="fetch disabled (allow_fetch=False)")
                reg.log(project, code, run_id, f"request_{page_type}", "stale_no_fetch", "")
        elif need_fetch:
            fetch_fn = fetcher or (default_zaimu_fetcher if page_type == "zaimu" else default_topix_fetcher)
            tmp_dir = TMP_FETCH_DIR / run_id
            tmp_dir.mkdir(parents=True, exist_ok=True)
            try:
                with MonexFetchLock(owner=f"request_monex_raw:{project}:{run_id}", wait_sec=lock_wait_sec) as lock:
                    out["lock_wait_sec"] = lock.waited_sec
                    # ロック待ちの間に別Projectの要求が同じ銘柄を取得済みなら再取得しない(同一銘柄の二重取得防止)
                    if lock.waited_sec > 0:
                        still = []
                        for code in need_fetch:
                            if _mark_if_fresh(reg, project, run_id, code, page_type, max_age_hours, results[code]):
                                log(f"{code}: became fresh while waiting for lock; skip fetch")
                            else:
                                still.append(code)
                        need_fetch = still
                    log(f"lock acquired waited={lock.waited_sec}s; fetching {need_fetch}")
                    rc, rows = (EXIT_OK, {}) if not need_fetch else fetch_fn(need_fetch, tmp_dir, allow_interactive_login=allow_interactive_login)
                log(f"fetcher exit={rc} rows={len(rows)}")
                if rc == EXIT_LOGIN_REQUIRED:
                    out["login_required"] = True
                for code in need_fetch:
                    r = results[code]
                    row = rows.get(code)
                    if out["login_required"] and (row is None or row.get("fetch_status") != "success"):
                        r.update(status="login_required", error="05専用プロファイルが未ログイン/ログイン切れ。scripts/login_monex_profile_05.ps1 でログイン更新が必要")
                        reg.update_fetch_result(code, status="login_required", error=r["error"], project=project, run_id=run_id)
                        continue
                    if row is None:
                        r.update(status="error", error="fetch result missing (batch stopped early or fetcher crashed)")
                        reg.update_fetch_result(code, status="error", error=r["error"], project=project, run_id=run_id)
                        continue
                    if row.get("fetch_status") != "success":
                        r.update(status="error", error=f"{row.get('error_type', '')}: {row.get('error_message', '')}".strip(": "))
                        reg.update_fetch_result(code, status="error", error=r["error"], project=project, run_id=run_id)
                        continue
                    if page_type == "zaimu":
                        _promote_zaimu(code, tmp_dir, r, reg, project, run_id)
                    else:
                        _promote_topix(code, tmp_dir, r, reg, project, run_id, row)
            except LockTimeout as e:
                log(f"lock timeout: {e}")
                for code in need_fetch:
                    results[code].update(status="lock_timeout", error=str(e))
                out["exit_code"] = EXIT_LOCK_TIMEOUT
            finally:
                if not keep_tmp:
                    shutil.rmtree(tmp_dir, ignore_errors=True)

        try:
            reg.export_view()
        except Exception as e:  # noqa: BLE001 - ビューは補助出力
            log(f"export_view failed: {e}")

    out["results"] = [results[c] for c in norm]
    statuses = {r["status"] for r in out["results"]}
    out["ok"] = bool(norm) and statuses <= {"fresh", "fetched"}
    if out["exit_code"] == EXIT_OK:
        if out["login_required"]:
            out["exit_code"] = EXIT_LOGIN_REQUIRED
        elif not out["ok"]:
            out["exit_code"] = EXIT_PARTIAL
    out["ended_at"] = now_str()
    log(f"END run_id={run_id} ok={out['ok']} exit={out['exit_code']} statuses={[ (r['code'], r['status']) for r in out['results'] ]}")
    return out


def _promote_zaimu(code: str, tmp_dir: Path, r: dict, reg: Registry, project: str, run_id: str) -> None:
    tmp_txt = tmp_dir / "raw" / f"{code}.txt"
    tmp_html = tmp_dir / "raw" / f"{code}.html"
    if not tmp_txt.is_file():
        r.update(status="error", error="temporary raw text missing after fetch")
        reg.update_fetch_result(code, status="error", error=r["error"], project=project, run_id=run_id)
        return
    v = run_validate(code, tmp_txt, tmp_html)
    if not v.get("ok"):
        r.update(status="error", error=f"validation_failed: {v.get('reason')}")
        reg.update_fetch_result(code, status="error", error=r["error"], project=project, run_id=run_id)
        log(f"{code}: validation failed -> last good RAW kept. reason={v.get('reason')}")
        return
    dst_txt = RAW_DIR / f"{code}.txt"
    dst_html = RAW_DIR / f"{code}.html"
    atomic_copy(tmp_txt, dst_txt)
    if tmp_html.is_file():
        atomic_copy(tmp_html, dst_html)
    fetched_at = now_str()
    h = sha256_file(dst_txt)
    sh = shared_raw_status(code)
    if sh.get("present") and sh.get("hash") and sh.get("hash") != h:
        log(f"{code}: WARNING shared raw hash differs from promoted raw (shared={sh.get('hash')[:20]} raw={h[:20]})")
    # data_as_of(通期・パーサ由来)は05日次の fetch_status 同期でのみ更新する。ここではRAW内の最新決算期を結果JSONで返すだけ。
    reg.update_fetch_result(code, status="success", fetched_at=fetched_at, raw_path=dst_txt, raw_html_path=dst_html, raw_hash=h,
                            monex_data_updated_at=v.get("monex_data_updated_at", ""), project=project, run_id=run_id)
    if v.get("stock_name"):
        reg.ensure_stock(code, v["stock_name"])
    r.update(status="fetched", raw_path=str(dst_txt), raw_html_path=str(dst_html) if dst_html.is_file() else "",
             shared_raw_path=sh.get("path", ""), fetched_at=fetched_at, raw_hash=h, age_hours=0.0, source="fetched_now",
             stock_name=v.get("stock_name") or r["stock_name"], latest_period_in_raw=v.get("latest_period_in_raw", ""),
             monex_data_updated_at=v.get("monex_data_updated_at", ""))


def _promote_topix(code: str, tmp_dir: Path, r: dict, reg: Registry, project: str, run_id: str, row: dict) -> None:
    src_dir = tmp_dir / "raw_topix"
    tmp_txt, tmp_html, tmp_json = src_dir / f"{code}.txt", src_dir / f"{code}.html", src_dir / f"{code}_news.json"
    if not (tmp_txt.is_file() and tmp_json.is_file()):
        r.update(status="error", error="temporary topix raw/news json missing after fetch")
        reg.log(project, code, run_id, "fetch_topix", "error", r["error"])
        return
    text = tmp_txt.read_text(encoding="utf-8", errors="replace")
    import re
    if not re.search(rf"(^|\n)\s*{re.escape(code)}\s+\S", text, re.I):
        r.update(status="error", error="validation_failed: code_mismatch (topix)")
        reg.log(project, code, run_id, "fetch_topix", "error", r["error"])
        return
    RAW_TOPIX_DIR.mkdir(parents=True, exist_ok=True)
    atomic_copy(tmp_txt, RAW_TOPIX_DIR / f"{code}.txt")
    if tmp_html.is_file():
        atomic_copy(tmp_html, RAW_TOPIX_DIR / f"{code}.html")
    atomic_copy(tmp_json, _topix_news_json(code))
    fetched_at = now_str()
    h = sha256_file(RAW_TOPIX_DIR / f"{code}.txt")
    reg.log(project, code, run_id, "fetch_topix", "success", f"hash={h} news={row.get('news_count', '')}")
    if row.get("stock_name"):
        reg.ensure_stock(code, row["stock_name"])
    r.update(status="fetched", raw_path=str(RAW_TOPIX_DIR / f"{code}.txt"), raw_html_path=str(RAW_TOPIX_DIR / f"{code}.html"),
             news_json_path=str(_topix_news_json(code)), fetched_at=fetched_at, raw_hash=h, age_hours=0.0, source="fetched_now",
             stock_name=row.get("stock_name") or r["stock_name"], monex_data_updated_at=row.get("monex_data_updated_at", ""))


# ---------------------------------------------------------------------- CLI

def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="05 共通RAW取得センターへの要求入口")
    ap.add_argument("--project", required=True, help="依頼元Project名 (例: 111 / 109 / 104-3 / 05)")
    ap.add_argument("--codes", required=True, help="カンマ区切りの証券コード")
    ap.add_argument("--reason", default="")
    ap.add_argument("--run-id", default="")
    ap.add_argument("--max-age-hours", type=float, default=24.0)
    ap.add_argument("--mode", default="on_demand", choices=("on_demand", "daily"), help="依頼時のデフォルトは on_demand")
    ap.add_argument("--page-type", default="zaimu", choices=PAGE_TYPES)
    ap.add_argument("--no-fetch", action="store_true", help="取得せず既存RAWの確認のみ")
    ap.add_argument("--allow-interactive-login", action="store_true", help="手動実行時のみ: ログイン切れならブラウザで人間のログインを待つ")
    ap.add_argument("--lock-wait-sec", type=int, default=900)
    ap.add_argument("--json-out", default="", help="結果JSONの保存先(省略時は標準出力のみ)")
    ap.add_argument("--keep-tmp", action="store_true")
    ap.add_argument("--db", default="", help="レジストリDBの明示指定(テスト用。通常は省略)")
    args = ap.parse_args(argv)

    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

    codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    try:
        result = request_raw(args.project, codes, reason=args.reason, run_id=args.run_id, max_age_hours=args.max_age_hours,
                             mode=args.mode, page_type=args.page_type, allow_fetch=not args.no_fetch,
                             allow_interactive_login=args.allow_interactive_login, lock_wait_sec=args.lock_wait_sec,
                             keep_tmp=args.keep_tmp, db_path=Path(args.db) if args.db else None)
    except Exception as e:  # noqa: BLE001
        log(f"FATAL {type(e).__name__}: {e}")
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}", "exit_code": EXIT_FATAL}, ensure_ascii=False))
        return EXIT_FATAL
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.json_out:
        p = Path(args.json_out)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    print(text)
    return int(result.get("exit_code", EXIT_FATAL))


if __name__ == "__main__":
    sys.exit(main())
