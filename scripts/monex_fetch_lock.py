#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
05専用Chromeプロファイル(monex-login-profile / CDP:9222)に対する取得処理の直列化ロック。

- 05日次(fetch_target_financials.ps1)・on-demand取得(request_monex_raw.py)・109向けニュース取得は
  すべてこのロックを取ってからブラウザに触る。同じプロファイルを複数Playwrightが同時に開く事故を防ぐ。
- ロック = data/locks/monex_fetch.lock を排他作成(O_EXCL)。中身はJSON {pid, owner, started_at}。
- 保持プロセスが生存していなければ stale と判定して奪取する(クラッシュ後の永久ロック防止)。
- PowerShell版(scripts/monex_fetch_lock.ps1)と同じファイル・同じプロトコル。

使い方(Python):
    from monex_fetch_lock import MonexFetchLock
    with MonexFetchLock(owner="request_monex_raw:111", wait_sec=900):
        ...
CLI(検証用):
    python scripts/monex_fetch_lock.py status
"""
from __future__ import annotations

import ctypes
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

PROJECT_ROOT = Path(__file__).resolve().parents[1]
LOCK_DIR = PROJECT_ROOT / "data" / "locks"
LOCK_PATH = LOCK_DIR / "monex_fetch.lock"
STALE_AFTER_SEC = 3 * 60 * 60  # 生存PIDでも3時間を超えたら異常とみなして奪取(通常の05日次は約10分)


class LockTimeout(RuntimeError):
    pass


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        k32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return False
        try:
            code = ctypes.c_ulong()
            if not k32.GetExitCodeProcess(h, ctypes.byref(code)):
                return False
            return code.value == STILL_ACTIVE
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def read_lock(path: Path = LOCK_PATH) -> Optional[dict]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None if not path.exists() else {"pid": 0, "owner": "unreadable", "started_at": ""}


def is_stale(info: Optional[dict]) -> bool:
    if info is None:
        return True
    pid = int(info.get("pid") or 0)
    if not pid_alive(pid):
        return True
    try:
        started = datetime.strptime(info.get("started_at", ""), "%Y-%m-%d %H:%M:%S")
        if (datetime.now() - started).total_seconds() > STALE_AFTER_SEC:
            return True
    except ValueError:
        pass
    return False


class MonexFetchLock:
    def __init__(self, owner: str, wait_sec: int = 900, poll_sec: float = 2.0, path: Path = LOCK_PATH):
        self.owner = owner
        self.wait_sec = wait_sec
        self.poll_sec = poll_sec
        self.path = Path(path)
        self.acquired = False
        self.waited_sec = 0.0

    def acquire(self) -> "MonexFetchLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + self.wait_sec
        t0 = time.monotonic()
        payload = json.dumps({"pid": os.getpid(), "owner": self.owner,
                              "started_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}, ensure_ascii=False)
        while True:
            try:
                fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(payload)
                self.acquired = True
                self.waited_sec = round(time.monotonic() - t0, 1)
                return self
            except FileExistsError:
                info = read_lock(self.path)
                if is_stale(info):
                    try:
                        self.path.unlink()
                    except OSError:
                        pass
                    continue
                if time.monotonic() >= deadline:
                    raise LockTimeout(
                        f"monex fetch lock busy: holder={info} waited={int(time.monotonic() - t0)}s path={self.path}")
                time.sleep(self.poll_sec)

    def release(self) -> None:
        if not self.acquired:
            return
        try:
            info = read_lock(self.path)
            if info and int(info.get("pid") or 0) == os.getpid():
                self.path.unlink()
        except OSError:
            pass
        self.acquired = False

    def __enter__(self) -> "MonexFetchLock":
        return self.acquire()

    def __exit__(self, *exc) -> None:
        self.release()


def main(argv: Optional[list[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    cmd = argv[0] if argv else "status"
    if cmd == "status":
        info = read_lock()
        print(json.dumps({"path": str(LOCK_PATH), "exists": LOCK_PATH.exists(), "info": info,
                          "stale": is_stale(info) if info else None}, ensure_ascii=False, indent=2))
        return 0
    if cmd == "clear-stale":
        info = read_lock()
        if info and is_stale(info):
            LOCK_PATH.unlink(missing_ok=True)
            print("stale lock removed")
        else:
            print("no stale lock")
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main())
