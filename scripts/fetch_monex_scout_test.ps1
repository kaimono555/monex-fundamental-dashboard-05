param(
    [string]$BCode = "4063",
    [string]$Url = "",
    [string]$RawDir = "data/raw",
    [string]$LogPath = "logs/run_log.txt"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Url)) {
    $Url = "https://monex.ifis.co.jp/index.php?sa=report_zaimu&bcode=$BCode"
}

$htmlPath = Join-Path $RawDir "$BCode.html"
$textPath = Join-Path $RawDir "$BCode.txt"

function Ensure-Directory {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
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
    $text = [regex]::Replace($text, "(?i)</(p|div|tr|li|h[1-6]|table|section|article)>", "`n")
    $text = [regex]::Replace($text, "(?is)<[^>]+>", " ")
    $text = [System.Net.WebUtility]::HtmlDecode($text)
    $text = [regex]::Replace($text, "[ \t]+", " ")
    $text = [regex]::Replace($text, "(\r?\n\s*){2,}", "`n")
    return $text.Trim()
}

try {
    Ensure-Directory $RawDir
    Ensure-Directory (Split-Path $LogPath -Parent)

    Write-RunLog "START fetch bcode=$BCode url=$Url"

    $headers = @{
        "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
        "Accept" = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        "Accept-Language" = "ja,en-US;q=0.9,en;q=0.8"
    }

    try {
        $response = Invoke-WebRequest -Uri $Url -Headers $headers -MaximumRedirection 5 -TimeoutSec 30 -UseBasicParsing
        Write-RunLog "URLアクセス成功 status=$($response.StatusCode) bcode=$BCode"
    }
    catch {
        Write-RunLog "URLアクセス失敗 bcode=$BCode error=$($_.Exception.Message)"
        throw
    }

    $html = $response.Content
    if ([string]::IsNullOrWhiteSpace($html)) {
        Write-RunLog "HTML取得失敗 bcode=$BCode error=empty response body"
        throw "empty response body"
    }

    Set-Content -Path $htmlPath -Value $html -Encoding UTF8
    Write-RunLog "HTML取得成功 path=$htmlPath bytes=$([System.Text.Encoding]::UTF8.GetByteCount($html))"

    if ($html -match "認証されたユーザ|ログインページ|login") {
        Write-RunLog "認証ページ検出 bcode=$BCode note=ログインなしでは財務ページ本文を取得できない可能性があります"
    }

    $bodyText = Convert-HtmlToText $html
    if ([string]::IsNullOrWhiteSpace($bodyText)) {
        Write-RunLog "本文テキスト取得失敗 bcode=$BCode error=empty text"
        throw "empty page text"
    }

    Set-Content -Path $textPath -Value $bodyText -Encoding UTF8
    Write-RunLog "本文テキスト取得成功 path=$textPath chars=$($bodyText.Length)"

    Write-RunLog "END fetch bcode=$BCode result=success"
}
catch {
    Write-RunLog "END fetch bcode=$BCode result=failed error=$($_.Exception.Message)"
    exit 1
}


