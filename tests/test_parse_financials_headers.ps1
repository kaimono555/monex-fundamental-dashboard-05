# test_parse_financials_headers.ps1
# ヘッダー検証型パーサ(scripts/parse_financials_core.ps1)のテスト。
# 検証目的は「列数が期待通りか」ではなく、
#  (1) 見出しから正しい項目を特定し、正しい値を取得できること
#  (2) 不確定な形式を推測せず Fail Closed (PARSER_SCHEMA_MISMATCH) できること
# 実行: powershell -NoProfile -ExecutionPolicy Bypass -File tests\test_parse_financials_headers.ps1
# 本番データ・本番CSVには一切触れない(文字列fixtureのみ)。

$ErrorActionPreference = "Stop"
. (Join-Path (Split-Path $PSScriptRoot -Parent) "scripts\parse_financials_core.ps1")

$script:passCount = 0
$script:failCount = 0

function Assert-Equal {
    param($Expected, $Actual, [string]$Name)
    if ("$Expected" -eq "$Actual") {
        $script:passCount++
        Write-Host "PASS: $Name"
    } else {
        $script:failCount++
        Write-Host "FAIL: $Name expected=[$Expected] actual=[$Actual]" -ForegroundColor Red
    }
}

$T = "`t"
$NBSP = [string][char]0x00A0

# style B(縦並び・▲付き)の見出しブロックを実物同様に組み立てる
function New-StyleBHeader {
    param([string[]]$Labels)
    $lines = @()
    foreach ($lab in $Labels) {
        $lines += $lab
        $lines += "▲"
        $lines += $T
    }
    # 実物は最後のラベルの後に▲、その後空行を挟んでデータ行が続く
    return ($lines[0..($lines.Count - 2)] -join "`n") + "`n"
}

# ---------------------------------------------------------------------------
# fixture 1: 現行10列形式(決算期+10フィールド: 売上高/(前期比)/営業利益/(前期比)/
#            経常利益/(前期比)/当期利益/(前期比)/EPS/BPS)。
#            実績行・会計基準マーク行・銀行様式行(営業利益「－」)・予行を含む。
# ---------------------------------------------------------------------------
$hdr10 = New-StyleBHeader @("決算期", "売上高", "(前期比)", "営業利益", "(前期比)", "経常利益", "(前期比)", "当期利益", "(前期比)", "EPS", "BPS")
$fixCurrent10 = @"
通期業績推移
業績
詳細：
表示：折りたたむ
$hdr10
2024/03${T}1,304,695${T}15.7%${T}241,028${T}30.1%${T}247,018${T}33.5%${T}154,010${T}33.9%${T}82.9円${T}731.1円
2025/03 I${T}1,376,364${T}5.5%${T}287,145${T}19.1%${T}300,040${T}21.5%${T}183,504${T}19.1%${T}98.8円${T}811.1円
2026/03${T}2,033,530${T}47.7%${T}－${T}－${T}719,073${T}75.2%${T}429,613${T}82.3%${T}119.3円${T}963.4円
2027/03予${T}2,700,000${T}4.9%${T}700,000${T}10.2%${T}770,000${T}8.7%${T}525,000${T}10.7%${T}282.5円${T}－円
四半期業績推移
"@

$r = Parse-AnnualFromText -Text $fixCurrent10
Assert-Equal "ok" $r.status "現行10列: status=ok"
Assert-Equal 3 $r.records.Count "現行10列: 実績3行(予行は除外)"
$rec2024 = $r.records | Where-Object { $_."決算期" -eq "2024/03" }
Assert-Equal "1304695" $rec2024."売上高" "現行10列: 売上高を見出しから取得"
Assert-Equal "241028" $rec2024."営業利益" "現行10列: 営業利益を見出しから取得"
Assert-Equal "247018" $rec2024."経常利益" "現行10列: 経常利益を見出しから取得"
Assert-Equal "154010" $rec2024."当期利益" "現行10列: 当期利益を見出しから取得"
Assert-Equal "82.9" $rec2024."EPS" "現行10列: EPS取得"
Assert-Equal "731.1" $rec2024."BPS" "現行10列: BPS取得"
$recMark = $r.records | Where-Object { $_."決算期" -eq "2025/03 I" }
Assert-Equal "1376364" $recMark."売上高" "現行10列: 会計基準マーク付き決算期を保持"
$recBank = $r.records | Where-Object { $_."決算期" -eq "2026/03" }
Assert-Equal "719073" $recBank."営業利益" "現行10列: 営業利益「－」は経常利益で代用(銀行様式)"

