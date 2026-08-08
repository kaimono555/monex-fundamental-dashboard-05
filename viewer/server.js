"use strict";
// 05 ローカルビューアサーバー（依存ゼロ・読み取り専用）
// 起動: node viewer/server.js  → http://<このPCのIP>:8055/
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 8055;
const HOST = "0.0.0.0";
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); field = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvToObjects(file) {
  if (!fs.existsSync(file)) return null;
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  if (rows.length < 1) return [];
  const header = rows[0];
  return rows.slice(1).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i] !== undefined ? r[i] : ""; });
    return o;
  });
}

function nowLocal() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function toCsv(header, rows) {
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [header.map(esc).join(",")];
  for (const r of rows) lines.push(header.map(h => esc(r[h])).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// 貼付テキスト解析: 決算期で始まる行を業績データとして取り込む
const FIN_COLS = ["決算期", "売上高", "営業利益", "経常利益", "当期利益", "EPS", "BPS"];
const COL_ALIASES = {
  "売上高": ["売上高", "売上"],
  "営業利益": ["営業利益", "営業益"],
  "経常利益": ["経常利益", "経常益"],
  "当期利益": ["当期利益", "最終益", "純利益", "当期純利益"],
  "EPS": ["EPS", "1株益", "修正1株益", "一株益"],
  "BPS": ["BPS", "1株純資産", "一株純資産"],
};
function normNum(s) {
  const t = String(s ?? "").trim()
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，,]/g, "").replace(/[－―—‐]/g, "-").replace(/円$/, "");
  if (t === "" || t === "-" || t === "--") return "";
  return /^-?\d+(\.\d+)?$/.test(t) ? t : null; // null = 数値でない
}
// 貼付テキスト先頭部から「7826 フルヤ金属」のような行を探して銘柄コード・銘柄名を抽出
function extractCodeName(lines) {
  for (const line of lines.slice(0, 40)) {
    const m = line.trim().match(/^([0-9]{4}|[0-9]{3}[A-Z])\s+(\S.*)$/);
    if (!m) continue;
    const name = m[2].trim()
      .replace(/[（(]株[）)]$/, "").replace(/^[（(]株[）)]/, "")
      .replace(/株式会社$/, "").replace(/^株式会社/, "").trim();
    return { code: m[1], name };
  }
  return null;
}

// startKw を含む行から次セクションの手前までを切り出す
// stopAtNote=true の場合は※注記行でも打ち切る（falseにすると注記後の速報値ブロックまで含む）
function sliceSection(lines, startKw, endKws, stopAtNote = true) {
  const start = lines.findIndex(l => l.includes(startKw));
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if ((stopAtNote && t.startsWith("※")) || endKws.some(k => t.includes(k))) break;
    out.push(lines[i]);
  }
  return out;
}

function parseDataRow(line, minNums) {
  const cells = (line.includes("\t") ? line.split("\t") : line.trim().split(/\s+/)).map(c => c.trim());
  if (!cells.length || !/^\d{4}\/\d{1,2}/.test(cells[0])) return null;
  if (cells[0].includes("予")) return null; // 会社予想行は取り込まない
  const nums = cells.slice(1).map(normNum).filter(v => v !== null);
  if (nums.length < minNums) return null;
  return { period: cells[0].replace(/\s*New$/, "").trim(), nums }; // 速報値の「New」マークは除去
}

function detectColOrder(lines) {
  for (const line of lines) {
    const cells = line.split(/\t|\s{2,}| /).map(c => c.trim()).filter(Boolean);
    if (!cells.some(c => c.includes("決算期"))) continue;
    const mapped = [];
    for (const c of cells) {
      for (const col of Object.keys(COL_ALIASES)) {
        if (COL_ALIASES[col].some(a => c.replace(/（.*?）|\(.*?\)/g, "") === a)) { mapped.push(col); break; }
      }
    }
    if (mapped.length >= 4) return mapped;
  }
  return null;
}

function parsePastedFinancials(text) {
  const lines = text.split(/\r?\n/);
  // 「通期業績推移」セクションがあればその範囲のみ解析（CF・貸借対照表等の誤取り込み防止）。
  // 注記(※)後の速報値ブロック（決算発表直後のNew行）も含めるため stopAtNote=false。
  // セクションが無ければ単純なテーブル貼付とみなし全行を走査（数値6個以上の行のみ）
  const section = sliceSection(lines, "通期業績推移", ["四半期業績推移", "平均成長率", "キャッシュフロー推移"], false);
  const target = section || lines;
  const minNums = section ? 4 : 6;
  // 列順: セクション内にヘッダーがあればそれを使う。セクション外のヘッダー（速報値表など）は
  // 列数が異なるため参照せず、既定の6列順（売上高〜BPS）とする
  const colOrder = section
    ? (detectColOrder(section) || FIN_COLS.slice(1))
    : (detectColOrder(lines) || FIN_COLS.slice(1));
  const rows = [];
  for (const line of target) {
    const parsed = parseDataRow(line, minNums);
    if (!parsed) continue;
    const row = { "決算期": parsed.period };
    colOrder.forEach((col, i) => { row[col] = parsed.nums[i] !== undefined ? parsed.nums[i] : ""; });
    for (const col of FIN_COLS) if (!(col in row)) row[col] = "";
    rows.push(row);
  }
  return rows;
}

