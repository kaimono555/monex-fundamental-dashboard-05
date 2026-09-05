"use strict";
// 05 ローカルビューアサーバー（依存ゼロ・読み取り専用が原則。共通RAW管理操作のみ
// 既存registryモジュール(scripts/monex_registry.py)をサブプロセス実行して書き込む）
// 起動: node viewer/server.js  → http://<このPCのIP>:8055/
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const PORT = 8055;
const HOST = "0.0.0.0";
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
// 共通RAW取得センターのregistry(2026-09-04〜)。正本はSQLite(data/stock_registry.sqlite3)だが、
// ビューア(Node・依存ゼロ)はSQLiteを直接読まず、registry側が書き出す人間確認用CSV
// (stock_registry_view.csv / stock_registry_usage_view.csv)を読む。これらは
// scripts/monex_registry.py の pin/unpin/set-usage/import-existing と
// scripts/request_monex_raw.py・scripts/registry_daily_sync.py が既存の書き込み経路で
// 呼び出すたびに export_view() で更新されるため、ビューア側で判定ロジックを再実装しない。
const REGISTRY_VIEW_PATH = path.join(DATA_DIR, "stock_registry_view.csv");
const REGISTRY_USAGE_VIEW_PATH = path.join(DATA_DIR, "stock_registry_usage_view.csv");
const REGISTRY_CLI_PATH = path.join(ROOT, "scripts", "monex_registry.py");
const MODE_LABEL = { daily: "毎日", on_demand: "必要時", inactive: "停止" };
// 108Phase2-B: 05・104-3が共通で参照するマネックス貼付原文の共有ストア(105/104-3どちらの
// 加工ロジックも変更せず、原文保存先だけを共通化する。詳細は _shared_monex_raw/README.md)
const SHARED_RAW_ROOT = path.join(ROOT, "..", "_shared_monex_raw");

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

// 2026-08-11 バリュエーション評価追加: PER相対水準(2年/5年)・PBR相対水準(2年/5年)・
// EV/EBITDA・予想PEGレシオを追加。parse_financials_extended.ps1(Parse-LatestIndicators)
// と同一の列名・同一のラベルを使い、自動取得と手動貼付で同じCSVスキーマにする。
const IND_COLS = ["ROE", "ROIC", "PER予想", "PBR", "自己資本比率", "有利子負債比率", "ネットD_Eレシオ",
  "PER相対水準2年", "PER相対水準5年", "PBR相対水準2年", "PBR相対水準5年", "EV_EBITDA", "予想PEGレシオ",
  "52週株価水準", "目標株価", "data_as_of"];
const IND_ALIASES = {
  "ROE": ["実績ROE", "ROE(実)", "ROE（実）"],
  "ROIC": ["ROIC", "ROIC(実)", "ROIC（実）"],
  "PER予想": ["予想PER（会社予想）", "予想PER(会社予想)", "PER(予)", "PER（予）"],
  "PBR": ["PBR", "PBR(実)", "PBR（実）"],
  "自己資本比率": ["自己資本比率"],
  "有利子負債比率": ["有利子負債比率", "有利子負債率"],
  "ネットD_Eレシオ": ["ネットD/Eレシオ", "ネットD_Eレシオ"],
  "PER相対水準2年": ["予想PER相対水準（2年）", "予想PER相対水準(2年)"],
  "PER相対水準5年": ["予想PER相対水準（5年）", "予想PER相対水準(5年)"],
  "PBR相対水準2年": ["PBR相対水準（2年）", "PBR相対水準(2年)"],
  "PBR相対水準5年": ["PBR相対水準（5年）", "PBR相対水準(5年)"],
  "EV_EBITDA": ["EV/EBITDA"],
  "予想PEGレシオ": ["予想PEGレシオ"],
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
  // 52週株価水準・目標株価はラベルと値が別行に分かれる(ページ上部ヘッダー/株価分析節)ため、
  // parse_financials_extended.ps1 と同じ全文regexで抽出する（同一行lookaheadでは取得不可）。
  const week52M = text.match(/52週株価水準\t[^\r\n]*\r?\n([\-0-9.]+)/);
  if (week52M) out["52週株価水準"] = week52M[1];
  const targetPriceM = text.match(/目標株価[\s\S]{0,20}\(コ\)[\s\S]{0,40}?([0-9,]+)円/);
  if (targetPriceM) out["目標株価"] = targetPriceM[1].replace(/,/g, "");
  return out;
}

// 指標一覧の残り（成長率・レーティング等）→ ビューア専用 manual_fundamentals.csv
const MF_COLS = ["code", "analyst_rating", "target_price_gap", "progress_rate",
  "sales_growth_3y", "sales_growth_5y", "operating_growth_3y", "operating_growth_5y",
  "ordinary_growth_3y", "ordinary_growth_5y", "net_income_growth_3y", "net_income_growth_5y",
  "operating_margin_3y", "operating_margin_5y", "黒字継続年数", "dividend_increase_years",
  "forecast_loss", "current_price", "price_as_of", "data_as_of", "updated_at",
  "ordinary_income_consensus_growth"];
