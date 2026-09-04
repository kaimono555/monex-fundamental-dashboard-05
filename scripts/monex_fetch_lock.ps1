# monex_fetch_lock.ps1
# 05専用Chromeプロファイル(monex-login-profile / CDP:9222)への取得処理を直列化するロック。
# scripts/monex_fetch_lock.py と同じファイル(data/locks/monex_fetch.lock)・同じプロトコル
# (排他作成 + JSON {pid, owner, started_at} + 保持PID死亡/3時間超で stale 判定)。
# fetch_target_financials.ps1 から dot-source して使う。
#
#   . (Join-Path $PSScriptRoot "monex_fetch_lock.ps1")
#   $lock = Acquire-MonexFetchLock -Owner "05_daily" -WaitSec 900
#   try { ... } finally { Release-MonexFetchLock $lock }

$script:MonexFetchLockStaleAfterSec = 3 * 60 * 60

function Get-MonexFetchLockPath {
    param([string]$ProjectRoot)
    if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
        $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    }
    return (Join-Path $ProjectRoot "data\locks\monex_fetch.lock")
}

function Read-MonexFetchLock {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
        return ($raw | ConvertFrom-Json)
    } catch {
        return [pscustomobject]@{ pid = 0; owner = "unreadable"; started_at = "" }
    }
}

function Test-MonexFetchLockStale {
    param($Info)
    if ($null -eq $Info) { return $true }
    $lockPid = 0
    try { $lockPid = [int]$Info.pid } catch { $lockPid = 0 }
    if ($lockPid -le 0) { return $true }
    $proc = Get-Process -Id $lockPid -ErrorAction SilentlyContinue
    if ($null -eq $proc) { return $true }
    try {
        $started = [datetime]::ParseExact([string]$Info.started_at, "yyyy-MM-dd HH:mm:ss", $null)
        if (((Get-Date) - $started).TotalSeconds -gt $script:MonexFetchLockStaleAfterSec) { return $true }
    } catch { }
    return $false
}

function Acquire-MonexFetchLock {
    param(
        [string]$Owner = "05_daily",
        [int]$WaitSec = 900,
        [int]$PollSec = 2,
        [string]$Path = ""
    )
    if ([string]::IsNullOrWhiteSpace($Path)) { $Path = Get-MonexFetchLockPath }
    $dir = Split-Path $Path -Parent
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    $payload = @{ pid = $PID; owner = $Owner; started_at = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss") } | ConvertTo-Json -Compress
    $deadline = (Get-Date).AddSeconds($WaitSec)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $announced = $false
    while ($true) {
        try {
            # FileMode.CreateNew = 排他作成(既存なら IOException)
            $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            try {
                $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
                $fs.Write($bytes, 0, $bytes.Length)
            } finally { $fs.Dispose() }
            return [pscustomobject]@{ Path = $Path; Pid = $PID; Owner = $Owner; WaitedSec = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
        } catch [System.IO.IOException] {
            $info = Read-MonexFetchLock -Path $Path
            if (Test-MonexFetchLockStale -Info $info) {
                try { Remove-Item -LiteralPath $Path -Force -ErrorAction Stop } catch { }
                continue
            }
            if (-not $announced) {
                Write-Host "  [lock] 05取得ロックが使用中のため待機します(holder=$($info.owner) pid=$($info.pid) since=$($info.started_at))" -ForegroundColor Yellow
                $announced = $true
            }
            if ((Get-Date) -ge $deadline) {
                throw "monex fetch lock busy: holder=$($info.owner) pid=$($info.pid) since=$($info.started_at) waited=$([int]$sw.Elapsed.TotalSeconds)s path=$Path"
            }
            Start-Sleep -Seconds $PollSec
        }
    }
}

function Release-MonexFetchLock {
    param($Lock)
    if ($null -eq $Lock) { return }
    try {
        $info = Read-MonexFetchLock -Path $Lock.Path
        if ($null -ne $info -and [int]$info.pid -eq $PID) {
            Remove-Item -LiteralPath $Lock.Path -Force -ErrorAction Stop
        }
    } catch { }
}
