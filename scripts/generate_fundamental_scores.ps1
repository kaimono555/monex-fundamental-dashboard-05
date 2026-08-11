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

function Get-FinancialIndustryProfitabilityScore($Row) {
    $score = 0.0
    $score += Add-ThresholdScore (Parse-Number $Row.roe) @(20, 15, 10, 5) @(12, 9, 6, 2)
    $score += Add-ThresholdScore (Parse-Number $Row.operating_margin_5y) @(25, 15, 10, 5) @(8, 6, 4, 1)
    if ($score -gt 20) { return 20.0 }
    return $score
}

function Get-FinancialIndustryFinancialScore($Row) {
    $score = 0.0
    $score += Add-ThresholdScore (Parse-Number $Row.profit_streak_years) @(10, 7, 5, 3) @(12, 9, 6, 2)
    $score += Add-ThresholdScore (Parse-Number $Row.dividend_increase_years) @(10, 7, 5, 3) @(8, 6, 4, 1)
    if ($score -gt 20) { return 20.0 }
    return $score
}

function Format-ScoreN([double]$Value, [int]$Max) {
    if ($Value -lt 0) { $Value = 0 }
    if ($Value -gt $Max) { $Value = $Max }
    return $Value.ToString("F1", [System.Globalization.CultureInfo]::InvariantCulture).TrimEnd("0").TrimEnd(".")
}

# ===========================================================================
# バリュエーション評価（20点満点）2026-08-11 追加
# 既存 quality_score / quality_rank（80点満点）は一切変更しない。
# 新規に valuation_score(20点満点)・valuation_coverage・valuation_status・
# total_score_100・total_rank_100 を別項目として算出する。
# ===========================================================================

# A. 自社過去PER相対評価 6点。予想PER相対水準（2年/5年、0-100の百分位。
# 0=自社の過去レンジの最安値側、100=最高値側。同業/業種比較ではなく自社過去比較）。
# 5年をやや重視（5年0.6・2年0.4）。どちらも欠損なら評価対象外。
function Get-ValuationA($Row) {
    $rel2y = Parse-Number $Row.per_relative_2y
    $rel5y = Parse-Number $Row.per_relative_5y
    if ($null -eq $rel2y -and $null -eq $rel5y) {
        return @{ available = $false; score = 0.0; value = $null; max = 6.0 }
    }
    $combined = 0.0
    if ($null -ne $rel2y -and $null -ne $rel5y) { $combined = ($rel5y * 0.6) + ($rel2y * 0.4) }
    elseif ($null -ne $rel5y) { $combined = $rel5y }
    else { $combined = $rel2y }
    $score = Add-ThresholdScore (100 - $combined) @(80, 65, 50, 35, 20, 10) @(6, 5, 4, 3, 2, 1)
    return @{ available = $true; score = $score; value = $combined; max = 6.0 }
}

# B. 成長率調整PER（PEG）5点。
# 第一優先: 銘柄スカウター自身の「予想PEGレシオ」(存在し正の値の場合のみ採用)。
# 欠損時のみ自前計算: PER ÷ 成長率。成長率は
#   1) 予想EPS成長率 = (会社予想EPS - 直近実績EPS) / 直近実績EPS
#   2) 予想当期利益成長率（本データセットでは単独のコンセンサス値が取得できないため未実装。
#      「取得可能な評価項目だけで評価する」方針により optional として省略し、報告済み）
#   3) 予想経常利益（コンセンサス）増益率
# の順で採用。予想PER自体が欠損の場合、自前PEGは計算しない（無理に計算しない）。
# 異常値対策: 前年実績が赤字/存在しない場合、または成長率が200%を超える場合
# （前年比数百～数千%＝極端に小さい前年基準からの回復局面）は「PEGとして意味を持たない」
# として評価対象外にする。0%<成長率<=200%の場合のみ60%を上限にクリップして使用する。
function Get-GrowthForPeg($Row) {
    $epsLatest = Parse-Number $Row.eps_actual_latest
    $epsNext = Parse-Number $Row.eps_forecast_next
    if ($null -ne $epsLatest -and $epsLatest -gt 0 -and $null -ne $epsNext) {
        $g = (($epsNext - $epsLatest) / $epsLatest) * 100.0
        if ($g -gt 0 -and $g -le 200) {
            return @{ growth = [math]::Min($g, 60.0); source = "eps_forecast" }
        }
    }
    $ordPrev = Parse-Number $Row.ordinary_income_actual_prev_year
    $ordGrowth = Parse-Number $Row.ordinary_income_consensus_growth
    if ($null -ne $ordPrev -and $ordPrev -gt 0 -and $null -ne $ordGrowth) {
        if ($ordGrowth -gt 0 -and $ordGrowth -le 200) {
            return @{ growth = [math]::Min($ordGrowth, 60.0); source = "ordinary_consensus" }
        }
    }
    return @{ growth = $null; source = "" }
}