function parsePastedExtras(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  // B.PEG用: 予想経常利益(コンセンサス)増益率。generate_fundamentals.ps1の
  // Get-OrdinaryIncomeConsensusGrowth と同一パターン（全文regex、行分割の外）。
  const ordM = text.match(/予想経常利益[\s\S]{0,10}\(コ\)[\s\S]{0,30}\(増益率\)[\s\S]{0,10}[\d,\-]+[\s\S]{0,10}\(([\-0-9.]+)%\)/);
  if (ordM) out.ordinary_income_consensus_growth = ordM[1];
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

// ===========================================================================
// バリュエーション評価（20点満点）2026-08-11 追加
// scripts/generate_fundamental_scores.ps1 の Get-ValuationA〜E / Get-ValuationResult と
// 同一の閾値・同一の計算式（PowerShell版と一致させる。自動取得/手動貼付で結果を揃えるため）。
// ===========================================================================
function valA(src) {
  const rel2y = numOrNull(src.per_relative_2y), rel5y = numOrNull(src.per_relative_5y);
  if (rel2y == null && rel5y == null) return { available: false, score: 0, value: null, max: 6 };
  const combined = (rel2y != null && rel5y != null) ? (rel5y * 0.6 + rel2y * 0.4) : (rel5y != null ? rel5y : rel2y);
  const score = thresholdScore(100 - combined, [80, 65, 50, 35, 20, 10], [6, 5, 4, 3, 2, 1]);
  return { available: true, score, value: combined, max: 6 };
}
function growthForPeg(src) {
  const epsLatest = numOrNull(src.eps_actual_latest), epsNext = numOrNull(src.eps_forecast_next);
  if (epsLatest != null && epsLatest > 0 && epsNext != null) {
    const g = ((epsNext - epsLatest) / epsLatest) * 100;
    if (g > 0 && g <= 200) return { growth: Math.min(g, 60), source: "eps_forecast" };
  }
  const ordPrev = numOrNull(src.ordinary_income_actual_prev_year), ordGrowth = numOrNull(src.ordinary_income_consensus_growth);
  if (ordPrev != null && ordPrev > 0 && ordGrowth != null) {
    if (ordGrowth > 0 && ordGrowth <= 200) return { growth: Math.min(ordGrowth, 60), source: "ordinary_consensus" };
  }
  return { growth: null, source: "" };
}
function valB(src) {
  const pegMonex = numOrNull(src.peg_monex);
  let peg = null, source = "";
  if (pegMonex != null && pegMonex > 0) { peg = pegMonex; source = "monex_peg"; }
  else {
    const perForecast = numOrNull(src.per_forecast);
    if (perForecast != null && perForecast > 0) {
      const g = growthForPeg(src);
      if (g.growth != null) { peg = perForecast / g.growth; source = g.source; }
    }
  }
  if (peg == null || peg <= 0) return { available: false, score: 0, value: null, source: "", max: 5 };
  const score = thresholdScore(0 - peg, [-0.7, -1.0, -1.5, -2.0, -2.5], [5, 4, 3, 2, 1]);
  return { available: true, score, value: peg, source, max: 5 };
}
function valC(src) {
  const ev = numOrNull(src.ev_ebitda);
  if (ev == null) return { available: false, score: 0, value: null, max: 4 };
  const score = thresholdScore(0 - ev, [-10.8, -13.2, -22.9, -32.8], [4, 3, 2, 1]);
  return { available: true, score, value: ev, max: 4 };
}
function valD(src) {
  const pbr = numOrNull(src.pbr), roe = numOrNull(src.roe);
  if (pbr == null || roe == null || roe <= 0) return { available: false, score: 0, value: null, max: 3 };
  const ratio = pbr / roe;
  const score = thresholdScore(0 - ratio, [-0.152, -0.212, -0.347], [3, 2, 1]);
  return { available: true, score, value: ratio, max: 3 };
}
function valE(src) {
  const level = numOrNull(src.week52_level);
  if (level == null) return { available: false, score: 0, value: null, max: 2 };
  const score = thresholdScore(0 - level, [-41.4, -75.6], [2, 1]);
  return { available: true, score, value: level, max: 2 };
}
function numOrNull(x) { if (x === undefined || x === null || String(x).trim() === "") return null; const n = parseFloat(String(x).replace(/,/g, "")); return isNaN(n) ? null : n; }
function totalRank100(score) {
  if (score >= 85) return "A"; if (score >= 70) return "B"; if (score >= 55) return "C"; if (score >= 40) return "D"; return "E";
}
function computeValuation(src) {
  const a = valA(src), b = valB(src), c = valC(src), d = valD(src), e = valE(src);
  let availableMax = 0, earned = 0;
  for (const item of [a, b, c, d, e]) { if (item.available) { availableMax += item.max; earned += item.score; } }
  const coverage = availableMax / 20;
  let status = "insufficient_data", score = null;
  if (availableMax >= 9) {
    score = (earned / availableMax) * 20;
    status = coverage >= 0.70 ? "normal" : (coverage >= 0.45 ? "reference" : "insufficient_data");
  }
  return { a, b, c, d, e, available_max: availableMax, earned, coverage, status, score };
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
  const quality = computeQualityScore(src);

  // バリュエーション評価用の追加データ（自動取得と同じ生ファイルを参照するのみ。独自regexは追加しない）
  const finRows = (csvToObjects(path.join(DATA_DIR, "output", `${code}_financials.csv`)) || [])
    .filter(r => !/New|予/.test(String(r["決算期"])));
  const latestFin = finRows.length ? finRows[finRows.length - 1] : null;
  const prevFin = finRows.length >= 2 ? finRows[finRows.length - 2] : null;
  const epsForecastRows = csvToObjects(path.join(DATA_DIR, "output_extended", `${code}_eps_forecast.csv`)) || [];
  const valSrc = {
    per_forecast: ind ? ind["PER予想"] : "",
    per_relative_2y: ind ? ind["PER相対水準2年"] : "",
    per_relative_5y: ind ? ind["PER相対水準5年"] : "",
    pbr: ind ? ind["PBR"] : "",
    ev_ebitda: ind ? ind["EV_EBITDA"] : "",
    peg_monex: ind ? ind["予想PEGレシオ"] : "",
    week52_level: ind ? ind["52週株価水準"] : "",
    roe: ind ? ind.ROE : "",
    eps_actual_latest: latestFin ? latestFin["EPS"] : "",
    eps_forecast_next: epsForecastRows.length ? epsForecastRows[0]["EPS予想"] : "",
    ordinary_income_actual_prev_year: prevFin ? prevFin["経常利益"] : "",
    ordinary_income_consensus_growth: mf ? mf.ordinary_income_consensus_growth : "",
  };
  const valuation = computeValuation(valSrc);
  const qualityScoreNum = parseFloat(quality.quality_score) || 0;
  const totalScore100 = valuation.score != null ? qualityScoreNum + valuation.score : null;

  return {
    ...quality, viewer_computed: true, ind, mf,
    valuation_score: valuation.score != null ? fmtScore(valuation.score) : "",
    valuation_coverage: Math.round(valuation.coverage * 1000) / 10,
    valuation_status: valuation.status,
    valuation_a_score: fmtScore(valuation.a.score), valuation_a_available: valuation.a.available,
    valuation_b_score: fmtScore(valuation.b.score), valuation_b_available: valuation.b.available, valuation_b_source: valuation.b.source,
    valuation_c_score: fmtScore(valuation.c.score), valuation_c_available: valuation.c.available,
    valuation_d_score: fmtScore(valuation.d.score), valuation_d_available: valuation.d.available,
    valuation_e_score: fmtScore(valuation.e.score), valuation_e_available: valuation.e.available,
    target_price: ind ? ind["目標株価"] : "",
    target_price_gap: mf ? mf.target_price_gap : "",
    total_score_100: totalScore100 != null ? fmtScore(totalScore100) : "",
    total_rank_100: totalScore100 != null ? totalRank100(totalScore100) : "",
  };
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

// 銘柄の元テキスト: 手動貼付全文(manual_raw)と自動取得(raw)の新しい方を返す
function loadSourceText(code) {
  const cands = [
    path.join(DATA_DIR, "manual_raw", `${code}.txt`),
    path.join(DATA_DIR, "raw", `${code}.txt`),
  ].filter(p => fs.existsSync(p));
  if (!cands.length) return "";
  cands.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  try { return fs.readFileSync(cands[0], "utf8"); } catch { return ""; }
}

// 「決算発表予定」: 直近決算の発表内容と対会社予想進捗率の文を抽出
function parseAnnounce(text) {
  const recent = text.match(/直近の決算は[^\r\n]+/);
  const progress = text.match(/対会社予想進捗率：[^\r\n]+/);
  if (!recent && !progress) return null;
  return { recent: recent ? recent[0].trim() : "", progress: progress ? progress[0].trim() : "" };
}

// 「速報値(日付発表)」ブロック: 見出し日付と直後のデータ行（New/予ラベル・前期比%込み）を抽出。
// 通期/四半期(3か月)/四半期(累積)のどのセクションに属すかも位置関係から判定する
function parseFlashBlocks(text) {
  const lines = text.split(/\r?\n/);
  const secIdx = (kw) => lines.findIndex(l => l.includes(kw));
  const iAnnual = secIdx("通期業績推移");
  const iQ3 = lines.findIndex(l => l.includes("四半期業績推移（3か月）") || l.includes("四半期業績推移(3か月)"));
  const iQc = lines.findIndex(l => l.includes("四半期業績推移（累積）") || l.includes("四半期業績推移(累積)"));
  const iCf = secIdx("キャッシュフロー推移");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/速報値\s*[（(]([^（）()]*発表)[）)]/);
    if (!m) continue;
    const rows = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
      const t = lines[j].trim();
      if (/^\d{4}\/\d{1,2}/.test(t)) {
        rows.push(lines[j].split("\t").map(c => c.trim()).filter(Boolean));
      } else if (rows.length) break;
    }
    if (!rows.length) continue;
    let section = "annual";
    if (iQc !== -1 && i > iQc && (iCf === -1 || i < iCf)) section = "qcum";
    else if (iQ3 !== -1 && i > iQ3) section = "q3";
    else if (iAnnual !== -1 && i > iAnnual) section = "annual";
    blocks.push({ section, date: m[1], rows });
  }
  return blocks;
}

