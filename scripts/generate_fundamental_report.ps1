param(
    [string]$ScoresPath = "data/fundamental_scores.csv",
    [string]$ReportPath = "reports/fundamental_scores.md",
    [string]$ExcelPath = "reports/fundamental_scores.xlsx",
    [switch]$FallbackReport
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
    }
}

function Format-Cell($Value) {
    if ($null -eq $Value) { return "" }
    return ([string]$Value).Replace("|", "/").Replace("`r", " ").Replace("`n", " ")
}

function ConvertTo-ExcelColumnName([int]$Index) {
    $name = ""
    while ($Index -gt 0) {
        $Index -= 1
        $name = [char](65 + ($Index % 26)) + $name
        $Index = [math]::Floor($Index / 26)
    }
    return $name
}

function Escape-Xml($Value) {
    return [System.Security.SecurityElement]::Escape([string]$Value)
}

function Get-FallbackWarningText {
    return [string]::Concat([char[]]@(27880,24847,65306,12371,12398,12524,12509,12540,12488,12399,26368,26032,21462,24471,12487,12540,12479,12391,12399,12354,12426,12414,12379,12435,12290,102,97,108,108,98,97,99,107,36942,21435,12487,12540,12479,12434,20351,29992,12375,12390,12356,12414,12377,12290))
}

