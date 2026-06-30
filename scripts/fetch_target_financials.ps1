param(
    [string]$TargetPath = "data/target_codes.csv",
    [string]$UserDataDir = "data/playwright-profile/monex-login-profile",
    [string]$ChromeExecutablePath = "",
    [string]$RawDir = "data/raw",
    [string]$OutputDir = "data/output",
    [string]$FetchResultsPath = "data/fetch_results.csv",
    [string]$FetchStatusPath = "data/fetch_status.csv",
    [string]$ErrorPath = "logs/fundamental_fetch_errors.csv",
    [string]$LogPath = "logs/run_log.txt",
    [int]$MaxRetries = 3,
    [int]$RetryDelayMs = 5000,
    [int]$RequestDelayMs = 1500
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Ensure-Directory([string]$Path) {
    if (-not [string]::IsNullOrWhiteSpace($Path) -and -not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
    }
}

function Write-RunLog([string]$Message) {
    Ensure-Directory (Split-Path $LogPath -Parent)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $LogPath -Value "[$timestamp] $Message" -Encoding UTF8
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

function Get-PeriodKey([string]$Period) {
    $digits = $Period -replace "\D", ""
    if ([string]::IsNullOrWhiteSpace($digits)) { return 0 }
    return [int]$digits
}

function Get-Field([object]$Row, [int]$Index) {
    if ($null -eq $Row) { return "" }
    $properties = @($Row.PSObject.Properties)
    if ($Index -lt 0 -or $Index -ge $properties.Count) { return "" }
    return [string]$properties[$Index].Value
}

function Get-LatestPeriod([string]$CsvPath) {
    if (-not (Test-Path -LiteralPath $CsvPath)) { return "" }
    $rows = @(Import-Csv -LiteralPath $CsvPath -Encoding UTF8 | Sort-Object { Get-PeriodKey (Get-Field $_ 0) })
    if ($rows.Count -eq 0) { return "" }
    return Get-Field $rows[-1] 0
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

function Invoke-BatchFetch {
    param(
        [string[]]$Codes,
        [string]$NodeScript,
        [string]$ChromePath
    )

    if (Test-Path -LiteralPath $FetchResultsPath) {
        Remove-Item -LiteralPath $FetchResultsPath -Force
    }

    # 本スクリプトは自動実行モード専用。人間の入力（Enter確認）は一切待たない。
    # ログインが切れている場合はplaywright_batch_fetch_financials.js側が即座に
    # exitCode=3を返して終了する（待機なし）。マネックスへの手動ログイン更新は
    # scripts\login_monex_profile_05.ps1（専用スクリプト）でのみ行う設計とする。
    $resolvedUserDataDir = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $UserDataDir))

    # 05専用プロファイルを起動前に解放しておく（前回異常終了の残存プロセス対策）。
    Write-Host "  [cleanup] 起動前クリーンアップ（05専用プロファイルのみ対象）" -ForegroundColor Gray
    Stop-Monex05StaleProcesses
    Start-Sleep -Milliseconds 500
    Remove-Monex05LockFiles -ResolvedProfileDir $resolvedUserDataDir

    $nodeArgs = @(
        $NodeScript,
        "--codes", ($Codes -join ","),
        "--user-data-dir", $UserDataDir,
        "--chrome-executable", $ChromePath,
        "--raw-dir", $RawDir,
        "--log-path", $LogPath,
        "--results-path", $FetchResultsPath,
        "--max-retries", ([string]$MaxRetries),
        "--retry-delay-ms", ([string]$RetryDelayMs),
        "--request-delay-ms", ([string]$RequestDelayMs)
    )

    # 自動実行モードでは人間入力を待たないため、Start-Process(非同期起動+ポーリング)
    # ではなく呼び出し演算子で同期実行する。これによりnodeの標準出力がそのまま
    # このPowerShellコンソール/トランスクリプトに流れ、終了コードも$LASTEXITCODEで
    # 確実に取得できる（Start-Process -NoNewWindow -PassThru は .ExitCode が
    # 正しく取得できない場合があるため使用しない）。
    $nodeExitCode = 0
    try {
        & node $nodeArgs
        $nodeExitCode = $LASTEXITCODE
    }
    finally {
        # 正常終了・異常終了どちらでも、05専用プロファイルを使い終えたら必ず後始末する。
        Write-Host "  [cleanup] 終了後クリーンアップ（05専用プロファイルのみ対象）" -ForegroundColor Gray
        Stop-Monex05StaleProcesses
        Remove-Monex05LockFiles -ResolvedProfileDir $resolvedUserDataDir
    }

    return $nodeExitCode
}

function Get-FetchResults {
    if (Test-Path -LiteralPath $FetchResultsPath) {
        return @(Import-Csv -LiteralPath $FetchResultsPath -Encoding UTF8)
    }
    return @()
}

Ensure-Directory $RawDir
Ensure-Directory $OutputDir
Ensure-Directory $UserDataDir
Ensure-Directory (Split-Path $FetchResultsPath -Parent)
Ensure-Directory (Split-Path $FetchStatusPath -Parent)
Ensure-Directory (Split-Path $ErrorPath -Parent)

if (-not (Test-Path -LiteralPath $TargetPath)) {
    throw "target file not found: $TargetPath"
}

$targets = @(Import-Csv -LiteralPath $TargetPath -Encoding UTF8 | Where-Object { -not [string]::IsNullOrWhiteSpace($_.code) })
$codes = @($targets | ForEach-Object { ([string]$_.code).Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })

if ($codes.Count -eq 0) {
    throw "target file has no codes: $TargetPath"
}

$chromePath = Get-ChromeExecutable $ChromeExecutablePath
if ([string]::IsNullOrWhiteSpace($chromePath)) {
    throw "Chrome executable not found"
}

$existingCsv = @{}
foreach ($code in $codes) {
    $csvPath = Join-Path $OutputDir "$code`_financials.csv"
    $existingCsv[$code] = Test-Path -LiteralPath $csvPath
}

Write-RunLog "target fetch start count=$($codes.Count)"

$nodeScript = Join-Path $PSScriptRoot "playwright_batch_fetch_financials.js"

# ログイン確認と60銘柄取得は、Invoke-BatchFetch が起動する単一のnodeプロセス・
# 単一のpersistent context内で行う（playwright_batch_fetch_financials.js の
# ensureLoginReady）。本スクリプトは自動実行モード専用のため、ログインが切れて
# いる場合は人間の入力を待たずに即座に失敗する（exitCode=3）。
# ログインが既に有効な場合は人間の操作なしにそのまま取得が始まる。
$nodeExitCode = Invoke-BatchFetch -Codes $codes -NodeScript $nodeScript -ChromePath $chromePath
$fetchResults = @(Get-FetchResults)

if ($nodeExitCode -eq 3) {
    Write-RunLog "target fetch aborted: login not ready (automated mode, no human wait)"
    Write-Host ""
    Write-Host "=========================================" -ForegroundColor Red
    Write-Host "05専用マネックスプロファイルが未ログイン、またはログイン切れです。" -ForegroundColor Red
    Write-Host "自動実行モードのため、この画面ではログイン待ちは行いません。" -ForegroundColor Red
    Write-Host "先に scripts\login_monex_profile_05.ps1 を手動実行して、マネックスへログイン状態を保存してください。" -ForegroundColor Red
    Write-Host "その後、親バッチ run_all_04_05_04_06.bat を再実行してください。" -ForegroundColor Red
    Write-Host "=========================================" -ForegroundColor Red
    throw "05専用マネックスプロファイルが未ログインのため停止しました。scripts\login_monex_profile_05.ps1 を実行してください。"
}

if ($nodeExitCode -ne 0 -and $fetchResults.Count -eq 0) {
    Write-RunLog "target fetch fatal no fetch result rows exitCode=$nodeExitCode; aborting before fallback"
    throw "fetch did not produce result rows (exitCode=$nodeExitCode). ログイン確認に失敗したか、Chromeウィンドウが$UserDataDirを使用中の可能性があります。"
}

if ($nodeExitCode -ne 0) {
    Write-RunLog "target fetch returned non-zero exitCode=$nodeExitCode; continuing with per-code fallback checks"
}
$fetchByCode = @{}
foreach ($result in $fetchResults) {
    $fetchByCode[[string]$result.code] = $result
}
$batchStoppedByAuthError = $false
$batchStopReason = ""
if ($nodeExitCode -ne 0) {
    $authErrorRows = @($fetchResults | Where-Object { [string]$_.error_type -eq "auth_error" })
    $batchStoppedByAuthError = ($authErrorRows.Count -gt 0 -and $fetchResults.Count -lt $codes.Count)
    $stopRows = @($fetchResults | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.stop_reason) })
    if ($stopRows.Count -gt 0) {
        $batchStopReason = [string]$stopRows[0].stop_reason
    }
}

