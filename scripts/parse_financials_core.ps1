# parse_financials_core.ps1
# ヘッダー検証型パーサの共通関数（関数定義のみ。実行時副作用なし）。
# parse_financials.ps1 / parse_financials_extended.ps1 / tests から dot-source で読み込む。
#
# 設計原則（2026-08-09 nobu指示）:
#  - データ行を読む前に必ずテーブルの見出しを取得し、見出し名から列位置を動的に決定する。
#  - 必須見出しの欠落・重複・未知見出しの混入・行と見出しの列数不一致は推測せず
#    PARSER_SCHEMA_MISMATCH として Fail Closed する。
#  - New速報行・予想行・四半期行は文字列位置の偶然ではなく、
#    セクション範囲・見出し構造・行の決算期セルで区別する。
#  - 見出しの軽微な表記揺れは明示的な alias 辞書のみで吸収する（推測対応付け禁止）。

# ---------------------------------------------------------------------------
# 見出し正規化と alias 辞書
# ---------------------------------------------------------------------------

function Normalize-HeaderLabel {
    param([string]$Label)
    if ($null -eq $Label) { return "" }
    $v = $Label
    $v = $v -replace [char]0x00A0, ""     # NBSP
    $v = $v -replace "▲", ""              # tablesorter のソートマーカー
    $v = $v -replace "（", "("
    $v = $v -replace "）", ")"
    $v = $v -replace "\s+", ""
    return $v.Trim()
}

# 通期業績テーブルの見出し辞書。
# required: この5項目が一意に特定できなければ解析しない。
# optional: あれば取得する。ignorable: 存在してよいが値は使わない。
# quarterly_marker: この見出しがあるテーブルは四半期テーブルとして通期対象から除外する。
# 上記いずれにも該当しない見出しが1つでもあれば、そのテーブルは意味を確定できない
# として PARSER_SCHEMA_MISMATCH にする（未知見出しの推測対応付け禁止）。
$script:AnnualHeaderAliases = @{
    "決算期"   = "period"
    "売上高"   = "sales"
    "営業利益" = "op"
    "経常利益" = "ordinary"
    "当期利益" = "net"
    "純利益"   = "net"
    "当期純利益" = "net"
    "親会社株主に帰属する当期純利益" = "net"
    "EPS"      = "eps"
    "BPS"      = "bps"
}
$script:AnnualRequiredKeys = @("period", "sales", "op", "ordinary", "net")
# 2026-08-11: 一部銘柄（7826等）で「売上原価・売上総利益・販売管理費・EBITDA」列を含む
# 拡張レイアウトが返り、未知見出しとして表全体がPARSER_SCHEMA_MISMATCHになっていたため追加。
# 値は使わない（既存の決算期/売上高/営業利益/経常利益/当期利益/EPS/BPS抽出には影響しない）。
$script:AnnualIgnorableHeaders = @("(前期比)", "前期比", "(前年比)", "前年比", "発表日", "売上原価", "売上総利益", "販売管理費", "EBITDA")
$script:QuarterlyMarkerHeaders = @("区分")

# キャッシュフロー推移テーブルの見出し辞書
$script:CashflowHeaderAliases = @{
    "決算期" = "period"
    "営業CF" = "op_cf"
    "投資CF" = "inv_cf"
    "財務CF" = "fin_cf"
    "現金・現金等価物" = "cash"
    "現金同等物" = "cash"
    "フリーCF" = "free_cf"
}
$script:CashflowRequiredKeys = @("period", "op_cf", "inv_cf", "fin_cf")
$script:CashflowIgnorableHeaders = @()

# ---------------------------------------------------------------------------
# 見出し → 列位置マップの解決
# ---------------------------------------------------------------------------

