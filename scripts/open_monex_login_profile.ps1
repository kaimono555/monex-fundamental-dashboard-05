param(
    [string]$LoginUrl = "https://www.monex.co.jp/",
    [string]$UserDataDir = "data/playwright-profile/monex-login-profile",
    [string]$ChromeExecutablePath = "",
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
    Ensure-Directory (Split-Path $LogPath -Parent)

    if ([string]::IsNullOrWhiteSpace($ChromeExecutablePath) -or -not (Test-Path -LiteralPath $ChromeExecutablePath)) {
        Write-RunLog "Playwright専用ログインプロファイル起動失敗 error=Chrome executable not found"
        throw "Chrome executable not found"
    }

    $nodeScript = Join-Path $PSScriptRoot "playwright_monex_login_profile.js"
    $nodeArgs = @(
        $nodeScript,
        "--mode", "login",
        "--login-url", $LoginUrl,
        "--user-data-dir", $UserDataDir,
        "--chrome-executable", $ChromeExecutablePath,
        "--log-path", $LogPath
    )
    $argumentList = ($nodeArgs | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join " "

    Write-RunLog "Playwright専用ログインプロファイル起動開始 loginUrl=$LoginUrl userDataDir=$UserDataDir"
    $process = Start-Process -FilePath "node" -ArgumentList $argumentList -WindowStyle Hidden -PassThru
    Write-RunLog "Playwright専用ログインプロファイル起動済み pid=$($process.Id) note=Chromeで手動ログイン後、Chromeウィンドウを閉じてください"

    Write-Output "Chromeを起動しました。マネックスに手動ログインし、ログイン完了後にChromeウィンドウを閉じてください。"
    Write-Output "その後、fetch_monex_with_login_profile.ps1 を実行すると同じ専用プロファイルで取得判定します。"
}
catch {
    Write-RunLog "Playwright専用ログインプロファイル起動失敗 error=$($_.Exception.Message)"
    exit 1
}


