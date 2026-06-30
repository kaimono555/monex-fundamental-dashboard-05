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
        # monex.ifis.co.jp の直リンクはマネックス本体メニュー経由の正規遷移を経ないと
        # 認証が渡らないため、node側では対象URLを開かずChromeを開いたまま待機する。
        # ここでは人間が「マネックス本体ログイン→本体メニューから銘柄スカウターを開く」
        # 操作を終えたことをこのPowerShell画面のEnterで確認し、シグナルファイルで
        # node側へ伝えてから対象URLの再チェックを行わせる。
        # （process.stdin を node 側で読む方式は subprocess チェーンで機能しないため使用しない）
        $confirmSignalPath = Join-Path $resolvedUserDataDir ".relogin_confirm_signal"
        $abortSignalPath   = Join-Path $resolvedUserDataDir ".relogin_abort_signal"
        Remove-Item -LiteralPath $confirmSignalPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $abortSignalPath -Force -ErrorAction SilentlyContinue

        $waitArgumentList = ($nodeArgs | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join " "
        $waitProcess = Start-Process -FilePath "node" -ArgumentList $waitArgumentList -NoNewWindow -PassThru

        Write-Host ""
        Write-Host "=========================================" -ForegroundColor Yellow
        Write-Host "マネックスログインが必要です。" -ForegroundColor Yellow
        Write-Host "マネックスにログインしただけでは不十分です。" -ForegroundColor Yellow
        Write-Host "必ずマネックス本体メニューから銘柄スカウターを開き、" -ForegroundColor Yellow
        Write-Host "$BCode などの銘柄スカウター財務ページが正常に表示されていることを確認してから" -ForegroundColor Yellow
        Write-Host "Enterを押してください。" -ForegroundColor Yellow
        Write-Host "=========================================" -ForegroundColor Yellow

        $waitTimeoutMs = 5 * 60 * 1000
        $deadline = (Get-Date).AddMilliseconds($waitTimeoutMs)
        $lastStatusAt = Get-Date
        $confirmed = $false

        while ((Get-Date) -lt $deadline) {
            if ($waitProcess.HasExited) {
                Write-RunLog "login profile check wait process exited unexpectedly before user confirmation pid=$($waitProcess.Id)"
                break
            }
            if ([Console]::KeyAvailable) {
                $key = [Console]::ReadKey($true)
                if ($key.Key -eq "Enter") {
                    $confirmed = $true
                    break
                }
            }
            if (((Get-Date) - $lastStatusAt).TotalSeconds -ge 30) {
                $remaining = [int](($deadline - (Get-Date)).TotalSeconds)
                Write-Host "  ...待機中（残り約 $remaining 秒）。ログイン・銘柄スカウター表示後にEnterを押してください。" -ForegroundColor Gray
                Write-RunLog "login profile check waiting-for-enter (powershell side) remaining=${remaining}s"
                $lastStatusAt = Get-Date
            }
            Start-Sleep -Milliseconds 200
        }

        if (-not $confirmed) {
            Write-RunLog "login profile check timeout waiting for user Enter confirmation"
            New-Item -ItemType File -Path $abortSignalPath -Force | Out-Null
            Write-Host ""
            Write-Host "=========================================" -ForegroundColor Red
            Write-Host "5分以内にEnterが押されなかったため、再ログイン確認はタイムアウトしました。" -ForegroundColor Red
            Write-Host "次の手順を確認してください：" -ForegroundColor Red
            Write-Host "  1. 開いたChromeでマネックス証券にログインできているか確認する" -ForegroundColor Red
            Write-Host "  2. マネックス本体のメニューから銘柄スカウターが正常に表示されるか確認する" -ForegroundColor Red
            Write-Host "  3. 表示できる状態になったら run_05_update.bat を再実行する" -ForegroundColor Red
            Write-Host "=========================================" -ForegroundColor Red
            if (-not $waitProcess.HasExited) {
                try { $waitProcess.WaitForExit(10000) } catch {}
            }
            exit 3
        }

        Write-Host ""
        Write-Host "ログイン状態を再チェックしています..." -ForegroundColor Cyan
        New-Item -ItemType File -Path $confirmSignalPath -Force | Out-Null

        $checkTimeoutMs = 30000
        if (-not $waitProcess.WaitForExit($checkTimeoutMs)) {
            Write-RunLog "login profile check did not exit after confirmation within ${checkTimeoutMs}ms"
            try { $waitProcess.Kill() } catch {}
            Write-Host ""
            Write-Host "再チェックが${checkTimeoutMs}ms以内に完了しませんでした。" -ForegroundColor Red
            exit 3
        }

        if ($waitProcess.ExitCode -ne 0) {
            Write-Host ""
            Write-Host "=========================================" -ForegroundColor Red
            Write-Host "マネックス銘柄スカウターの認証が有効ではありません。" -ForegroundColor Red
            Write-Host "Chromeでマネックス本体にログイン後、必ず本体メニューから銘柄スカウターを開き、" -ForegroundColor Red
            Write-Host "銘柄スカウターの画面が正常表示された状態でEnterを押してください。" -ForegroundColor Red
            Write-Host "=========================================" -ForegroundColor Red
        } else {
            Write-Host "ログイン確認OK。取得を再開します。" -ForegroundColor Green
        }

        exit $waitProcess.ExitCode
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