// raw HTML内の非表示詳細テーブルをセクション単位で汎用抽出する
// （貸借対照表・設備投資等はテキスト版にグラフ凡例しか無く、実数値はHTML内の隠しテーブルにある）
const HTML_TABLE_SECTIONS = [
  "貸借対照表", "設備投資・減価償却費・研究開発費", "有利子負債", "各種回転率", "従業員数・1人当り業績",
];
function extractSectionTables(code) {
  const file = path.join(DATA_DIR, "raw", `${code}.html`);
  if (!fs.existsSync(file)) return {};
  let html;
  try { html = fs.readFileSync(file, "utf8"); } catch { return {}; }
  // セクション見出し(h2)の位置で判定する（本文中の同語、例: 銘柄カルテ内の「有利子負債率」に誤マッチしないように）
  const findHeading = name => {
    const i = html.indexOf(`${name}</h2>`);
    return i !== -1 ? i : -1;
  };
  const marks = HTML_TABLE_SECTIONS
    .map(name => ({ name, idx: findHeading(name) }))
    .filter(m => m.idx !== -1)
    .sort((a, b) => a.idx - b.idx);
  const endIdx = findHeading("指標一覧");
  const out = {};
  marks.forEach((m, i) => {
    const to = i + 1 < marks.length ? marks[i + 1].idx : (endIdx !== -1 ? endIdx : m.idx + 400000);
    const seg = html.slice(m.idx, to);
    const tables = (seg.match(/<table[\s\S]*?<\/table>/g) || []).map(t => {
      const rows = (t.match(/<tr[\s\S]*?<\/tr>/g) || []).map(tr =>
        (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) || []).map(c => stripTags(c).replace(/[▲△]/g, "").trim()));
      return rows.filter(r => r.length);
    }).filter(rows => rows.length >= 2);
    if (tables.length) out[m.name] = tables;
  });
  return out;
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