$statusRows = @()
$errorRows = @()
$index = 0
foreach ($target in $targets) {
    $index += 1
    $code = ([string]$target.code).Trim()
    $name = ([string]$target.name).Trim()
    $csvPath = Join-Path $OutputDir "$code`_financials.csv"
    $result = if ($fetchByCode.ContainsKey($code)) { $fetchByCode[$code] } else { $null }
    $fetchedAt = if ($result) { [string]$result.fetched_at } else { (Get-Date -Format "yyyy-MM-dd HH:mm:ss") }
    $sourceUpdateDate = if ($result) { [string]$result.source_update_date } else { "" }
    $retryCount = if ($result) { [string]$result.retry_count } else { "0" }
    $errorType = if ($result) { [string]$result.error_type } elseif ($batchStoppedByAuthError) { "auth_error" } else { "missing_fetch_result" }
    $errorMessage = if ($result) { [string]$result.error_message } elseif ($batchStoppedByAuthError) { "batch stopped after authentication error before this code was fetched" } else { "fetch result was not produced" }
    $stopReason = if ($result) { [string]$result.stop_reason } else { $batchStopReason }

    Write-Host "[$index/$($targets.Count)] parse/fallback $code $name"

    if ($result -and [string]$result.fetch_status -eq "success") {
        try {
            & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "parse_financials.ps1") -BCode $code -RawDir $RawDir -OutputDir $OutputDir -LogPath $LogPath
            if ($LASTEXITCODE -ne 0) { throw "parse_financials failed exitCode=$LASTEXITCODE" }
            $dataAsOf = Get-LatestPeriod $csvPath
            $staleFlag = if ([string]::IsNullOrWhiteSpace($fetchedAt) -or [string]::IsNullOrWhiteSpace($dataAsOf)) { "true" } else { "false" }
            $statusRows += [pscustomobject]@{
                code = $code
                name = $name
                fetched_at = $fetchedAt
                data_as_of = $dataAsOf
                source_update_date = $sourceUpdateDate
                fetch_status = "success"
                stale_flag = $staleFlag
                retry_count = $retryCount
                error_type = ""
                error_message = ""
                stop_reason = ""
            }
            continue
        }
        catch {
            $errorType = "parse_failed"
            $errorMessage = $_.Exception.Message
        }
    }

    if ($existingCsv[$code] -and (Test-Path -LiteralPath $csvPath)) {
        $dataAsOf = Get-LatestPeriod $csvPath
        $statusRows += [pscustomobject]@{
            code = $code
            name = $name
            fetched_at = $fetchedAt
            data_as_of = $dataAsOf
            source_update_date = $sourceUpdateDate
            fetch_status = "fallback_used"
            stale_flag = "true"
            retry_count = $retryCount
            error_type = $errorType
            error_message = $errorMessage
            stop_reason = $stopReason
        }
        $errorRows += [pscustomobject]@{
            code = $code
            name = $name
            error_type = $errorType
            error_message = $errorMessage
            retry_count = $retryCount
            fetch_status = "fallback_used"
            stop_reason = $stopReason
            timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        }
    }
    else {
        $statusRows += [pscustomobject]@{
            code = $code
            name = $name
            fetched_at = $fetchedAt
            data_as_of = ""
            source_update_date = $sourceUpdateDate
            fetch_status = "failed"
            stale_flag = "true"
            retry_count = $retryCount
            error_type = $errorType
            error_message = $errorMessage
            stop_reason = $stopReason
        }
        $errorRows += [pscustomobject]@{
            code = $code
            name = $name
            error_type = $errorType
            error_message = $errorMessage
            retry_count = $retryCount
            fetch_status = "failed"
            stop_reason = $stopReason
            timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        }
    }
}

$statusRows | Export-Csv -LiteralPath $FetchStatusPath -NoTypeInformation -Encoding UTF8
$errorRows | Export-Csv -LiteralPath $ErrorPath -NoTypeInformation -Encoding UTF8

$successCount = @($statusRows | Where-Object { $_.fetch_status -eq "success" }).Count
$fallbackCount = @($statusRows | Where-Object { $_.fetch_status -eq "fallback_used" }).Count
$failedCount = @($statusRows | Where-Object { $_.fetch_status -eq "failed" }).Count
$successRate = if ($statusRows.Count -gt 0) { [math]::Round(($successCount / $statusRows.Count) * 100, 1) } else { 0 }

Write-RunLog "target fetch end input=$($statusRows.Count) success=$successCount fallback=$fallbackCount failed=$failedCount successRate=$successRate%"
Write-Host "Fetch summary: input=$($statusRows.Count) success=$successCount fallback=$fallbackCount failed=$failedCount successRate=$successRate%"
