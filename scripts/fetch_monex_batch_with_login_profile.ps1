param(
    [string[]]$BCodes = @("8035", "7735", "4062", "3436", "285A"),
    [string]$UserDataDir = "data/playwright-profile/monex-login-profile",
    [string]$ChromeExecutablePath = "",
    [string]$RawDir = "data/raw",
    [string]$OutputDir = "data/output",
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
    if ($BCodes.Count -eq 1 -and $BCodes[0] -match ",") {
        $BCodes = $BCodes[0] -split "," | ForEach-Object { $_.Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    }

    Ensure-Directory $RawDir
    Ensure-Directory $OutputDir
    Ensure-Directory $UserDataDir
    Ensure-Directory (Split-Path $LogPath -Parent)

    if ([string]::IsNullOrWhiteSpace($ChromeExecutablePath) -or -not (Test-Path -LiteralPath $ChromeExecutablePath)) {
        Write-RunLog "複数銘柄取得失敗 error=Chrome executable not found"
        throw "Chrome executable not found"
    }

    $nodeScript = Join-Path $PSScriptRoot "playwright_batch_fetch_financials.js"
    $nodeArgs = @(
        $nodeScript,
        "--codes", ($BCodes -join ","),
        "--user-data-dir", $UserDataDir,
        "--chrome-executable", $ChromeExecutablePath,
        "--raw-dir", $RawDir,
        "--log-path", $LogPath
    )

    Write-RunLog "START batch fetch codes=$($BCodes -join ',')"
    & node @nodeArgs
    $fetchExitCode = $LASTEXITCODE
    if ($fetchExitCode -ne 0) {
        Write-RunLog "複数銘柄HTML/TXT取得 一部または全部失敗 exitCode=$fetchExitCode"
    }

    foreach ($code in $BCodes) {
        $textPath = Join-Path $RawDir "$code.txt"
        if (-not (Test-Path -LiteralPath $textPath)) {
            Write-RunLog "CSV生成スキップ bcode=$code reason=text not found"
            continue
        }

        Write-RunLog "CSV生成開始 bcode=$code"
        & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "parse_financials.ps1") -BCode $code -RawDir $RawDir -OutputDir $OutputDir -LogPath $LogPath
        if ($LASTEXITCODE -ne 0) {
            Write-RunLog "CSV生成失敗 bcode=$code exitCode=$LASTEXITCODE"
        }
        else {
            Write-RunLog "CSV生成成功 bcode=$code"
        }
    }

    Write-RunLog "END batch fetch codes=$($BCodes -join ',') result=done fetchExitCode=$fetchExitCode"
    if ($fetchExitCode -ne 0) {
        exit $fetchExitCode
    }
}
catch {
    Write-RunLog "END batch fetch result=failed error=$($_.Exception.Message)"
    exit 1
}



