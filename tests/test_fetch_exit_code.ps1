# test_fetch_exit_code.ps1
# fetch_target_financials.ps1 が node の「実プロセス終了コード」だけを $nodeExitCode として扱うことの検証。
# 本物の node / Chrome / マネックスには接続しない: PATH の先頭に偽 node.cmd を置き、
#   - 標準出力に "[1/2] fetch 5803" 等の行を出す
#   - 指定した終了コードで終了する
#   - fetch_results.csv を書く(成功/失敗行)
# ようにして、scratch の target/raw/output/log で fetch_target_financials.ps1 を実行する。
# 本番 data/ や本番 target_codes.csv には触れない。ロック(data/locks)は本物を使うが、終了時に解放される。
# 実行: powershell -NoProfile -ExecutionPolicy Bypass -File tests\test_fetch_exit_code.ps1
$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("fetch_exit_test_" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$FakeBin = Join-Path $Work "bin"
New-Item -ItemType Directory -Force -Path $FakeBin | Out-Null

$script:pass = 0
$script:fail = 0
function Check([bool]$Cond, [string]$Name) {
    if ($Cond) { $script:pass++; Write-Host "PASS: $Name" } else { $script:fail++; Write-Host "FAIL: $Name" -ForegroundColor Red }
}

# 偽 node: 引数から --results-path を拾って CSV を書き、行を出力し、FAKE_NODE_EXIT で終了する。
$fakeNode = @'
@echo off
setlocal enabledelayedexpansion
set RESULTS=
:loop
if "%~1"=="" goto done
if "%~1"=="--results-path" set RESULTS=%~2
shift
goto loop
:done
echo [1/2] fetch 5803
echo [2/2] fetch 4062
if not "%RESULTS%"=="" (
  > "%RESULTS%" echo "code","fetched_at","data_as_of","source_update_date","fetch_status","stale_flag","retry_count","error_type","error_message","stop_reason"
  >> "%RESULTS%" echo "5803","2026-09-04 12:00:00","","","%FAKE_ROW1%","true","0","%FAKE_ERR1%","simulated",""
  >> "%RESULTS%" echo "4062","2026-09-04 12:00:01","","","failed","true","3","timeout_error","simulated",""
)
exit /b %FAKE_NODE_EXIT%
'@
[System.IO.File]::WriteAllText((Join-Path $FakeBin "node.cmd"), $fakeNode, [System.Text.Encoding]::ASCII)
# 偽 chrome.exe の存在確認は Get-ChromeExecutable が実パスを探すためそのまま(実Chromeは起動しない)

$target = Join-Path $Work "target.csv"
[System.IO.File]::WriteAllText($target, "`"code`",`"name`",`"source`"`r`n`"5803`",`"A`",`"`"`r`n`"4062`",`"B`",`"`"`r`n", [System.Text.UTF8Encoding]::new($true))

function Run-Case([int]$ExitCode, [string]$Row1, [string]$Err1, [string]$Label) {
    $caseDir = Join-Path $Work $Label
    New-Item -ItemType Directory -Force -Path $caseDir | Out-Null
    $log = Join-Path $caseDir "run_log.txt"
    $env:FAKE_NODE_EXIT = "$ExitCode"
    $env:FAKE_ROW1 = $Row1
    $env:FAKE_ERR1 = $Err1
    $oldPath = $env:Path
    $env:Path = "$FakeBin;$oldPath"
    $out = ""
    $threw = $null
    try {
        Push-Location $ProjectRoot
        $out = & powershell -NoProfile -ExecutionPolicy Bypass -Command "& { `$env:Path = '$FakeBin;' + `$env:Path; & '$ProjectRoot\scripts\fetch_target_financials.ps1' -TargetPath '$target' -RawDir '$caseDir\raw' -OutputDir '$caseDir\output' -FetchResultsPath '$caseDir\fetch_results.csv' -FetchStatusPath '$caseDir\fetch_status.csv' -ErrorPath '$caseDir\errors.csv' -LogPath '$log'; exit `$LASTEXITCODE }" 2>&1 | Out-String
        $rc = $LASTEXITCODE
    } catch {
        $threw = $_.Exception.Message
        $rc = -1
    } finally {
        Pop-Location
        $env:Path = $oldPath
    }
    $logText = if (Test-Path $log) { Get-Content $log -Raw -Encoding UTF8 } else { "" }
    return @{ rc = $rc; out = $out; log = $logText; threw = $threw; status = (Join-Path $caseDir "fetch_status.csv") }
}

# --- ケース1: node exit 0(全件成功扱いの行は無いが exit 0) → "returned non-zero" をログに出さない
$r = Run-Case 0 "failed" "timeout_error" "case_exit0"
Check ($r.log -notmatch "returned non-zero") "exit 0: 'returned non-zero' がログに出ない"
Check ($r.log -notmatch "exitCode=\[") "exit 0: exitCode に出力配列が混入しない"
Check ($r.log -match "target fetch end input=2") "exit 0: 取得後処理まで進む"

# --- ケース2: node exit 2(一部失敗) → 実終了コード 2 がそのままログに出る
$r = Run-Case 2 "failed" "timeout_error" "case_exit2"
Check ($r.log -match "target fetch returned non-zero exitCode=2;") "exit 2: exitCode=2 として記録される(配列混入なし)"
Check ($r.log -match "target fetch end input=2 success=0") "exit 2: 失敗行はそのまま失敗/フォールバック扱い"

# --- ケース3: node exit 3(ログイン未確立) → 認証扱いで停止(通常失敗と混同しない)
$r = Run-Case 3 "failed" "auth_error" "case_exit3"
Check ($r.log -match "target fetch aborted: login not ready") "exit 3: login not ready として停止"
Check ($r.rc -ne 0) "exit 3: スクリプトは非0で終了"
Check (-not (Test-Path $r.status)) "exit 3: fetch_status.csv を書かない(既存状態を壊さない)"

# --- ケース4: 出力行が多くても $nodeExitCode は int(exit 5)
$r = Run-Case 5 "failed" "exception" "case_exit5"
Check ($r.log -match "target fetch returned non-zero exitCode=5;") "exit 5: 任意の終了コードがそのまま int で記録される"

Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "==== fetch exit code test: PASS=$($script:pass) FAIL=$($script:fail) ===="
if ($script:fail -gt 0) { exit 1 }
exit 0
