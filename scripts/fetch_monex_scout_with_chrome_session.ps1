param(
    [string]$BCode = "4063",
    [string]$Url = "",
    [string]$UserDataDir = "",
    [string]$ProfileDirectory = "Default",
    [string]$ChromeExecutablePath = "",
    [string]$RawDir = "data/raw",
    [string]$LogPath = "logs/run_log.txt",
    [string]$ProfileWorkDir = "data/playwright-profile",
    [switch]$UseOriginalProfile
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

if ([string]::IsNullOrWhiteSpace($UserDataDir)) {
    $localAppData = [Environment]::GetEnvironmentVariable("LOCALAPPDATA")
    $UserDataDir = Join-Path $localAppData "Google\Chrome\User Data"
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
    Ensure-Directory (Split-Path $LogPath -Parent)
    Ensure-Directory $ProfileWorkDir

    Write-RunLog "START playwright persistent fetch bcode=$BCode url=$Url"

    if (-not (Test-Path -LiteralPath $UserDataDir)) {
        Write-RunLog "Chromeユーザーデータディレクトリ確認失敗 path=$UserDataDir"
        throw "Chrome user data directory not found: $UserDataDir"
    }

    if ([string]::IsNullOrWhiteSpace($ChromeExecutablePath) -or -not (Test-Path -LiteralPath $ChromeExecutablePath)) {
        Write-RunLog "Chrome実行ファイル確認失敗 path=$ChromeExecutablePath"
        throw "Chrome executable not found"
    }

    $effectiveUserDataDir = $UserDataDir
    if (-not $UseOriginalProfile) {
        $effectiveUserDataDir = Join-Path $ProfileWorkDir "$BCode-user-data"
        Ensure-Directory $effectiveUserDataDir

        Write-RunLog "Chromeプロファイルコピー開始 source=$UserDataDir dest=$effectiveUserDataDir profile=$ProfileDirectory"
        $excludeFiles = @(
            "SingletonCookie",
            "SingletonLock",
            "SingletonSocket",
            "lockfile",
            "LOCK"
        )
        $excludeDirs = @(
            "BrowserMetrics",
            "CertificateRevocation",
            "Crashpad",
            "GrShaderCache",
            "GraphiteDawnCache",
            "Safe Browsing",
            "ShaderCache",
            "SwReporter"
        )

        $robocopyArgs = @(
            $UserDataDir,
            $effectiveUserDataDir,
            "/E",
            "/COPY:DAT",
            "/DCOPY:DAT",
            "/R:1",
            "/W:1",
            "/NFL",
            "/NDL",
            "/NJH",
            "/NJS",
            "/NP",
            "/XF"
        ) + $excludeFiles + @("/XD") + $excludeDirs

        & robocopy @robocopyArgs | Out-Null
        if ($LASTEXITCODE -gt 7) {
            $copiedProfilePath = Join-Path $effectiveUserDataDir $ProfileDirectory
            if (Test-Path -LiteralPath $copiedProfilePath) {
                Write-RunLog "Chromeプロファイルコピー警告 exitCode=$LASTEXITCODE note=一部ファイルをコピーできませんでしたが検証を継続します"
            }
            else {
                Write-RunLog "Chromeプロファイルコピー失敗 exitCode=$LASTEXITCODE"
                throw "robocopy failed: exitCode=$LASTEXITCODE"
            }
        }
        else {
            Write-RunLog "Chromeプロファイルコピー成功 dest=$effectiveUserDataDir"
        }
    }
    else {
        Write-RunLog "Chrome元プロファイル直接利用 mode=UseOriginalProfile path=$effectiveUserDataDir"
    }

    $nodeScript = Join-Path $PSScriptRoot "playwright_persistent_fetch.js"
    $nodeArgs = @(
        $nodeScript,
        "--bcode", $BCode,
        "--url", $Url,
        "--user-data-dir", $effectiveUserDataDir,
        "--profile-directory", $ProfileDirectory,
        "--chrome-executable", $ChromeExecutablePath,
        "--raw-dir", $RawDir,
        "--log-path", $LogPath
    )

    & node @nodeArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Playwright fetch failed: exitCode=$LASTEXITCODE"
    }

    Write-RunLog "END playwright persistent fetch bcode=$BCode result=success"
}
catch {
    Write-RunLog "END playwright persistent fetch bcode=$BCode result=failed error=$($_.Exception.Message)"
    exit 1
}