// 貼付テキストから会社予想行（「2027/03予 ...」）を全項目抽出。
// EPSは eps_forecast 用、全項目は {code}_forecast.csv 用、当期利益は forecast_loss 判定用
function parsePastedEpsForecast(text) {
  const lines = text.split(/\r?\n/);
  const section = sliceSection(lines, "通期業績推移", ["四半期業績推移", "平均成長率", "キャッシュフロー推移"], false) || lines;
  const out = [];
  const fullByPeriod = new Map();
  let forecastLoss = "";
  for (const line of section) {
    const cells = (line.includes("\t") ? line.split("\t") : line.trim().split(/\s+/)).map(c => c.trim());
    if (!cells.length || !/^\d{4}\/\d{1,2}.*予/.test(cells[0])) continue;
    const nums = cells.slice(1).map(normNum).filter(v => v !== null);
    if (nums.length < 4) continue;
    const period = cells[0].match(/^\d{4}\/\d{1,2}予?/)[0];
    const eps = nums[4]; // 売上高,営業,経常,当期,EPS,BPS の並び
    if (eps !== "" && eps !== undefined && !out.some(r => r["決算期"] === period)) {
      out.push({ "決算期": period, "EPS予想": eps, "区分": "会社予想" });
    }
    // 本表と速報値ブロックの両方に同じ予想期がある場合は項目単位でマージ
    // （速報値はEPS/BPSが無いため、空欄で本表の値を潰さない）
    const label = period.endsWith("予") ? period : period + "予";
    const row = fullByPeriod.get(label) || {
      "決算期": label, "売上高": "", "営業利益": "", "経常利益": "", "当期利益": "", "EPS": "", "BPS": "", "区分": "会社予想",
    };
    ["売上高", "営業利益", "経常利益", "当期利益", "EPS", "BPS"].forEach((col, k) => {
      if (nums[k] !== undefined && nums[k] !== "") row[col] = nums[k];
    });
    fullByPeriod.set(label, row);
    // 会社予想の当期利益がマイナスなら forecast_loss（スコアのランク上限判定に使用）
    const net = nums[3];
    if (net !== "" && net !== undefined) {
      forecastLoss = forecastLoss === "TRUE" ? "TRUE" : (Number(net) < 0 ? "TRUE" : "FALSE");
    }
  }
  return { rows: out, full: [...fullByPeriod.values()], forecast_loss: forecastLoss };
}

// タブ区切りセルの「ラベル → 直後の数値」ペアを抽出する共通処理
function cellValue(cells, i) {
  for (let j = i + 1; j < cells.length && j <= i + 2; j++) {
    const first = String(cells[j]).trim().split(/\s+/)[0];
    const n = normNum(String(first).replace(/[%％倍期回]|以上$/g, ""));
    if (n !== null && n !== "") return n;
  }
  return null;
}

const IND_COLS = ["ROE", "ROIC", "PER予想", "PBR", "自己資本比率", "有利子負債比率", "ネットD_Eレシオ", "data_as_of"];
const IND_ALIASES = {
  "ROE": ["実績ROE", "ROE(実)", "ROE（実）"],
  "ROIC": ["ROIC", "ROIC(実)", "ROIC（実）"],
  "PER予想": ["予想PER（会社予想）", "予想PER(会社予想)", "PER(予)", "PER（予）"],
  "PBR": ["PBR", "PBR(実)", "PBR（実）"],
  "自己資本比率": ["自己資本比率"],
  "有利子負債比率": ["有利子負債比率", "有利子負債率"],
  "ネットD_Eレシオ": ["ネットD/Eレシオ", "ネットD_Eレシオ"],
};
function parsePastedIndicators(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split("\t").map(c => c.trim());
    for (let i = 0; i < cells.length; i++) {
      for (const col of Object.keys(IND_ALIASES)) {
        if (out[col] !== undefined) continue;
        if (IND_ALIASES[col].includes(cells[i])) {
          const v = cellValue(cells, i);
          if (v !== null) out[col] = v;
        }
      }
    }
  }
  return out;
}

