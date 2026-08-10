param(
    [string]$TargetPath = "data/target_codes.csv",
    [string]$FinancialDir = "data/output",
    [string]$RawDir = "data/raw",
    [string]$FetchStatusPath = "data/fetch_status.csv",
    [string]$OutputPath = "data/fundamentals.csv",
    [string]$ErrorPath = "logs/fundamental_fetch_errors.csv"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
    }
}

function Normalize-Number([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $v = [System.Net.WebUtility]::HtmlDecode($Value).Trim()
    $v = $v -replace [char]0x00A0, " "
    $v = $v -replace ",", ""
    $v = $v -replace "円|百万円|％|%|倍|回|期|以上", ""
    $v = $v -replace "－|―|--", ""
    $v = $v -replace "\s+", ""
    if ([string]::IsNullOrWhiteSpace($v)) { return $null }
    $number = 0.0
    if ([double]::TryParse($v, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
        return $number
    }
    return $null
}

function Format-Number([object]$Value, [int]$Decimals = 1) {
    if ($null -eq $Value) { return "" }
    $formatted = ([double]$Value).ToString("F$Decimals", [System.Globalization.CultureInfo]::InvariantCulture)
    if ($Decimals -le 0) { return $formatted }
    return $formatted.TrimEnd("0").TrimEnd(".")
}

function Get-PeriodKey([string]$Period) {
    $digits = $Period -replace "\D", ""
    if ([string]::IsNullOrWhiteSpace($digits)) { return 0 }
    return [int]$digits
}

function Get-Field([object]$Row, [int]$Index) {
    if ($null -eq $Row) { return $null }
    $properties = @($Row.PSObject.Properties)
    if ($Index -lt 0 -or $Index -ge $properties.Count) { return $null }
    return [string]$properties[$Index].Value
}

function Get-Cagr([Nullable[double]]$Current, [Nullable[double]]$Base, [int]$Years) {
    if ($null -eq $Current -or $null -eq $Base -or $Years -le 0 -or $Current -le 0 -or $Base -le 0) { return $null }
    return ([math]::Pow(($Current / $Base), (1.0 / $Years)) - 1.0) * 100.0
}

function Get-AverageMargin($Rows, [int]$Years) {
    $items = @($Rows | Select-Object -Last $Years)
    $margins = @()
    foreach ($row in $items) {
        $sales = Normalize-Number (Get-Field $row 1)
        $op = Normalize-Number (Get-Field $row 2)
        if ($null -ne $sales -and $sales -ne 0 -and $null -ne $op) {
            $margins += (($op / $sales) * 100.0)
        }
    }
    if ($margins.Count -eq 0) { return $null }
    return ($margins | Measure-Object -Average).Average
}

function Get-CompanyName([string]$Code, [string]$Text, [string]$HtmlPath) {
    $m = [regex]::Match($Text, "(?m)^\s*" + [regex]::Escape($Code) + "\s+(.+?)\s*$")
    if ($m.Success) { return $m.Groups[1].Value.Trim() }
    if (Test-Path -LiteralPath $HtmlPath) {
        $html = Get-Content -LiteralPath $HtmlPath -Raw -Encoding UTF8
        $patterns = @(
            ("<title>\s*(.+?)\s*\(" + [regex]::Escape($Code) + "\)の企業分析"),
            "class=""stock"" title=""([^""]+)"""
        )
        foreach ($pattern in $patterns) {
            $match = [regex]::Match($html, $pattern)
            if ($match.Success) { return [System.Net.WebUtility]::HtmlDecode($match.Groups[1].Value.Trim()) }
        }
    }
    return ""
}

function Get-FirstRegexNumber([string]$Text, [string[]]$Patterns) {
    foreach ($pattern in $Patterns) {
        $match = [regex]::Match($Text, $pattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
        if ($match.Success) { return Normalize-Number $match.Groups[1].Value }
    }
    return $null
}

function Get-ProfitStreakYears([string]$Text) {
    return Get-FirstRegexNumber $Text @("連続黒字年数（経常利益）\s*([0-9]+)", "連続黒字年数（営業利益）\s*([0-9]+)", "連続黒字年数（当期利益）\s*([0-9]+)")
}

function Test-ForecastLoss([string]$Text) {
    return ($Text -match "赤字予想" -or $Text -match "予想[\s\S]{0,40}赤字" -or $Text -match "営業赤字" -or $Text -match "経常赤字")
}

if (-not (Test-Path -LiteralPath $FinancialDir)) {
    throw "financial directory not found: $FinancialDir"
}

Ensure-Directory (Split-Path $OutputPath -Parent)
Ensure-Directory (Split-Path $ErrorPath -Parent)

if (Test-Path -LiteralPath $TargetPath) {
    $targets = @(Import-Csv -LiteralPath $TargetPath -Encoding UTF8 | Where-Object { -not [string]::IsNullOrWhiteSpace($_.code) })
} else {
    $targets = @(Get-ChildItem -LiteralPath $FinancialDir -Filter "*_financials.csv" | Sort-Object Name | ForEach-Object {
        if ($_.BaseName -match "^(.+)_financials$") { [pscustomobject]@{ code = $Matches[1]; name = "" } }
    })
}

$fetchStatusByCode = @{}
if (Test-Path -LiteralPath $FetchStatusPath) {
    foreach ($status in @(Import-Csv -LiteralPath $FetchStatusPath -Encoding UTF8)) {
        $fetchStatusByCode[[string]$status.code] = $status
    }
}

$rows = @()
# 2026-08-09 修正: if式の出力は配列が単一要素/空のときスカラー・$nullに縮退し、
# エラー行が2件以上発生すると「+=」でop_Addition例外になる既存バグがあったため、
# 全体を@()で包んで常に配列にする(null行も除外)。
$errors = @(if (Test-Path -LiteralPath $ErrorPath) { Import-Csv -LiteralPath $ErrorPath -Encoding UTF8 } ) | Where-Object { $null -ne $_ }
$errors = @($errors)

foreach ($target in $targets) {
    $code = ([string]$target.code).Trim()
    $targetName = ([string]$target.name).Trim()
    $filePath = Join-Path $FinancialDir "$code`_financials.csv"
    $textPath = Join-Path $RawDir "$code.txt"
    $htmlPath = Join-Path $RawDir "$code.html"
    $fetchStatus = if ($fetchStatusByCode.ContainsKey($code)) { $fetchStatusByCode[$code] } else { $null }

    try {
        if ($fetchStatus -and [string]$fetchStatus.fetch_status -eq "failed") { throw "latest fetch failed and no fallback csv exists" }
        if (-not (Test-Path -LiteralPath $filePath)) { throw "financial csv not found" }
        $text = if (Test-Path -LiteralPath $textPath) { Get-Content -LiteralPath $textPath -Raw -Encoding UTF8 } else { "" }
        $financialRows = @(Import-Csv -LiteralPath $filePath -Encoding UTF8 | Sort-Object { Get-PeriodKey (Get-Field $_ 0) })
        if ($financialRows.Count -eq 0) { throw "financial csv has no rows" }

        $latestIndex = $financialRows.Count - 1
        $latest = $financialRows[$latestIndex]
        $base3 = if ($latestIndex -ge 3) { $financialRows[$latestIndex - 3] } else { $null }
        $base5 = if ($latestIndex -ge 5) { $financialRows[$latestIndex - 5] } else { $null }

        $latestSales = Normalize-Number (Get-Field $latest 1)
        $latestOperating = Normalize-Number (Get-Field $latest 2)
        $latestOrdinary = Normalize-Number (Get-Field $latest 3)
        $latestNetIncome = Normalize-Number (Get-Field $latest 4)
        $base3Sales = if ($base3) { Normalize-Number (Get-Field $base3 1) } else { $null }
        $base3Operating = if ($base3) { Normalize-Number (Get-Field $base3 2) } else { $null }
        $base3Ordinary = if ($base3) { Normalize-Number (Get-Field $base3 3) } else { $null }
        $base3NetIncome = if ($base3) { Normalize-Number (Get-Field $base3 4) } else { $null }
        $base5Sales = if ($base5) { Normalize-Number (Get-Field $base5 1) } else { $null }
        $base5Operating = if ($base5) { Normalize-Number (Get-Field $base5 2) } else { $null }
        $base5Ordinary = if ($base5) { Normalize-Number (Get-Field $base5 3) } else { $null }
        $base5NetIncome = if ($base5) { Normalize-Number (Get-Field $base5 4) } else { $null }

        $roe = Get-FirstRegexNumber $text @("実績ROE\s*([\-0-9.,]+)\s*%", "ROE\s*\(実\)\s*([\-0-9.,]+)\s*%")
        $roic = Get-FirstRegexNumber $text @("ROIC\s*([\-0-9.,]+)\s*%", "ROIC\s*\(実\)\s*([\-0-9.,]+)\s*%")
        $equityRatio = Get-FirstRegexNumber $text @("自己資本比率\s*([\-0-9.,]+)\s*%")
        $debtRatio = Get-FirstRegexNumber $text @("有利子負債比率\s*([\-0-9.,]+)\s*%", "有利子負債率\s*([\-0-9.,]+)\s*%")
        $analystRating = Get-FirstRegexNumber $text @("レーティング\s*\(対前週変化\)\s*([\-0-9.,]+)", "レーティング\s*目標株価\(対株価\)\s*([\-0-9.,]+)")
        $targetGap = Get-FirstRegexNumber $text @("目標株価[\s\S]{0,80}\(([\+\-0-9.,]+)\s*%\)", "目標株価\(対株価\)[\s\S]{0,80}([\-0-9.,]+)\s*%\s*(?:割安|割高)")
        $progressRate = Get-FirstRegexNumber $text @("対会社予想進捗率：\s*([\-0-9.,]+)\s*%", "進捗率\s*([\-0-9.,]+)\s*%")
        $dividendIncreaseYears = Get-FirstRegexNumber $text @("連続増配年数（直近実績）\s*([0-9]+)", "年間1株配当\s*予想配当利回り\s*[^\r\n]*?([0-9]+)期連続増配")
        $profitStreakYears = Get-ProfitStreakYears $text
        $currentPrice = Get-FirstRegexNumber $text @("現在値\s*([\-0-9.,]+)\s*円")
        $priceAsOfMatch = [regex]::Match($text, "現在値\s*[\-0-9.,]+\s*円\(([^)]+)\)")
        $priceAsOf = if ($priceAsOfMatch.Success) { $priceAsOfMatch.Groups[1].Value.Trim() } else { "" }

        $resolvedName = Get-CompanyName $code $text $htmlPath
        if ([string]::IsNullOrWhiteSpace($resolvedName)) { $resolvedName = $targetName }
        $metadataFetchedAt = if ($fetchStatus) { [string]$fetchStatus.fetched_at } else { "" }
        $metadataDataAsOf = if ($fetchStatus) { [string]$fetchStatus.data_as_of } else { Get-Field $latest 0 }
        if ([string]::IsNullOrWhiteSpace($metadataDataAsOf)) { $metadataDataAsOf = Get-Field $latest 0 }
        $metadataSourceUpdateDate = if ($fetchStatus) { [string]$fetchStatus.source_update_date } else { "" }
        $metadataFetchStatus = if ($fetchStatus) { [string]$fetchStatus.fetch_status } else { "unknown" }
        $metadataStaleFlag = if ($fetchStatus) { [string]$fetchStatus.stale_flag } else { "true" }
        if ([string]::IsNullOrWhiteSpace($metadataFetchedAt) -or [string]::IsNullOrWhiteSpace($metadataDataAsOf)) { $metadataStaleFlag = "true" }
        $metadataNote = if ($metadataFetchStatus -eq "fallback_used") { "最新取得に失敗したため既存データを使用" } else { "" }

        $rows += [pscustomobject]@{
            code = $code
            name = $resolvedName
            roe = Format-Number $roe
            roic = Format-Number $roic
            equity_ratio = Format-Number $equityRatio
            interest_bearing_debt_ratio = Format-Number $debtRatio
            analyst_rating = Format-Number $analystRating 2
            current_price = Format-Number $currentPrice 1
            price_as_of = $priceAsOf
            target_price_gap = Format-Number $targetGap
            progress_rate = Format-Number $progressRate
            sales_growth_3y = Format-Number (Get-Cagr $latestSales $base3Sales 3)
            sales_growth_5y = Format-Number (Get-Cagr $latestSales $base5Sales 5)
            operating_growth_3y = Format-Number (Get-Cagr $latestOperating $base3Operating 3)
            operating_growth_5y = Format-Number (Get-Cagr $latestOperating $base5Operating 5)
            ordinary_growth_3y = Format-Number (Get-Cagr $latestOrdinary $base3Ordinary 3)
            ordinary_growth_5y = Format-Number (Get-Cagr $latestOrdinary $base5Ordinary 5)
            net_income_growth_3y = Format-Number (Get-Cagr $latestNetIncome $base3NetIncome 3)
            net_income_growth_5y = Format-Number (Get-Cagr $latestNetIncome $base5NetIncome 5)
            operating_margin_3y = Format-Number (Get-AverageMargin $financialRows 3)
            operating_margin_5y = Format-Number (Get-AverageMargin $financialRows 5)
            profit_streak_years = Format-Number $profitStreakYears 0
            dividend_increase_years = Format-Number $dividendIncreaseYears 0
            "黒字継続年数" = Format-Number $profitStreakYears 0
            forecast_loss = if (Test-ForecastLoss $text) { "TRUE" } else { "FALSE" }
            fetched_at = $metadataFetchedAt
            data_as_of = $metadataDataAsOf
            source_update_date = $metadataSourceUpdateDate
            fetch_status = $metadataFetchStatus
            stale_flag = $metadataStaleFlag
            fetch_score_note = $metadataNote
        }
    }
    catch {
        $errors += [pscustomobject]@{
            code = $code
            name = $targetName
            error_type = "fundamentals"
            error_message = $_.Exception.Message
            retry_count = if ($fetchStatus) { [string]$fetchStatus.retry_count } else { "0" }
            fetch_status = if ($fetchStatus) { [string]$fetchStatus.fetch_status } else { "failed" }
            timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        }
    }
}

$rows | Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding UTF8
$errors | Export-Csv -LiteralPath $ErrorPath -NoTypeInformation -Encoding UTF8
Write-Host "Wrote $($rows.Count) rows: $OutputPath"
Write-Host "Wrote $($errors.Count) errors: $ErrorPath"