function New-ScoresWorkbook([string]$Path, $Rows) {
    Ensure-Directory (Split-Path $Path -Parent)
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("fundamental_scores_xlsx_" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    try {
        New-Item -ItemType Directory -Force -Path (Join-Path $tempRoot "_rels") | Out-Null
        New-Item -ItemType Directory -Force -Path (Join-Path $tempRoot "xl") | Out-Null
        New-Item -ItemType Directory -Force -Path (Join-Path $tempRoot "xl\_rels") | Out-Null
        New-Item -ItemType Directory -Force -Path (Join-Path $tempRoot "xl\worksheets") | Out-Null

        $headers = @("rank", "code", "name", "quality_rank", "quality_score", "growth", "profitability", "financial", "source_status", "stale_flag", "data_as_of", "fetched_at", "valuation_score", "valuation_status", "total_score_100", "total_rank_100")
        $sheetRows = [System.Text.StringBuilder]::new()
        $rowNumber = 1
        $null = $sheetRows.Append("<row r=""$rowNumber"">")
        for ($i = 0; $i -lt $headers.Count; $i += 1) {
            $cellRef = "$(ConvertTo-ExcelColumnName ($i + 1))$rowNumber"
            $value = Escape-Xml $headers[$i]
            $null = $sheetRows.Append("<c r=""$cellRef"" t=""inlineStr""><is><t>$value</t></is></c>")
        }
        $null = $sheetRows.Append("</row>")

        foreach ($row in $Rows) {
            $rowNumber += 1
            $values = @($row.rank, $row.code, $row.name, $row.quality_rank, $row.quality_score, $row.growth, $row.profitability, $row.financial, $row.source_status, $row.stale_flag, $row.data_as_of, $row.fetched_at, $row.valuation_score, $row.valuation_status, $row.total_score_100, $row.total_rank_100)
            $null = $sheetRows.Append("<row r=""$rowNumber"">")
            for ($i = 0; $i -lt $values.Count; $i += 1) {
                $cellRef = "$(ConvertTo-ExcelColumnName ($i + 1))$rowNumber"
                $value = Escape-Xml $values[$i]
                $null = $sheetRows.Append("<c r=""$cellRef"" t=""inlineStr""><is><t>$value</t></is></c>")
            }
            $null = $sheetRows.Append("</row>")
        }

        $contentTypes = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>
'@
        $rels = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>
'@
        $workbook = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="fundamental_scores" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>
'@
        $workbookRels = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>
'@
        $sheetXml = "<?xml version=""1.0"" encoding=""UTF-8"" standalone=""yes""?><worksheet xmlns=""http://schemas.openxmlformats.org/spreadsheetml/2006/main""><sheetData>$($sheetRows.ToString())</sheetData></worksheet>"

        [System.IO.File]::WriteAllText((Join-Path $tempRoot "[Content_Types].xml"), $contentTypes, [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText((Join-Path $tempRoot "_rels\.rels"), $rels, [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText((Join-Path $tempRoot "xl\workbook.xml"), $workbook, [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText((Join-Path $tempRoot "xl\_rels\workbook.xml.rels"), $workbookRels, [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText((Join-Path $tempRoot "xl\worksheets\sheet1.xml"), $sheetXml, [System.Text.UTF8Encoding]::new($false))

        if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
        Add-Type -AssemblyName System.IO.Compression
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $fullPath = Join-Path (Resolve-Path (Split-Path $Path -Parent)) (Split-Path $Path -Leaf)
        $archive = [System.IO.Compression.ZipFile]::Open($fullPath, [System.IO.Compression.ZipArchiveMode]::Create)
        try {
            $entries = @(
                @{ Source = "[Content_Types].xml"; Entry = "[Content_Types].xml" },
                @{ Source = "_rels\.rels"; Entry = "_rels/.rels" },
                @{ Source = "xl\workbook.xml"; Entry = "xl/workbook.xml" },
                @{ Source = "xl\_rels\workbook.xml.rels"; Entry = "xl/_rels/workbook.xml.rels" },
                @{ Source = "xl\worksheets\sheet1.xml"; Entry = "xl/worksheets/sheet1.xml" }
            )
            foreach ($item in $entries) {
                [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $tempRoot $item.Source), $item.Entry) | Out-Null
            }
        }
        finally {
            $archive.Dispose()
        }
    }
    finally {
        if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
    }
}

function Add-ScoreTable([System.Collections.Generic.List[string]]$Lines, [string]$Title, $Rows) {
    $items = @($Rows)
    $Lines.Add("")
    $Lines.Add("## $Title")
    $Lines.Add("")
    if ($items.Count -eq 0) {
        $Lines.Add("none")
        return
    }
    $Lines.Add("| rank | code | name | quality_rank | quality_score | growth | profitability | financial | source_status | data_as_of |")
    $Lines.Add("|---:|---|---|---:|---:|---:|---:|---:|---|---|")
    $rank = 1
    foreach ($row in $items) {
        $Lines.Add("| $rank | $(Format-Cell $row.code) | $(Format-Cell $row.name) | $(Format-Cell $row.quality_rank) | $(Format-Cell $row.quality_score) | $(Format-Cell $row.growth) | $(Format-Cell $row.profitability) | $(Format-Cell $row.financial) | $(Format-Cell $row.source_status) | $(Format-Cell $row.data_as_of) |")
        $rank += 1
    }
}

function Add-Total100ScoreTable([System.Collections.Generic.List[string]]$Lines, [string]$Title, $Rows) {
    $items = @($Rows)
    $Lines.Add("")
    $Lines.Add("## $Title")
    $Lines.Add("")
    if ($items.Count -eq 0) {
        $Lines.Add("none")
        return
    }
    $Lines.Add("| rank | code | name | total_rank_100 | total_score_100 | quality_score | valuation_score | valuation_status | data_as_of |")
    $Lines.Add("|---:|---|---|---:|---:|---:|---:|---|---|")
    $rank = 1
    foreach ($row in $items) {
        $Lines.Add("| $rank | $(Format-Cell $row.code) | $(Format-Cell $row.name) | $(Format-Cell $row.total_rank_100) | $(Format-Cell $row.total_score_100) | $(Format-Cell $row.quality_score) | $(Format-Cell $row.valuation_score) | $(Format-Cell $row.valuation_status) | $(Format-Cell $row.data_as_of) |")
        $rank += 1
    }
}

if (-not (Test-Path -LiteralPath $ScoresPath)) {
    throw "input file not found: $ScoresPath"
}

Ensure-Directory (Split-Path $ReportPath -Parent)

$rows = @(Import-Csv -LiteralPath $ScoresPath -Encoding UTF8)
$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add("# Fundamental quality_score report")
$lines.Add("")
if ($FallbackReport) {
    $lines.Add("# " + (Get-FallbackWarningText))
    $lines.Add("")
}
$lines.Add("generated_at: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
$lines.Add("")
$lines.Add("quality_score = growth + profitability + financial（80点満点・従来どおり不変）")
$lines.Add("total_score_100 = quality_score + valuation_score（新規・valuation_status=insufficient_dataの銘柄は算出しない）")

$rankCounts = @($rows | Group-Object quality_rank | Sort-Object Name)
$lines.Add("")
$lines.Add("## quality_rank counts（従来80点満点ランク・不変）")
$lines.Add("")
$lines.Add("| quality_rank | count |")
$lines.Add("|---|---:|")
foreach ($group in $rankCounts) {
    $lines.Add("| $(Format-Cell $group.Name) | $($group.Count) |")
}

$totalRankCounts = @($rows | Where-Object { -not [string]::IsNullOrWhiteSpace($_.total_rank_100) } | Group-Object total_rank_100 | Sort-Object Name)
$insufficientCount = @($rows | Where-Object { $_.valuation_status -eq "insufficient_data" }).Count
$lines.Add("")
$lines.Add("## total_rank_100 counts（新規・100点満点ランク）")
$lines.Add("")
$lines.Add("| total_rank_100 | count |")
$lines.Add("|---|---:|")
foreach ($group in $totalRankCounts) {
    $lines.Add("| $(Format-Cell $group.Name) | $($group.Count) |")
}
$lines.Add("| (insufficient_data、N/A) | $insufficientCount |")

Add-ScoreTable $lines "Top 20" (@($rows | Sort-Object @{ Expression = { -[double]$_.quality_score } }, code | Select-Object -First 20))
Add-ScoreTable $lines "Growth top 10" (@($rows | Sort-Object @{ Expression = { -[double]$_.growth } }, code | Select-Object -First 10))
Add-ScoreTable $lines "Profitability top 10" (@($rows | Sort-Object @{ Expression = { -[double]$_.profitability } }, code | Select-Object -First 10))
Add-ScoreTable $lines "Financial top 10" (@($rows | Sort-Object @{ Expression = { -[double]$_.financial } }, code | Select-Object -First 10))
Add-ScoreTable $lines "Overall top 20" (@($rows | Sort-Object @{ Expression = { -[double]$_.quality_score } }, code | Select-Object -First 20))
Add-Total100ScoreTable $lines "Total100 top 20" (@($rows | Where-Object { -not [string]::IsNullOrWhiteSpace($_.total_score_100) } | Sort-Object @{ Expression = { -[double]$_.total_score_100 } }, code | Select-Object -First 20))

$utf8Bom = [System.Text.UTF8Encoding]::new($true)
[System.IO.File]::WriteAllLines((Resolve-Path (Split-Path $ReportPath -Parent) | Join-Path -ChildPath (Split-Path $ReportPath -Leaf)), $lines, $utf8Bom)
Write-Host "Wrote report: $ReportPath"
New-ScoresWorkbook $ExcelPath $rows
Write-Host "Wrote Excel: $ExcelPath"