// 指標一覧の残り（成長率・レーティング等）→ ビューア専用 manual_fundamentals.csv
const MF_COLS = ["code", "analyst_rating", "target_price_gap", "progress_rate",
  "sales_growth_3y", "sales_growth_5y", "operating_growth_3y", "operating_growth_5y",
  "ordinary_growth_3y", "ordinary_growth_5y", "net_income_growth_3y", "net_income_growth_5y",
  "operating_margin_3y", "operating_margin_5y", "黒字継続年数", "dividend_increase_years",
  "forecast_loss", "data_as_of", "updated_at"];
function parsePastedExtras(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  const growthCols = ["sales", "operating", "ordinary", "net_income"];
  for (let li = 0; li < lines.length; li++) {
    const cells = lines[li].split("\t").map(c => c.trim());
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (c === "進捗率" && out.progress_rate === undefined) {
        const v = cellValue(cells, i); if (v !== null) out.progress_rate = v;
      }
      if (c.startsWith("連続増配年数") && out.dividend_increase_years === undefined) {
        const v = cellValue(cells, i); if (v !== null) out.dividend_increase_years = v;
      }
      if (c.startsWith("連続黒字年数（営業利益）") && out["黒字継続年数"] === undefined) {
        const v = cellValue(cells, i); if (v !== null) out["黒字継続年数"] = v;
      }
      if ((c === "3年平均成長率" || c === "5年平均成長率")) {
        const suffix = c[0] === "3" ? "3y" : "5y";
        const nums = cells.slice(i + 1).map(x => normNum(x.replace(/[%％]/g, ""))).filter(v => v !== null && v !== "");
        nums.slice(0, 4).forEach((n, k) => {
          const key = `${growthCols[k]}_growth_${suffix}`;
          if (out[key] === undefined) out[key] = n;
        });
      }
      if ((c === "3年平均利益率" || c === "5年平均利益率")) {
        const suffix = c[0] === "3" ? "3y" : "5y";
        // 列並びは 売上高(-)・営業・経常・当期。営業=ラベル直後の2列目
        const after = cells.slice(i + 1);
        const op = after.length > 1 ? normNum(after[1].replace(/[%％]/g, "")) : null;
        if (op !== null && op !== "" && out[`operating_margin_${suffix}`] === undefined) {
          out[`operating_margin_${suffix}`] = op;
        }
      }
    }
    // 「レーティング  目標株価(対株価)」ヘッダーの次行に「5.0 強気  57.8% 割安」
    if (cells.includes("レーティング") && cells.some(x => x.includes("目標株価")) && lines[li + 1]) {
      const next = lines[li + 1].split("\t").map(c => c.trim());
      const nums = next.map(x => normNum(String(x).split(/\s+/)[0].replace(/[%％]/g, ""))).filter(v => v !== null && v !== "");
      if (nums[0] !== undefined && out.analyst_rating === undefined) out.analyst_rating = nums[0];
      if (nums[1] !== undefined && out.target_price_gap === undefined) out.target_price_gap = nums[1];
    }
  }
  return out;
}

// generate_fundamental_scores.ps1 と同一式のスコア算出（ビューア表示用・CSVには書き込まない）
function thresholdScore(v, ths, scs) {
  if (v == null) return 0;
  for (let i = 0; i < ths.length; i++) if (v >= ths[i]) return scs[i];
  return 0;
}
function growthMetricScore(v, w) {
  if (v == null) return 0;
  if (v >= 20) return w;
  if (v >= 12) return w * 0.8;
  if (v >= 7) return w * 0.6;
  if (v >= 3) return w * 0.4;
  if (v >= 0) return w * 0.2;
  return 0;
}
function fmtScore(v) {
  v = Math.max(0, Math.min(100, v));
  return v.toFixed(1).replace(/\.?0+$/, "");
}
function computeQualityScore(src) {
  const num = x => { const n = parseFloat(String(x ?? "").replace(/,/g, "")); return isNaN(n) ? null : n; };
  const growth = Math.min(40,
    growthMetricScore(num(src.sales_growth_5y), 8) +
    growthMetricScore(num(src.operating_growth_5y), 12) +
    growthMetricScore(num(src.ordinary_growth_5y), 10) +
    growthMetricScore(num(src.net_income_growth_5y), 10));
  const profitability = Math.min(20,
    thresholdScore(num(src.roe), [20, 15, 10, 5], [7, 5, 4, 1]) +
    thresholdScore(num(src.roic), [15, 10, 7, 4], [7, 5, 4, 1]) +
    thresholdScore(num(src.operating_margin_5y), [25, 15, 10, 5], [6, 4, 3, 1]));
  const debt = num(src.interest_bearing_debt_ratio);
  let fin = thresholdScore(num(src.equity_ratio), [70, 50, 30, 20], [9, 7, 4, 1]);
  if (debt == null) fin += 4;
  else if (debt <= 10) fin += 6;
  else if (debt <= 30) fin += 4;
  else if (debt <= 60) fin += 2;
  fin += thresholdScore(num(src.profit_streak_years), [10, 7, 5, 3], [5, 4, 3, 1]);
  const financial = Math.min(20, fin);
  const missingFields = ["sales_growth_5y", "operating_growth_5y", "ordinary_growth_5y", "net_income_growth_5y",
    "roe", "roic", "equity_ratio", "interest_bearing_debt_ratio", "operating_margin_5y", "profit_streak_years"];
  const missing = missingFields.filter(f => src[f] == null || String(src[f]).trim() === "").length;
  const quality = Math.max(0, growth + profitability + financial - Math.min(20, missing * 2));
  let rank = quality >= 68 ? "A" : quality >= 56 ? "B" : quality >= 44 ? "C" : quality >= 32 ? "D" : "E";
  const capped = (num(src.operating_growth_5y) != null && num(src.operating_growth_5y) < 0) ||
    (num(src.ordinary_growth_5y) != null && num(src.ordinary_growth_5y) < 0) ||
    (num(src.equity_ratio) != null && num(src.equity_ratio) < 30) ||
    String(src.forecast_loss).toUpperCase() === "TRUE";
  if (capped && (rank === "A" || rank === "B")) rank = "C";
  return {
    quality_rank: rank, quality_score: fmtScore(quality),
    growth: fmtScore(growth), profitability: fmtScore(profitability), financial: fmtScore(financial),
  };
}

