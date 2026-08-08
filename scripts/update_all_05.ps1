# update_all_05.ps1
# 05_マネックス銘柄スカウター自動取得 の定期更新を実行するためのラッパースクリプト。
# 既存の正式な更新処理（scripts/run_project.ps1）を呼び出すだけで、新しい取得・生成ロジックは作らない。
#
# 実行内容（黒いPowerShell画面に進捗を流しながら、logs/ にも同じ内容を保存する）:
#   [1/11] git status（更新前）
#   [2/11] scripts/run_project.ps1 を実行（既存の正式なパイプライン）
#         → 04の follow_candidates.csv 突合 → fetch_target_financials.ps1 →
#           generate_fundamentals.ps1 → generate_fundamental_scores.ps1 →
#           generate_fundamental_report.ps1 → 04側候補再生成 →
#           generate_fundamental_fetch_summary.ps1 まで一括実行される
#         → 本スクリプトは自動実行モード専用。05専用Chromeプロファイルに
#           ログイン状態が既に保存されている前提で取得し、人間の入力は
#           一切待たない。ログイン切れ・未ログインの場合は安全に失敗して
#           終了する（commit/pushしない）。
#           マネックスへの手動ログイン更新は scripts\login_monex_profile_05.ps1
#           （専用スクリプト）で行うこと。
#   [3/11] reports/fundamental_scores.md 存在確認
#   [4/11] reports/fundamental_fetch_summary.md 存在確認
#   [5/11] 必須文字列チェック（05の実ファイルから採取した文言）
#   [6/11] 取得成功数チェック（data/fetch_status.csv・fundamental_fetch_summary.md記載値）
#         → 最新取得成功数が0件、successRate=0%、または通常レポートが今回更新されず
#           fallback専用レポートのみ更新された場合は赤字エラーで停止し、
#           commit/push を一切行わない（最新取得0件＝失敗として扱う）。
#   [7/11] git diff --stat 表示
#   [8/11] 変更があれば git add -A → git commit
#   [9/11] commit した場合のみ git push
#  [10/11] 最終 git status 表示
#  [11/11] 04側 git status 確認（参考情報のみ、04のcommit/pushは行わない）
#         → run_project.ps1 が04の follow_candidates.csv 等を再生成する場合があるため、
#           05がcleanでも04側に未コミット変更が残っていないか確認するためのチェック
#
# エラーが発生した場合は赤字で停止理由を表示し、commit/push は行わない。
# 正常終了・異常終了のどちらでも、最後に Read-Host で必ず一時停止してから画面を閉じる
# （try/catch/finally構成。途中で例外が起きても finally が必ず実行される）。
#
# パスワード・トークン等の秘密情報はこのファイルに一切含めない。
# GitHub への認証は、実行PCに既にログイン済みの状態（git credential 等）を前提とする。

param()

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ProjectDir = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $ProjectDir

# ── ログ準備 ──────────────────────────────────────────────
$LogsDir = Join-Path $ProjectDir "logs"
if (-not (Test-Path $LogsDir)) {
    New-Item -ItemType Directory -Path $LogsDir | Out-Null
}
$LogTimestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$LogFileName  = "update_05_$LogTimestamp.log"
$LogPath      = Join-Path $LogsDir $LogFileName

$TOTAL    = 11
$ExitCode = 0

function Write-Step($n, $total, $msg) {
    Write-Host ""
    Write-Host "[$n/$total] $msg" -ForegroundColor Cyan
}
function Write-Ok($msg)   { Write-Host "  OK: $msg" -ForegroundColor Green }
function Write-WarnBox($msg) {
    Write-Host ""
    Write-Host "----------------------------------------------------" -ForegroundColor Yellow
    Write-Host " WARNING: $msg" -ForegroundColor Yellow
    Write-Host "----------------------------------------------------" -ForegroundColor Yellow
}

