param(
    [string]$BCode = "4063",
    [string]$RawDir = "data/raw",
    [string]$OutputDir = "data/output_extended",
    [string]$LogPath = "logs/run_log_extended.txt",
    [string]$DataAsOf = ""
)

# 既存の parse_financials.ps1 / data/output / 既存CSV形式には一切影響しない独立出力先。
# 05の取得ロジック（fetch系スクリプト）は変更しない。data/raw/{code}.txt の
# 「キャッシュフロー推移」セクションのみが展開済みで保存されているため対象とする。
# 「有利子負債」セクション（総資産・自己資本・有利子負債・純有利子負債の年次推移）は
# 全銘柄で未展開のまま保存されており、生テキストに実数値が存在しないため今回は対象外。

$ErrorActionPreference = "Stop"

$textPath = Join-Path $RawDir "$BCode.txt"
$cashflowCsvPath = Join-Path $OutputDir "$BCode`_cashflow.csv"
$indicatorsCsvPath = Join-Path $OutputDir "$BCode`_latest_indicators.csv"
$forecastCsvPath = Join-Path $OutputDir "$BCode`_eps_forecast.csv"

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

function Normalize-Value {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }
    $v = [System.Net.WebUtility]::HtmlDecode($Value).Trim()
    $v = $v -replace [char]0x00A0, " "
    $v = $v -replace ",", ""
    $v = $v -replace "円|百万円|倍|％|%", ""
    $v = $v -replace "\s+", ""
    if ($v -match "^[-－―]+$" -or $v -eq "") {
        return ""
    }
    return $v
}

function Get-SourceText {
    if (-not (Test-Path -LiteralPath $textPath)) {
        throw "source file not found: $textPath"
    }
    return Get-Content -Path $textPath -Raw -Encoding UTF8
}

function Test-AuthenticatedFinancialText {
    param([string]$Text)
    if ($Text -match "認証されたユーザのみ") {
        throw "authentication page detected"
    }
}

function Get-SectionSlice {
    param([string]$Text, [string]$StartMarker, [string]$EndMarker, [int]$FallbackLength = 4000)
    $startIdx = $Text.IndexOf($StartMarker)
    if ($startIdx -lt 0) {
        return ""
    }
    $searchFrom = $startIdx + $StartMarker.Length
    $endIdx = -1
    if ($EndMarker) {
        $endIdx = $Text.IndexOf($EndMarker, $searchFrom)
    }
    if ($endIdx -lt 0) {
        $endIdx = [Math]::Min($Text.Length, $searchFrom + $FallbackLength)
    }
    return $Text.Substring($startIdx, $endIdx - $startIdx)
}

function Parse-CashflowSeries {
    param([string]$Text)

    $section = Get-SectionSlice -Text $Text -StartMarker "キャッシュフロー推移" -EndMarker "貸借対照表"
    if ([string]::IsNullOrWhiteSpace($section)) {
        return @()
    }

    $records = @()
    $lines = $section -split "\r?\n"
    foreach ($line in $lines) {
        if ($line -match '^(\d{4}/\d{2}(?:\s+[SI])?)予?\t([^\t]*)\t([^\t]*)\t([^\t]*)\t([^\t]*)\t([^\t]*)\s*$') {
            $period = $Matches[1]
            $records += [pscustomobject]@{
                "決算期" = $period
                "営業CF" = Normalize-Value $Matches[2]
                "投資CF" = Normalize-Value $Matches[3]
                "財務CF" = Normalize-Value $Matches[4]
                "現金同等物" = Normalize-Value $Matches[5]
                "フリーCF" = Normalize-Value $Matches[6]
            }
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

function Parse-EpsForecast {
    param([string]$Text)

    if ($Text -match '(?m)^(\d{4}/\d{2})予\t([^\t]*)\t([^\t]*)\t([^\t]*)\t([^\t]*)\t([^\t]*)\t([^\t]*)\t([^\t]*)\t([^\t]*)\t([^\t]*)\t([^\t]*)\s*$') {
        return [pscustomobject]@{
            "決算期" = $Matches[1] + "予"
            "EPS予想" = Normalize-Value $Matches[10]
            "区分" = "会社予想"
        }
    }
    return $null
}

function Parse-LatestIndicators {
    param([string]$Text)

    $anchorIdx = $Text.IndexOf("指標一覧")
    if ($anchorIdx -lt 0) {
        return $null
    }
    $section = $Text.Substring($anchorIdx)

    function Get-LabelValue {
        param([string]$Section, [string]$Label)
        $escaped = [regex]::Escape($Label)
        if ($Section -match "(?m)^$escaped\t([^\t\r\n]+)") {
            return Normalize-Value $Matches[1]
        }
        return ""
    }

    return [pscustomobject]@{
        "ROE" = Get-LabelValue $section "実績ROE"
        "ROIC" = Get-LabelValue $section "ROIC"
        "PER予想" = Get-LabelValue $section "予想PER（会社予想）"
        "PBR" = Get-LabelValue $section "PBR"
        "自己資本比率" = Get-LabelValue $section "自己資本比率"
        "有利子負債比率" = Get-LabelValue $section "有利子負債比率"
        "ネットD_Eレシオ" = Get-LabelValue $section "ネットD/Eレシオ"
    }
}

try {
    Ensure-Directory $OutputDir
    Ensure-Directory (Split-Path $LogPath -Parent)

    Write-RunLog "START parse_extended bcode=$BCode text=$textPath"

    $sourceText = Get-SourceText
    Test-AuthenticatedFinancialText $sourceText

    $asOf = $DataAsOf
    if ([string]::IsNullOrWhiteSpace($asOf)) {
        $asOf = (Get-Item -LiteralPath $textPath).LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
    }

    $cashflowRecords = Parse-CashflowSeries $sourceText
    if ($cashflowRecords.Count -gt 0) {
        $cashflowRecords | Export-Csv -Path $cashflowCsvPath -NoTypeInformation -Encoding UTF8
        Write-RunLog "cashflow抽出成功 bcode=$BCode rows=$($cashflowRecords.Count)"
    } else {
        Write-RunLog "cashflow抽出失敗 bcode=$BCode rows=0"
    }

    $indicators = Parse-LatestIndicators $sourceText
    if ($indicators) {
        $indicators | Add-Member -NotePropertyName "data_as_of" -NotePropertyValue $asOf
        @($indicators) | Export-Csv -Path $indicatorsCsvPath -NoTypeInformation -Encoding UTF8
        Write-RunLog "latest_indicators抽出成功 bcode=$BCode"
    } else {
        Write-RunLog "latest_indicators抽出失敗 bcode=$BCode"
    }

    $forecast = Parse-EpsForecast $sourceText
    if ($forecast) {
        @($forecast) | Export-Csv -Path $forecastCsvPath -NoTypeInformation -Encoding UTF8
        Write-RunLog "eps_forecast抽出成功 bcode=$BCode"
    } else {
        Write-RunLog "eps_forecast抽出なし bcode=$BCode（会社予想行が生テキストに存在しない）"
    }

    Write-RunLog "END parse_extended bcode=$BCode result=success"
}
catch {
    Write-RunLog "END parse_extended bcode=$BCode result=failed error=$($_.Exception.Message)"
    exit 1
}
