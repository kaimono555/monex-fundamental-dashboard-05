param(
    [string]$InputPath = "data/fundamentals.csv",
    [string]$OutputPath = "data/fundamental_scores.csv",
    [ValidateSet("all", "latest", "fallback", "failed")]
    [string]$SourceStatusFilter = "all"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
}

function Parse-Number([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $number = 0.0
    if ([double]::TryParse(($Value.Trim() -replace ",", ""), [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
        return $number
    }
    return $null
}

function Format-Score([double]$Value) {
    if ($Value -lt 0) { $Value = 0 }
    if ($Value -gt 100) { $Value = 100 }
    return $Value.ToString("F1", [System.Globalization.CultureInfo]::InvariantCulture).TrimEnd("0").TrimEnd(".")
}

function Add-ThresholdScore([Nullable[double]]$Value, [double[]]$Thresholds, [double[]]$Scores) {
    if ($null -eq $Value) { return 0.0 }
    for ($i = 0; $i -lt $Thresholds.Count; $i += 1) {
        if ($Value -ge $Thresholds[$i]) { return $Scores[$i] }
    }
    return 0.0
}

function Get-GrowthMetricScore([Nullable[double]]$Value, [double]$Weight) {
    if ($null -eq $Value) { return 0.0 }
    if ($Value -ge 20) { return $Weight }
    if ($Value -ge 12) { return $Weight * 0.8 }
    if ($Value -ge 7) { return $Weight * 0.6 }
    if ($Value -ge 3) { return $Weight * 0.4 }
    if ($Value -ge 0) { return $Weight * 0.2 }
    return 0.0
}

function Get-GrowthScore($Row) {
    $score = 0.0
    $score += Get-GrowthMetricScore (Parse-Number $Row.sales_growth_5y) 8
    $score += Get-GrowthMetricScore (Parse-Number $Row.operating_growth_5y) 12
    $score += Get-GrowthMetricScore (Parse-Number $Row.ordinary_growth_5y) 10
    $score += Get-GrowthMetricScore (Parse-Number $Row.net_income_growth_5y) 10
    if ($score -gt 40) { return 40.0 }
    return $score
}

function Get-ProfitabilityScore($Row) {
    $score = 0.0
    $score += Add-ThresholdScore (Parse-Number $Row.roe) @(20, 15, 10, 5) @(7, 5, 4, 1)
    $score += Add-ThresholdScore (Parse-Number $Row.roic) @(15, 10, 7, 4) @(7, 5, 4, 1)
    $score += Add-ThresholdScore (Parse-Number $Row.operating_margin_5y) @(25, 15, 10, 5) @(6, 4, 3, 1)
    if ($score -gt 20) { return 20.0 }
    return $score
}

function Get-FinancialScore($Row) {
    $score = 0.0
    $score += Add-ThresholdScore (Parse-Number $Row.equity_ratio) @(70, 50, 30, 20) @(9, 7, 4, 1)
    $debt = Parse-Number $Row.interest_bearing_debt_ratio
    if ($null -eq $debt) { $score += 4 }
    elseif ($debt -le 10) { $score += 6 }
    elseif ($debt -le 30) { $score += 4 }
    elseif ($debt -le 60) { $score += 2 }
    $score += Add-ThresholdScore (Parse-Number $Row.profit_streak_years) @(10, 7, 5, 3) @(5, 4, 3, 1)
    if ($score -gt 20) { return 20.0 }
    return $score
}

function Get-QualityRank([double]$Score) {
    if ($Score -ge 68) { return "A" }
    if ($Score -ge 56) { return "B" }
    if ($Score -ge 44) { return "C" }
    if ($Score -ge 32) { return "D" }
    return "E"
}

function Limit-RankToC([string]$Rank) {
    if ($Rank -in @("A", "B")) { return "C" }
    return $Rank
}

function Get-MissingDataCount($Row) {
    $fields = @(
        "sales_growth_5y", "operating_growth_5y", "ordinary_growth_5y", "net_income_growth_5y",
        "roe", "roic", "equity_ratio", "interest_bearing_debt_ratio",
        "operating_margin_5y", "profit_streak_years"
    )
    $count = 0
    foreach ($field in $fields) {
        if (-not ($Row.PSObject.Properties.Name -contains $field) -or [string]::IsNullOrWhiteSpace([string]$Row.$field)) { $count += 1 }
    }
    return $count
}

function Get-ScoreReason($Row, [double]$QualityScore, [string]$QualityRank, [int]$MissingCount, [string[]]$CapReasons) {
    $reasons = @()
    $op5 = Parse-Number $Row.operating_growth_5y
    $ord5 = Parse-Number $Row.ordinary_growth_5y
    $roe = Parse-Number $Row.roe
    $equity = Parse-Number $Row.equity_ratio

    if ($null -ne $op5 -and $op5 -ge 12 -and $null -ne $ord5 -and $ord5 -ge 12) { $reasons += "5年利益成長率が高い" }
    elseif ($null -ne $op5 -and $op5 -lt 0) { $reasons += "5年営業利益成長率がマイナス" }
    else { $reasons += "成長性は中立から控えめ" }

    if ($null -ne $roe -and $roe -ge 15) { $reasons += "ROEが高い" }
    elseif ($null -ne $roe -and $roe -ge 10) { $reasons += "ROEは良好" }

    if ($null -ne $equity -and $equity -ge 50) { $reasons += "自己資本比率が高い" }
    elseif ($null -ne $equity -and $equity -lt 30) { $reasons += "自己資本比率が低い" }

    if ($MissingCount -ge 4) { $reasons += "主要業績データの欠損が多いため評価を控えめに算出" }
    if ($CapReasons.Count -gt 0) { $reasons += "強制ランク上限: $($CapReasons -join ',')" }
    if (([string]$Row.fetch_status) -eq "fallback_used") { $reasons += "最新取得に失敗したため既存データを使用" }
    elseif (([string]$Row.stale_flag).ToLowerInvariant() -eq "true") { $reasons += "取得日時または基準日が不明なため信頼性を低めに扱う" }
    return ($reasons -join "。") + "。"
}

function Get-SourceStatus($Row) {
    $status = [string]$Row.fetch_status
    if ($status -eq "success") { return "latest" }
    if ($status -eq "fallback_used") { return "fallback" }
    if ($status -eq "failed") { return "failed" }
    if (([string]$Row.stale_flag).ToLowerInvariant() -eq "true") { return "fallback" }
    return "failed"
}

if (-not (Test-Path -LiteralPath $InputPath)) { throw "input file not found: $InputPath" }
Ensure-Directory (Split-Path $OutputPath -Parent)

$rows = @()
foreach ($row in @(Import-Csv -LiteralPath $InputPath -Encoding UTF8)) {
    $sourceStatus = Get-SourceStatus $row
    if ($SourceStatusFilter -ne "all" -and $sourceStatus -ne $SourceStatusFilter) { continue }

    $missingCount = Get-MissingDataCount $row
    $growthScore = Get-GrowthScore $row
    $profitabilityScore = Get-ProfitabilityScore $row
    $financialScore = Get-FinancialScore $row
    $missingPenalty = [math]::Min(20.0, [double]$missingCount * 2.0)
    $qualityScore = $growthScore + $profitabilityScore + $financialScore - $missingPenalty
    if ($qualityScore -lt 0) { $qualityScore = 0 }

    $rank = Get-QualityRank $qualityScore
    $capReasons = @()
    $operatingGrowth5y = Parse-Number $row.operating_growth_5y
    $ordinaryGrowth5y = Parse-Number $row.ordinary_growth_5y
    $equityRatio = Parse-Number $row.equity_ratio
    if ($null -ne $operatingGrowth5y -and $operatingGrowth5y -lt 0) { $capReasons += "operating_growth_5y_negative" }
    if ($null -ne $ordinaryGrowth5y -and $ordinaryGrowth5y -lt 0) { $capReasons += "ordinary_growth_5y_negative" }
    if ($null -ne $equityRatio -and $equityRatio -lt 30) { $capReasons += "equity_ratio_below_30" }
    if (([string]$row.forecast_loss).ToUpperInvariant() -eq "TRUE") { $capReasons += "forecast_loss" }
    $rankCap = "FALSE"
    if ($capReasons.Count -gt 0) {
        $rankCap = "TRUE"
        $rank = Limit-RankToC $rank
    }

    $rows += [pscustomobject]@{
        rank = 0
        code = $row.code
        name = $row.name
        quality_score = Format-Score $qualityScore
        quality_rank = $rank
        growth = Format-Score $growthScore
        profitability = Format-Score $profitabilityScore
        financial = Format-Score $financialScore
        source_status = $sourceStatus
        stale_flag = if ([string]::IsNullOrWhiteSpace([string]$row.stale_flag)) { if ($sourceStatus -eq "latest") { "false" } else { "true" } } else { [string]$row.stale_flag }
        data_as_of = $row.data_as_of
        fetched_at = $row.fetched_at
        rank_cap = $rankCap
        rank_cap_reason = ($capReasons -join "|")
    }
}

$rows = @($rows | Sort-Object @{ Expression = { -[double]$_.quality_score } }, code)
$rankIndex = 0
$rows = @($rows | ForEach-Object {
    $rankIndex += 1
    [pscustomobject]@{
        rank = $rankIndex
        code = $_.code
        name = $_.name
        quality_rank = $_.quality_rank
        quality_score = $_.quality_score
        growth = $_.growth
        profitability = $_.profitability
        financial = $_.financial
        source_status = $_.source_status
        stale_flag = $_.stale_flag
        data_as_of = $_.data_as_of
        fetched_at = $_.fetched_at
    }
})
$rows | Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding UTF8
Write-Host "Wrote $($rows.Count) rows: $OutputPath"