function Get-ValuationB($Row) {
    $pegMonex = Parse-Number $Row.peg_monex
    $peg = $null
    $source = ""
    if ($null -ne $pegMonex -and $pegMonex -gt 0) {
        $peg = $pegMonex
        $source = "monex_peg"
    } else {
        $perForecast = Parse-Number $Row.per_forecast
        if ($null -ne $perForecast -and $perForecast -gt 0) {
            $g = Get-GrowthForPeg $Row
            if ($null -ne $g.growth) {
                $peg = $perForecast / $g.growth
                $source = $g.source
            }
        }
    }
    if ($null -eq $peg -or $peg -le 0) {
        return @{ available = $false; score = 0.0; value = $null; source = ""; max = 5.0 }
    }
    $score = Add-ThresholdScore (0 - $peg) @((-0.7), (-1.0), (-1.5), (-2.0), (-2.5)) @(5, 4, 3, 2, 1)
    return @{ available = $true; score = $score; value = $peg; source = $source; max = 5.0 }
}

# C. EV/EBITDA 4点。絶対水準評価（同業比較データが取得不能なため）。
# 閾値は68銘柄実データの四分位（25%点10.8・中央値13.2・75%点22.9・90%点32.8）を採用。
function Get-ValuationC($Row) {
    $ev = Parse-Number $Row.ev_ebitda
    if ($null -eq $ev) {
        return @{ available = $false; score = 0.0; value = $null; max = 4.0 }
    }
    $score = Add-ThresholdScore (0 - $ev) @((-10.8), (-13.2), (-22.9), (-32.8)) @(4, 3, 2, 1)
    return @{ available = $true; score = $score; value = $ev; max = 4.0 }
}

# D. PBR×ROE 3点。pbr_roe_ratio = PBR / ROE(%)。低いほど高得点。
# ROE<=0（赤字）は指標が数学的に意味を持たないため評価対象外（0点にしない）。
# 閾値は68銘柄実データ（ROE>0のみ）の四分位（25%点0.152・中央値0.212・75%点0.347）を採用。
function Get-ValuationD($Row) {
    $pbr = Parse-Number $Row.pbr
    $roe = Parse-Number $Row.roe
    if ($null -eq $pbr -or $null -eq $roe -or $roe -le 0) {
        return @{ available = $false; score = 0.0; value = $null; max = 3.0 }
    }
    $ratio = $pbr / $roe
    $score = Add-ThresholdScore (0 - $ratio) @((-0.152), (-0.212), (-0.347)) @(3, 2, 1)
    return @{ available = $true; score = $score; value = $ratio; max = 3.0 }
}

# E. 52週株価水準 2点（0-100、低いほど52週安値に近い＝割安方向）。
# 閾値は68銘柄実データの四分位（25%点41.4・75%点75.6）を採用。
function Get-ValuationE($Row) {
    $level = Parse-Number $Row.week52_level
    if ($null -eq $level) {
        return @{ available = $false; score = 0.0; value = $null; max = 2.0 }
    }
    $score = Add-ThresholdScore (0 - $level) @((-41.4), (-75.6)) @(2, 1)
    return @{ available = $true; score = $score; value = $level; max = 2.0 }
}