// 手動追加銘柄のスコア入力（latest_indicators + manual_fundamentals）を組み立てる
function buildManualScore(code) {
  const ind = (csvToObjects(path.join(DATA_DIR, "output_extended", `${code}_latest_indicators.csv`)) || [])[0] || null;
  const mf = (csvToObjects(path.join(DATA_DIR, "manual_fundamentals.csv")) || []).find(r => r.code === code) || null;
  if (!ind && !mf) return null;
  const src = {
    roe: ind ? ind.ROE : "", roic: ind ? ind.ROIC : "",
    equity_ratio: ind ? ind["自己資本比率"] : "",
    interest_bearing_debt_ratio: ind ? ind["有利子負債比率"] : "",
    sales_growth_5y: mf ? mf.sales_growth_5y : "", operating_growth_5y: mf ? mf.operating_growth_5y : "",
    ordinary_growth_5y: mf ? mf.ordinary_growth_5y : "", net_income_growth_5y: mf ? mf.net_income_growth_5y : "",
    operating_margin_5y: mf ? mf.operating_margin_5y : "",
    profit_streak_years: mf ? mf["黒字継続年数"] : "",
    forecast_loss: mf ? mf.forecast_loss : "",
  };
  return { ...computeQualityScore(src), viewer_computed: true, ind, mf };
}

// 四半期業績推移: 「2026/06 New 1Q 402,009 50.1% ...」形式（%列は除外して取り込む）
const QTR_COLS = ["決算期", "区分", "売上高", "営業利益", "経常利益", "当期利益"];
function parsePastedQuarterly(text, sectionKey) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => l.includes(`四半期業績推移（${sectionKey}）`) || l.includes(`四半期業績推移(${sectionKey})`));
  if (start === -1) return [];
  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if ((t.includes("四半期業績推移") && !t.includes(sectionKey)) ||
        t.includes("キャッシュフロー推移") || t.includes("貸借対照表")) break;
    const cells = lines[i].split("\t").map(c => c.trim());
    if (!cells.length || !/^\d{4}\/\d{1,2}/.test(cells[0]) || cells[0].includes("予")) continue;
    const period = cells[0].match(/^\d{4}\/\d{1,2}/)[0];
    const kubun = cells.slice(1).find(c => /^(本|中|[1-4]Q)$/.test(c)) || "";
    const nums = cells.slice(1).map(normNum).filter(v => v !== null);
    if (nums.length < 4) continue;
    rows.push({ "決算期": period, "区分": kubun, "売上高": nums[0], "営業利益": nums[1], "経常利益": nums[2], "当期利益": nums[3] });
  }
  return rows;
}

