param(
    [string]$BCode = "4063",
    [string]$RawDir = "data/raw",
    [string]$OutputDir = "data/output",
    [string]$LogPath = "logs/run_log.txt"
)

$ErrorActionPreference = "Stop"

# ヘッダー検証型パーサ共通関数（2026-08-09 改修: 固定列位置依存を廃止）
. (Join-Path $PSScriptRoot "parse_financials_core.ps1")

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

# 2026-08-09 改修: 固定列位置(columns[1],[3],[5],[7],[9])と固定HTMLクラス位置への依存を廃止し、
# 見出し検証型(parse_financials_core.ps1)へ移行。
#  - テーブルの見出しを取得・検証してから、見出し名で列位置を動的に決定する。
#  - 必須見出し欠落/重複/未知見出し/行と見出しの列数不一致は PARSER_SCHEMA_MISMATCH として
#    Fail Closed し、CSVを書かない(exit 1)。呼び出し元(fetch_target_financials.ps1)が
#    parse_failed として前回CSV維持+fallback_used(stale)で処理する。
#  - New速報行・会社予想行・四半期テーブル(区分見出し)は構造で区別して除外する。

try {
    Ensure-Directory $OutputDir
    Ensure-Directory (Split-Path $LogPath -Parent)

    Write-RunLog "START parse bcode=$BCode text=$textPath html=$htmlPath"

    $sourceText = Get-SourceText
    Test-AuthenticatedFinancialText $sourceText

    $parsedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $source = "text"
    $parsed = Parse-AnnualFromText -Text $sourceText

    if ($parsed.status -eq "absent" -and (Test-Path -LiteralPath $htmlPath)) {
        # テキスト側に通期テーブルが存在しない(折りたたみ未展開等)場合のみHTMLへフォールバック。
        # HTML側も同じ見出し検証を行い、通期業績推移セクション内のテーブルだけを対象にする
        # (従来のdetail_year位置依存はCF表・進捗表の値を業績として誤取込していたため廃止)。
        $html = Get-Content -Path $htmlPath -Raw -Encoding UTF8
        $source = "html"
        $parsed = Parse-AnnualFromHtml -Html $html
    }

    if ($parsed.status -eq "mismatch") {
        $rawRef = if ($source -eq "html") { $htmlPath } else { $textPath }
        foreach ($line in (Format-SchemaMismatchLogLines -BCode $BCode -FetchedAt $parsedAt `
                -Mismatches $parsed.mismatches -RawPath $rawRef)) {
            Write-RunLog $line
        }
        Write-RunLog "テーブル抽出失敗 bcode=$BCode error=PARSER_SCHEMA_MISMATCH source=$source"
        throw "PARSER_SCHEMA_MISMATCH"
    }

    foreach ($ex in @($parsed.excluded)) {
        if ($ex.reason -eq "new_flash_row") {
            Write-RunLog "速報行除外 bcode=$BCode row=$([string]$ex.row)"
        }
    }
    foreach ($w in @($parsed.warnings)) {
        Write-RunLog ("PARSER_SCHEMA_WARNING bcode=$BCode table=$($w.table) reason=$($w.reason) " +
                      "headers_found=$($w.headersFound) (検証済みテーブルから取得済みのため続行)")
    }

    $records = @($parsed.records)
    if ($records.Count -eq 0) {
        Write-RunLog "テーブル抽出失敗 bcode=$BCode error=financial rows not found source=$source"
        throw "financial rows not found"
    }

    $records | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8
    Write-RunLog "テーブル抽出成功 path=$csvPath rows=$($records.Count) source=$source"
    Write-RunLog "END parse bcode=$BCode result=success"
}
catch {
    Write-RunLog "END parse bcode=$BCode result=failed error=$($_.Exception.Message)"
    exit 1
}