# run_project.ps1 失敗時、直近の logs\run_log.txt に「login not ready」が
# 記録されていればログインセッション切れとみなし、最前面にポップアップで知らせる。
# （自動実行モードは人間の入力を待たず即エラー終了するだけなので、
#   PCの前にいないと気づけない問題への対処。判定・通知のみ追加し、
#   既存の取得・commit/pushロジックには一切手を入れない。）
function Show-LoginAlertIfNeeded {
    param([string]$RunLogPath)
    try {
        if (-not (Test-Path -LiteralPath $RunLogPath)) { return }
        $tail = Get-Content -LiteralPath $RunLogPath -Tail 20 -Encoding UTF8 -ErrorAction SilentlyContinue
        if (-not $tail) { return }
        $loginNotReady = $tail | Where-Object { $_ -match "login not ready" }
        if (-not $loginNotReady) { return }

        Add-Type -AssemblyName System.Windows.Forms | Out-Null
        Add-Type -AssemblyName System.Drawing | Out-Null
        $form = New-Object System.Windows.Forms.Form
        $form.TopMost = $true
        $form.Width = 0
        $form.Height = 0
        $form.StartPosition = "CenterScreen"
        [System.Windows.Forms.MessageBox]::Show(
            $form,
            "login_monex_profile_05.bat を起動してマネックス証券にログインしてください。",
            "05 マネックス銘柄スカウター - ログイン切れ",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        ) | Out-Null
        $form.Dispose()
    } catch {
        Write-Host "  [warn] ログイン切れポップアップの表示に失敗しました: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# 05専用プロファイル（playwright-profile\monex-login-profile）を掴んでいる
# 残存プロセスだけを安全に検出して終了する。
# 通常Chromeや他プロジェクトのChrome/Nodeを巻き込まないよう、CommandLineに
# 以下のいずれかを含むプロセスだけを対象にする：
#   playwright-profile / monex-login-profile / 05_マネックス銘柄スカウター自動取得 / update_all_05
# chrome.exe / node.exe を無条件に終了する実装は行わない。
function Stop-Monex05StaleProcesses {
    $patterns = @(
        "playwright-profile",
        "monex-login-profile",
        "05_マネックス銘柄スカウター自動取得",
        "update_all_05"
    )
    try {
        $procs = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='node.exe'" -ErrorAction SilentlyContinue)
    } catch {
        $procs = @()
    }
    foreach ($p in $procs) {
        $cmd = [string]$p.CommandLine
        if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
        $isTarget = $false
        foreach ($pat in $patterns) {
            if ($cmd -like "*$pat*") { $isTarget = $true; break }
        }
        if (-not $isTarget) { continue }
        try {
            Write-Host "  [cleanup] 残存プロセス終了: PID=$($p.ProcessId) Name=$($p.Name)" -ForegroundColor Gray
            Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
        } catch {
            Write-Host "  [cleanup] プロセス終了に失敗 PID=$($p.ProcessId): $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
}

# 05専用プロファイル配下のロックファイルだけを削除する（他プロファイルには触れない）。
function Remove-Monex05LockFiles {
    param([string]$ResolvedProfileDir)
    if ([string]::IsNullOrWhiteSpace($ResolvedProfileDir) -or -not (Test-Path -LiteralPath $ResolvedProfileDir)) { return }
    $lockNames = @("SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile")
    foreach ($name in $lockNames) {
        $lockPath = Join-Path $ResolvedProfileDir $name
        if (Test-Path -LiteralPath $lockPath) {
            try {
                Remove-Item -LiteralPath $lockPath -Force -ErrorAction Stop
                Write-Host "  [cleanup] ロックファイル削除: $lockPath" -ForegroundColor Gray
            } catch {
                Write-Host "  [cleanup] ロックファイル削除に失敗: $lockPath - $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
    }
}

$MonexProfileDir = Join-Path $ProjectDir "data\playwright-profile\monex-login-profile"

try {
    Start-Transcript -Path $LogPath | Out-Null

    Write-Host "====================================================" -ForegroundColor Green
    Write-Host " 05 マネックス銘柄スカウター 自動更新を開始します" -ForegroundColor Green
    Write-Host "====================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "作業場所:" -ForegroundColor Gray
    Write-Host "  $ProjectDir"
    Write-Host ""
    Write-Host "ログ:" -ForegroundColor Gray
    Write-Host "  logs\$LogFileName"
    Write-Host ""
    Write-Host "注意: 自動実行モードのため、05専用Chromeプロファイルに保存済みの" -ForegroundColor Yellow
    Write-Host "      ログイン状態のみを使用します（人間の入力待ちは行いません）。" -ForegroundColor Yellow
    Write-Host "      ログイン切れの場合は scripts\login_monex_profile_05.ps1 で更新してください。" -ForegroundColor Yellow

    Write-Host ""
    Write-Host "[cleanup] 実行前クリーンアップ（05専用プロファイルのみ対象）" -ForegroundColor Gray
    Stop-Monex05StaleProcesses
    Remove-Monex05LockFiles -ResolvedProfileDir $MonexProfileDir

    try {
        Write-Step 1 $TOTAL "git status"
        git status
        if ($LASTEXITCODE -ne 0) { throw "git status の実行に失敗しました（Gitリポジトリか確認してください）。" }

        Write-Step 2 $TOTAL "run_project.ps1 実行（正式更新パイプライン）"
        $runProject = Join-Path $ProjectDir "scripts\run_project.ps1"
        if (-not (Test-Path $runProject)) { throw "scripts\run_project.ps1 が見つかりません。" }
        & powershell -NoProfile -ExecutionPolicy Bypass -File $runProject
        if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
            Show-LoginAlertIfNeeded -RunLogPath (Join-Path $ProjectDir "logs\run_log.txt")
            throw "scripts\run_project.ps1 が異常終了しました（exit code: $LASTEXITCODE）。"
        }

        Write-Step 3 $TOTAL "reports\fundamental_scores.md 存在確認"
        $scoresReport = Join-Path $ProjectDir "reports\fundamental_scores.md"
        if (-not (Test-Path $scoresReport)) { throw "reports\fundamental_scores.md が生成されていません。" }
        Write-Ok "reports\fundamental_scores.md 存在確認"

        Write-Step 4 $TOTAL "reports\fundamental_fetch_summary.md 存在確認"
        $summaryReport = Join-Path $ProjectDir "reports\fundamental_fetch_summary.md"
        if (-not (Test-Path $summaryReport)) { throw "reports\fundamental_fetch_summary.md が生成されていません。" }
        Write-Ok "reports\fundamental_fetch_summary.md 存在確認"

        Write-Step 5 $TOTAL "必須文字列チェック"
        $scoresContent = Get-Content -Raw -Encoding UTF8 $scoresReport
        $requiredScoresStrings = @(
            "# Fundamental quality_score report",
            "## quality_rank counts",
            "## Top 20"
        )
        foreach ($s in $requiredScoresStrings) {
            if ($scoresContent -notmatch [Regex]::Escape($s)) {
                throw "検証失敗: reports\fundamental_scores.md 内に「$s」が見つかりません。"
            }
            Write-Ok "reports\fundamental_scores.md 内「$s」を確認"
        }

        $summaryContent = Get-Content -Raw -Encoding UTF8 $summaryReport
        $requiredSummaryStrings = @(
            "# fundamentals 一括処理サマリー",
            "入力銘柄数"
        )
        foreach ($s in $requiredSummaryStrings) {
            if ($summaryContent -notmatch [Regex]::Escape($s)) {
                throw "検証失敗: reports\fundamental_fetch_summary.md 内に「$s」が見つかりません。"
            }
            Write-Ok "reports\fundamental_fetch_summary.md 内「$s」を確認"
        }

        Write-Step 6 $TOTAL "取得成功数チェック"
        $fetchStatusPath = Join-Path $ProjectDir "data\fetch_status.csv"
        if (-not (Test-Path $fetchStatusPath)) {
            throw "data\fetch_status.csv が見つかりません。取得処理が完了していない可能性があります。"
        }
        $fetchStatusRows = @(Import-Csv -LiteralPath $fetchStatusPath -Encoding UTF8)
        $totalFetchCount = $fetchStatusRows.Count
        $successFetchCount = @($fetchStatusRows | Where-Object { $_.fetch_status -eq "success" }).Count
        $fetchSuccessRate = if ($totalFetchCount -gt 0) { [math]::Round(($successFetchCount / $totalFetchCount) * 100, 1) } else { 0 }

        $summaryReportSuccessCount = $null
        if ($summaryContent -match '最新取得成功数\s*\|\s*(\d+)') {
            $summaryReportSuccessCount = [int]$Matches[1]
        }

        $normalReportStale = $false
        $fallbackOnlyReportPath = Join-Path $ProjectDir "reports\fundamental_scores_fallback_only.md"
        if ((Test-Path $fallbackOnlyReportPath) -and (Test-Path $scoresReport)) {
            $fallbackOnlyTime = (Get-Item $fallbackOnlyReportPath).LastWriteTime
            $normalReportTime = (Get-Item $scoresReport).LastWriteTime
            if ($fallbackOnlyTime -gt $normalReportTime) { $normalReportStale = $true }
        }

        Write-Host "  data\fetch_status.csv: success=$successFetchCount / total=$totalFetchCount (successRate=$fetchSuccessRate%)" -ForegroundColor Gray
        if ($null -ne $summaryReportSuccessCount) {
            Write-Host "  reports\fundamental_fetch_summary.md 記載の最新取得成功数: $summaryReportSuccessCount" -ForegroundColor Gray
        }
        if ($normalReportStale) {
            Write-Host "  reports\fundamental_scores_fallback_only.md の方が reports\fundamental_scores.md より新しい（通常レポート未更新）" -ForegroundColor Gray
        }

        $fetchFailed = ($successFetchCount -eq 0) `
            -or ($fetchSuccessRate -eq 0) `
            -or ($null -ne $summaryReportSuccessCount -and $summaryReportSuccessCount -eq 0)

        if ($fetchFailed) {
            Write-Host ""
            Write-Host "=========================================" -ForegroundColor Red
            Write-Host "マネックス最新取得成功数が0件のため、05更新は失敗扱いにします。" -ForegroundColor Red
            Write-Host "fallbackデータのみではcommit/pushしません。" -ForegroundColor Red
            Write-Host "マネックス銘柄スカウターの認証状態を確認して、再実行してください。" -ForegroundColor Red
            Write-Host "=========================================" -ForegroundColor Red
            throw "マネックス最新取得成功数0件のため停止しました（success=$successFetchCount/$totalFetchCount, successRate=$fetchSuccessRate%）。"
        }
        Write-Ok "取得成功数チェックOK（success=$successFetchCount/$totalFetchCount, successRate=$fetchSuccessRate%）"

        Write-Step 7 $TOTAL "git diff --stat"
        git diff --stat
        if ($LASTEXITCODE -ne 0) { throw "git diff の実行に失敗しました。" }

        Write-Step 8 $TOTAL "変更があれば commit"
        $changedFiles = git status --porcelain
        $didCommit = $false
        if ($changedFiles) {
            $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"
            $commitMsg = "update: refresh 05 dashboard $timestamp"
            Write-Host "  変更を検出しました。コミットします: $commitMsg" -ForegroundColor Yellow

            git add -A
            if ($LASTEXITCODE -ne 0) { throw "git add に失敗しました。" }

            git commit -m $commitMsg
            if ($LASTEXITCODE -ne 0) { throw "git commit に失敗しました。" }
            $didCommit = $true
        } else {
            Write-Host "  変更なし。commit はスキップします。" -ForegroundColor Yellow
        }

        Write-Step 9 $TOTAL "commitした場合のみ push"
        if ($didCommit) {
            git push
            if ($LASTEXITCODE -ne 0) { throw "git push に失敗しました（GitHubへの認証状態を確認してください）。" }
            Write-Host "  push 完了" -ForegroundColor Green
        } else {
            Write-Host "  commitしていないため push はスキップします。" -ForegroundColor Yellow
        }

        Write-Step 10 $TOTAL "最終 git status"
        git status

        Write-Step 11 $TOTAL "04側 git status 確認（参考情報のみ）"
        $SourceProjectDir = Join-Path (Resolve-Path (Join-Path $ProjectDir "..")) "04_強銘柄追随"
        if (-not (Test-Path $SourceProjectDir)) {
            Write-WarnBox "04プロジェクトフォルダが見つかりません: $SourceProjectDir"
        } else {
            Push-Location $SourceProjectDir
            try {
                $sourceChanged = git status --porcelain
                if ($sourceChanged) {
                    Write-WarnBox "04側に未コミットの変更があります。"
                    git status
                    Write-Host "  → 04側に変更がある場合は、必要に応じて04の run_04_update.bat を実行してください。" -ForegroundColor Yellow
                } else {
                    git status
                    Write-Ok "04側は変更なし（clean）"
                }
            }
            finally {
                Pop-Location
            }
        }

        Write-Host ""
        Write-Host "====================================================" -ForegroundColor Green
        Write-Host " 完了しました。" -ForegroundColor Green
        Write-Host "====================================================" -ForegroundColor Green
    }
    catch {
        $ExitCode = 1
        Write-Host ""
        Write-Host "====================================================" -ForegroundColor Red
        Write-Host " ERROR: 処理を停止しました" -ForegroundColor Red
        Write-Host "====================================================" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
        Write-Host "====================================================" -ForegroundColor Red
    }

    Write-Host ""
    Write-Host "[cleanup] 終了後クリーンアップ（05専用プロファイルのみ対象）" -ForegroundColor Gray
    Stop-Monex05StaleProcesses
    Remove-Monex05LockFiles -ResolvedProfileDir $MonexProfileDir
}
finally {
    try { Stop-Transcript | Out-Null } catch {}
    Write-Host ""
    # タスクスケジューラ等の無人実行（stdinリダイレクト）ではRead-Hostで待たない。
    # 手動実行時（[Console]::IsInputRedirectedがfalse）のみ、従来どおりEnter待ちで一時停止する。
    if (-not [Console]::IsInputRedirected) {
        Write-Host "Enterキーを押すと閉じます。" -ForegroundColor Gray
        Read-Host | Out-Null
    }
}

exit $ExitCode
