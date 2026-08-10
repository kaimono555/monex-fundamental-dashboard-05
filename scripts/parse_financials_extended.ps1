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

# ヘッダー検証型パーサ共通関数（2026-08-09 改修: 固定フィールド数regex依存を廃止）
. (Join-Path $PSScriptRoot "parse_financials_core.ps1")

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

# Normalize-Value は parse_financials_core.ps1 の共通実装（同一仕様）を使用する

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

# 2026-08-09 改修: Parse-CashflowSeries / Parse-EpsForecast の固定フィールド数regexを廃止し、
# 見出し検証型(parse_financials_core.ps1)へ移行。
#  - CF: 見出し(決算期/営業CF/投資CF/財務CF/現金・現金等価物/フリーCF)から列位置を動的決定。
#    見出し不一致・行列数不一致は PARSER_SCHEMA_MISMATCH (Fail Closed、CSV未更新)。
#  - EPS予想: 「予想行が本当に存在しない(→抽出なし)」と「予想行はあるが既知形式に
#    一致しない(→PARSER_SCHEMA_MISMATCH、対象行をログ)」を区別する。
#    New速報行(EPS列なしの速報値テーブル)は後者として扱う。

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

    $schemaMismatch = $false

    $cfResult = Parse-CashflowFromText -Text $sourceText
    if ($cfResult.status -eq "ok") {
        $cfResult.records | Export-Csv -Path $cashflowCsvPath -NoTypeInformation -Encoding UTF8
        Write-RunLog "cashflow抽出成功 bcode=$BCode rows=$($cfResult.records.Count)"
    } elseif ($cfResult.status -eq "mismatch") {
        $schemaMismatch = $true
        foreach ($line in (Format-SchemaMismatchLogLines -BCode $BCode -FetchedAt $asOf `
                -Mismatches $cfResult.mismatches -RawPath $textPath)) {
            Write-RunLog $line
        }
        Write-RunLog "cashflow抽出失敗 bcode=$BCode error=PARSER_SCHEMA_MISMATCH（前回CSVを維持）"
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

    $fcResult = Parse-EpsForecastFromText -Text $sourceText
    if ($fcResult.status -eq "ok") {
        @($fcResult.record) | Export-Csv -Path $forecastCsvPath -NoTypeInformation -Encoding UTF8
        Write-RunLog "eps_forecast抽出成功 bcode=$BCode"
    } elseif ($fcResult.status -eq "mismatch") {
        $schemaMismatch = $true
        foreach ($line in (Format-SchemaMismatchLogLines -BCode $BCode -FetchedAt $asOf `
                -Mismatches $fcResult.mismatches -RawPath $textPath)) {
            Write-RunLog $line
        }
        Write-RunLog "eps_forecast抽出失敗 bcode=$BCode error=PARSER_SCHEMA_MISMATCH（予想行はあるが既知形式に一致しない。前回CSVを維持）"
    } else {
        Write-RunLog "eps_forecast抽出なし bcode=$BCode（会社予想行が生テキストに存在しない）"
    }

    if ($schemaMismatch) {
        # 正常に解釈できたセクションは保存済み。不一致セクションはCSV未更新のまま
        # 失敗として明示する（呼び出し元では拡張パース失敗は非致命として扱われる）。
        Write-RunLog "END parse_extended bcode=$BCode result=failed error=PARSER_SCHEMA_MISMATCH"
        exit 1
    }

    Write-RunLog "END parse_extended bcode=$BCode result=success"
}
catch {
    Write-RunLog "END parse_extended bcode=$BCode result=failed error=$($_.Exception.Message)"
    exit 1
}