function Resolve-HeaderMap {
    param(
        [string[]]$Labels,
        [hashtable]$Aliases,
        [string[]]$RequiredKeys,
        [string[]]$IgnorableHeaders,
        [string[]]$MarkerHeaders = @()
    )
    $map = @{}
    $unknown = @()
    $duplicates = @()
    $hasMarker = $false
    for ($i = 0; $i -lt $Labels.Count; $i++) {
        $lab = Normalize-HeaderLabel $Labels[$i]
        if ([string]::IsNullOrWhiteSpace($lab)) { continue }
        if ($MarkerHeaders -contains $lab) { $hasMarker = $true; continue }
        if ($IgnorableHeaders -contains $lab) { continue }
        if ($Aliases.ContainsKey($lab)) {
            $key = $Aliases[$lab]
            if ($map.ContainsKey($key)) { $duplicates += $lab } else { $map[$key] = $i }
        } else {
            $unknown += $lab
        }
    }
    $missing = @($RequiredKeys | Where-Object { -not $map.ContainsKey($_) })
    $ok = ($missing.Count -eq 0 -and $duplicates.Count -eq 0 -and $unknown.Count -eq 0 -and -not $hasMarker)
    $reason = ""
    if ($hasMarker) { $reason = "quarterly_table" }
    elseif ($missing.Count -gt 0) { $reason = "missing_required:" + ($missing -join ",") }
    elseif ($duplicates.Count -gt 0) { $reason = "duplicate_header:" + ($duplicates -join ",") }
    elseif ($unknown.Count -gt 0) { $reason = "unknown_header:" + ($unknown -join ",") }
    return @{
        ok = $ok
        reason = $reason
        map = $map
        unknown = $unknown
        duplicates = $duplicates
        missing = $missing
        isQuarterly = $hasMarker
        headerCount = $Labels.Count
        labels = @($Labels | ForEach-Object { Normalize-HeaderLabel $_ })
    }
}

# ---------------------------------------------------------------------------
# テキストからのセクション切り出しとテーブルブロック検出
# ---------------------------------------------------------------------------

# StartMarker の全出現箇所についてセクションを切り出す。
# マネックスのページは「通期業績推移」がチャート要約ブロックと詳細テーブルブロックの
# 2箇所に現れるため、最初の1箇所だけを見ると詳細テーブルを取りこぼす。
function Get-TextSections {
    param([string]$Text, [string]$StartMarker, [string[]]$EndMarkers)
    $sections = @()
    $pos = 0
    while ($true) {
        $startIdx = $Text.IndexOf($StartMarker, $pos)
        if ($startIdx -lt 0) { break }
        $searchFrom = $startIdx + $StartMarker.Length
        $endIdx = $Text.Length
        foreach ($m in ($EndMarkers + @($StartMarker))) {
            $i = $Text.IndexOf($m, $searchFrom)
            if ($i -ge 0 -and $i -lt $endIdx) { $endIdx = $i }
        }
        $sections += $Text.Substring($startIdx, $endIdx - $startIdx)
        $pos = [Math]::Max($endIdx, $searchFrom)
    }
    return $sections
}

function Test-DataRowLine {
    param([string]$Line)
    return ($Line -match "^\d{4}/\d{2}" -and $Line.Contains("`t"))
}

# セクション内のテーブルブロック（見出し列挙 + 直後のデータ行群）を列挙する。
# 見出しは2形式に対応:
#   style A: 「決算期<TAB>売上高<TAB>...」の1行見出し
#   style B: 「決算期」「▲」「(タブのみ行)」「売上高」... と縦に並ぶ複数行見出し
function Get-TextTableBlocks {
    param([string]$SectionText)
    $blocks = @()
    if ([string]::IsNullOrWhiteSpace($SectionText)) { return $blocks }
    $lines = $SectionText -split "\r?\n"
    $n = $lines.Count
    $i = 0
    while ($i -lt $n) {
        $line = $lines[$i]
        $norm = Normalize-HeaderLabel $line
        $headers = $null
        if ($line -match "^決算期`t") {
            # style A: 1行見出し
            $headers = @($line.TrimEnd() -split "`t")
            $i++
        } elseif ($norm -eq "決算期" -and -not $line.Contains("`t")) {
            # style B: 縦並び見出し。▲行・タブのみ行・空行を読み飛ばしつつ
            # 見出しラベルを収集し、データ行または空行到達で終える。
            $headers = @("決算期")
            $j = $i + 1
            while ($j -lt $n) {
                $l2 = $lines[$j]
                $t2 = $l2.Trim()
                if ($t2 -eq "▲" -or $t2 -eq "") {
                    # 空行はデータ行直前の区切りの可能性がある。次の非空行がデータ行なら終了。
                    if ($t2 -eq "") {
                        $k = $j
                        while ($k -lt $n -and $lines[$k].Trim() -eq "") { $k++ }
                        if ($k -lt $n -and (Test-DataRowLine $lines[$k])) { $j = $k; break }
                    }
                    $j++
                    continue
                }
                if (Test-DataRowLine $l2) { break }
                # タブのみ行（区切り）を除いたラベル行
                if (($l2 -replace "`t", "").Trim() -eq "") { $j++; continue }
                $headers += $l2
                $j++
            }
            $i = $j
        } else {
            $i++
            continue
        }
        # データ行の収集（見出し直後の連続する行のみ。空行はデータ開始前のみ許容）
        while ($i -lt $n -and $lines[$i].Trim() -eq "") { $i++ }
        $rows = @()
        while ($i -lt $n -and (Test-DataRowLine $lines[$i])) {
            $rows += $lines[$i]
            $i++
        }
        $blocks += @{ Headers = $headers; Rows = $rows }
    }
    return $blocks
}