// data/raw/{code}.html の非表示テーブル（詳細ビュー）から四半期履歴を抽出する。
// ヘッダー名で列位置を判定するため、業種による列構成差（売上原価の有無等）に耐える
function stripTags(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").trim();
}
function parseRawQuarterly(code, startKw, endKw) {
  const file = path.join(DATA_DIR, "raw", `${code}.html`);
  if (!fs.existsSync(file)) return [];
  let html;
  try { html = fs.readFileSync(file, "utf8"); } catch { return []; }
  const s = html.indexOf(startKw);
  if (s === -1) return [];
  const eIdx = html.indexOf(endKw, s);
  const seg = html.slice(s, eIdx === -1 ? s + 600000 : eIdx);
  const tableMatch = seg.match(/<table[\s\S]*?<\/table>/);
  if (!tableMatch) return [];
  const trs = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/g) || [];
  let numericHeaders = null;
  const rows = [];
  for (const tr of trs) {
    const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) || []).map(stripTags);
    if (!cells.length) continue;
    if (cells.some(c => c.includes("決算期"))) {
      // ヘッダー行: 決算期・区分・(前年比)・▲を除いた数値列名の並びを記録
      numericHeaders = cells
        .map(c => c.replace(/[▲△]/g, "").trim())
        .filter(c => c && !c.includes("決算期") && c !== "区分" && !c.includes("前年比"));
      continue;
    }
    if (!/^\d{4}\/\d{1,2}/.test(cells[0]) || cells[0].includes("予")) continue;
    const period = cells[0].match(/^\d{4}\/\d{1,2}/)[0];
    const kubun = cells.slice(1).find(c => /^(本|中|[1-4]Q)$/.test(c)) || "";
    // %セルは normNum で除外され、数値セルのみが numericHeaders と同順で残る
    const nums = cells.slice(1).filter(c => !/^(本|中|[1-4]Q)$/.test(c)).map(normNum).filter(v => v !== null);
    if (!numericHeaders || nums.length < 4) continue;
    const pick = label => {
      const idx = numericHeaders.findIndex(h => h.startsWith(label));
      return idx >= 0 && nums[idx] !== undefined ? nums[idx] : "";
    };
    rows.push({
      "決算期": period, "区分": kubun,
      "売上高": pick("売上高"), "営業利益": pick("営業利益"),
      "経常利益": pick("経常利益"), "当期利益": pick("当期利益"),
    });
  }
  return rows;
}

// raw履歴（自動取得時点）に貼付蓄積分（決算発表後）を重ねて返す
function combinedQuarterly(code, sectionKey, csvName) {
  const raw = parseRawQuarterly(code,
    `四半期業績推移（${sectionKey}）`,
    sectionKey === "3か月" ? "四半期業績推移（累積）" : "キャッシュフロー推移");
  const pasted = csvToObjects(path.join(DATA_DIR, "output_extended", `${code}_${csvName}.csv`)) || [];
  const m = new Map(raw.map(r => [periodKey(r["決算期"]), r]));
  for (const r of pasted) m.set(periodKey(r["決算期"]), r);
  return [...m.values()].sort((a, b) => periodKey(a["決算期"]).localeCompare(periodKey(b["決算期"])));
}

const CF_COLS = ["決算期", "営業CF", "投資CF", "財務CF", "現金同等物", "フリーCF"];
function parsePastedCashflow(text) {
  const lines = text.split(/\r?\n/);
  const section = sliceSection(lines, "キャッシュフロー推移", ["貸借対照表", "設備投資", "指標一覧"]);
  if (!section) return [];
  const rows = [];
  for (const line of section) {
    const parsed = parseDataRow(line, 5);
    if (!parsed) continue;
    const row = { "決算期": parsed.period };
    CF_COLS.slice(1).forEach((col, i) => { row[col] = parsed.nums[i] !== undefined ? parsed.nums[i] : ""; });
    rows.push(row);
  }
  return rows;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => { buf += c; if (buf.length > 2 * 1024 * 1024) reject(new Error("payload too large")); });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

// 決算期の照合キー: 会計基準サフィックス(「2024/03 I」「2007/03 S」等)を無視して年月で照合する
function periodKey(p) {
  const m = String(p).match(/^\d{4}\/\d{1,2}/);
  return m ? m[0] : String(p);
}

function mergeCsvByPeriod(file, cols, rows) {
  // 既存行は削除・統合しない（会計基準移行年はS/I両方の行が正当に存在するため、
  // 年月キーで既存行同士をまとめてはならない）。貼付行は同じ年月の既存行があれば
  // その「最後の」行（＝最新会計基準の行）の値のみ更新し、無ければ追加する。
  const merged = (csvToObjects(file) || []).slice();
  let added = 0, updated = 0;
  for (const r of rows) {
    const key = periodKey(r["決算期"]);
    let idx = -1;
    for (let i = 0; i < merged.length; i++) {
      if (periodKey(merged[i]["決算期"]) === key) idx = i;
    }
    if (idx >= 0) {
      updated++;
      merged[idx] = { ...r, "決算期": merged[idx]["決算期"] }; // ラベル(サフィックス)は既存を維持
    } else {
      added++;
      merged.push(r);
    }
  }
  merged.sort((a, b) => periodKey(a["決算期"]).localeCompare(periodKey(b["決算期"])) ||
    String(a["決算期"]).localeCompare(String(b["決算期"])));
  fs.writeFileSync(file, toCsv(cols, merged), "utf8");
  return { added, updated, total: merged.length, last: merged.length ? merged[merged.length - 1]["決算期"] : "" };
}

