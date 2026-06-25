param(
    [string]$BCode = "4063",
    [string]$RawDir = "data/raw",
    [string]$OutputDir = "data/output",
    [string]$LogPath = "logs/run_log.txt"
)

$ErrorActionPreference = "Stop"

$textPath = Join-Path $RawDir "$BCode.txt"
$htmlPath = Join-Path $RawDir "$BCode.html"
$csvPath = Join-Path $OutputDir "$BCode`_financials.csv"

function Ensure-Directory {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path | Out-Null
    }
}

function Write-RunLog {
    param([string]$Message)
    $dir = Split-Path $LogPath -Parent
    Ensure-Directory $dir
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LogPath -Value "[$timestamp] $Message" -Encoding UTF8
}

function Normalize-FinancialValue {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }

    $v = [System.Net.WebUtility]::HtmlDecode($Value).Trim()
    $v = $v -replace [char]0x00A0, " "
    $v = $v -replace ",", ""
    $v = $v -replace "円|百万円|％|%", ""
    $v = $v -replace "\s+", ""

    if ($v -match "^[-－―]+$") {
        return ""
    }

    return $v
}

function Convert-HtmlToText {
    param([string]$Html)
    $text = $Html
    $text = [regex]::Replace($text, "(?is)<script\b[^>]*>.*?</script>", "`n")
    $text = [regex]::Replace($text, "(?is)<style\b[^>]*>.*?</style>", "`n")
    $text = [regex]::Replace($text, "(?i)<br\s*/?>", "`n")
    $text = [regex]::Replace($text, "(?i)</(td|th)>", "`t")
    $text = [regex]::Replace($text, "(?i)</(tr|p|div|li|h[1-6]|table|section|article)>", "`n")
    $text = [regex]::Replace($text, "(?is)<[^>]+>", " ")
    $text = [System.Net.WebUtility]::HtmlDecode($text)
    $text = [regex]::Replace($text, "[ \t]+", "`t")
    $text = [regex]::Replace($text, "(\r?\n\s*){2,}", "`n")
    return $text.Trim()
}

function Get-SourceText {
    if (Test-Path -LiteralPath $textPath) {
        return Get-Content -Path $textPath -Raw -Encoding UTF8
    }

    if (Test-Path -LiteralPath $htmlPath) {
        $html = Get-Content -Path $htmlPath -Raw -Encoding UTF8
        return Convert-HtmlToText $html
    }

    throw "source file not found: $textPath or $htmlPath"
}

function Test-AuthenticatedFinancialText {
    param([string]$Text)

    if ($Text -match "認証されたユーザのみ") {
        throw "authentication page detected"
    }

    $hasFiscalPeriod = $Text -match "\d{4}/\d{2}"
    $hasMetric = $Text -match "売上高" -and $Text -match "営業利益" -and $Text -match "経常利益" -and $Text -match "当期利益"

    if (-not $hasFiscalPeriod -or -not $hasMetric) {
        throw "financial markers not found"
    }
}

function Parse-FinancialsFromText {
    param([string]$Text)

    $records = @()
    $lines = $Text -split "\r?\n"

    foreach ($line in $lines) {
        $trimmed = $line.Trim()
        if ($trimmed -notmatch "^\d{4}/\d{2}\b") {
            continue
        }

        $columns = $trimmed -split "`t+"
        if ($columns.Count -lt 10) {
            $columns = [regex]::Split($trimmed, "\s{2,}")
        }

        if ($columns.Count -lt 9) {
            continue
        }

        $period = $columns[0].Trim()
        if ($period -notmatch "^\d{4}/\d{2}") {
            continue
        }

        $sales = Normalize-FinancialValue $columns[1]
        $operatingProfit = Normalize-FinancialValue $columns[3]
        $ordinaryProfit = Normalize-FinancialValue $columns[5]
        $netIncome = Normalize-FinancialValue $columns[7]
        $eps = if ($columns.Count -ge 10) { Normalize-FinancialValue $columns[9] } else { "" }
        $bps = if ($columns.Count -ge 11) { Normalize-FinancialValue $columns[10] } else { "" }

        if ([string]::IsNullOrWhiteSpace($sales) -or [string]::IsNullOrWhiteSpace($operatingProfit) -or [string]::IsNullOrWhiteSpace($ordinaryProfit) -or [string]::IsNullOrWhiteSpace($netIncome)) {
            continue
        }

        $records += [pscustomobject]@{
            "決算期" = $period
            "売上高" = $sales
            "営業利益" = $operatingProfit
            "経常利益" = $ordinaryProfit
            "当期利益" = $netIncome
            "EPS" = $eps
            "BPS" = $bps
        }
    }

    $unique = @{}
    foreach ($record in $records) {
        if (-not $unique.ContainsKey($record."決算期")) {
            $unique[$record."決算期"] = $record
        }
    }

    return $unique.Values | Sort-Object "決算期"
}

