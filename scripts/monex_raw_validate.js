"use strict";
/**
 * 銘柄スカウター財務ページRAW(本文テキスト/HTML)の正常判定 ― 唯一の正本。
 *
 * - evaluateFinancialText: 従来 playwright_batch_fetch_financials.js 内にあった成功判定
 *   (認証エラー無し・決算期あり・指標ラベル4つ以上・財務テーブル行あり)をそのまま移設したもの。
 *   判定内容は変更していない。認証エラー判定は auth_detect.js(唯一の認証判定ロジック)を使う。
 * - validateRawText: 上記に「銘柄コード一致」「本文長」を加えた、正本RAW(data/raw)へ昇格させる前のゲート。
 *   playwright_batch_fetch_financials.js(05日次・on-demand の取得本体)と validate_monex_raw.js
 *   (request_monex_raw.py からのCLI)の両方がこのモジュールを使い、同じ検証を別実装しない。
 */
const { detectAuthErrorPage } = require("./auth_detect");

const DEFAULT_MIN_CHARS = 3000;

function evaluateFinancialText(text, html = "") {
  const authError = detectAuthErrorPage(text, html);
  const hasFiscalPeriod = /\d{4}\/\d{2}/.test(text);
  const metricLabels = ["売上高", "営業利益", "経常利益", "純利益", "EPS"];
  const foundMetricLabels = metricLabels.filter((label) => text.includes(label));
  const financialRows = text
    .split(/\r?\n/)
    .filter((line) => /^\d{4}\/\d{2}\b/.test(line.trim()) && line.split("\t").length >= 9);
  return {
    ok: !authError.detected && hasFiscalPeriod && foundMetricLabels.length >= 4 && financialRows.length > 0,
    hasAuthError: authError.detected,
    authMarker: authError.marker,
    hasFiscalPeriod,
    foundMetricLabels,
    financialRowCount: financialRows.length
  };
}

function extractStockName(text, code) {
  const re = new RegExp(`^\\s*${code}\\s+(\\S.*)$`, "mi");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

function extractLatestPeriodInRaw(text) {
  // 財務テーブルの実績行(決算期セルが "2026/03" / "2026/03 I" の行)の中で最大の決算期を返す(四半期テーブルの行も含む)。
  // 05の fetch_status.csv の data_as_of(パーサ由来・通期のみ)とは別物なので、名前も別にしている。
  // 会社予想行は決算期セルが "2027/03予" のように「予」を含むため除外する
  // (parse_financials_core.ps1 の forecast 判定 ^\d{4}/\d{2}\s*予 と同じ基準)。
  let best = "";
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split("\t");
    if (cells.length < 9) continue;
    // 会計基準マーカー("2026/03 I" = IFRS, "S"=SEC, "U"=US 等)が付く行も実績行として扱う
    const m = cells[0].trim().match(/^(\d{4}\/\d{2})(?:\s+[A-Za-z]{1,4})?$/);
    if (m && m[1] > best) best = m[1];
  }
  return best;
}

function extractMonexUpdatedAt(text) {
  const m = text.match(/現在値\s*[\-0-9.,]+\s*円\(([^)]+)\)/);
  return m ? m[1].trim() : "";
}

// 正本RAWへ昇格させてよいかの総合判定。ok=false のとき reason に不合格理由(1つ)を入れる。
function validateRawText(code, text, html = "", minChars = DEFAULT_MIN_CHARS) {
  const safeText = String(text || "");
  const evalResult = evaluateFinancialText(safeText, html || "");
  const codeUpper = String(code).toUpperCase();
  const codeMatch = new RegExp(`(^|\\n)\\s*${codeUpper}\\s+\\S`, "i").test(safeText);
  const longEnough = safeText.length >= minChars;
  const checks = {
    not_auth_error: !evalResult.hasAuthError,
    auth_marker: evalResult.authMarker,
    has_fiscal_period: evalResult.hasFiscalPeriod,
    metric_labels: evalResult.foundMetricLabels,
    financial_rows: evalResult.financialRowCount,
    financial_body_ok: evalResult.ok,
    code_match: codeMatch,
    long_enough: longEnough
  };
  const ok = evalResult.ok && codeMatch && longEnough;
  let reason = "";
  if (!ok) {
    if (evalResult.hasAuthError) reason = `auth_error:${evalResult.authMarker}`;
    else if (!longEnough) reason = `too_short:${safeText.length}<${minChars}`;
    else if (!codeMatch) reason = "code_mismatch";
    else if (!evalResult.hasFiscalPeriod) reason = "fiscal_period_not_found";
    else reason = `financial_rows_or_metrics_not_found rows=${evalResult.financialRowCount} metrics=${evalResult.foundMetricLabels.join("|")}`;
  }
  return {
    code: codeUpper,
    ok,
    reason,
    checks,
    evalResult,
    stock_name: extractStockName(safeText, codeUpper),
    latest_period_in_raw: extractLatestPeriodInRaw(safeText),
    monex_data_updated_at: extractMonexUpdatedAt(safeText),
    text_chars: safeText.length
  };
}

module.exports = {
  DEFAULT_MIN_CHARS,
  evaluateFinancialText,
  validateRawText,
  extractStockName,
  extractLatestPeriodInRaw,
  extractMonexUpdatedAt
};