// 108Phase2-B: 貼付原文を _shared_monex_raw/{code}/ へ保存する。
// 方針(2026-08-12追加指示): 1銘柄=最新RAW1件のみ保持。新しい貼付が来たら旧RAWファイルは削除し、
// latest.jsonも最新内容へ置き換える(履歴配列は持たない)。104-3・108の過去レポート自体は
// このフォルダの管理外なので削除しない(旧104-3はhash不一致からstale判定できるようにするだけ)。
// 05・104-3の既存パーサー・スコア計算には一切関与しない、保存処理のみの追加。
// 失敗しても05自身の保存・スコア反映は継続させるため、呼び出し側でtry/catchする。
function saveSharedMonexRaw(code, name, text) {
  const dir = path.join(SHARED_RAW_ROOT, code);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // 旧RAWファイルを削除してから最新版のみを書く(latest.jsonは後述のとおり上書き)
  for (const f of fs.readdirSync(dir)) {
    if (/^\d[0-9A-Za-z]*_\d{8}_\d{6}\.txt$/.test(f)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* 削除失敗は無視して続行 */ }
    }
  }

  const capturedAt = nowLocal();
  const fileStamp = capturedAt.replace(/[-:]/g, "").replace(" ", "_");
  const rawFile = `${code}_${fileStamp}.txt`;
  fs.writeFileSync(path.join(dir, rawFile), text, "utf8");

  const priceMatch = text.match(/現在値\s*[\-0-9.,]+\s*円\(([^)]+)\)/);
  const monexDataUpdatedAt = priceMatch ? priceMatch[1].trim() : null;
  const rawTextHash = "sha256:" + crypto.createHash("sha256").update(text, "utf8").digest("hex");

  const latest = {
    stock_code: code,
    stock_name: name || "",
    source: "monex_stock_scout",
    captured_at: capturedAt,
    monex_data_updated_at: monexDataUpdatedAt,
    raw_text_file: rawFile,
    raw_text_hash: rawTextHash,
  };
  fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(latest, null, 2), "utf8");
  return latest;
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

  // 貼付全文を保存（速報値・決算発表予定など、CSV化しない情報の表示時抽出に使う）
  const manualRawDir = path.join(DATA_DIR, "manual_raw");
  if (!fs.existsSync(manualRawDir)) fs.mkdirSync(manualRawDir, { recursive: true });
  fs.writeFileSync(path.join(manualRawDir, `${code}.txt`), text, "utf8");

  // 108Phase2-B: 同じ貼付原文を共通RAW置き場へも保存（104-3・108が読み取り専用で参照する）。
  // 失敗しても05自身の更新は継続する（共通化は補助機能であり05の主機能をブロックしない）。
  let sharedRaw = null;
  try {
    sharedRaw = saveSharedMonexRaw(code, name, text);
  } catch (e) {
    console.error(`[shared_monex_raw] save failed for ${code}: ${e && e.message || e}`);
  }

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
  // 現在値（株価）: パイプライン側(generate_fundamentals.ps1)と同じ「現在値8,560.0円(08/10 15:30)」形式を抽出。
  // 貼付文に無ければ何もしない（前回値を維持・エラーにしない）
  const priceMatch = text.match(/現在値\s*([\-0-9.,]+)\s*円\(([^)]+)\)/);
  if (priceMatch) {
    extras.current_price = priceMatch[1].replace(/,/g, "");
    extras.price_as_of = priceMatch[2].trim();
  }
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
    indicators: indSaved, extras: extrasSaved, eps_forecast: epsRows.length, rows,
    shared_raw: sharedRaw ? { saved: true, captured_at: sharedRaw.captured_at,
      raw_text_file: sharedRaw.raw_text_file, raw_text_hash: sharedRaw.raw_text_hash } :
      { saved: false } });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(body);
}

function safeCode(raw) {
  return /^[0-9A-Za-z]{1,6}$/.test(raw) ? raw : null;
}

// 09の自動決済監視状態（保有・監視中銘柄）を読む。
// 09_*/runtime/auto_exit/auto_exit_state.json のキー＝監視対象の銘柄コード。
// holding_quantity > 0 が保有中、0 は監視のみ（売却済み等）。読めない場合は null。
function load09Holdings() {
  try {
    const parent = path.join(ROOT, "..");
    const dir = fs.readdirSync(parent).find(n => n.startsWith("09_"));
    if (!dir) return null;
    const p = path.join(parent, dir, "runtime", "auto_exit", "auto_exit_state.json");
    if (!fs.existsSync(p)) return null;
    const state = JSON.parse(fs.readFileSync(p, "utf8"));
    const map = new Map();
    for (const [code, v] of Object.entries(state)) {
      if (!v || typeof v !== "object") continue;
      map.set(code, { qty: Number(v.holding_quantity ?? v.quantity ?? 0) || 0 });
    }
    return map;
  } catch { return null; }
}

// {file}内のcode列がcodeと一致する行を削除する。ヘッダーの列順は維持する。
// 対象行が無い/ファイルが無い場合はfalseを返す（何もしない）。
function removeCsvRowByCode(file, code) {
  if (!fs.existsSync(file)) return false;
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  if (rows.length < 1) return false;
  const header = rows[0];
  const codeIdx = header.indexOf("code");
  if (codeIdx < 0) return false;
  const before = rows.length - 1;
  const kept = rows.slice(1).filter(r => r[codeIdx] !== code);
  if (kept.length === before) return false;
  const objs = kept.map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i] !== undefined ? r[i] : ""; });
    return o;
  });
  fs.writeFileSync(file, toCsv(header, objs), "utf8");
  return true;
}

function removeFileIfExists(p) {
  if (fs.existsSync(p)) { fs.unlinkSync(p); return true; }
  return false;
}

function removeGlobPrefix(dir, prefix) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(prefix)) { fs.unlinkSync(path.join(dir, f)); n++; }
  }
  return n;
}