# 評価可能満点9点未満は「十分な根拠のある割安評価」として扱わない
# (insufficient_data)。9点以上は 獲得点/評価可能満点 * 20 に比例換算する。
# coverage(=評価可能満点/20点満点) 70%以上=normal、45%以上70%未満=reference。
function Get-ValuationResult($Row) {
    $a = Get-ValuationA $Row
    $b = Get-ValuationB $Row
    $c = Get-ValuationC $Row
    $d = Get-ValuationD $Row
    $e = Get-ValuationE $Row

    $availableMax = 0.0
    $earned = 0.0
    foreach ($item in @($a, $b, $c, $d, $e)) {
        if ($item.available) { $availableMax += $item.max; $earned += $item.score }
    }
    $coverage = $availableMax / 20.0

    $status = "insufficient_data"
    $valuationScore = $null
    if ($availableMax -ge 9.0) {
        $valuationScore = ($earned / $availableMax) * 20.0
        if ($coverage -ge 0.70) { $status = "normal" }
        elseif ($coverage -ge 0.45) { $status = "reference" }
        else { $status = "insufficient_data" }
    }

    return @{
        a = $a; b = $b; c = $c; d = $d; e = $e
        available_max = $availableMax
        earned = $earned
        coverage = $coverage
        status = $status
        score = $valuationScore
    }
}

