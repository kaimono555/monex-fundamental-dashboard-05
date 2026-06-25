param(
    [string]$InputDir = "data/output",
    [string]$RawDir = "data/raw",
    [string]$OutputPath = "growth_metrics.csv"
)

$ErrorActionPreference = "Stop"

function Normalize-Number {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $null
    }

    $v = $Value.Trim() -replace ",", ""
    $number = 0.0
    if ([double]::TryParse($v, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
        return $number
    }

    return $null
}

function Get-PeriodKey {
    param([string]$Period)
    $digits = $Period -replace "\D", ""
    if ([string]::IsNullOrWhiteSpace($digits)) {
        return 0
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

    $html = Get-Content -LiteralPath $HtmlPath -Raw -Encoding UTF8
    $titlePattern = "<title>\s*(.+?)\s*\($([regex]::Escape($Code))\)の企業分析\s*-\s*銘柄スカウター</title>"
    $match = [regex]::Match($html, $titlePattern)
    if ($match.Success) {
        return [System.Net.WebUtility]::HtmlDecode($match.Groups[1].Value.Trim())
    }

    $jsonPattern = '"code"\s*:\s*"' + [regex]::Escape($Code) + '".{0,200}?"NAME"\s*:\s*"([^"]+)"'
    $match = [regex]::Match($html, $jsonPattern)
    if ($match.Success) {
        return [regex]::Unescape($match.Groups[1].Value)
    }

    return ""
}

function Get-Field {
    param(
        [object]$Row,
        [int]$Index
    )

    if ($null -eq $Row) {
        return $null
    }

    $properties = @($Row.PSObject.Properties)
    if ($Index -lt 0 -or $Index -ge $properties.Count) {
        return $null
    }

    return [string]$properties[$Index].Value
}

function Get-Cagr {
    param(
        [Nullable[double]]$Current,
        [Nullable[double]]$Base,
        [int]$Years
    )

    if ($null -eq $Current -or $null -eq $Base -or $Years -le 0 -or $Current -le 0 -or $Base -le 0) {
        return $null
    }

    return ([math]::Pow(($Current / $Base), (1.0 / $Years)) - 1.0) * 100.0
}

function Get-Yoy {
    param(
        [Nullable[double]]$Current,
        [Nullable[double]]$Previous
    )

    if ($null -eq $Current -or $null -eq $Previous -or $Previous -eq 0) {
        return $null
    }

    return (($Current - $Previous) / [math]::Abs($Previous)) * 100.0
}

function Find-LatestNumericIndex {
    param(
        [array]$Rows,
        [int]$FieldIndex
    )

    for ($i = $Rows.Count - 1; $i -ge 0; $i -= 1) {
        $value = Normalize-Number (Get-Field -Row $Rows[$i] -Index $FieldIndex)
        if ($null -ne $value) {
            return $i
        }
    }

    return -1
}

function Format-Metric {
    param([object]$Value)
    if ($null -eq $Value) {
        return ""
    }

    return ([math]::Round([double]$Value, 1)).ToString([System.Globalization.CultureInfo]::InvariantCulture)
}

if (-not (Test-Path -LiteralPath $InputDir)) {
    throw "input directory not found: $InputDir"
}

$financialFiles = Get-ChildItem -LiteralPath $InputDir -Filter "*_financials.csv" | Sort-Object Name
if ($financialFiles.Count -eq 0) {
    throw "financial csv files not found: $InputDir"
}

$rows = @()

foreach ($file in $financialFiles) {
    if ($file.BaseName -notmatch "^(.+)_financials$") {
        continue
    }

    $code = $Matches[1]
    $financialRows = Import-Csv -LiteralPath $file.FullName -Encoding UTF8 |
        Sort-Object { Get-PeriodKey (Get-Field -Row $_ -Index 0) }

    if ($financialRows.Count -eq 0) {
        continue
    }

    $latestIndex = $financialRows.Count - 1
    $latest = $financialRows[$latestIndex]
    $previous = if ($latestIndex -ge 1) { $financialRows[$latestIndex - 1] } else { $null }
    $base3 = if ($latestIndex -ge 3) { $financialRows[$latestIndex - 3] } else { $null }
    $base5 = if ($latestIndex -ge 5) { $financialRows[$latestIndex - 5] } else { $null }

    $epsIndex = Find-LatestNumericIndex -Rows $financialRows -FieldIndex 5
    if ($epsIndex -ge 0) {
        $latestEps = Normalize-Number (Get-Field -Row $financialRows[$epsIndex] -Index 5)
        $previousEps = if ($epsIndex -ge 1) { Normalize-Number (Get-Field -Row $financialRows[$epsIndex - 1] -Index 5) } else { $null }
        $base3Eps = if ($epsIndex -ge 3) { Normalize-Number (Get-Field -Row $financialRows[$epsIndex - 3] -Index 5) } else { $null }
        $base5Eps = if ($epsIndex -ge 5) { Normalize-Number (Get-Field -Row $financialRows[$epsIndex - 5] -Index 5) } else { $null }
    } else {
        $latestEps = $null
        $previousEps = $null
        $base3Eps = $null
        $base5Eps = $null
    }

    $latestSales = Normalize-Number (Get-Field -Row $latest -Index 1)
    $base5Sales = if ($null -ne $base5) { Normalize-Number (Get-Field -Row $base5 -Index 1) } else { $null }
    $latestOrdinaryProfit = Normalize-Number (Get-Field -Row $latest -Index 3)
    $base5OrdinaryProfit = if ($null -ne $base5) { Normalize-Number (Get-Field -Row $base5 -Index 3) } else { $null }

    $metrics = @(
        Get-Yoy -Current $latestEps -Previous $previousEps
        Get-Cagr -Current $latestEps -Base $base3Eps -Years 3
        Get-Cagr -Current $latestEps -Base $base5Eps -Years 5
        Get-Cagr -Current $latestSales -Base $base5Sales -Years 5
        Get-Cagr -Current $latestOrdinaryProfit -Base $base5OrdinaryProfit -Years 5
    )

    $availableMetrics = $metrics | Where-Object { $null -ne $_ }
    $growthScore = if ($availableMetrics.Count -gt 0) {
        ($availableMetrics | Measure-Object -Average).Average
    } else {
        $null
    }

    $rows += [pscustomobject]@{
        code = $code
        name = Get-CompanyName -Code $code -HtmlPath (Join-Path $RawDir "$code.html")
        eps_yoy = Format-Metric $metrics[0]
        eps_3y_cagr = Format-Metric $metrics[1]
        eps_5y_cagr = Format-Metric $metrics[2]
        sales_5y_cagr = Format-Metric $metrics[3]
        ordinary_profit_5y_cagr = Format-Metric $metrics[4]
        growth_score = Format-Metric $growthScore
    }
}

$rows | Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding UTF8