# ---------------------------------------------------------------------------
# fixture 2: 旧11列形式(既知の追加列「発表日」が末尾にある12列相当)。
#            必要な見出しが存在し意味が変わらなければ列数が増えても解析できること。
# ---------------------------------------------------------------------------
$hdr11 = New-StyleBHeader @("決算期", "売上高", "(前期比)", "営業利益", "(前期比)", "経常利益", "(前期比)", "当期利益", "(前期比)", "EPS", "BPS", "発表日")
$fixLegacy11 = @"
通期業績推移
$hdr11
2025/03${T}1,376,364${T}5.5%${T}287,145${T}19.1%${T}300,040${T}21.5%${T}183,504${T}19.1%${T}98.8円${T}811.1円${T}2025/05/15
四半期業績推移
"@
$r = Parse-AnnualFromText -Text $fixLegacy11
Assert-Equal "ok" $r.status "旧11列(既知列追加): status=ok"
Assert-Equal "287145" $r.records[0]."営業利益" "旧11列: 営業利益を見出しから取得"
Assert-Equal "98.8" $r.records[0]."EPS" "旧11列: EPS位置がずれても見出しで取得"

# ---------------------------------------------------------------------------
# fixture 3: 列順変更(営業利益と経常利益の位置を入替)。
#            固定位置なら値が入れ替わるが、見出し検証型では正しく対応付くこと。
# ---------------------------------------------------------------------------
$hdrSwap = New-StyleBHeader @("決算期", "売上高", "(前期比)", "経常利益", "(前期比)", "営業利益", "(前期比)", "当期利益", "(前期比)", "EPS", "BPS")
$fixSwap = @"
通期業績推移
$hdrSwap
2025/03${T}1,376,364${T}5.5%${T}300,040${T}21.5%${T}287,145${T}19.1%${T}183,504${T}19.1%${T}98.8円${T}811.1円
四半期業績推移
"@
$r = Parse-AnnualFromText -Text $fixSwap
Assert-Equal "ok" $r.status "列順変更: status=ok"
Assert-Equal "287145" $r.records[0]."営業利益" "列順変更: 営業利益が見出しに追従"
Assert-Equal "300040" $r.records[0]."経常利益" "列順変更: 経常利益が見出しに追従"

# ---------------------------------------------------------------------------
# fixture 4: 未知見出しの混入(意味を確定できない列) → Fail Closed
# ---------------------------------------------------------------------------
$hdrUnknown = New-StyleBHeader @("決算期", "売上高", "(前期比)", "調整後利益", "(前期比)", "経常利益", "(前期比)", "当期利益", "(前期比)", "EPS", "BPS")
$fixUnknown = @"
通期業績推移
$hdrUnknown
2025/03${T}1,376,364${T}5.5%${T}287,145${T}19.1%${T}300,040${T}21.5%${T}183,504${T}19.1%${T}98.8円${T}811.1円
四半期業績推移
"@
$r = Parse-AnnualFromText -Text $fixUnknown
Assert-Equal "mismatch" $r.status "未知見出し: PARSER_SCHEMA_MISMATCH"
Assert-Equal $true ("$($r.mismatches[0].reason)".Contains("missing_required") -or "$($r.mismatches[0].reason)".Contains("unknown_header")) "未知見出し: 理由に欠落/未知が記録される"

