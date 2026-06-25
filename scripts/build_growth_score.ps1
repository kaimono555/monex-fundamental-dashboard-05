param(
    [string]$InputPath = "growth_metrics.csv",
    [string]$RawDir = "data/raw",
    [string]$OutputPath = "growth_score.csv",
    [string]$ScoreRulesPath = "score_rules.csv"
)

$ErrorActionPreference = "Stop"

function Normalize-Number {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $null
    }

    $v = $Value.Trim()
    if ($v -match "^(?:-|－|―|--)$") {
        return $null
    }

    $v = $v -replace ",", ""
    $v = $v -replace "円|百万円|％|%", ""
    $v = $v -replace "\s+", ""

    $number = 0.0
    if ([double]::TryParse($v, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
        return $number
    }

    return $null
}

function Get-PeriodKey {
    param([string]$Period)
    $digits = ($Period -replace "\D", "")
    if ([string]::IsNullOrWhiteSpace($digits)) {
        return [int]::MaxValue
    }
    return [int]$digits
}

function Get-CompanyName {
    param(
        [string]$Code,
        [string]$HtmlPath
    )

    if (-not (Test-Path -LiteralPath $HtmlPath)) {
        return ""
    }

    $html = Get-Content -Path $HtmlPath -Raw -Encoding UTF8
    $codeRegex = [regex]::Escape($Code)
    $patterns = @(
        "<title>\s*(.+?)\s*\($codeRegex\)の企業分析 - 銘柄スカウター</title>",
        "class=""stock"" title=""([^""]+)""[^>]*>\s*$codeRegex\s+([^<]+)<",
        '\"NAME\":\"([^\"]+)\"'
    )

    foreach ($pattern in $patterns) {
        $match = [regex]::Match($html, $pattern)
        if ($match.Success) {
            if ($match.Groups.Count -ge 3 -and -not [string]::IsNullOrWhiteSpace($match.Groups[2].Value)) {
                return $match.Groups[2].Value.Trim()
            }
            return $match.Groups[1].Value.Trim()
        }
    }

    return ""
}

function Get-Cagr {
    param(
        [double]$Current,
        [double]$Base,
        [int]$Years
    )

    if ($Years -le 0 -or $Current -le 0 -or $Base -le 0) {
        return $null
    }

    return ([math]::Pow(($Current / $Base), (1.0 / $Years)) - 1.0) * 100.0
}

function Format-Percent {
    param([object]$Value)
    if ($null -eq $Value -or $Value -eq "") {
        return ""
    }

    return ([math]::Round([double]$Value, 1)).ToString([System.Globalization.CultureInfo]::InvariantCulture)
}

function Get-EpsScore {
    param(
        [object]$EpsYoy,
        [object]$Eps3yCagr,
        [object]$Eps5yCagr
    )

    $score = 0

    $yoy = Normalize-Number ([string]$EpsYoy)
    if ($null -ne $yoy) {
        if ($yoy -ge 80) { $score += 5 }
        elseif ($yoy -ge 40) { $score += 4 }
        elseif ($yoy -ge 20) { $score += 3 }
        elseif ($yoy -ge 0) { $score += 2 }
    }

    $cagr3 = Normalize-Number ([string]$Eps3yCagr)
    if ($null -ne $cagr3) {
        if ($cagr3 -ge 30) { $score += 2 }
        elseif ($cagr3 -ge 10) { $score += 1 }
    }

    $cagr5 = Normalize-Number ([string]$Eps5yCagr)
    if ($null -ne $cagr5) {
        if ($cagr5 -ge 20) { $score += 1 }
    }

    if ($score -lt 0) { return 0 }
    if ($score -gt 8) { return 8 }
    return [int]$score
}

function Get-RevisionScore {
    param([string]$RevisionStatus)

    $status = "unknown"
    if (-not [string]::IsNullOrWhiteSpace($RevisionStatus)) {
        $status = $RevisionStatus.Trim().ToLowerInvariant()
    }

    switch ($status) {
        "profit_up_large" { return 7 }
        "profit_up_mid" { return 5 }
        "profit_up_small" { return 3 }
        "sales_up" { return 1 }
        "none" { return 0 }
        "downward" { return -3 }
        default { return 0 }
    }
}

function Clamp-FinalScore {
    param([int]$Value)
    if ($Value -lt 0) { return 0 }
    if ($Value -gt 15) { return 15 }
    return $Value
}

if (-not (Test-Path -LiteralPath $InputPath)) {
    throw "input file not found: $InputPath"
}

if (-not (Test-Path -LiteralPath $ScoreRulesPath)) {
    throw "score rules not found: $ScoreRulesPath"
}

$inputRows = Import-Csv -LiteralPath $InputPath -Encoding UTF8
$rows = @()

foreach ($row in $inputRows) {
    $code = $row.code
    $name = $row.name
    if ([string]::IsNullOrWhiteSpace($name)) {
        $name = Get-CompanyName -Code $code -HtmlPath (Join-Path $RawDir "$code.html")
    }

    $epsYoy = $row.eps_yoy
    $eps3 = $row.eps_3y_cagr
    $eps5 = $row.eps_5y_cagr

    $epsScore = Get-EpsScore -EpsYoy $epsYoy -Eps3yCagr $eps3 -Eps5yCagr $eps5

    $revisionStatus = ""
    if ($inputRows[0].PSObject.Properties.Name -contains "revision_status") {
        $revisionStatus = [string]$row.revision_status
    }
    if ([string]::IsNullOrWhiteSpace($revisionStatus)) {
        $revisionStatus = "unknown"
    }
    $revisionScore = Get-RevisionScore -RevisionStatus $revisionStatus
    $finalGrowthScore = Clamp-FinalScore -Value ($epsScore + $revisionScore)

    $rows += [pscustomobject]@{
        code = $code
        name = $name
        eps_yoy = $epsYoy
        eps_3y_cagr = $eps3
        eps_5y_cagr = $eps5
        eps_score = $epsScore
        revision_status = $revisionStatus
        revision_score = $revisionScore
        final_growth_score = $finalGrowthScore
    }
}

$rows | Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding UTF8
