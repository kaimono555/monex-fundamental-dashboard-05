param(
    [string]$BCode = "4063",
    [string]$LoginUrl = "https://www.monex.co.jp/",
    [string]$TargetUrl = "",
    [string]$UserDataDir = "data/playwright-profile/monex-login-profile",
    [string]$ChromeExecutablePath = "",
    [string]$RawDir = "data/raw",
    [string]$LogPath = "logs/run_log.txt"
)

$ErrorActionPreference = "Stop"

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

function ConvertTo-ProcessArgument {
    param([string]$Value)
    if ($null -eq $Value) {
        return '""'
    }
    return '"' + ($Value -replace '"', '\"') + '"'
}

if ([string]::IsNullOrWhiteSpace($TargetUrl)) {
    $TargetUrl = "https://monex.ifis.co.jp/index.php?sa=report_zaimu&bcode=$BCode"
}

if ([string]::IsNullOrWhiteSpace($ChromeExecutablePath)) {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            $ChromeExecutablePath = $candidate
            break
        }
    }
}

try {
    Ensure-Directory $UserDataDir
    Ensure-Directory $RawDir
    Ensure-Directory (Split-Path $LogPath -Parent)

    if ([string]::IsNullOrWhiteSpace($ChromeExecutablePath) -or -not (Test-Path -LiteralPath $ChromeExecutablePath)) {
        Write-RunLog "ログイン監視起動失敗 error=Chrome executable not found"
        throw "Chrome executable not found"
    }

    $nodeScript = Join-Path $PSScriptRoot "playwright_login_watch_save.js"
    $nodeArgs = @(
        $nodeScript,
        "--bcode", $BCode,
        "--login-url", $LoginUrl,
        "--target-url", $TargetUrl,
        "--user-data-dir", $UserDataDir,
        "--chrome-executable", $ChromeExecutablePath,
        "--raw-dir", $RawDir,
        "--log-path", $LogPath
    )
    $argumentList = ($nodeArgs | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join " "

    Write-RunLog "ログイン監視Chrome起動開始 bcode=$BCode loginUrl=$LoginUrl targetUrl=$TargetUrl userDataDir=$UserDataDir"
    $process = Start-Process -FilePath "node" -ArgumentList $argumentList -WindowStyle Hidden -PassThru
    Write-RunLog "ログイン監視Chrome起動済み pid=$($process.Id) note=Chromeを閉じずに4063ページへ移動すると自動保存します"

    Write-Output "Chromeを起動しました。ログイン後、同じChromeで以下URLへ移動してください。"
    Write-Output $TargetUrl
    Write-Output "4063ページを検出すると data/raw/$BCode.html と data/raw/$BCode.txt を保存します。Chromeは閉じないで構いません。"
}
catch {
    Write-RunLog "ログイン監視起動失敗 error=$($_.Exception.Message)"
    exit 1
}