# ---------------------------------------------------------------------------
# 行の分類（通期実績 / 会社予想 / New速報 / 構造不一致）
# ---------------------------------------------------------------------------

function Get-PeriodCellKind {
    param([string]$PeriodCell)
    $p = ($PeriodCell -replace [char]0x00A0, " ").Trim()
    if ($p -match "New") { return "new_flash" }
    if ($p -match "^\d{4}/\d{2}\s*予") { return "forecast" }
    if ($p -match "^\d{4}/\d{2}(\s+(変|S|I))?$") { return "actual" }
    return "unknown"
}

function Split-DataRow {
    param([string]$Line)
    return @($Line.TrimEnd() -split "`t")
}

# ---------------------------------------------------------------------------
# 通期業績のテキスト解析（ヘッダー検証型）
# 戻り値: @{ status = "ok" | "absent" | "mismatch"; records; mismatches; excluded }
#   ok      : 検証済みテーブルから1行以上の実績を取得
#   absent  : 通期業績推移セクションまたは対象テーブル・実績行が存在しない
#             （折りたたみ未展開など。誤値を作らないため解析しない）
#   mismatch: 見出しまたは行構造を確定できない → Fail Closed
# ---------------------------------------------------------------------------

# テーブルブロック集合に共通の通期解析。ブロックは @{ Headers; Rows(セル配列の配列) } の配列。
# 判定規則:
#  - 区分見出しを持つテーブル(四半期)は対象外として読み飛ばす。
#  - 見出し検証に失敗したテーブルは headerMismatch として記録し、
#    クリーンなテーブルから1行も取得できなかった場合のみ全体を mismatch にする
#    (検証済みテーブルがあれば対応関係は確定しているため、無関係テーブルで解析を止めない。
#     その場合も警告として warnings に残す)。
#  - 検証済みテーブル内の行列数不一致・解釈不能な決算期セルは、そのテーブル自体の
#    構造変化を意味するため即 mismatch (Fail Closed)。
function Resolve-AnnualBlocks {
    param([object[]]$Blocks, [string]$TableName)
    $result = @{ status = ""; records = @(); mismatches = @(); warnings = @(); excluded = @(); tables = 0 }
    $required = "決算期|売上高|営業利益|経常利益|当期利益(または純利益)"
    $records = @()
    foreach ($block in $Blocks) {
        $hdr = Resolve-HeaderMap -Labels $block.Headers `
            -Aliases $script:AnnualHeaderAliases -RequiredKeys $script:AnnualRequiredKeys `
            -IgnorableHeaders $script:AnnualIgnorableHeaders -MarkerHeaders $script:QuarterlyMarkerHeaders
        if ($hdr.isQuarterly) { continue }   # 四半期テーブル（区分見出し）は通期対象外
        if (-not $hdr.ok) {
            $result.warnings += @{
                table = $TableName; reason = $hdr.reason
                headersFound = ($hdr.labels -join "|"); headersRequired = $required; row = ""
            }
            continue
        }
        $result.tables += 1
        foreach ($row in $block.Rows) {
            $cols = @($row)
            if ($cols.Count -ne $block.Headers.Count) {
                $result.mismatches += @{
                    table = $TableName; reason = "row_column_count_mismatch(header=$($block.Headers.Count) row=$($cols.Count))"
                    headersFound = ($hdr.labels -join "|"); headersRequired = $required
                    row = ($cols -join "|")
                }
                continue
            }
            $periodCell = $cols[$hdr.map["period"]]
            $kind = Get-PeriodCellKind $periodCell
            if ($kind -eq "new_flash") {
                $result.excluded += @{ reason = "new_flash_row"; row = ($cols -join "|") }
                continue
            }
            if ($kind -eq "forecast") {
                $result.excluded += @{ reason = "forecast_row"; row = ($cols -join "|") }
                continue
            }
            if ($kind -eq "unknown") {
                $result.mismatches += @{
                    table = $TableName; reason = "unrecognized_period_cell($periodCell)"
                    headersFound = ($hdr.labels -join "|"); headersRequired = $required
                    row = ($cols -join "|")
                }
                continue
            }
            $rec = New-AnnualRecord -Cols $cols -HeaderMap $hdr.map
            if ($null -ne $rec) { $records += $rec }
        }
    }
    if ($result.mismatches.Count -gt 0) { $result.status = "mismatch"; return $result }
    if ($records.Count -eq 0) {
        if ($result.warnings.Count -gt 0) {
            # 業績らしきテーブルはあったが見出しを確定できなかった → Fail Closed
            $result.mismatches = $result.warnings
            $result.status = "mismatch"
        } else {
            $result.status = "absent"
        }
        return $result
    }
    $unique = @{}
    foreach ($r in $records) {
        if (-not $unique.ContainsKey($r."決算期")) { $unique[$r."決算期"] = $r }
    }
    $result.records = @($unique.Values | Sort-Object "決算期")
    $result.status = "ok"
    return $result
}