# ---------------------------------------------------------------------------
# fixture 5: 必須見出し欠落(経常利益なし) → Fail Closed
# ---------------------------------------------------------------------------
$hdrMissing = New-StyleBHeader @("決算期", "売上高", "(前期比)", "営業利益", "(前期比)", "当期利益", "(前期比)", "EPS", "BPS")
$fixMissing = @"
通期業績推移
$hdrMissing
2025/03${T}1,376,364${T}5.5%${T}287,145${T}19.1%${T}183,504${T}19.1%${T}98.8円${T}811.1円
四半期業績推移
"@
$r = Parse-AnnualFromText -Text $fixMissing
Assert-Equal "mismatch" $r.status "必須見出し欠落: PARSER_SCHEMA_MISMATCH"
Assert-Equal $true "$($r.mismatches[0].reason)".Contains("missing_required") "必須見出し欠落: 理由=missing_required"

# ---------------------------------------------------------------------------
# fixture 6: 同名必須見出しの重複 → Fail Closed
# ---------------------------------------------------------------------------
$hdrDup = New-StyleBHeader @("決算期", "売上高", "(前期比)", "売上高", "(前期比)", "経常利益", "(前期比)", "当期利益", "(前期比)", "EPS", "BPS")
$fixDup = @"
通期業績推移
$hdrDup
2025/03${T}1,376,364${T}5.5%${T}287,145${T}19.1%${T}300,040${T}21.5%${T}183,504${T}19.1%${T}98.8円${T}811.1円
四半期業績推移
"@
$r = Parse-AnnualFromText -Text $fixDup
Assert-Equal "mismatch" $r.status "見出し重複: PARSER_SCHEMA_MISMATCH"

# ---------------------------------------------------------------------------
# fixture 7: 行とヘッダーの列数不一致(値が1つ欠けた行) → Fail Closed
# ---------------------------------------------------------------------------
$fixShortRow = @"
通期業績推移
$hdr10
2025/03${T}1,376,364${T}5.5%${T}287,145${T}19.1%${T}300,040${T}21.5%${T}183,504${T}19.1%${T}98.8円
四半期業績推移
"@
$r = Parse-AnnualFromText -Text $fixShortRow
Assert-Equal "mismatch" $r.status "行列数不一致: PARSER_SCHEMA_MISMATCH"
Assert-Equal $true "$($r.mismatches[0].reason)".Contains("row_column_count_mismatch") "行列数不一致: 理由が記録される"

# ---------------------------------------------------------------------------
# fixture 8: New速報行混入(2026-08-08の実事例を再現)。
#            速報値テーブル(独自見出し・EPS/BPS列なし)のNew行は構造で識別して除外し、
#            通期詳細テーブルの実績行だけが取得されること。
# ---------------------------------------------------------------------------
$fixNewRow = @"
通期業績推移
※「変」は変則決算
速報値(2026/08/07発表)
決算期${T}売上高${T}（前期比）${T}営業利益${T}（前期比）${T}経常利益${T}（前期比）${T}当期利益${T}（前期比）
2027/03予${NBSP}New${T}10,666,000${T}-5.7%${T}-${T}-${T}869,000${T}15.3%${T}513,000${T}17.5%
$hdr10
2025/03${T}1,376,364${T}5.5%${T}287,145${T}19.1%${T}300,040${T}21.5%${T}183,504${T}19.1%${T}98.8円${T}811.1円
四半期業績推移
"@
$r = Parse-AnnualFromText -Text $fixNewRow
Assert-Equal "ok" $r.status "New行混入: status=ok(実績のみ取得)"
Assert-Equal 1 $r.records.Count "New行混入: New行はCSV対象外"
Assert-Equal "2025/03" $r.records[0]."決算期" "New行混入: 実績行のみ取得"
Assert-Equal 1 @($r.excluded | Where-Object { $_.reason -eq "new_flash_row" }).Count "New行混入: 速報行として分類・記録"

