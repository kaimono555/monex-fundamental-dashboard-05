param(
    [string]$BCode = "4063",
    [string]$Url = "",
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

if ([string]::IsNullOrWhiteSpace($Url)) {
    $Url = "https://monex.ifis.co.jp/index.php?sa=report_zaimu&bcode=$BCode"
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
    Ensure-Directory $RawDir
    Ensure-Directory $UserDataDir
    Ensure-Directory (Split-Path $LogPath -Parent)

    if ([string]::IsNullOrWhiteSpace($ChromeExecutablePath) -or -not (Test-Path -LiteralPath $ChromeExecutablePath)) {
        Write-RunLog "Playwright専用プロファイル取得失敗 bcode=$BCode error=Chrome executable not found"
        throw "Chrome executable not found"
    }

    $nodeScript = Join-Path $PSScriptRoot "playwright_monex_login_profile.js"
    $nodeArgs = @(
        $nodeScript,
        "--mode", "fetch",
        "--bcode", $BCode,
        "--url", $Url,
        "--user-data-dir", $UserDataDir,
        "--chrome-executable", $ChromeExecutablePath,
        "--raw-dir", $RawDir,
        "--log-path", $LogPath
    )

    & node @nodeArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Playwright dedicated profile fetch failed: exitCode=$LASTEXITCODE"
    }
}
catch {
    Write-RunLog "Playwright専用プロファイル取得終了 bcode=$BCode result=failed error=$($_.Exception.Message)"
    exit 1
}

