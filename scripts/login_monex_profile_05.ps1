# login_monex_profile_05.ps1
# 05専用Chromeプロファイル（playwright-profile\monex-login-profile）への
# 手動ログイン更新専用スクリプト。
#
# 必ず人間が直接（ダブルクリック等で）実行すること。
# run_all_04_05_04_06.bat（親バッチ）からは呼び出されない。
# 親バッチ経由の自動実行（update_all_05.ps1）は stdin が NUL にリダイレクトされて
# いるため、Enterキー入力を待つ処理はこのスクリプトでのみ行う設計とする。
#
# 流れ:
#   1. 05専用プロファイルの残存プロセス・ロックファイルを後始末する
#   2. 05専用Chromeでマネックスのトップページを開く
#   3. 人間がブラウザでログインする
#   4. ログイン完了後、このPowerShell画面でEnterを押す
#   5. Enter後、ログイン状態を軽く確認してからChromeを安全に閉じる
#      （閉じることで05専用プロファイルにログイン状態が保存される）
#   6. 終了後も同じプロファイルの後始末を行う
#
# 完了後は run_all_04_05_04_06.bat を再実行すれば、05が自動取得できる。

param(
    [string]$UserDataDir = "data/playwright-profile/monex-login-profile",
    [string]$ChromeExecutablePath = "",
    [string]$CheckCode = "6871",
    [int]$TimeoutMs = 600000,
    [string]$LogPath = "logs/run_log.txt"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ProjectDir = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $ProjectDir

function Ensure-Directory([string]$Path) {
    if (-not [string]::IsNullOrWhiteSpace($Path) -and -not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
    }
}

function Get-ChromeExecutable {
    param([string]$ProvidedPath)
    if (-not [string]::IsNullOrWhiteSpace($ProvidedPath) -and (Test-Path -LiteralPath $ProvidedPath)) {
        return $ProvidedPath
    }
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return ""
}

# 05専用プロファイル（playwright-profile\monex-login-profile）を掴んでいる
# 残存プロセスだけを安全に検出して終了する。
# 通常Chromeや他プロジェクトのChrome/Nodeを巻き込まないよう、CommandLineに
# 以下のいずれかを含むプロセスだけを対象にする：
#   playwright-profile / monex-login-profile / 05_マネックス銘柄スカウター自動取得 / update_all_05
# chrome.exe / node.exe を無条件に終了する実装は行わない。
function Stop-Monex05StaleProcesses {
    $patterns = @(
        "playwright-profile",
        "monex-login-profile",
        "05_マネックス銘柄スカウター自動取得",
        "update_all_05"
    )
    try {
        $procs = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='node.exe'" -ErrorAction SilentlyContinue)
    } catch {
        $procs = @()
    }
    foreach ($p in $procs) {
        $cmd = [string]$p.CommandLine
        if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
        $isTarget = $false
        foreach ($pat in $patterns) {
            if ($cmd -like "*$pat*") { $isTarget = $true; break }
        }
        if (-not $isTarget) { continue }
        try {
            Write-Host "  [cleanup] 残存プロセス終了: PID=$($p.ProcessId) Name=$($p.Name)" -ForegroundColor Gray
            Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
        } catch {
            Write-Host "  [cleanup] プロセス終了に失敗 PID=$($p.ProcessId): $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
}

# 05専用プロファイル配下のロックファイルだけを削除する（他プロファイルには触れない）。
function Remove-Monex05LockFiles {
    param([string]$ResolvedProfileDir)
    if ([string]::IsNullOrWhiteSpace($ResolvedProfileDir) -or -not (Test-Path -LiteralPath $ResolvedProfileDir)) { return }
    $lockNames = @("SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile")
    foreach ($name in $lockNames) {
        $lockPath = Join-Path $ResolvedProfileDir $name
        if (Test-Path -LiteralPath $lockPath) {
            try {
                Remove-Item -LiteralPath $lockPath -Force -ErrorAction Stop
                Write-Host "  [cleanup] ロックファイル削除: $lockPath" -ForegroundColor Gray
            } catch {
                Write-Host "  [cleanup] ロックファイル削除に失敗: $lockPath - $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
    }
}

Ensure-Directory $UserDataDir
Ensure-Directory (Split-Path $LogPath -Parent)

$resolvedProfileDir = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $UserDataDir))

Write-Host "====================================================" -ForegroundColor Green
Write-Host " 05 マネックス専用プロファイル 手動ログイン更新" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Green
Write-Host ""
Write-Host "対象プロファイル:" -ForegroundColor Gray
Write-Host "  $resolvedProfileDir"
Write-Host ""

Write-Host "[cleanup] 実行前クリーンアップ（05専用プロファイルのみ対象）" -ForegroundColor Gray
Stop-Monex05StaleProcesses
Start-Sleep -Milliseconds 500
Remove-Monex05LockFiles -ResolvedProfileDir $resolvedProfileDir

$chromePath = Get-ChromeExecutable $ChromeExecutablePath
if ([string]::IsNullOrWhiteSpace($chromePath)) {
    throw "Chrome executable not found"
}

$nodeScript = Join-Path $PSScriptRoot "playwright_login_monex_profile_05.js"
if (-not (Test-Path -LiteralPath $nodeScript)) {
    throw "playwright_login_monex_profile_05.js が見つかりません。"
}

$nodeArgs = @(
    $nodeScript,
    "--user-data-dir", $UserDataDir,
    "--chrome-executable", $chromePath,
    "--check-code", $CheckCode,
    "--timeout-ms", ([string]$TimeoutMs),
    "--log-path", $LogPath
)
$exitCode = 0
try {
    # Start-Processではなく呼び出し演算子で同期実行する。これにより、このPowerShell
    # コンソールのstdin/stdoutがnodeプロセスにそのまま引き継がれ、node側のreadline
    # によるEnterキー入力待ちが正しく機能する（本スクリプトは常に対話実行が前提）。
    & node $nodeArgs
    $exitCode = $LASTEXITCODE
}
finally {
    Write-Host ""
    Write-Host "[cleanup] 終了後クリーンアップ（05専用プロファイルのみ対象）" -ForegroundColor Gray
    Stop-Monex05StaleProcesses
    Remove-Monex05LockFiles -ResolvedProfileDir $resolvedProfileDir
}

Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "====================================================" -ForegroundColor Green
    Write-Host " ログイン状態の更新が完了しました。" -ForegroundColor Green
    Write-Host " 続けて run_all_04_05_04_06.bat を実行すると、05が自動取得を行います。" -ForegroundColor Green
    Write-Host "====================================================" -ForegroundColor Green
} else {
    Write-Host "====================================================" -ForegroundColor Red
    Write-Host " ログイン更新が完了しませんでした（exitCode=$exitCode）。" -ForegroundColor Red
    Write-Host " 再度このスクリプトを実行してください。" -ForegroundColor Red
    Write-Host "====================================================" -ForegroundColor Red
}

exit $exitCode
