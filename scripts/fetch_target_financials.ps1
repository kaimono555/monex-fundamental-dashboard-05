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

function ConvertTo-ProcessArgument {
    param([string]$Value)
    if ($null -eq $Value) { return '""' }
    return '"' + ($Value -replace '"', '\"') + '"'
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

    # ログイン確認と60銘柄取得は、同一nodeプロセス・同一persistent context内で
    # 行わせる（playwright_batch_fetch_financials.js側のensureLoginReady）。
    # 別contextで再ログイン確認してからこのcontextへ引き継ぐ方式は、ブラウザの
    # 完全な再起動（close→再launch）を挟むとIFIS側の認証が失われるため使用しない。
    # Enter確認のUIはこのPowerShellプロセス側で行う必要があるため
    # （process.stdinをnode側で読む方式はsubprocessチェーンで機能しない）、
    # nodeはStart-Processで非同期起動し、シグナルファイルでやり取りする。
    $resolvedUserDataDir = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $UserDataDir))
    $needSignalPath    = Join-Path $resolvedUserDataDir ".relogin_needed_signal"
    $confirmSignalPath = Join-Path $resolvedUserDataDir ".relogin_confirm_signal"
    $abortSignalPath   = Join-Path $resolvedUserDataDir ".relogin_abort_signal"
    Remove-Item -LiteralPath $needSignalPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $confirmSignalPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $abortSignalPath -Force -ErrorAction SilentlyContinue

    # 05専用プロファイルを起動前に解放しておく（前回異常終了の残存プロセス対策）。
    Write-Host "  [cleanup] 起動前クリーンアップ（05専用プロファイルのみ対象）" -ForegroundColor Gray
    Stop-Monex05StaleProcesses
    Start-Sleep -Milliseconds 500
    Remove-Monex05LockFiles -ResolvedProfileDir $resolvedUserDataDir

    # 無人実行（stdinリダイレクト）ではコンソールのキー入力監視ができないため、
    # ここで一度だけ判定して使い回す。リダイレクトされている場合はKeyAvailableを
    # 一切呼び出さず、シグナルファイル待機とタイムアウトのみで処理する。
    $consoleInputAvailable = $false
    try {
        $consoleInputAvailable = -not [Console]::IsInputRedirected
    } catch {
        $consoleInputAvailable = $false
    }

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
    $argumentList = ($nodeArgs | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join " "
    $process = Start-Process -FilePath "node" -ArgumentList $argumentList -NoNewWindow -PassThru

    try {
    $reloginPromptShown = $false
    while (-not $process.HasExited) {
        if (-not $reloginPromptShown -and (Test-Path -LiteralPath $needSignalPath)) {
            $reloginPromptShown = $true
            Write-Host ""
            Write-Host "=========================================" -ForegroundColor Yellow
            Write-Host "マネックスログインが必要です。" -ForegroundColor Yellow
            Write-Host "マネックスにログインしただけでは不十分です。" -ForegroundColor Yellow
            Write-Host "必ずマネックス本体メニューから銘柄スカウターを開き、" -ForegroundColor Yellow
            Write-Host "$($Codes[0]) などの銘柄スカウター財務ページが正常に表示されていることを確認してから" -ForegroundColor Yellow
            Write-Host "Enterを押してください。" -ForegroundColor Yellow
            Write-Host "=========================================" -ForegroundColor Yellow

            $waitTimeoutMs = 5 * 60 * 1000
            $deadline = (Get-Date).AddMilliseconds($waitTimeoutMs)
            $lastStatusAt = Get-Date
            $confirmed = $false

            while ((Get-Date) -lt $deadline) {
                if ($process.HasExited) { break }
                if ($consoleInputAvailable -and [Console]::KeyAvailable) {
                    $key = [Console]::ReadKey($true)
                    if ($key.Key -eq "Enter") { $confirmed = $true; break }
                }
                if (((Get-Date) - $lastStatusAt).TotalSeconds -ge 30) {
                    $remaining = [int](($deadline - (Get-Date)).TotalSeconds)
                    Write-Host "  ...待機中（残り約 $remaining 秒）。ログイン・銘柄スカウター表示後にEnterを押してください。" -ForegroundColor Gray
                    Write-RunLog "batch fetch waiting-for-enter (powershell side) remaining=${remaining}s"
                    $lastStatusAt = Get-Date
                }
                Start-Sleep -Milliseconds 200
            }

            if (-not $process.HasExited) {
                if (-not $confirmed) {
                    Write-RunLog "batch fetch timeout waiting for user Enter confirmation"
                    New-Item -ItemType File -Path $abortSignalPath -Force | Out-Null
                    Write-Host ""
                    Write-Host "=========================================" -ForegroundColor Red
                    Write-Host "5分以内にEnterが押されなかったため、再ログイン確認はタイムアウトしました。" -ForegroundColor Red
                    Write-Host "次の手順を確認してください：" -ForegroundColor Red
                    Write-Host "  1. 開いたChromeでマネックス証券にログインできているか確認する" -ForegroundColor Red
                    Write-Host "  2. マネックス本体のメニューから銘柄スカウターが正常に表示されるか確認する" -ForegroundColor Red
                    Write-Host "  3. 表示できる状態になったら run_05_update.bat を再実行する" -ForegroundColor Red
                    Write-Host "=========================================" -ForegroundColor Red
                } else {
                    Write-Host ""
                    Write-Host "ログイン状態を再チェックしています..." -ForegroundColor Cyan
                    New-Item -ItemType File -Path $confirmSignalPath -Force | Out-Null
                }
            }
        }
        Start-Sleep -Milliseconds 300
    }

    Remove-Item -LiteralPath $needSignalPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $confirmSignalPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $abortSignalPath -Force -ErrorAction SilentlyContinue

    return [int]$process.ExitCode
    }
    finally {
        # 正常終了・異常終了どちらでも、05専用プロファイルを使い終えたら必ず後始末する。
        if (-not $process.HasExited) {
            try {
                Write-Host "  [cleanup] nodeプロセスが残っているため終了します: PID=$($process.Id)" -ForegroundColor Gray
                Stop-Process -Id $process.Id -Force -ErrorAction Stop
            } catch {
                Write-Host "  [cleanup] nodeプロセス終了に失敗 PID=$($process.Id): $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
        Start-Sleep -Milliseconds 500
        Write-Host "  [cleanup] 終了後クリーンアップ（05専用プロファイルのみ対象）" -ForegroundColor Gray
        Stop-Monex05StaleProcesses
        Remove-Monex05LockFiles -ResolvedProfileDir $resolvedUserDataDir
    }
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

# ログイン確認(必要な場合のEnter確認待ちを含む)と60銘柄取得は、Invoke-BatchFetch が
# 起動する単一のnodeプロセス・単一のpersistent context内で行う
# （playwright_batch_fetch_financials.js の ensureLoginReady）。
# ログインが既に有効な場合は人間の操作なしにそのまま取得が始まる。
$nodeExitCode = Invoke-BatchFetch -Codes $codes -NodeScript $nodeScript -ChromePath $chromePath
$fetchResults = @(Get-FetchResults)

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
