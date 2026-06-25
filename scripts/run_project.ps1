param()

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    $ScriptDir = Resolve-Path ".\scripts"
} else {
    $ScriptDir = Resolve-Path $PSScriptRoot
}

$ProjectRoot = Resolve-Path (Join-Path $ScriptDir "..")
$DesktopDir = Resolve-Path (Join-Path $ProjectRoot "..")
$SourceProjectDir = Join-Path $DesktopDir "04_強銘柄追随"
$SourceCandidatesPath = Join-Path $SourceProjectDir "data\follow_candidates.csv"
$SourceHandoffScript = Join-Path $SourceProjectDir "scripts\generate_handoff_to_05.ps1"
$TargetCodesPath = Join-Path $ProjectRoot "data\target_codes.csv"

function Get-CodeList([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return @()
    }
    return @(Import-Csv -LiteralPath $Path -Encoding UTF8 | ForEach-Object { ([string]$_.code).Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Test-CodeListEqual([string[]]$Left, [string[]]$Right) {
    if ($Left.Count -ne $Right.Count) { return $false }
    for ($i = 0; $i -lt $Left.Count; $i += 1) {
        if ([string]$Left[$i] -ne [string]$Right[$i]) { return $false }
    }
    return $true
}

Push-Location $ProjectRoot
try {
    $StartedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    if (-not (Test-Path -LiteralPath $SourceCandidatesPath)) {
        throw "source follow_candidates not found: $SourceCandidatesPath"
    }
    if (-not (Test-Path -LiteralPath $SourceHandoffScript)) {
        throw "handoff script not found: $SourceHandoffScript"
    }

    & powershell -NoProfile -ExecutionPolicy Bypass -File $SourceHandoffScript

    if (-not (Test-Path -LiteralPath $TargetCodesPath)) {
        throw "target codes not found after handoff: $TargetCodesPath"
    }

    $SourceCodes = @(Get-CodeList $SourceCandidatesPath)
    $TargetCodes = @(Get-CodeList $TargetCodesPath)
    $SourceFile = Get-Item -LiteralPath $SourceCandidatesPath
    $TargetFile = Get-Item -LiteralPath $TargetCodesPath

    Write-Host "04 follow_candidates.csv: $($SourceFile.FullName) lastwrite=$($SourceFile.LastWriteTime.ToString('yyyy/MM/dd HH:mm:ss')) count=$($SourceCodes.Count)"
    Write-Host "05 target_codes.csv: $($TargetFile.FullName) lastwrite=$($TargetFile.LastWriteTime.ToString('yyyy/MM/dd HH:mm:ss')) count=$($TargetCodes.Count)"

    if ($SourceCodes.Count -ne 60) {
        throw "04 follow_candidates count is not 60: $($SourceCodes.Count)"
    }
    if ($TargetCodes.Count -ne 60) {
        throw "05 target_codes count is not 60: $($TargetCodes.Count)"
    }

    $SourceSet = @($SourceCodes | Sort-Object -Unique)
    $TargetSet = @($TargetCodes | Sort-Object -Unique)
    if (-not (Test-CodeListEqual $SourceSet $TargetSet)) {
        $OnlySource = @($SourceSet | Where-Object { $_ -notin $TargetSet })
        $OnlyTarget = @($TargetSet | Where-Object { $_ -notin $SourceSet })
        throw "04/05 code set mismatch: only04=$($OnlySource -join ',') only05=$($OnlyTarget -join ',')"
    }

    if (-not (Test-CodeListEqual $SourceCodes $TargetCodes)) {
        Write-Host "04と05のコード集合は一致していますが、CSV順は04 follow_candidates.csv を基準に確認済みです。"
    }

    & (Join-Path $ScriptDir "fetch_target_financials.ps1")
    & (Join-Path $ScriptDir "generate_fundamentals.ps1")

    $fetchStatuses = @(Import-Csv -LiteralPath "data/fetch_status.csv" -Encoding UTF8)
    $latestSuccessCount = @($fetchStatuses | Where-Object { $_.fetch_status -eq "success" }).Count
    $fallbackCount = @($fetchStatuses | Where-Object { $_.fetch_status -eq "fallback_used" }).Count

    if ($latestSuccessCount -gt 0) {
        & (Join-Path $ScriptDir "generate_fundamental_scores.ps1") -SourceStatusFilter latest
        & (Join-Path $ScriptDir "generate_fundamental_report.ps1")
    }
    else {
        Write-Warning "警告：最新取得成功数0件。通常レポートは更新しません。fallback専用レポートのみ出力しました。"
    }

    if ($fallbackCount -gt 0) {
        $fallbackScoresPath = "data/fundamental_scores_fallback_only.csv"
        $fallbackReportPath = "reports/fundamental_scores_fallback_only.md"
        $fallbackExcelPath = "reports/fundamental_scores_fallback_only.xlsx"
        & (Join-Path $ScriptDir "generate_fundamental_scores.ps1") -OutputPath $fallbackScoresPath -SourceStatusFilter fallback
        & (Join-Path $ScriptDir "generate_fundamental_report.ps1") -ScoresPath $fallbackScoresPath -ReportPath $fallbackReportPath -ExcelPath $fallbackExcelPath -FallbackReport
    }

    if ($latestSuccessCount -le 0) {
        Write-Host "04最終再生成をスキップ: 05の最新取得成功数が0件"
    }
    else {
        $FinalProjectDir = $SourceProjectDir
        $FinalGenerateCandidates = Join-Path $FinalProjectDir "scripts\generate_follow_candidates.ps1"
        $FinalGenerateExcel = Join-Path $FinalProjectDir "scripts\generate_excel_report.py"
        $FinalFundamentalScores = Join-Path $ProjectRoot "data\fundamental_scores.csv"
        $FinalFundamentals = Join-Path $ProjectRoot "data\fundamentals.csv"
        $FinalFollowCandidates = Join-Path $FinalProjectDir "data\follow_candidates.csv"
        $FinalFollowCandidatesXlsx = Join-Path $FinalProjectDir "reports\follow_candidates.xlsx"

        if (-not (Test-Path -LiteralPath $FinalGenerateCandidates)) {
            throw "04 candidate generation script not found: $FinalGenerateCandidates"
        }
        if (-not (Test-Path -LiteralPath $FinalGenerateExcel)) {
            throw "04 excel report script not found: $FinalGenerateExcel"
        }

        $FundamentalScoresFile = Get-Item -LiteralPath $FinalFundamentalScores
        $FundamentalsFile = Get-Item -LiteralPath $FinalFundamentals
        Write-Host "04最終再生成開始"
        Write-Host "参照 fundamental_scores.csv: $($FundamentalScoresFile.FullName) lastwrite=$($FundamentalScoresFile.LastWriteTime.ToString('yyyy/MM/dd HH:mm:ss'))"
        Write-Host "参照 fundamentals.csv: $($FundamentalsFile.FullName) lastwrite=$($FundamentalsFile.LastWriteTime.ToString('yyyy/MM/dd HH:mm:ss'))"

        Push-Location $FinalProjectDir
        try {
            & powershell -NoProfile -ExecutionPolicy Bypass -File $FinalGenerateCandidates
            if ($LASTEXITCODE -ne 0) {
                throw "04 candidate generation failed exitCode=$LASTEXITCODE"
            }

            python $FinalGenerateExcel
            if ($LASTEXITCODE -ne 0) {
                throw "04 excel generation failed exitCode=$LASTEXITCODE"
            }
        }
        finally {
            Pop-Location
        }

        if (-not (Test-Path -LiteralPath $FinalFollowCandidates)) {
            throw "04 follow_candidates.csv not found after regeneration: $FinalFollowCandidates"
        }
        if (-not (Test-Path -LiteralPath $FinalFollowCandidatesXlsx)) {
            throw "04 follow_candidates.xlsx not found after regeneration: $FinalFollowCandidatesXlsx"
        }

        $FinalRows = @(Import-Csv -LiteralPath $FinalFollowCandidates -Encoding UTF8)
        Write-Host "再生成後 follow_candidates.csv: $FinalFollowCandidates lastwrite=$((Get-Item -LiteralPath $FinalFollowCandidates).LastWriteTime.ToString('yyyy/MM/dd HH:mm:ss')) count=$($FinalRows.Count)"
        if ($FinalRows.Count -ne 60) {
            throw "04 final follow_candidates count is not 60: $($FinalRows.Count)"
        }
    }

    $EndedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    $summaryScoresPath = if ($latestSuccessCount -gt 0) { "data/fundamental_scores.csv" } elseif (Test-Path -LiteralPath "data/fundamental_scores_fallback_only.csv") { "data/fundamental_scores_fallback_only.csv" } else { "data/fundamental_scores.csv" }
    & (Join-Path $ScriptDir "generate_fundamental_fetch_summary.ps1") -StartedAt $StartedAt -EndedAt $EndedAt -ScoresPath $summaryScoresPath
}
finally {
    Pop-Location
}