// 銘柄の完全削除: 一覧表示元CSV（fundamental_scores/fundamentals/fetch_results/
// fetch_status/manual_fundamentals/manual_names）の該当行と、取得済みキャッシュ
// （output/output_extended/raw）を削除する。data/target_codes.csv（04由来の
// 取得対象リスト、および09保有銘柄の追記分）はここでは変更しない。そのため、
// 対象コードが引き続き取得対象であれば次回の自動取り込みで再取得され一覧に戻る。
async function apiDeleteStock(req, res) {
  const body = JSON.parse(await readBody(req) || "{}");
  const code = safeCode(String(body.code || ""));
  if (!code) return sendJson(res, 400, { error: "invalid code" });

  const removed = {
    fundamental_scores: removeCsvRowByCode(path.join(DATA_DIR, "fundamental_scores.csv"), code),
    fundamentals: removeCsvRowByCode(path.join(DATA_DIR, "fundamentals.csv"), code),
    fetch_results: removeCsvRowByCode(path.join(DATA_DIR, "fetch_results.csv"), code),
    fetch_status: removeCsvRowByCode(path.join(DATA_DIR, "fetch_status.csv"), code),
    manual_fundamentals: removeCsvRowByCode(path.join(DATA_DIR, "manual_fundamentals.csv"), code),
    manual_names: removeCsvRowByCode(path.join(DATA_DIR, "manual_names.csv"), code),
    financials_csv: removeFileIfExists(path.join(DATA_DIR, "output", `${code}_financials.csv`)),
    output_extended_files: removeGlobPrefix(path.join(DATA_DIR, "output_extended"), `${code}_`),
    raw_html: removeFileIfExists(path.join(DATA_DIR, "raw", `${code}.html`)),
    raw_txt: removeFileIfExists(path.join(DATA_DIR, "raw", `${code}.txt`)),
  };
  sendJson(res, 200, { code, removed });
}

// ── 共通RAW管理registry(view CSV)の読み込み・統合 ──────────────────────
// 正本のdaily/on_demand/inactive判定はすべてregistry(monex_registry.py)側で行われた結果
// (effective_update_mode列)をそのまま使う。ここで別の判定ロジックを作らない。
function loadRegistryViews() {
  const stocks = csvToObjects(REGISTRY_VIEW_PATH) || [];
  const usages = csvToObjects(REGISTRY_USAGE_VIEW_PATH) || [];
  const usagesByCode = new Map();
  for (const u of usages) {
    if (!usagesByCode.has(u.code)) usagesByCode.set(u.code, []);
    usagesByCode.get(u.code).push(u);
  }
  return { stocks, usagesByCode };
}

// registryのstocks行1件をビューア表示用に整形する（未登録銘柄はnullのまま呼び出し側でフォールバック）
function formatRegistryFields(regRow, usagesForCode) {
  const usages = usagesForCode || [];
  const activeUsages = usages.filter(u => u.active === "1");
  return {
    registry_present: true,
    pinned: regRow.pinned === "1",
    effective_update_mode: regRow.effective_update_mode || "inactive",
    effective_update_mode_label: MODE_LABEL[regRow.effective_update_mode] || regRow.effective_update_mode || "-",
    raw_present: regRow.raw_present === "1",
    registry_last_fetch: regRow.last_fetch || "",
    registry_fetch_status: regRow.fetch_status || "",
    registry_last_error: regRow.last_error || "",
    registry_data_as_of: regRow.data_as_of || "",
    registry_name: regRow.name || "",
    // active_projects例: "05:daily;111/defense:on_demand"。テーマ別project("111/defense")は
    // "/"より前を代表表示名(111)としてバッジ化しつつ、詳細(usages)で元projectを確認できるようにする。
    active_projects: activeUsages.map(u => ({
      project: u.project, group: u.project.split("/")[0],
      mode: u.requested_mode, mode_label: MODE_LABEL[u.requested_mode] || u.requested_mode,
      last_required: u.last_required, reason: u.reason,
    })),
    usages: usages.map(u => ({
      project: u.project, group: u.project.split("/")[0], active: u.active === "1",
      mode: u.requested_mode, mode_label: MODE_LABEL[u.requested_mode] || u.requested_mode,
      last_required: u.last_required, reason: u.reason, run_id: u.run_id, updated_at: u.updated_at,
    })),
  };
}

// registryに存在しない銘柄（例: registry未import時点の古い手動貼付等）向けの既定値
function emptyRegistryFields() {
  return {
    registry_present: false, pinned: false, effective_update_mode: "", effective_update_mode_label: "-",
    raw_present: false, registry_last_fetch: "", registry_fetch_status: "", registry_last_error: "",
    registry_data_as_of: "", registry_name: "", active_projects: [], usages: [],
  };
}

// registryのstocks(view CSV)からダッシュボード上部の集計値を作る。固定値は使わず必ずここから算出する。
function computeRegistrySummary(registryStocks) {
  const s = { total: registryStocks.length, daily: 0, on_demand: 0, inactive: 0, raw_present: 0, pinned: 0 };
  for (const r of registryStocks) {
    if (r.effective_update_mode === "daily") s.daily++;
    else if (r.effective_update_mode === "on_demand") s.on_demand++;
    else s.inactive++;
    if (r.raw_present === "1") s.raw_present++;
    if (r.pinned === "1") s.pinned++;
  }
  return s;
}

// 既存のスコア一覧(list)へregistry情報をcodeでJOINし、registryにしか無い銘柄
// (111/109/104-3が一時取得しただけでfundamental_scores.csvに未登録の銘柄等)も行として追加する。
// codeは常に文字列のまま扱う（285A等の英数字コードを壊さない）。
function mergeRegistryIntoList(list, registryStocks, usagesByCode) {
  const regByCode = new Map(registryStocks.map(r => [String(r.code), r]));
  const known = new Set(list.map(s => String(s.code)));
  const merged = list.map(s => {
    const code = String(s.code);
    const regRow = regByCode.get(code);
    return { ...s, ...(regRow ? formatRegistryFields(regRow, usagesByCode.get(code)) : emptyRegistryFields()) };
  });
  for (const r of registryStocks) {
    const code = String(r.code);
    if (known.has(code)) continue;
    known.add(code);
    merged.push({
      rank: "", code, name: r.name || "(registry)", code_source: "registry_only",
      quality_rank: "", quality_score: "", growth: "", profitability: "", financial: "",
      valuation_score: "", valuation_status: "", total_score_100: "", total_rank_100: "",
      data_as_of: "", fetched_at: "", fundamentals: null,
      ...formatRegistryFields(r, usagesByCode.get(code)),
    });
  }
  return merged;
}

