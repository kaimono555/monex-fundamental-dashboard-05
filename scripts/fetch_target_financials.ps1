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

function Invoke-BatchFetch {
    param(
        [string[]]$Codes,
        [string]$NodeScript,
        [string]$ChromePath
    )

    if (Test-Path -LiteralPath $FetchResultsPath) {
        Remove-Item -LiteralPath $FetchResultsPath -Force
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

    & node @nodeArgs | ForEach-Object { Write-Host $_ }
    $exitCode = $LASTEXITCODE
    return [int]$exitCode
}

function Get-FetchResults {
    if (Test-Path -LiteralPath $FetchResultsPath) {
        return @(Import-Csv -LiteralPath $FetchResultsPath -Encoding UTF8)
    }
    return @()
}

function Test-AuthFetchStop {
    param(
        [object[]]$FetchResults,
        [int]$CodeCount,
        [int]$ExitCode
    )

    if ($ExitCode -eq 0) { return $false }
    $authErrorRows = @($FetchResults | Where-Object { [string]$_.error_type -eq "auth_error" })
    return ($authErrorRows.Count -gt 0 -and $FetchResults.Count -lt $CodeCount)
}

function Invoke-UserRelogin {
    param([string]$BCode)

    Write-RunLog "認証エラーページ検出→ユーザーへ再ログイン依頼"
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "check_monex_login_profile.ps1") `
        -BCode $BCode `
        -UserDataDir $UserDataDir `
        -ChromeExecutablePath $chromePath `
        -LogPath $LogPath `
        -WaitForEnterAndClose
    return $LASTEXITCODE
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

$nodeExitCode = Invoke-BatchFetch -Codes $codes -NodeScript $nodeScript -ChromePath $chromePath
$fetchResults = @(Get-FetchResults)

while (Test-AuthFetchStop -FetchResults $fetchResults -CodeCount $codes.Count -ExitCode $nodeExitCode) {
    $firstAuthCode = [string](@($fetchResults | Where-Object { [string]$_.error_type -eq "auth_error" } | Select-Object -First 1).code)
    if ([string]::IsNullOrWhiteSpace($firstAuthCode)) { $firstAuthCode = [string]$codes[0] }

    $loginExitCode = Invoke-UserRelogin -BCode $firstAuthCode
    if ($loginExitCode -ne 0) {
        Write-RunLog "user relogin check failed exitCode=$loginExitCode; requesting login again"
        $nodeExitCode = $loginExitCode
        $fetchResults = @(Get-FetchResults)
        continue
    }

    Write-RunLog "target fetch restart from first code after user relogin"
    $nodeExitCode = Invoke-BatchFetch -Codes $codes -NodeScript $nodeScript -ChromePath $chromePath
    $fetchResults = @(Get-FetchResults)
}

if ($nodeExitCode -ne 0 -and $fetchResults.Count -eq 0) {
    Write-RunLog "target fetch fatal no fetch result rows exitCode=$nodeExitCode; aborting before fallback"
    throw "fetch did not produce result rows. Close any Chrome window using $UserDataDir, then rerun."
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