async function apiManual(req, res) {
  const body = JSON.parse(await readBody(req) || "{}");
  const text = String(body.text || "");
  const lines = text.split(/\r?\n/);
  const cn = extractCodeName(lines);
  if (!cn || !safeCode(cn.code)) {
    return sendJson(res, 400, { error: "銘柄コードをテキストから検出できませんでした。ページ先頭の「7826 フルヤ金属」のような行を含めて貼り付けてください。" });
  }
  const { code, name } = cn;
  const rows = parsePastedFinancials(text);
  if (!rows.length) return sendJson(res, 400, { error: `業績データ行が見つかりません（${code}）。通期業績推移の表を含めて貼り付けてください。` });

  const fin = mergeCsvByPeriod(path.join(DATA_DIR, "output", `${code}_financials.csv`), FIN_COLS, rows);

  const extDir = path.join(DATA_DIR, "output_extended");
  if (!fs.existsSync(extDir)) fs.mkdirSync(extDir, { recursive: true });

  let cf = null;
  const cfRows = parsePastedCashflow(text);
  if (cfRows.length) {
    cf = mergeCsvByPeriod(path.join(extDir, `${code}_cashflow.csv`), CF_COLS, cfRows);
  }

  // 四半期業績（3か月・累積）→ {code}_quarterly(_cum).csv（貼付のたびに四半期が蓄積される）
  let qtr = null;
  const qtrRows = parsePastedQuarterly(text, "3か月");
  if (qtrRows.length) {
    qtr = mergeCsvByPeriod(path.join(extDir, `${code}_quarterly.csv`), QTR_COLS, qtrRows);
  }
  let qtrCum = null;
  const qtrCumRows = parsePastedQuarterly(text, "累積");
  if (qtrCumRows.length) {
    qtrCum = mergeCsvByPeriod(path.join(extDir, `${code}_quarterly_cum.csv`), QTR_COLS, qtrCumRows);
  }

  // 指標（ROE/ROIC/PER/PBR等）→ {code}_latest_indicators.csv（既存値は貼付に無い項目のみ維持）
  const ind = parsePastedIndicators(text);
  let indSaved = 0;
  if (Object.keys(ind).length) {
    const indFile = path.join(extDir, `${code}_latest_indicators.csv`);
    const prev = (csvToObjects(indFile) || [])[0] || {};
    const row = {};
    for (const col of IND_COLS) row[col] = ind[col] !== undefined ? ind[col] : (prev[col] || "");
    row.data_as_of = nowLocal();
    fs.writeFileSync(indFile, toCsv(IND_COLS, [row]), "utf8");
    indSaved = Object.keys(ind).length;
  }

  // EPS会社予想 → {code}_eps_forecast.csv
  const epsF = parsePastedEpsForecast(text);
  const epsRows = epsF.rows;
  if (epsRows.length) {
    fs.writeFileSync(path.join(extDir, `${code}_eps_forecast.csv`), toCsv(["決算期", "EPS予想", "区分"], epsRows), "utf8");
  }
  // 会社予想（速報値含む・全項目）→ {code}_forecast.csv
  if (epsF.full.length) {
    fs.writeFileSync(path.join(extDir, `${code}_forecast.csv`),
      toCsv(["決算期", "売上高", "営業利益", "経常利益", "当期利益", "EPS", "BPS", "区分"], epsF.full), "utf8");
  }

  // 成長率・レーティング等 → manual_fundamentals.csv（ビューア専用・codeでマージ）
  // 抽出項目が無くても updated_at は常に記録し、一覧の「更新日時」に手動更新時刻を反映できるようにする
  const extras = parsePastedExtras(text);
  if (epsF.forecast_loss) extras.forecast_loss = epsF.forecast_loss;
  if (fin.last) extras.data_as_of = fin.last; // 貼付後の最新決算期
  const extrasSaved = Object.keys(extras).length;
  {
    const mfFile = path.join(DATA_DIR, "manual_fundamentals.csv");
    const rows = csvToObjects(mfFile) || [];
    const m = new Map(rows.map(r => [r.code, r]));
    const prev = m.get(code) || {};
    const row = { code };
    for (const col of MF_COLS.slice(1)) row[col] = extras[col] !== undefined ? extras[col] : (prev[col] || "");
    row.updated_at = nowLocal();
    m.set(code, row);
    fs.writeFileSync(mfFile, toCsv(MF_COLS, [...m.values()]), "utf8");
  }

  if (name) {
    const namesFile = path.join(DATA_DIR, "manual_names.csv");
    const names = csvToObjects(namesFile) || [];
    const m = new Map(names.map(r => [r.code, r.name]));
    m.set(code, name);
    fs.writeFileSync(namesFile, toCsv(["code", "name"], [...m.entries()].map(([c, n]) => ({ code: c, name: n }))), "utf8");
  }
  sendJson(res, 200, { code, name, fin, cf, qtr, qtrCum, forecast: epsF.full.length,
    indicators: indSaved, extras: extrasSaved, eps_forecast: epsRows.length, rows });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(body);
}