function Parse-AnnualFromText {
    param([string]$Text)
    $sections = @(Get-TextSections -Text $Text -StartMarker "通期業績推移" `
        -EndMarkers @("四半期業績推移", "キャッシュフロー推移", "貸借対照表"))
    if ($sections.Count -eq 0) {
        return @{ status = "absent"; records = @(); mismatches = @(); warnings = @(); excluded = @(); tables = 0 }
    }
    $blocks = @()
    foreach ($section in $sections) {
        foreach ($b in @(Get-TextTableBlocks $section)) {
            $rows = @()
            foreach ($line in $b.Rows) { $rows += , (Split-DataRow $line) }
            $blocks += @{ Headers = $b.Headers; Rows = $rows }
        }
    }
    return Resolve-AnnualBlocks -Blocks $blocks -TableName "通期業績推移"
}

function New-AnnualRecord {
    param([string[]]$Cols, [hashtable]$HeaderMap)
    $period = ($Cols[$HeaderMap["period"]] -replace [char]0x00A0, " ").Trim()
    $sales = Normalize-Value $Cols[$HeaderMap["sales"]]
    $op = Normalize-Value $Cols[$HeaderMap["op"]]
    $ordinary = Normalize-Value $Cols[$HeaderMap["ordinary"]]
    $net = Normalize-Value $Cols[$HeaderMap["net"]]
    $eps = ""
    $bps = ""
    if ($HeaderMap.ContainsKey("eps")) { $eps = Normalize-Value $Cols[$HeaderMap["eps"]] }
    if ($HeaderMap.ContainsKey("bps")) { $bps = Normalize-Value $Cols[$HeaderMap["bps"]] }
    # 銀行・金融業は営業利益欄が「－」になるため経常利益を代用する（従来仕様を維持）
    if ([string]::IsNullOrWhiteSpace($op)) { $op = $ordinary }
    if ([string]::IsNullOrWhiteSpace($sales) -or [string]::IsNullOrWhiteSpace($op) -or
        [string]::IsNullOrWhiteSpace($ordinary) -or [string]::IsNullOrWhiteSpace($net)) {
        return $null   # 必須値が欠ける行は従来どおり除外（推測補完しない）
    }
    return [pscustomobject]@{
        "決算期" = $period
        "売上高" = $sales
        "営業利益" = $op
        "経常利益" = $ordinary
        "当期利益" = $net
        "EPS" = $eps
        "BPS" = $bps
    }
}

# 値の正規化（旧 parse_financials.ps1 / parse_financials_extended.ps1 と同一仕様）
function Normalize-Value {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    $v = [System.Net.WebUtility]::HtmlDecode($Value).Trim()
    $v = $v -replace [char]0x00A0, " "
    $v = $v -replace ",", ""
    $v = $v -replace "円|百万円|倍|％|%", ""
    $v = $v -replace "\s+", ""
    if ($v -match "^[-－―]+$" -or $v -eq "") { return "" }
    return $v
}

# ---------------------------------------------------------------------------
# 通期業績のHTML解析（テキスト側に通期テーブルが存在しない場合のフォールバック。
# 従来の detail_year/detail_num 位置依存を廃し、テキストと同じヘッダー検証を行う）
# ---------------------------------------------------------------------------

function Strip-HtmlCellText {
    param([string]$Html)
    $text = [regex]::Replace($Html, "(?is)<script\b[^>]*>.*?</script>", "")
    $text = [regex]::Replace($text, "(?is)<style\b[^>]*>.*?</style>", "")
    $text = [regex]::Replace($text, "(?is)<[^>]+>", "")
    $text = [System.Net.WebUtility]::HtmlDecode($text)
    $text = $text -replace [char]0x00A0, " "
    return ($text -replace "\s+", " ").Trim()
}

function Parse-AnnualFromHtml {
    param([string]$Html)
    $scopes = @(Get-TextSections -Text $Html -StartMarker "通期業績推移" `
        -EndMarkers @("四半期業績推移"))
    if ($scopes.Count -eq 0) {
        return @{ status = "absent"; records = @(); mismatches = @(); warnings = @(); excluded = @(); tables = 0 }
    }
    $scope = $scopes -join "`n"
    $blocks = @()
    $tableMatches = [regex]::Matches($scope, "(?is)<table\b[^>]*>.*?</table>")
    foreach ($tm in $tableMatches) {
        $rowMatches = [regex]::Matches($tm.Value, "(?is)<tr\b[^>]*>.*?</tr>")
        if ($rowMatches.Count -lt 2) { continue }
        $headerCells = [regex]::Matches($rowMatches[0].Value, "(?is)<t[hd]\b[^>]*>(.*?)</t[hd]>")
        $headers = @()
        foreach ($hc in $headerCells) { $headers += (Strip-HtmlCellText $hc.Groups[1].Value) }
        if ($headers.Count -eq 0) { continue }
        if ((Normalize-HeaderLabel $headers[0]) -ne "決算期") { continue }
        $rows = @()
        for ($ri = 1; $ri -lt $rowMatches.Count; $ri++) {
            $cellMatches = [regex]::Matches($rowMatches[$ri].Value, "(?is)<t[hd]\b[^>]*>(.*?)</t[hd]>")
            $cols = @()
            foreach ($cm in $cellMatches) { $cols += (Strip-HtmlCellText $cm.Groups[1].Value) }
            if ($cols.Count -eq 0) { continue }
            if ($cols[0] -notmatch "^\d{4}/\d{2}") { continue }
            $rows += , $cols
        }
        $blocks += @{ Headers = $headers; Rows = $rows }
    }
    return Resolve-AnnualBlocks -Blocks $blocks -TableName "通期業績推移(HTML)"
}

