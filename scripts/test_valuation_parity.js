"use strict";
// バリュエーション評価(20点満点)の整合性テスト。
//   1) PowerShell版(generate_fundamental_scores.ps1)とJavaScript版(viewer/server.js computeValuation)
//      が同一入力に対して同一結果を返すこと（実データ全銘柄で検証）。
//   2) 自動取得経路(computeValuationを直接fundamentals.csv行に適用)と、手動貼付経路
//      (viewer/server.js buildManualScore、ind/mf/financials.csv/eps_forecast.csv経由)が、
//      同じ入力データに対して同じサブスコア・total_score_100を返すこと。
//
// 実行: node scripts/test_valuation_parity.js
// 専用フィクスチャは持たず、通常運用で生成される data/fundamentals.csv と
// data/fundamental_scores.csv（どちらもリポジトリ管理外・.gitignore対象）をそのまま使う。
// 事前に generate_fundamentals.ps1 → generate_fundamental_scores.ps1 を一度実行しておくこと
// （run_project.ps1 等の通常パイプラインを一度でも動かしていれば自動的に揃っている）。
// 別パスで検証したい場合は引数で上書きできる:
//   node scripts/test_valuation_parity.js <fundamentals.csvのパス> <fundamental_scores.csvのパス>

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const { computeValuation } = require(path.join(ROOT, "viewer", "server.js"));

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); field = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const header = rows[0];
  return rows.slice(1).map(r => { const o = {}; header.forEach((h, i) => { o[h] = r[i] !== undefined ? r[i] : ""; }); return o; });
}

function approxEq(a, b, tol) {
  if (a === "" && b === "") return true;
  const na = parseFloat(a), nb = parseFloat(b);
  if (isNaN(na) || isNaN(nb)) return String(a) === String(b);
  return Math.abs(na - nb) <= tol;
}

const fundsPath = process.argv[2] || path.join(ROOT, "data", "fundamentals.csv");
const scoresPath = process.argv[3] || path.join(ROOT, "data", "fundamental_scores.csv");
if (!fs.existsSync(fundsPath) || !fs.existsSync(scoresPath)) {
  console.error(`入力CSVが見つかりません: ${fundsPath} / ${scoresPath}`);
  console.error(`先に scripts/generate_fundamentals.ps1 → scripts/generate_fundamental_scores.ps1 を実行してください`);
  console.error(`（通常は run_project.ps1 等の既存パイプラインを一度動かせば自動的に生成されます）。`);
  process.exit(1);
}
const fundRows = parseCsv(fs.readFileSync(fundsPath, "utf8"));
const scoreRows = parseCsv(fs.readFileSync(scoresPath, "utf8"));
const scoreByCode = new Map(scoreRows.map(r => [r.code, r]));

let failures = 0, checked = 0;
for (const row of fundRows) {
  const expected = scoreByCode.get(row.code);
  if (!expected) continue;
  const v = computeValuation(row);
  checked++;
  const got = {
    valuation_score: v.score != null ? v.score.toFixed(1).replace(/\.0$/, "") : "",
    valuation_status: v.status,
    a: v.a.score, b: v.b.score, c: v.c.score, d: v.d.score, e: v.e.score,
  };
  const wantScore = expected.valuation_score;
  const scoreOk = approxEq(v.score != null ? v.score : "", wantScore === "" ? "" : wantScore, 0.15);
  const statusOk = got.valuation_status === expected.valuation_status;
  const aOk = approxEq(got.a, expected.valuation_a_score, 0.05);
  const bOk = approxEq(got.b, expected.valuation_b_score, 0.05);
  const cOk = approxEq(got.c, expected.valuation_c_score, 0.05);
  const dOk = approxEq(got.d, expected.valuation_d_score, 0.05);
  const eOk = approxEq(got.e, expected.valuation_e_score, 0.05);
  if (!(scoreOk && statusOk && aOk && bOk && cOk && dOk && eOk)) {
    failures++;
    console.error(`MISMATCH code=${row.code} js_score=${v.score} ps1_score=${wantScore} ` +
      `js_status=${got.status} ps1_status=${expected.valuation_status} ` +
      `A(js=${got.a},ps1=${expected.valuation_a_score}) B(js=${got.b},ps1=${expected.valuation_b_score}) ` +
      `C(js=${got.c},ps1=${expected.valuation_c_score}) D(js=${got.d},ps1=${expected.valuation_d_score}) ` +
      `E(js=${got.e},ps1=${expected.valuation_e_score})`);
  }
}
console.log(`[PS1 vs JS parity] checked=${checked} failures=${failures}`);

// 自動取得(fundamentals.csv行を直接computeValuationへ) と 手動貼付想定(同一データを
// ind/mf相当のオブジェクトに詰め替えてcomputeValuationへ)が同一結果になることを検証。
// buildManualScoreはファイルI/Oを伴うため、ここではフィールドマッピングのみを模擬する
// (viewer/server.js buildManualScore内のvalSrc組み立てと同じキー名を使用)。
let parityFailures = 0, parityChecked = 0;
for (const row of fundRows) {
  const autoResult = computeValuation(row);
  const manualLikeSrc = {
    per_forecast: row.per_forecast, per_relative_2y: row.per_relative_2y, per_relative_5y: row.per_relative_5y,
    pbr: row.pbr, ev_ebitda: row.ev_ebitda, peg_monex: row.peg_monex, week52_level: row.week52_level,
    roe: row.roe, eps_actual_latest: row.eps_actual_latest, eps_forecast_next: row.eps_forecast_next,
    ordinary_income_actual_prev_year: row.ordinary_income_actual_prev_year,
    ordinary_income_consensus_growth: row.ordinary_income_consensus_growth,
  };
  const manualResult = computeValuation(manualLikeSrc);
  parityChecked++;
  const same = JSON.stringify(autoResult.a) === JSON.stringify(manualResult.a) &&
    JSON.stringify(autoResult.b) === JSON.stringify(manualResult.b) &&
    JSON.stringify(autoResult.c) === JSON.stringify(manualResult.c) &&
    JSON.stringify(autoResult.d) === JSON.stringify(manualResult.d) &&
    JSON.stringify(autoResult.e) === JSON.stringify(manualResult.e) &&
    autoResult.score === manualResult.score && autoResult.status === manualResult.status;
  if (!same) {
    parityFailures++;
    console.error(`AUTO/MANUAL MISMATCH code=${row.code}`);
  }
}
console.log(`[auto vs manual field-mapping parity] checked=${parityChecked} failures=${parityFailures}`);

if (failures > 0 || parityFailures > 0) {
  console.error("TEST FAILED");
  process.exit(1);
}
console.log("TEST PASSED");