function safeCode(raw) {
  return /^[0-9A-Za-z]{1,6}$/.test(raw) ? raw : null;
}

function apiStocks(res) {
  const scores = csvToObjects(path.join(DATA_DIR, "fundamental_scores.csv")) || [];
  const funds = csvToObjects(path.join(DATA_DIR, "fundamentals.csv")) || [];
  const fmap = new Map(funds.map(f => [f.code, f]));
  // 手動貼付（manual_fundamentals.csv）がパイプライン取得より新しい銘柄は、
  // 貼付データを優先表示し、スコアも同一式で再計算する（CSVには書き込まない）
  const mfMap = new Map((csvToObjects(path.join(DATA_DIR, "manual_fundamentals.csv")) || []).map(r => [r.code, r]));
  const list = scores.map(s => {
    const mf = mfMap.get(s.code);
    if (!mf || !mf.updated_at || String(mf.updated_at) <= String(s.fetched_at || "")) {
      return { ...s, fundamentals: fmap.get(s.code) || null };
    }
    const ms = buildManualScore(s.code);
    const f = fmap.get(s.code) || null;
    return {
      ...s,
      ...(ms ? {
        quality_rank: ms.quality_rank, quality_score: ms.quality_score,
        growth: ms.growth, profitability: ms.profitability, financial: ms.financial,
      } : {}),
      data_as_of: mf.data_as_of || s.data_as_of,
      fetched_at: mf.updated_at,
      manual_override: true,
      fundamentals: (ms && ms.ind)
        ? { ...(f || {}), roe: ms.ind.ROE || (f ? f.roe : ""), equity_ratio: ms.ind["自己資本比率"] || (f ? f.equity_ratio : "") }
        : f,
    };
  });

  // 手動追加分（financials CSVはあるがスコア一覧に無い銘柄）も一覧に載せる
  const known = new Set(list.map(s => s.code));
  const manualNames = new Map((csvToObjects(path.join(DATA_DIR, "manual_names.csv")) || []).map(r => [r.code, r.name]));
  const outDir = path.join(DATA_DIR, "output");
  if (fs.existsSync(outDir)) {
    for (const f of fs.readdirSync(outDir)) {
      const m = f.match(/^([0-9A-Za-z]{1,6})_financials\.csv$/);
      if (!m || known.has(m[1])) continue;
      const ms = buildManualScore(m[1]);
      const ind = ms ? ms.ind : null;
      list.push({
        rank: "", code: m[1], name: manualNames.get(m[1]) || "(手動追加)",
        quality_rank: ms ? ms.quality_rank : "", quality_score: ms ? ms.quality_score : "",
        growth: ms ? ms.growth : "", profitability: ms ? ms.profitability : "", financial: ms ? ms.financial : "",
        data_as_of: "", fetched_at: (ms && ms.mf && ms.mf.updated_at) || (ind ? (ind.data_as_of || "") : ""), manual: true,
        fundamentals: fmap.get(m[1]) || (ind ? { roe: ind.ROE || "", equity_ratio: ind["自己資本比率"] || "" } : null),
      });
    }
  }
  sendJson(res, 200, { stocks: list, generated_at: new Date().toISOString() });
}