function safeProject(raw) {
  // "111" や "111/defense" のようなテーマ付きproject名を許可する。
  return /^[0-9A-Za-z_-]{1,20}(\/[0-9A-Za-z_-]{1,40})?$/.test(raw) ? raw : null;
}

function pythonCmd() {
  return process.platform === "win32" ? "python" : "python3";
}

// registryへの書き込みは既存CLI(scripts/monex_registry.py)をサブプロセス実行するだけで、
// ビューア側にdaily/on_demand判定やeffective_update_mode更新のロジックは一切持たない。
// execFileSyncはargv配列を直接execするためシェル展開・インジェクションの余地が無い。
function runRegistryCli(args) {
  const out = execFileSync(pythonCmd(), [REGISTRY_CLI_PATH, ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 15000, windowsHide: true,
  });
  return out;
}

// pinのON/OFF。pinned=1は「effective_update_modeを常にdailyにする」既存ロジック(recompute_effective)
// を素通しするだけで、このAPI自体はdaily/inactiveを判定しない。
async function apiRegistryPin(req, res) {
  const body = JSON.parse(await readBody(req) || "{}");
  const code = safeCode(String(body.code || ""));
  if (!code) return sendJson(res, 400, { error: "invalid code" });
  const pinned = !!body.pinned;
  try {
    runRegistryCli([pinned ? "pin" : "unpin", code, "--reason", "05_viewer_manual"]);
    sendJson(res, 200, { code, pinned });
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
}

// 「このProjectでのこの銘柄の利用を停止する」= project_usage.active=0(inactive)にするだけ。
// 対象project以外の利用（例: 05のdaily）や、RAW本体には一切触れない
// (set-usage --inactiveは既存registryのeffective_update_mode再計算を経由するのみ)。
// dailyへの昇格やreactivateはこのAPIでは提供しない(誤操作で日次対象を増やさないため)。
async function apiRegistryDeactivateUsage(req, res) {
  const body = JSON.parse(await readBody(req) || "{}");
  const code = safeCode(String(body.code || ""));
  const project = safeProject(String(body.project || ""));
  if (!code || !project) return sendJson(res, 400, { error: "invalid code/project" });
  try {
    runRegistryCli(["set-usage", "--project", project, "--codes", code, "--inactive", "--reason", "05_viewer_manual_deactivate"]);
    sendJson(res, 200, { code, project, active: false });
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
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
        valuation_score: ms.valuation_score, valuation_coverage: ms.valuation_coverage, valuation_status: ms.valuation_status,
        valuation_a_score: ms.valuation_a_score, valuation_a_available: ms.valuation_a_available,
        valuation_b_score: ms.valuation_b_score, valuation_b_available: ms.valuation_b_available, valuation_b_source: ms.valuation_b_source,
        valuation_c_score: ms.valuation_c_score, valuation_c_available: ms.valuation_c_available,
        valuation_d_score: ms.valuation_d_score, valuation_d_available: ms.valuation_d_available,
        valuation_e_score: ms.valuation_e_score, valuation_e_available: ms.valuation_e_available,
        target_price: ms.target_price, target_price_gap: ms.target_price_gap,
        total_score_100: ms.total_score_100, total_rank_100: ms.total_rank_100,
      } : {}),
      data_as_of: mf.data_as_of || s.data_as_of,
      current_price: mf.current_price || s.current_price,
      price_as_of: mf.price_as_of || s.price_as_of,
      fetched_at: mf.updated_at,
      manual_override: true,
      fundamentals: (ms && ms.ind)
        ? { ...(f || {}), roe: ms.ind.ROE || (f ? f.roe : ""), equity_ratio: ms.ind["自己資本比率"] || (f ? f.equity_ratio : "") }
        : f,
    };
  });

  // フォールバックデータ（今回の最新取得に失敗し、前回データを使った銘柄）も一覧に載せる。
  // fundamental_scores.csv には入らない（generate_fundamental_scores.ps1 が latest のみに絞るため）
  // fundamental_scores_fallback_only.csv 側に銘柄名・株価・決算期・スコアが揃っているので、
  // そちらを使う（「手動追加」スキャンだと output CSV が古いままでデータが欠けるため）。
  const known0 = new Set(list.map(s => s.code));
  const fallbackScores = csvToObjects(path.join(DATA_DIR, "fundamental_scores_fallback_only.csv")) || [];
  for (const s of fallbackScores) {
    if (known0.has(s.code)) continue;
    known0.add(s.code);
    list.push({ ...s, rank: "", fallback_used: true, fundamentals: fmap.get(s.code) || null });
  }

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
      const mfRow = ms ? ms.mf : null;
      list.push({
        rank: "", code: m[1], name: manualNames.get(m[1]) || "(手動追加)",
        code_source: "manual",
        quality_rank: ms ? ms.quality_rank : "", quality_score: ms ? ms.quality_score : "",
        growth: ms ? ms.growth : "", profitability: ms ? ms.profitability : "", financial: ms ? ms.financial : "",
        valuation_score: ms ? ms.valuation_score : "", valuation_coverage: ms ? ms.valuation_coverage : "", valuation_status: ms ? ms.valuation_status : "",
        valuation_a_score: ms ? ms.valuation_a_score : "", valuation_a_available: ms ? ms.valuation_a_available : false,
        valuation_b_score: ms ? ms.valuation_b_score : "", valuation_b_available: ms ? ms.valuation_b_available : false, valuation_b_source: ms ? ms.valuation_b_source : "",
        valuation_c_score: ms ? ms.valuation_c_score : "", valuation_c_available: ms ? ms.valuation_c_available : false,
        valuation_d_score: ms ? ms.valuation_d_score : "", valuation_d_available: ms ? ms.valuation_d_available : false,
        valuation_e_score: ms ? ms.valuation_e_score : "", valuation_e_available: ms ? ms.valuation_e_available : false,
        target_price: ms ? ms.target_price : "", target_price_gap: ms ? ms.target_price_gap : "",
        total_score_100: ms ? ms.total_score_100 : "", total_rank_100: ms ? ms.total_rank_100 : "",
        data_as_of: (mfRow && mfRow.data_as_of) || (ind ? (ind.data_as_of || "") : ""),
        current_price: mfRow ? mfRow.current_price : "",
        price_as_of: mfRow ? mfRow.price_as_of : "",
        fetched_at: (mfRow && mfRow.updated_at) || (ind ? (ind.data_as_of || "") : ""), manual: true,
        fundamentals: fmap.get(m[1]) || (ind ? { roe: ind.ROE || "", equity_ratio: ind["自己資本比率"] || "" } : null),
      });
    }
  }

  // 09の自動決済監視銘柄を反映: 既存行にはバッジ用フラグを付け、
  // 一覧に無い銘柄は行として追加する（財務データ未取得の場合スコア欄は空）
  const holdings = load09Holdings();
  if (holdings) {
    const tmap = new Map((csvToObjects(path.join(DATA_DIR, "target_codes.csv")) || []).map(r => [r.code, r.name]));
    for (const s of list) {
      const h = holdings.get(s.code);
      if (h) { s.watch09 = true; s.holding = h.qty > 0; }
    }
    const known2 = new Set(list.map(s => s.code));
    for (const [code, h] of holdings) {
      if (known2.has(code)) continue;
      list.push({
        rank: "", code, name: tmap.get(code) || manualNames.get(code) || "(09監視銘柄)",
        quality_rank: "", quality_score: "", growth: "", profitability: "", financial: "",
        data_as_of: "", fetched_at: "", watch09: true, holding: h.qty > 0, fundamentals: null,
      });
    }
  }
  // 共通RAW取得センターregistryをcodeでJOIN（registry-only銘柄も追加）。読み取りのみ、
  // ここでの表示処理がregistry/RAWを書き換えることは無い。
  const { stocks: registryStocks, usagesByCode } = loadRegistryViews();
  const merged = mergeRegistryIntoList(list, registryStocks, usagesByCode);
  const registrySummary = computeRegistrySummary(registryStocks);

  sendJson(res, 200, { stocks: merged, generated_at: new Date().toISOString(), registry_summary: registrySummary });
}

