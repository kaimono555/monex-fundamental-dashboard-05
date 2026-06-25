param(
    [string]$BCode = "7186",
    [string]$LoginUrl = "https://www.monex.co.jp/",
    [string]$TargetUrl = "",
    [string]$UserDataDir = "data/playwright-profile/monex-login-profile",
    [string]$ChromeExecutablePath = "",
    [string]$LogPath = "logs/run_log.txt",
    [switch]$ResetProfile,
    [switch]$WaitForEnterAndClose
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Ensure-Directory {
    param([string]$Path)
    if (-not [string]::IsNullOrWhiteSpace($Path) -and -not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
    }
}

function Write-RunLog {
    param([string]$Message)
    Ensure-Directory (Split-Path $LogPath -Parent)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $LogPath -Value "[$timestamp] $Message" -Encoding UTF8
}

function ConvertTo-ProcessArgument {
    param([string]$Value)
    if ($null -eq $Value) { return '""' }
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
    $projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
    $resolvedUserDataDir = if ([System.IO.Path]::IsPathRooted($UserDataDir)) {
        [System.IO.Path]::GetFullPath($UserDataDir)
    } else {
        [System.IO.Path]::GetFullPath((Join-Path $projectRoot $UserDataDir))
    }

    if ($ResetProfile -and (Test-Path -LiteralPath $resolvedUserDataDir)) {
        $resolvedProjectRoot = [System.IO.Path]::GetFullPath($projectRoot)
        if (-not $resolvedUserDataDir.StartsWith($resolvedProjectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to reset profile outside project root: $resolvedUserDataDir"
        }
        Write-RunLog "login profile check reset profile path=$resolvedUserDataDir"
        Remove-Item -LiteralPath $resolvedUserDataDir -Recurse -Force
    }

    Ensure-Directory $UserDataDir
    Ensure-Directory (Split-Path $LogPath -Parent)

    if ([string]::IsNullOrWhiteSpace($ChromeExecutablePath) -or -not (Test-Path -LiteralPath $ChromeExecutablePath)) {
        Write-RunLog "login profile check launch failed error=Chrome executable not found"
        throw "Chrome executable not found"
    }

    $nodeScript = Join-Path $PSScriptRoot "playwright_check_monex_login_profile.js"
    $nodeArgs = @(
        $nodeScript,
        "--bcode", $BCode,
        "--login-url", $LoginUrl,
        "--target-url", $TargetUrl,
        "--user-data-dir", $UserDataDir,
        "--chrome-executable", $ChromeExecutablePath,
        "--log-path", $LogPath,
        "--wait-for-enter-and-close", ([string]$WaitForEnterAndClose.IsPresent)
    )

    Write-RunLog "login profile check launch start bcode=$BCode loginUrl=$LoginUrl targetUrl=$TargetUrl userDataDir=$UserDataDir resetProfile=$ResetProfile waitForEnterAndClose=$WaitForEnterAndClose"

    if ($WaitForEnterAndClose) {
        & node @nodeArgs
        exit $LASTEXITCODE
    }

    $argumentList = ($nodeArgs | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join " "
    $process = Start-Process -FilePath "node" -ArgumentList $argumentList -WindowStyle Hidden -PassThru
    Write-RunLog "login profile check launched pid=$($process.Id) note=Chrome remains open for manual login/profile verification"

    Write-Output "Chrome launched."
    Write-Output "Profile: $UserDataDir"
    Write-Output "To recreate this profile later, run the same command with -ResetProfile."
    Write-Output "Log in on the Monex tab, then check whether the Scout tab displays the 7186 financial page."
    Write-Output "Check URL: $TargetUrl"
    Write-Output "Chrome will remain open. Diagnostics are written to: $LogPath"
}
catch {
    Write-RunLog "login profile check launch failed error=$($_.Exception.Message)"
    exit 1
}