# New速報行しか存在しない場合(通期詳細が未展開)は absent → CSVを更新しない
$fixNewOnly = @"
通期業績推移
速報値(2026/08/07発表)
決算期${T}売上高${T}（前期比）${T}営業利益${T}（前期比）${T}経常利益${T}（前期比）${T}当期利益${T}（前期比）
2027/03予${NBSP}New${T}10,666,000${T}-5.7%${T}-${T}-${T}869,000${T}15.3%${T}513,000${T}17.5%
四半期業績推移
"@
$r = Parse-AnnualFromText -Text $fixNewOnly
Assert-Equal "absent" $r.status "New行のみ: absent(誤値を生成せず前回CSV維持)"

# ---------------------------------------------------------------------------
# fixture 9: 四半期行混入。区分見出しを持つ四半期テーブルは通期対象外として
#            構造で識別され、その行が通期として取り込まれないこと。
# ---------------------------------------------------------------------------
$hdrQ = New-StyleBHeader @("決算期", "区分", "売上高", "(前年比)", "営業利益", "(前年比)", "経常利益", "(前年比)", "当期利益", "(前年比)", "EPS")
$fixQuarter = @"
通期業績推移
$hdr10
2025/03${T}1,376,364${T}5.5%${T}287,145${T}19.1%${T}300,040${T}21.5%${T}183,504${T}19.1%${T}98.8円${T}811.1円
$hdrQ
2025/06${T}1Q${T}402,009${T}50.1%${T}96,111${T}66.9%${T}98,554${T}61.3%${T}67,562${T}53.5%${T}36.3円
四半期業績推移
"@
$r = Parse-AnnualFromText -Text $fixQuarter
Assert-Equal "ok" $r.status "四半期行混入: status=ok"
Assert-Equal 1 $r.records.Count "四半期行混入: 四半期行は通期に取り込まれない"
Assert-Equal "2025/03" $r.records[0]."決算期" "四半期行混入: 通期実績のみ"

# ---------------------------------------------------------------------------
# EPS会社予想: 正常形式
# ---------------------------------------------------------------------------
$r = Parse-EpsForecastFromText -Text $fixCurrent10
Assert-Equal "ok" $r.status "EPS予想: 正常形式で取得"
Assert-Equal "2027/03予" $r.record."決算期" "EPS予想: 決算期"
Assert-Equal "282.5" $r.record."EPS予想" "EPS予想: EPS値を見出し位置から取得"

# EPS会社予想: 列順変更でも見出しに追従
$fixSwapWithFc = @"
通期業績推移
$hdrSwap
2025/03${T}1,376,364${T}5.5%${T}300,040${T}21.5%${T}287,145${T}19.1%${T}183,504${T}19.1%${T}98.8円${T}811.1円
2027/03予${T}1,500,000${T}9.0%${T}330,000${T}10.0%${T}310,000${T}8.0%${T}200,000${T}9.0%${T}107.5円${T}－円
四半期業績推移
"@
$r = Parse-EpsForecastFromText -Text $fixSwapWithFc
Assert-Equal "ok" $r.status "EPS予想(列順変更): status=ok"
Assert-Equal "107.5" $r.record."EPS予想" "EPS予想(列順変更): EPSが見出しに追従"

# EPS会社予想: 予想行が本当に存在しない → no_forecast_row(従来の「抽出なし」)
$fixNoFc = @"
通期業績推移
$hdr10
2025/03${T}1,376,364${T}5.5%${T}287,145${T}19.1%${T}300,040${T}21.5%${T}183,504${T}19.1%${T}98.8円${T}811.1円
四半期業績推移
"@
$r = Parse-EpsForecastFromText -Text $fixNoFc
Assert-Equal "no_forecast_row" $r.status "EPS予想: 予想行なしを正しく判定"

# EPS会社予想: New速報の予行のみ(EPS列なし) → 「行がない」ではなく PARSER_SCHEMA_MISMATCH
$r = Parse-EpsForecastFromText -Text $fixNewOnly
Assert-Equal "mismatch" $r.status "EPS予想: New速報予行はmismatch(なし扱いにしない)"
Assert-Equal $true ("$($r.mismatches[0].row)".Length -gt 0) "EPS予想: 問題の行をログ対象に記録"

