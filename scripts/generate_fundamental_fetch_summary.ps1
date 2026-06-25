param(
    [string]$TargetPath = "data/target_codes.csv",
    [string]$FetchStatusPath = "data/fetch_status.csv",
    [string]$FundamentalsPath = "data/fundamentals.csv",
    [string]$ScoresPath = "data/fundamental_scores.csv",
    [string]$ErrorPath = "logs/fundamental_fetch_errors.csv",
    [string]$ReportPath = "reports/fundamental_fetch_summary.md",
    [string]$StartedAt = "",
    [string]$EndedAt = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
}

function Format-Cell($Value) {
    if ($null -eq $Value) { return "" }
    return ([string]$Value).Replace("|", "/").Replace("`r", " ").Replace("`n", " ")
}

function Get-DurationText([string]$StartText, [string]$EndText) {
    $start = [datetime]::MinValue
    $end = [datetime]::MinValue
    if ([datetime]::TryParse($StartText, [ref]$start) -and [datetime]::TryParse($EndText, [ref]$end)) {
        $span = $end - $start
        return "{0:D2}:{1:D2}:{2:D2}" -f [int]$span.TotalHours, $span.Minutes, $span.Seconds
    }
    return ""
}

Ensure-Directory (Split-Path $ReportPath -Parent)

$targets = if (Test-Path -LiteralPath $TargetPath) { @(Import-Csv -LiteralPath $TargetPath -Encoding UTF8 | Where-Object { -not [string]::IsNullOrWhiteSpace($_.code) }) } else { @() }
$statuses = if (Test-Path -LiteralPath $FetchStatusPath) { @(Import-Csv -LiteralPath $FetchStatusPath -Encoding UTF8) } else { @() }
$fundamentals = if (Test-Path -LiteralPath $FundamentalsPath) { @(Import-Csv -LiteralPath $FundamentalsPath -Encoding UTF8) } else { @() }
$scores = if (Test-Path -LiteralPath $ScoresPath) { @(Import-Csv -LiteralPath $ScoresPath -Encoding UTF8) } else { @() }
$failureRows = if (Test-Path -LiteralPath $ErrorPath) { @(Import-Csv -LiteralPath $ErrorPath -Encoding UTF8) } else { @() }

$inputCount = if ($targets.Count -gt 0) { $targets.Count } elseif ($statuses.Count -gt 0) { $statuses.Count } else { $fundamentals.Count }
$successRows = @($statuses | Where-Object { $_.fetch_status -eq "success" })
$fallbackRows = @($statuses | Where-Object { $_.fetch_status -eq "fallback_used" })
$failedRows = @($statuses | Where-Object { $_.fetch_status -eq "failed" })
$successRate = if ($inputCount -gt 0) { [math]::Round(($successRows.Count / $inputCount) * 100, 1) } else { 0 }
$stopReasonRows = @($statuses + $failureRows | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.stop_reason) })
$stopReason = if ($stopReasonRows.Count -gt 0) { [string]$stopReasonRows[0].stop_reason } else { "" }

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add("# fundamentals 一括処理サマリー")
$lines.Add("")
$lines.Add('| item | value |')
$lines.Add('|---|---:|')
$lines.Add(('| 入力銘柄数 | {0} |' -f $inputCount))
$lines.Add(('| 最新取得成功数 | {0} |' -f $successRows.Count))
$lines.Add(('| fallback使用数 | {0} |' -f $fallbackRows.Count))
$lines.Add(('| 完全失敗数 | {0} |' -f $failedRows.Count))
$lines.Add(('| fundamentals生成数 | {0} |' -f $fundamentals.Count))
$lines.Add(('| スコア算出成功数 | {0} |' -f $scores.Count))
$lines.Add(('| 処理開始時刻 | {0} |' -f (Format-Cell $StartedAt)))
$lines.Add(('| 処理終了時刻 | {0} |' -f (Format-Cell $EndedAt)))
$lines.Add(('| 処理時間 | {0} |' -f (Get-DurationText $StartedAt $EndedAt)))
$lines.Add(('| 成功率 | {0}% |' -f $successRate))
if (-not [string]::IsNullOrWhiteSpace($stopReason)) {
    $lines.Add(('| 停止理由 | {0} |' -f (Format-Cell $stopReason)))
}
$lines.Add("")
$lines.Add("## 失敗銘柄一覧")
$lines.Add("")
if ($failedRows.Count -eq 0) {
    $lines.Add("該当なし")
} else {
    $lines.Add('| code | name | error_type | reason | retry_count |')
    $lines.Add('|---|---|---|---|---:|')
    foreach ($row in $failedRows) {
        $codeCell = Format-Cell $row.code
        $nameCell = Format-Cell $row.name
        $typeCell = Format-Cell $row.error_type
        $messageCell = Format-Cell $row.error_message
        $retryCell = Format-Cell $row.retry_count
        $line = '| ' + $codeCell + ' | ' + $nameCell + ' | ' + $typeCell + ' | ' + $messageCell + ' | ' + $retryCell + ' |'
        $lines.Add($line)
    }
}

$lines.Add("")
$lines.Add("## fallback使用銘柄一覧")
$lines.Add("")
if ($fallbackRows.Count -eq 0) {
    $lines.Add("該当なし")
} else {
    $lines.Add('| code | name | data_as_of | error_type | reason |')
    $lines.Add('|---|---|---|---|---|')
    foreach ($row in $fallbackRows) {
        $codeCell = Format-Cell $row.code
        $nameCell = Format-Cell $row.name
        $dataAsOfCell = Format-Cell $row.data_as_of
        $typeCell = Format-Cell $row.error_type
        $messageCell = Format-Cell $row.error_message
        $line = '| ' + $codeCell + ' | ' + $nameCell + ' | ' + $dataAsOfCell + ' | ' + $typeCell + ' | ' + $messageCell + ' |'
        $lines.Add($line)
    }
}

$lines.Add("")
$lines.Add("## エラーログ")
$lines.Add("")
if ($failureRows.Count -eq 0) {
    $lines.Add("該当なし")
} else {
    $lines.Add('| code | name | error_type | fetch_status | retry_count | timestamp | reason |')
    $lines.Add('|---|---|---|---|---:|---|---|')
    foreach ($row in $failureRows) {
        $codeCell = Format-Cell $row.code
        $nameCell = Format-Cell $row.name
        $typeCell = Format-Cell $row.error_type
        $statusCell = Format-Cell $row.fetch_status
        $retryCell = Format-Cell $row.retry_count
        $timestampCell = Format-Cell $row.timestamp
        $messageCell = Format-Cell $row.error_message
        $line = '| ' + $codeCell + ' | ' + $nameCell + ' | ' + $typeCell + ' | ' + $statusCell + ' | ' + $retryCell + ' | ' + $timestampCell + ' | ' + $messageCell + ' |'
        $lines.Add($line)
    }
}

$utf8Bom = [System.Text.UTF8Encoding]::new($true)
[System.IO.File]::WriteAllLines((Join-Path (Resolve-Path (Split-Path $ReportPath -Parent)) (Split-Path $ReportPath -Leaf)), $lines, $utf8Bom)
Write-Host "Wrote summary: $ReportPath"
