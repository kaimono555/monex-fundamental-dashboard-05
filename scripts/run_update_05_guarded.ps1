# run_update_05_guarded.ps1
# update_all_05.ps1 のガード付きラッパー。既存スクリプトは一切変更せず呼び出すだけ。
#
# 目的:
#   マネックスのセッション切れで自動取得が失敗した場合に、
#   (1) 最前面ダイアログで人間に手動ログインを促し（見逃し防止）、
#   (2) ログイン後の「Enterを押さずに5〜6分待つ」という確定手順
#       （2026-07-09実地テスト確立・CLAUDE.md記載）をこのスクリプトが代行し、
#   (3) 待機後に自動で update_all_05.ps1 を再実行する。
#
# 2026-08-07の事故（ログイン直後にEnterが押され、IFISセッション安定前に
# Chromeが閉じて2回連続取得0件）の再発防止策。
#
# 実装方針:
#   - login_monex_profile_05.ps1 を起動し、ログイン後にカウントダウン待機する。
#   - 待機後も Enter は送信せず Chrome を開いたまま update を再実行する（確定手順と同じ形）。
#     Enter送信→Chrome正常クローズだとIFIS側の揮発セッションCookieが消え、
#     再取得が必ず認証エラーになるため（2026-08-08 run_log.txt で確認）。
#     残った Chrome/node は update_all_05.ps1 の実行前クリーンアップが強制終了する。
#   - パスワード・認証情報は一切扱わない（ログインは人間がブラウザで行う）。