function apiStock(res, code) {
  let financials = csvToObjects(path.join(DATA_DIR, "output", `${code}_financials.csv`));
  if (!financials) return sendJson(res, 404, { error: `code ${code} not found` });
  // 防御: 四半期速報値の誤取り込み行（決算期に New を含む）が混入していても表示しない
  financials = financials.filter(r => !/New/.test(String(r["決算期"])));
  const cashflow = csvToObjects(path.join(DATA_DIR, "output_extended", `${code}_cashflow.csv`));
  const quarterly = combinedQuarterly(code, "3か月", "quarterly");
  const quarterlyCum = combinedQuarterly(code, "累積", "quarterly_cum");
  // 会社予想: 貼付保存分があればそれを優先。無ければ元テキスト（貼付全文 or raw）から抽出
  const sourceText = loadSourceText(code);
  let forecast = csvToObjects(path.join(DATA_DIR, "output_extended", `${code}_forecast.csv`)) || [];
  if (!forecast.length && sourceText) {
    try { forecast = parsePastedEpsForecast(sourceText).full; } catch { forecast = []; }
  }
  const announce = sourceText ? parseAnnounce(sourceText) : null;
  const flash = sourceText ? parseFlashBlocks(sourceText) : [];
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
        growth: ms.growth, profitability: ms.profitability, financial: ms.financial, viewer_computed: true,
        valuation_score: ms.valuation_score, valuation_coverage: ms.valuation_coverage, valuation_status: ms.valuation_status,
        valuation_a_score: ms.valuation_a_score, valuation_a_available: ms.valuation_a_available,
        valuation_b_score: ms.valuation_b_score, valuation_b_available: ms.valuation_b_available, valuation_b_source: ms.valuation_b_source,
        valuation_c_score: ms.valuation_c_score, valuation_c_available: ms.valuation_c_available,
        valuation_d_score: ms.valuation_d_score, valuation_d_available: ms.valuation_d_available,
        valuation_e_score: ms.valuation_e_score, valuation_e_available: ms.valuation_e_available,
        target_price: ms.target_price, target_price_gap: ms.target_price_gap,
        total_score_100: ms.total_score_100, total_rank_100: ms.total_rank_100 };
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
    announce,
    flash,
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
    // detached起動のpowershellはコンソールを持てず即終了する（何も実行されない）ため、
    // cmd "start /wait" で可視のコンソールウィンドウ付きで起動する。
    // ガードスクリプトのダイアログ・「黒い画面は閉じない」運用とも整合し、/wait で終了検知もできる。
    const cmdline = `start "05 自動取り込み" /wait powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`;
    updateProc = spawn("cmd.exe", ["/s", "/c", `"${cmdline}"`],
      { cwd: ROOT, stdio: "ignore", windowsVerbatimArguments: true });
    updateProc.on("exit", () => { updateProc = null; });
    updateProc.on("error", () => { updateProc = null; });
    sendJson(res, 200, { started: true });
  } catch (e) {
    updateProc = null;
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
}