# EPS会社予想: 予想行の列数不一致 → PARSER_SCHEMA_MISMATCH
$fixFcShort = @"
通期業績推移
$hdr10
2025/03${T}1,376,364${T}5.5%${T}287,145${T}19.1%${T}300,040${T}21.5%${T}183,504${T}19.1%${T}98.8円${T}811.1円
四半期業績推移
"@
# 予行だけ列を1つ欠けさせたfixture(実績行は正常)
$fixFcShort = $fixFcShort.Replace("四半期業績推移", "2027/03予${T}2,700,000${T}4.9%${T}700,000${T}10.2%${T}770,000${T}8.7%${T}525,000${T}10.7%${T}282.5円`n四半期業績推移")
$r = Parse-EpsForecastFromText -Text $fixFcShort
Assert-Equal "mismatch" $r.status "EPS予想: 予想行の列数不一致はmismatch"

# ---------------------------------------------------------------------------
# キャッシュフロー: 正常形式
# ---------------------------------------------------------------------------
$hdrCf = New-StyleBHeader @("決算期", "営業CF", "投資CF", "財務CF", "現金・現金等価物", "フリーCF")
$fixCf = @"
キャッシュフロー推移
表示：折りたたむ
$hdrCf
2024/03${T}272,488${T}-185,183${T}-61,833${T}404,532${T}87,305
2025/03${T}202,413${T}-248,626${T}-53,534${T}301,619${T}-46,213
貸借対照表
"@
$r = Parse-CashflowFromText -Text $fixCf
Assert-Equal "ok" $r.status "CF: status=ok"
Assert-Equal 2 $r.records.Count "CF: 2行取得"
Assert-Equal "272488" $r.records[0]."営業CF" "CF: 営業CFを見出しから取得"
Assert-Equal "-185183" $r.records[0]."投資CF" "CF: 投資CF"
Assert-Equal "87305" $r.records[0]."フリーCF" "CF: フリーCF"

# キャッシュフロー: 列順変更(投資CFと財務CFを入替)でも見出しに追従
$hdrCfSwap = New-StyleBHeader @("決算期", "営業CF", "財務CF", "投資CF", "現金・現金等価物", "フリーCF")
$fixCfSwap = @"
キャッシュフロー推移
$hdrCfSwap
2024/03${T}272,488${T}-61,833${T}-185,183${T}404,532${T}87,305
貸借対照表
"@
$r = Parse-CashflowFromText -Text $fixCfSwap
Assert-Equal "ok" $r.status "CF(列順変更): status=ok"
Assert-Equal "-185183" $r.records[0]."投資CF" "CF(列順変更): 投資CFが見出しに追従"
Assert-Equal "-61833" $r.records[0]."財務CF" "CF(列順変更): 財務CFが見出しに追従"

# キャッシュフロー: 未知見出し → Fail Closed
$hdrCfUnknown = New-StyleBHeader @("決算期", "営業CF", "投資CF", "財務CF", "謎の新列", "フリーCF")
$fixCfUnknown = @"
キャッシュフロー推移
$hdrCfUnknown
2024/03${T}272,488${T}-185,183${T}-61,833${T}404,532${T}87,305
貸借対照表
"@
$r = Parse-CashflowFromText -Text $fixCfUnknown
Assert-Equal "mismatch" $r.status "CF(未知見出し): PARSER_SCHEMA_MISMATCH"

# キャッシュフロー: 行列数不一致 → Fail Closed
$fixCfShort = @"
キャッシュフロー推移
$hdrCf
2024/03${T}272,488${T}-185,183${T}-61,833${T}404,532
貸借対照表
"@
$r = Parse-CashflowFromText -Text $fixCfShort
Assert-Equal "mismatch" $r.status "CF(行列数不一致): PARSER_SCHEMA_MISMATCH"

# ---------------------------------------------------------------------------
# 結果
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "==== 結果: PASS=$($script:passCount) FAIL=$($script:failCount) ===="
if ($script:failCount -gt 0) { exit 1 }
exit 0