function Strip-HtmlCell {
    param([string]$Html)
    $text = [regex]::Replace($Html, "(?is)<script\b[^>]*>.*?</script>", "")
    $text = [regex]::Replace($text, "(?is)<style\b[^>]*>.*?</style>", "")
    $text = [regex]::Replace($text, "(?is)<[^>]+>", "")
    $text = [System.Net.WebUtility]::HtmlDecode($text)
    $text = $text -replace [char]0x00A0, " "
    return ($text -replace "\s+", " ").Trim()
}

function Parse-FinancialsFromHtml {
    param([string]$Html)

    $records = @()
    $rowMatches = [regex]::Matches($Html, "(?is)<tr\b[^>]*>.*?<td\b[^>]*class=""detail_year""[^>]*>.*?</tr>")
    foreach ($rowMatch in $rowMatches) {
        $rowHtml = $rowMatch.Value
        if ($rowHtml -match "class=""detail_type""") {
            continue
        }

        $cellMatches = [regex]::Matches($rowHtml, "(?is)<td\b([^>]*)>(.*?)</td>")
        if ($cellMatches.Count -lt 5) {
            continue
        }

        $period = Strip-HtmlCell $cellMatches[0].Groups[2].Value
        if ($period -notmatch "^\d{4}/\d{2}") {
            continue
        }

        $values = @()
        for ($i = 1; $i -lt $cellMatches.Count; $i += 1) {
            $attrs = $cellMatches[$i].Groups[1].Value
            if ($attrs -notmatch "detail_num") {
                continue
            }
            $values += (Normalize-FinancialValue (Strip-HtmlCell $cellMatches[$i].Groups[2].Value))
        }

        if ($values.Count -lt 4) {
            continue
        }

        $sales = $values[0]
        $operatingProfit = $values[1]
        $ordinaryProfit = $values[2]
        $netIncome = $values[3]

        if ([string]::IsNullOrWhiteSpace($operatingProfit)) {
            $operatingProfit = $ordinaryProfit
        }
        if ([string]::IsNullOrWhiteSpace($netIncome) -and $values.Count -ge 7) {
            $netIncome = $values[6]
        }

        if ([string]::IsNullOrWhiteSpace($sales) -or [string]::IsNullOrWhiteSpace($ordinaryProfit) -or [string]::IsNullOrWhiteSpace($netIncome)) {
            continue
        }

        $eps = if ($values.Count -ge 8) { $values[7] } else { "" }
        $bps = if ($values.Count -ge 9) { $values[8] } else { "" }

        $records += [pscustomobject]@{
            "決算期" = $period
            "売上高" = $sales
            "営業利益" = $operatingProfit
            "経常利益" = $ordinaryProfit
            "当期利益" = $netIncome
            "EPS" = $eps
            "BPS" = $bps
        }
    }

    $unique = @{}
    foreach ($record in $records) {
        if (-not $unique.ContainsKey($record."決算期")) {
            $unique[$record."決算期"] = $record
        }
    }

    return $unique.Values | Sort-Object "決算期"
}

try {
    Ensure-Directory $OutputDir
    Ensure-Directory (Split-Path $LogPath -Parent)

    Write-RunLog "START parse bcode=$BCode text=$textPath html=$htmlPath"

    $sourceText = Get-SourceText
    Test-AuthenticatedFinancialText $sourceText

    $records = Parse-FinancialsFromText $sourceText
    if ($records.Count -eq 0 -and (Test-Path -LiteralPath $htmlPath)) {
        $html = Get-Content -Path $htmlPath -Raw -Encoding UTF8
        $records = Parse-FinancialsFromHtml $html
    }
    if ($records.Count -eq 0) {
        Write-RunLog "テーブル抽出失敗 bcode=$BCode error=financial rows not found"
        throw "financial rows not found"
    }

    $records | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8
    Write-RunLog "テーブル抽出成功 path=$csvPath rows=$($records.Count) source=text"
    Write-RunLog "END parse bcode=$BCode result=success"
}
catch {
    Write-RunLog "END parse bcode=$BCode result=failed error=$($_.Exception.Message)"
    exit 1
}