// ── 04手動更新（04ダッシュボード(Vercel)ページ内からの実行・ライブログ表示用） ──
// 04ページ(HTTPS)から http://127.0.0.1:8055 へのfetchを許可するため、
// CORS + Private Network Access ヘッダを返す。許可オリジンは04本番と
// ローカル確認(file://はOrigin:null)のみ。
let update04Proc = null;
const CORS_04_ORIGINS = new Set(["https://strong-stock-dashboard-04.vercel.app", "null"]);

function cors04Headers(req) {
  const origin = req.headers.origin || "";
  const h = { "Cache-Control": "no-cache" };
  if (CORS_04_ORIGINS.has(origin)) h["Access-Control-Allow-Origin"] = origin;
  h["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
  h["Access-Control-Allow-Headers"] = "content-type";
  h["Access-Control-Max-Age"] = "600";
  if (req.headers["access-control-request-private-network"]) {
    h["Access-Control-Allow-Private-Network"] = "true";
  }
  return h;
}

function sendJson04(res, status, obj, corsH) {
  res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, corsH));
  res.end(JSON.stringify(obj));
}

function find04Dir() {
  const parent = path.join(ROOT, "..");
  const name = fs.readdirSync(parent).find(n => n.startsWith("04_"));
  return name ? path.join(parent, name) : null;
}

function apiRun04(req, res, corsH) {
  if (update04Proc) return sendJson04(res, 409, { error: "既に実行中です", running: true }, corsH);
  const bat = path.join(ROOT, "..", "run_04_only.bat");
  if (!fs.existsSync(bat)) return sendJson04(res, 500, { error: "run_04_only.bat が見つかりません" }, corsH);
  try {
    // force: 営業日チェックをスキップ（手動実行の意図を優先） / quiet: バッチ側のライブログ別窓を開かない
    const cmdline = `start "04 manual update" /wait cmd /c "call \"${bat}\" force quiet"`;
    update04Proc = spawn("cmd.exe", ["/s", "/c", `"${cmdline}"`],
      { cwd: path.join(ROOT, ".."), stdio: "ignore", windowsVerbatimArguments: true });
    update04Proc.on("exit", () => { update04Proc = null; });
    update04Proc.on("error", () => { update04Proc = null; });
    sendJson04(res, 200, { started: true }, corsH);
  } catch (e) {
    update04Proc = null;
    sendJson04(res, 500, { error: String(e && e.message || e) }, corsH);
  }
}

// 最新の run_04_only_*.log をバイトオフセット差分で返す（実行ごとに新ファイルになるため
// クライアントは file 名も往復させ、ファイルが替わったら末尾から読み直す）
function apiLog04(req, res, corsH, fileParam, afterByte) {
  const dir04 = find04Dir();
  if (!dir04) return sendJson04(res, 500, { error: "04フォルダが見つかりません" }, corsH);
  const logsDir = path.join(dir04, "logs");
  let newest = null;
  if (fs.existsSync(logsDir)) {
    let best = -1;
    for (const n of fs.readdirSync(logsDir)) {
      if (!/^run_04_only_.*\.log$/.test(n)) continue;
      const m = fs.statSync(path.join(logsDir, n)).mtimeMs;
      if (m > best) { best = m; newest = n; }
    }
  }
  if (!newest) return sendJson04(res, 200, { file: null, text: "", offset: 0, running: !!update04Proc }, corsH);
  const full = path.join(logsDir, newest);
  const size = fs.statSync(full).size;
  let start = (fileParam === newest && Number.isFinite(afterByte) && afterByte >= 0 && afterByte <= size)
    ? afterByte : Math.max(0, size - 16384);
  let text = "";
  if (start < size) {
    const fd = fs.openSync(full, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8"); // cmd echo行(cp932)は一部文字化けするが、更新本体の出力は読める
    } finally { fs.closeSync(fd); }
  }
  sendJson04(res, 200, { file: newest, text, offset: size, running: !!update04Proc }, corsH);
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
    if (u.pathname === "/api/run-04" || u.pathname === "/api/log-04") {
      const corsH = cors04Headers(req);
      if (req.method === "OPTIONS") { res.writeHead(204, corsH); return res.end(); }
      if (u.pathname === "/api/run-04" && req.method === "POST") return apiRun04(req, res, corsH);
      if (u.pathname === "/api/log-04") return apiLog04(req, res, corsH, u.searchParams.get("file"), parseInt(u.searchParams.get("after"), 10));
    }
    if (u.pathname === "/api/manual" && req.method === "POST") {
      return apiManual(req, res).catch(e => sendJson(res, 500, { error: String(e && e.message || e) }));
    }
    if (u.pathname === "/api/stocks") return apiStocks(res);
    if (u.pathname === "/api/delete-stock" && req.method === "POST") {
      return apiDeleteStock(req, res).catch(e => sendJson(res, 500, { error: String(e && e.message || e) }));
    }
    if (u.pathname === "/api/registry/pin" && req.method === "POST") {
      return apiRegistryPin(req, res).catch(e => sendJson(res, 500, { error: String(e && e.message || e) }));
    }
    if (u.pathname === "/api/registry/deactivate-usage" && req.method === "POST") {
      return apiRegistryDeactivateUsage(req, res).catch(e => sendJson(res, 500, { error: String(e && e.message || e) }));
    }
    const ms = u.pathname.match(/^\/api\/source\/([^/]+)$/);
    if (ms) {
      const code = safeCode(ms[1]);
      if (!code) return sendJson(res, 400, { error: "invalid code" });
      return sendJson(res, 200, { code, text: loadSourceText(code), tables: extractSectionTables(code) });
    }
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

// テスト（scripts/test_valuation_parity.js）からの require 時はHTTPサーバーを起動しない。
// node viewer/server.js で直接実行した場合のみ listen する（既存の起動方法は変更なし）。
if (require.main === module) {
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
}

module.exports = {
  computeValuation, computeQualityScore, buildManualScore, saveSharedMonexRaw, apiManual,
  mergeRegistryIntoList, computeRegistrySummary, formatRegistryFields,
};