function Get-TotalRank100([double]$Score) {
    if ($Score -ge 85) { return "A" }
    if ($Score -ge 70) { return "B" }
    if ($Score -ge 55) { return "C" }
    if ($Score -ge 40) { return "D" }
    return "E"
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

function Get-MissingDataCountFinancialIndustry($Row) {
    $fields = @(
        "sales_growth_5y", "operating_growth_5y", "ordinary_growth_5y", "net_income_growth_5y",
        "roe", "operating_margin_5y", "profit_streak_years", "dividend_increase_years"
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

    # 金融業向けバリアント（equity_ratio/interest_bearing_debt_ratioは銀行業に不適切なため使用しない）
    $finIndProfitabilityScore = Get-FinancialIndustryProfitabilityScore $row
    $finIndFinancialScore = Get-FinancialIndustryFinancialScore $row
    $finIndMissingCount = Get-MissingDataCountFinancialIndustry $row
    $finIndMissingPenalty = [math]::Min(20.0, [double]$finIndMissingCount * 2.0)
    $finIndQualityScore = $growthScore + $finIndProfitabilityScore + $finIndFinancialScore - $finIndMissingPenalty
    if ($finIndQualityScore -lt 0) { $finIndQualityScore = 0 }
    $finIndRank = Get-QualityRank $finIndQualityScore
    $finIndCapReasons = @()
    if ($null -ne $operatingGrowth5y -and $operatingGrowth5y -lt 0) { $finIndCapReasons += "operating_growth_5y_negative" }
    if ($null -ne $ordinaryGrowth5y -and $ordinaryGrowth5y -lt 0) { $finIndCapReasons += "ordinary_growth_5y_negative" }
    if (([string]$row.forecast_loss).ToUpperInvariant() -eq "TRUE") { $finIndCapReasons += "forecast_loss" }
    $finIndRankCap = "FALSE"
    if ($finIndCapReasons.Count -gt 0) {
        $finIndRankCap = "TRUE"
        $finIndRank = Limit-RankToC $finIndRank
    }

    # 2026-08-11 バリュエーション評価（20点満点、既存quality_score/quality_rankとは独立）
    $valuation = Get-ValuationResult $row
    $valuationScoreText = if ($null -ne $valuation.score) { Format-ScoreN $valuation.score 20 } else { "" }
    $totalScore100 = if ($null -ne $valuation.score) { $qualityScore + $valuation.score } else { $null }
    $totalScore100Text = if ($null -ne $totalScore100) { Format-ScoreN $totalScore100 100 } else { "" }
    $totalRank100Text = if ($null -ne $totalScore100) { Get-TotalRank100 $totalScore100 } else { "" }

    $rows += [pscustomobject]@{
        rank = 0
        code = $row.code
        name = $row.name
        current_price = $row.current_price
        price_as_of = $row.price_as_of
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
        financial_industry_growth = Format-Score $growthScore
        financial_industry_profitability = Format-Score $finIndProfitabilityScore
        financial_industry_financial = Format-Score $finIndFinancialScore
        financial_industry_quality_score = Format-Score $finIndQualityScore
        financial_industry_quality_rank = $finIndRank
        financial_industry_rank_cap = $finIndRankCap
        financial_industry_rank_cap_reason = ($finIndCapReasons -join "|")
        valuation_score = $valuationScoreText
        valuation_coverage = [math]::Round($valuation.coverage * 100.0, 1)
        valuation_status = $valuation.status
        valuation_a_score = Format-ScoreN $valuation.a.score 6
        valuation_a_available = $valuation.a.available
        valuation_a_value = if ($null -ne $valuation.a.value) { [math]::Round($valuation.a.value, 1) } else { "" }
        valuation_b_score = Format-ScoreN $valuation.b.score 5
        valuation_b_available = $valuation.b.available
        valuation_b_peg = if ($null -ne $valuation.b.value) { [math]::Round($valuation.b.value, 2) } else { "" }
        valuation_b_source = $valuation.b.source
        valuation_c_score = Format-ScoreN $valuation.c.score 4
        valuation_c_available = $valuation.c.available
        valuation_c_value = if ($null -ne $valuation.c.value) { [math]::Round($valuation.c.value, 1) } else { "" }
        valuation_d_score = Format-ScoreN $valuation.d.score 3
        valuation_d_available = $valuation.d.available
        valuation_d_value = if ($null -ne $valuation.d.value) { [math]::Round($valuation.d.value, 3) } else { "" }
        valuation_e_score = Format-ScoreN $valuation.e.score 2
        valuation_e_available = $valuation.e.available
        valuation_e_value = if ($null -ne $valuation.e.value) { [math]::Round($valuation.e.value, 1) } else { "" }
        target_price = $row.target_price
        target_price_gap = $row.target_price_gap
        total_score_100 = $totalScore100Text
        total_rank_100 = $totalRank100Text
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
        current_price = $_.current_price
        price_as_of = $_.price_as_of
        quality_rank = $_.quality_rank
        quality_score = $_.quality_score
        growth = $_.growth
        profitability = $_.profitability
        financial = $_.financial
        source_status = $_.source_status
        stale_flag = $_.stale_flag
        data_as_of = $_.data_as_of
        fetched_at = $_.fetched_at
        financial_industry_growth = $_.financial_industry_growth
        financial_industry_profitability = $_.financial_industry_profitability
        financial_industry_financial = $_.financial_industry_financial
        financial_industry_quality_score = $_.financial_industry_quality_score
        financial_industry_quality_rank = $_.financial_industry_quality_rank
        financial_industry_rank_cap = $_.financial_industry_rank_cap
        financial_industry_rank_cap_reason = $_.financial_industry_rank_cap_reason
        valuation_score = $_.valuation_score
        valuation_coverage = $_.valuation_coverage
        valuation_status = $_.valuation_status
        valuation_a_score = $_.valuation_a_score
        valuation_a_available = $_.valuation_a_available
        valuation_a_value = $_.valuation_a_value
        valuation_b_score = $_.valuation_b_score
        valuation_b_available = $_.valuation_b_available
        valuation_b_peg = $_.valuation_b_peg
        valuation_b_source = $_.valuation_b_source
        valuation_c_score = $_.valuation_c_score
        valuation_c_available = $_.valuation_c_available
        valuation_c_value = $_.valuation_c_value
        valuation_d_score = $_.valuation_d_score
        valuation_d_available = $_.valuation_d_available
        valuation_d_value = $_.valuation_d_value
        valuation_e_score = $_.valuation_e_score
        valuation_e_available = $_.valuation_e_available
        valuation_e_value = $_.valuation_e_value
        target_price = $_.target_price
        target_price_gap = $_.target_price_gap
        total_score_100 = $_.total_score_100
        total_rank_100 = $_.total_rank_100
    }
})
$rows | Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding UTF8
Write-Host "Wrote $($rows.Count) rows: $OutputPath"