function apiStock(res, code) {
  const financials = csvToObjects(path.join(DATA_DIR, "output", `${code}_financials.csv`));
  if (!financials) return sendJson(res, 404, { error: `code ${code} not found` });
  const cashflow = csvToObjects(path.join(DATA_DIR, "output_extended", `${code}_cashflow.csv`));
  const quarterly = combinedQuarterly(code, "3か月", "quarterly");
  const quarterlyCum = combinedQuarterly(code, "累積", "quarterly_cum");
  const forecast = csvToObjects(path.join(DATA_DIR, "output_extended", `${code}_forecast.csv`)) || [];
  const indicators = csvToObjects(path.join(DATA_DIR, "output_extended", `${code}_latest_indicators.csv`));
  const epsForecast = csvToObjects(path.join(DATA_DIR, "output_extended", `${code}_eps_forecast.csv`));
  const funds = csvToObjects(path.join(DATA_DIR, "fundamentals.csv")) || [];
  const scores = csvToObjects(path.join(DATA_DIR, "fundamental_scores.csv")) || [];
  const manualNames = new Map((csvToObjects(path.join(DATA_DIR, "manual_names.csv")) || []).map(r => [r.code, r.name]));
  const manualFunds = (csvToObjects(path.join(DATA_DIR, "manual_fundamentals.csv")) || []).find(r => r.code === code) || null;
  const fundsRow = funds.find(f => f.code === code) || null;
  const scoreRow = scores.find(s => s.code === code) || null;

  // 手動貼付がパイプライン取得より新しい場合は貼付データを優先し、スコアも再計算する
  const manualNewer = manualFunds && manualFunds.updated_at &&
    String(manualFunds.updated_at) > String((scoreRow && scoreRow.fetched_at) || (fundsRow && fundsRow.fetched_at) || "");

  let fundamentals = fundsRow || manualFunds;
  if (fundsRow && manualFunds && manualNewer) {
    fundamentals = { ...fundsRow };
    for (const [k, v] of Object.entries(manualFunds)) {
      if (k !== "code" && v !== "" && v != null) fundamentals[k] = v;
    }
  }

  let score = scoreRow;
  if (!scoreRow || manualNewer) {
    const ms = buildManualScore(code);
    if (ms) {
      score = { rank: scoreRow ? scoreRow.rank : "", quality_rank: ms.quality_rank, quality_score: ms.quality_score,
        growth: ms.growth, profitability: ms.profitability, financial: ms.financial, viewer_computed: true };
    }
  }

  sendJson(res, 200, {
    code,
    manual_name: manualNames.get(code) || null,
    manual_updated_at: (manualFunds && manualFunds.updated_at) || null,
    financials,
    cashflow,
    quarterly: quarterly || [],
    quarterly_cum: quarterlyCum || [],
    forecast,
    indicators: indicators && indicators[0] ? indicators[0] : null,
    eps_forecast: epsForecast || [],
    fundamentals,
    score,
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

// ── 手動取り込み実行（run_update_05_guarded.ps1 起動）とログのライブ配信 ──
let updateProc = null; // 実行中プロセス（多重起動防止）

function apiRunUpdate(res) {
  if (updateProc) return sendJson(res, 409, { error: "既に実行中です", running: true });
  const script = path.join(ROOT, "scripts", "run_update_05_guarded.ps1");
  if (!fs.existsSync(script)) return sendJson(res, 500, { error: "run_update_05_guarded.ps1 が見つかりません" });
  try {
    updateProc = spawn("powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      { cwd: ROOT, detached: true, stdio: "ignore" });
    updateProc.on("exit", () => { updateProc = null; });
    updateProc.on("error", () => { updateProc = null; });
    updateProc.unref();
    sendJson(res, 200, { started: true });
  } catch (e) {
    updateProc = null;
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
}

// logs/run_log.txt をバイトオフセット差分で返す（09と同様のポーリング型ライブログ）
function apiLogs(res, afterByte) {
  const logFile = path.join(ROOT, "logs", "run_log.txt");
  if (!fs.existsSync(logFile)) return sendJson(res, 200, { text: "", offset: 0, running: !!updateProc });
  const size = fs.statSync(logFile).size;
  let start = Number.isFinite(afterByte) && afterByte >= 0 ? afterByte : Math.max(0, size - 16384);
  if (start > size) start = Math.max(0, size - 16384); // ログローテーション等でサイズが縮んだ場合
  let text = "";
  if (start < size) {
    const fd = fs.openSync(logFile, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  }
  sendJson(res, 200, { text, offset: size, running: !!updateProc });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  try {
    if (u.pathname === "/api/run-update" && req.method === "POST") return apiRunUpdate(res);
    if (u.pathname === "/api/logs") return apiLogs(res, parseInt(u.searchParams.get("after"), 10));
    if (u.pathname === "/api/manual" && req.method === "POST") {
      return apiManual(req, res).catch(e => sendJson(res, 500, { error: String(e && e.message || e) }));
    }
    if (u.pathname === "/api/stocks") return apiStocks(res);
    const m = u.pathname.match(/^\/api\/stock\/([^/]+)$/);
    if (m) {
      const code = safeCode(m[1]);
      if (!code) return sendJson(res, 400, { error: "invalid code" });
      return apiStock(res, code);
    }
    return serveStatic(res, decodeURIComponent(u.pathname));
  } catch (e) {
    return sendJson(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  const nets = require("os").networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === "IPv4" && !n.internal) ips.push(n.address);
    }
  }
  console.log(`[viewer] listening on:`);
  console.log(`  http://localhost:${PORT}/`);
  ips.forEach(ip => console.log(`  http://${ip}:${PORT}/  (LAN)`));
});