# ---------------------------------------------------------------------------
# EPS会社予想のテキスト解析（ヘッダー検証型）
# 戻り値: @{ status = "ok" | "no_forecast_row" | "mismatch"; record; mismatches }
#   ok              : 検証済みテーブルの予想行からEPSを取得
#   no_forecast_row : 予想行(決算期に「予」)がテキスト全体に存在しない
#   mismatch        : 予想行は存在するが既知形式で解釈できない → Fail Closed
# ---------------------------------------------------------------------------

function Parse-EpsForecastFromText {
    param([string]$Text)
    $result = @{ status = ""; record = $null; mismatches = @() }
    $sections = @(Get-TextSections -Text $Text -StartMarker "通期業績推移" `
        -EndMarkers @("四半期業績推移", "キャッシュフロー推移", "貸借対照表"))
    $forecastSeen = @()
    $blocks = @()
    foreach ($section in $sections) { $blocks += @(Get-TextTableBlocks $section) }
    if ($true) {
        foreach ($block in $blocks) {
            $hdr = Resolve-HeaderMap -Labels $block.Headers `
                -Aliases $script:AnnualHeaderAliases -RequiredKeys $script:AnnualRequiredKeys `
                -IgnorableHeaders $script:AnnualIgnorableHeaders -MarkerHeaders $script:QuarterlyMarkerHeaders
            if ($hdr.isQuarterly) { continue }
            foreach ($rowLine in $block.Rows) {
                $cols = Split-DataRow $rowLine
                $periodCell = if ($cols.Count -gt 0) { $cols[0] } else { "" }
                $kind = Get-PeriodCellKind $periodCell
                if ($kind -ne "forecast" -and $kind -ne "new_flash") { continue }
                if ($kind -eq "new_flash" -and $periodCell -notmatch "予") { continue }
                $forecastSeen += $rowLine
                if ($null -ne $result.record) { continue }   # 最初に解釈できた予想行を採用（従来仕様）
                if (-not $hdr.ok) {
                    $result.mismatches += @{
                        table = "通期業績推移"; reason = "forecast_row_in_unvalidated_table(" + $hdr.reason + ")"
                        headersFound = ($hdr.labels -join "|"); headersRequired = "決算期|売上高|営業利益|経常利益|当期利益|EPS"
                        row = $rowLine
                    }
                    continue
                }
                if (-not $hdr.map.ContainsKey("eps")) {
                    $result.mismatches += @{
                        table = "通期業績推移"; reason = "forecast_row_without_eps_header"
                        headersFound = ($hdr.labels -join "|"); headersRequired = "決算期|売上高|営業利益|経常利益|当期利益|EPS"
                        row = $rowLine
                    }
                    continue
                }
                if ($cols.Count -ne $block.Headers.Count) {
                    $result.mismatches += @{
                        table = "通期業績推移"; reason = "row_column_count_mismatch(header=$($block.Headers.Count) row=$($cols.Count))"
                        headersFound = ($hdr.labels -join "|"); headersRequired = "決算期|売上高|営業利益|経常利益|当期利益|EPS"
                        row = $rowLine
                    }
                    continue
                }
                if ($kind -eq "new_flash") {
                    $result.mismatches += @{
                        table = "通期業績推移"; reason = "forecast_row_is_flash_new"
                        headersFound = ($hdr.labels -join "|"); headersRequired = "決算期|売上高|営業利益|経常利益|当期利益|EPS"
                        row = $rowLine
                    }
                    continue
                }
                $eps = Normalize-Value $cols[$hdr.map["eps"]]
                $period = ($cols[0] -replace [char]0x00A0, " ").Trim()
                $result.record = [pscustomobject]@{
                    "決算期" = ($period -replace "\s*予$", "") + "予"
                    "EPS予想" = $eps
                    "区分" = "会社予想"
                }
            }
        }
    }
    if ($null -ne $result.record) { $result.status = "ok"; return $result }
    if ($forecastSeen.Count -eq 0) {
        # セクション外も含めテキスト全体で予想行の痕跡を確認してから「なし」と判定する
        $anywhere = [regex]::Match(($Text -replace [char]0x00A0, " "), "(?m)^\d{4}/\d{2}\s*予.*$")
        if ($anywhere.Success) {
            $result.mismatches += @{
                table = "通期業績推移"; reason = "forecast_row_outside_validated_table"
                headersFound = ""; headersRequired = "決算期|売上高|営業利益|経常利益|当期利益|EPS"
                row = $anywhere.Value
            }
            $result.status = "mismatch"; return $result
        }
        $result.status = "no_forecast_row"; return $result
    }
    $result.status = "mismatch"
    return $result
}

# ---------------------------------------------------------------------------
# キャッシュフロー推移のテキスト解析（ヘッダー検証型）
# 戻り値: @{ status = "ok" | "absent" | "mismatch"; records; mismatches }
# ---------------------------------------------------------------------------

function Parse-CashflowFromText {
    param([string]$Text)
    $result = @{ status = ""; records = @(); mismatches = @() }
    $sections = @(Get-TextSections -Text $Text -StartMarker "キャッシュフロー推移" `
        -EndMarkers @("貸借対照表"))
    if ($sections.Count -eq 0) { $result.status = "absent"; return $result }
    $blocks = @()
    foreach ($section in $sections) { $blocks += @(Get-TextTableBlocks $section) }
    $records = @()
    foreach ($block in $blocks) {
        $hdr = Resolve-HeaderMap -Labels $block.Headers `
            -Aliases $script:CashflowHeaderAliases -RequiredKeys $script:CashflowRequiredKeys `
            -IgnorableHeaders $script:CashflowIgnorableHeaders
        if (-not $hdr.ok) {
            $result.mismatches += @{
                table = "キャッシュフロー推移"; reason = $hdr.reason
                headersFound = ($hdr.labels -join "|")
                headersRequired = "決算期|営業CF|投資CF|財務CF"
                row = ""
            }
            continue
        }
        foreach ($rowLine in $block.Rows) {
            $cols = Split-DataRow $rowLine
            if ($cols.Count -ne $block.Headers.Count) {
                $result.mismatches += @{
                    table = "キャッシュフロー推移"; reason = "row_column_count_mismatch(header=$($block.Headers.Count) row=$($cols.Count))"
                    headersFound = ($hdr.labels -join "|")
                    headersRequired = "決算期|営業CF|投資CF|財務CF"
                    row = $rowLine
                }
                continue
            }
            $periodCell = ($cols[$hdr.map["period"]] -replace [char]0x00A0, " ").Trim()
            if ($periodCell -match "New") { continue }   # 速報行はCF系列に含めない
            # 従来仕様: 決算期の会計基準マーク(S/I)は保持し、末尾の「予」は除いた形で採用
            $period = $periodCell -replace "予$", ""
            if ($period -notmatch "^\d{4}/\d{2}(\s+(変|S|I))?$") { continue }
            $cash = ""
            $free = ""
            if ($hdr.map.ContainsKey("cash")) { $cash = Normalize-Value $cols[$hdr.map["cash"]] }
            if ($hdr.map.ContainsKey("free_cf")) { $free = Normalize-Value $cols[$hdr.map["free_cf"]] }
            $records += [pscustomobject]@{
                "決算期" = $period
                "営業CF" = Normalize-Value $cols[$hdr.map["op_cf"]]
                "投資CF" = Normalize-Value $cols[$hdr.map["inv_cf"]]
                "財務CF" = Normalize-Value $cols[$hdr.map["fin_cf"]]
                "現金同等物" = $cash
                "フリーCF" = $free
            }
        }
    }
    if ($result.mismatches.Count -gt 0) { $result.status = "mismatch"; return $result }
    if ($records.Count -eq 0) { $result.status = "absent"; return $result }
    $unique = @{}
    foreach ($r in $records) {
        if (-not $unique.ContainsKey($r."決算期")) { $unique[$r."決算期"] = $r }
    }
    $result.records = @($unique.Values | Sort-Object "決算期")
    $result.status = "ok"
    return $result
}

# ---------------------------------------------------------------------------
# PARSER_SCHEMA_MISMATCH のログ整形（1件1行。必須8項目を含める）
# ---------------------------------------------------------------------------

function Format-SchemaMismatchLogLines {
    param(
        [string]$BCode,
        [string]$FetchedAt,
        [object[]]$Mismatches,
        [string]$RawPath
    )
    $lines = @()
    foreach ($mm in $Mismatches) {
        $row = [string]$mm.row
        if ($row.Length -gt 300) { $row = $row.Substring(0, 300) + "..." }
        $lines += ("PARSER_SCHEMA_MISMATCH bcode=$BCode fetched_at=$FetchedAt table=$($mm.table) " +
                   "reason=$($mm.reason) headers_found=$($mm.headersFound) " +
                   "headers_required=$($mm.headersRequired) raw=$RawPath row=$row")
    }
    return $lines
}