param(
    [int]$StabilizeSeconds = 180,   # ログイン後の安定化待機（2026-08-08 ユーザー判断で6分→3分に短縮）
    [int]$MaxRetries = 2            # ログイン→再実行のリトライ上限
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ProjectDir = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $ProjectDir

$UpdateScript = Join-Path $PSScriptRoot "update_all_05.ps1"
$LoginScript  = Join-Path $PSScriptRoot "login_monex_profile_05.ps1"
$RunLogPath   = Join-Path $ProjectDir "logs\run_log.txt"

if (-not (Test-Path $UpdateScript)) { throw "update_all_05.ps1 が見つかりません。" }
if (-not (Test-Path $LoginScript))  { throw "login_monex_profile_05.ps1 が見つかりません。" }

Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null

function Get-RunLogLineCount {
    if (Test-Path -LiteralPath $RunLogPath) {
        return @(Get-Content -LiteralPath $RunLogPath -Encoding UTF8 -ErrorAction SilentlyContinue).Count
    }
    return 0
}

function Test-LoginNotReadySince([int]$BeforeCount) {
    if (-not (Test-Path -LiteralPath $RunLogPath)) { return $false }
    $lines = @(Get-Content -LiteralPath $RunLogPath -Encoding UTF8 -ErrorAction SilentlyContinue)
    if ($lines.Count -le $BeforeCount) { return $false }
    $appended = $lines[$BeforeCount..($lines.Count - 1)]
    return [bool]($appended | Where-Object { $_ -match "login not ready|relogin_timeout|relogin_chrome_still_running" })
}

function Invoke-Update05 {
    # stdinをNULにして実行し、update_all_05.ps1末尾のEnter待ちをスキップする
    Write-Host ""
    Write-Host "==== update_all_05.ps1 を実行します ====" -ForegroundColor Cyan
    cmd /c "powershell -NoProfile -ExecutionPolicy Bypass -File `"$UpdateScript`" <nul"
    return $LASTEXITCODE
}

# 最前面フォーム（メッセージ＋メインボタン＋中止ボタン）。戻り値: メインボタン押下=true / 中止=false
function Show-GuardDialog([string]$Title, [string]$Message, [string]$ButtonText, [bool]$ShowCancel) {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = $Title
    $form.TopMost = $true
    $form.StartPosition = "CenterScreen"
    $form.Width = 560
    $form.Height = 260
    $form.FormBorderStyle = "FixedDialog"
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false

    $label = New-Object System.Windows.Forms.Label
    $label.Text = $Message
    $label.Font = New-Object System.Drawing.Font("Meiryo UI", 11)
    $label.AutoSize = $false
    $label.Dock = "Top"
    $label.Height = 140
    $label.Padding = New-Object System.Windows.Forms.Padding(16, 16, 16, 0)
    $form.Controls.Add($label)

    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = $ButtonText
    $btn.Font = New-Object System.Drawing.Font("Meiryo UI", 11, [System.Drawing.FontStyle]::Bold)
    $btn.Width = 220
    $btn.Height = 44
    $btn.Left = 24
    $btn.Top = 160
    $btn.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.Controls.Add($btn)
    $form.AcceptButton = $btn

    if ($ShowCancel) {
        $cancel = New-Object System.Windows.Forms.Button
        $cancel.Text = "中止"
        $cancel.Font = New-Object System.Drawing.Font("Meiryo UI", 10)
        $cancel.Width = 120
        $cancel.Height = 44
        $cancel.Left = 400
        $cancel.Top = 160
        $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
        $form.Controls.Add($cancel)
    }

    $result = $form.ShowDialog()
    $form.Dispose()
    return ($result -eq [System.Windows.Forms.DialogResult]::OK)
}

# カウントダウンダイアログ（自動で閉じる）
function Show-CountdownDialog([int]$Seconds) {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = "05 セッション安定化待機中"
    $form.TopMost = $true
    $form.StartPosition = "CenterScreen"
    $form.Width = 560
    $form.Height = 220
    $form.FormBorderStyle = "FixedDialog"
    $form.MaximizeBox = $false
    $form.ControlBox = $false

    $label = New-Object System.Windows.Forms.Label
    $label.Font = New-Object System.Drawing.Font("Meiryo UI", 11)
    $label.AutoSize = $false
    $label.Dock = "Fill"
    $label.Padding = New-Object System.Windows.Forms.Padding(16)
    $form.Controls.Add($label)

    $script:remaining = $Seconds
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 1000
    $timer.Add_Tick({
        $script:remaining -= 1
        $m = [math]::Floor($script:remaining / 60)
        $s = $script:remaining % 60
        $label.Text = "IFIS側セッションの安定化待機中です（短縮運用・約3分）。`n`n" +
            "Chromeと黒いPowerShell画面は閉じずにそのままにしてください。`n`n" +
            ("残り {0}分{1:d2}秒 — 終了後、自動で再取得を開始します（Chromeはそのまま使われ、自動で閉じます）。" -f $m, $s)
        if ($script:remaining -le 0) {
            $timer.Stop()
            $form.Close()
        }
    })
    $m0 = [math]::Floor($Seconds / 60); $s0 = $Seconds % 60
    $label.Text = "IFIS側セッションの安定化待機中です（短縮運用・約3分）。`n`n" +
        "Chromeと黒いPowerShell画面は閉じずにそのままにしてください。`n`n" +
        ("残り {0}分{1:d2}秒 — 終了後、自動で再取得を開始します（Chromeはそのまま使われ、自動で閉じます）。" -f $m0, $s0)
    $timer.Start()
    $form.ShowDialog() | Out-Null
    $timer.Dispose()
    $form.Dispose()
}

# ログインスクリプトを stdin パイプ付きで起動し、安定化待機後に Enter を送信して完了させる
function Invoke-GuardedLogin {
    Write-Host ""
    Write-Host "==== 手動ログインを開始します（Chromeが開きます） ====" -ForegroundColor Cyan

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "powershell.exe"
    # 大きめのタイムアウト(30分)を渡し、ログイン+6分待機が余裕で収まるようにする
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$LoginScript`" -TimeoutMs 1800000"
    $psi.WorkingDirectory = $ProjectDir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $proc = [System.Diagnostics.Process]::Start($psi)

    $ok = Show-GuardDialog `
        "05 マネックス手動ログイン" `
        ("Chromeが開いたら、マネックス証券に通常どおりログインしてください。`n`n" +
         "ログインが完了したら、下のボタンを押してください。`n" +
         "（Chrome・黒い画面はどちらも閉じないでください。`n" +
         "  Enterキーも押す必要はありません — この後の待機と保存は自動で行います）") `
        "ログイン完了（安定化待機を開始）" $true

    if (-not $ok) {
        Write-Host "中止が選択されました。ログインプロセスを終了します。" -ForegroundColor Yellow
        try { if (-not $proc.HasExited) { $proc.Kill() } } catch {}
        return $false
    }

    # 確定手順: Enterを押さずに5〜6分待つ（＝Chromeを開いたまま安定化させる）
    Show-CountdownDialog $StabilizeSeconds

    if ($proc.HasExited) {
        Write-Host "ログインスクリプトが待機中に終了していました（exit=$($proc.ExitCode)）。" -ForegroundColor Yellow
        return ($proc.ExitCode -eq 0)
    }

    # 待機完了。Enterは送信せず、Chromeを開いたまま update を再実行する（確定手順と同じ形）。
    # Enter送信→ログインスクリプトがChromeを正常クローズすると、IFIS側の
    # セッションCookie（ブラウザ終了で消える揮発Cookie）が失われ、直後の再取得が
    # 再び認証エラーになる（2026-08-08 run_log.txt で確認:
    # 18:04:14 manual login verify ok=true → chrome closed → 18:04:18 認証エラー）。
    # update_all_05.ps1 の実行前クリーンアップが残った Chrome/node を強制終了する
    # （強制終了なら揮発Cookieはディスクに残る）ため、ここでは閉じずに戻る。
    Write-Host "安定化待機が完了しました。Chromeを開いたまま再取得を開始します..." -ForegroundColor Cyan
    $script:LoginProc = $proc
    return $true
}

# ── メインフロー ──────────────────────────────────────────
$attempt = 0
$script:LoginProc = $null
while ($true) {
    $beforeLines = Get-RunLogLineCount
    $exitCode = Invoke-Update05

    # ログイン用に開いたままにしていたプロセスの後始末
    # （Chrome/node本体は update_all_05.ps1 側のクリーンアップで既に終了している）
    if ($script:LoginProc) {
        try { if (-not $script:LoginProc.HasExited) { $script:LoginProc.Kill() } } catch {}
        $script:LoginProc = $null
    }

    if ($exitCode -eq 0) {
        Write-Host ""
        Write-Host "==== 更新が正常に完了しました ====" -ForegroundColor Green
        [System.Windows.Forms.MessageBox]::Show(
            "05の更新が完了しました。",
            "05 マネックス銘柄スカウター",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
        exit 0
    }

    $isLoginIssue = Test-LoginNotReadySince $beforeLines
    if (-not $isLoginIssue) {
        Write-Host ""
        Write-Host "==== ログイン切れ以外の理由で失敗しました。ログを確認してください ====" -ForegroundColor Red
        Write-Host "  logs\run_log.txt / logs\update_05_*.log" -ForegroundColor Red
        [System.Windows.Forms.MessageBox]::Show(
            "05の更新がログイン切れ以外の理由で失敗しました。`nlogs\run_log.txt を確認してください。",
            "05 マネックス銘柄スカウター - エラー",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
        exit 1
    }

    $attempt += 1
    if ($attempt -gt $MaxRetries) {
        [System.Windows.Forms.MessageBox]::Show(
            "ログイン再試行を$MaxRetries回行いましたが取得に失敗しました。`nlogs\run_log.txt を確認してください。",
            "05 マネックス銘柄スカウター - エラー",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
        exit 1
    }

    $go = Show-GuardDialog `
        "05 マネックス銘柄スカウター - ログイン切れ" `
        ("マネックスのセッションが切れているため、自動取得に失敗しました。`n`n" +
         "手動ログインが必要です（試行 $attempt/$MaxRetries）。`n" +
         "下のボタンを押すとChromeが開きます。") `
        "ログインを開始" $true

    if (-not $go) {
        Write-Host "中止が選択されました。" -ForegroundColor Yellow
        exit 1
    }

    if (-not (Invoke-GuardedLogin)) {
        Write-Host "ログインが完了しませんでした。再試行します。" -ForegroundColor Yellow
        continue
    }
    # ログイン成功 → ループ先頭に戻り update を自動再実行
}
