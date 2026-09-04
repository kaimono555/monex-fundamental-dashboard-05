#!/usr/bin/env node
/**
 * 取得済みRAW(text/html)が「銘柄スカウター財務ページの正常本文」かを判定して JSON で返す。
 *
 * 判定ロジックは新規に書かず、既存の正本をそのまま使う:
 *   - 認証エラー判定: scripts/auth_detect.js (detectAuthErrorPage)
 *   - 財務本文判定  : playwright_batch_fetch_financials.js の evaluateFinancialText
 * これに加えて、共通RAW取得センター(request_monex_raw.py)が latest へ昇格させる前の追加ゲートとして
 *   - 銘柄コード一致(本文先頭付近の「5803 フジクラ」行)
 *   - 異常に短い本文でない(minChars)
 * を確認する。
 *
 * 使い方:
 *   node scripts/validate_monex_raw.js --code 5803 --text path/to/5803.txt [--html path/to/5803.html] [--min-chars 3000]
 * 出力(標準出力1行JSON):
 *   {"code":"5803","ok":true,"checks":{...},"stock_name":"フジクラ","latest_period_in_raw":"2026/06","monex_data_updated_at":"09/03 15:30","text_chars":34554}
 * 終了コード: 0=ok / 2=検証NG / 1=引数・入出力エラー
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { evaluateFinancialText } = require(path.join(__dirname, "playwright_batch_fetch_financials.js"));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    args[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
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

function validate(code, text, html, minChars) {
  const evalResult = evaluateFinancialText(text, html);
  const codeUpper = String(code).toUpperCase();
  const codeMatch = new RegExp(`(^|\\n)\\s*${codeUpper}\\s+\\S`, "i").test(text);
  const longEnough = text.length >= minChars;
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
    else if (!longEnough) reason = `too_short:${text.length}<${minChars}`;
    else if (!codeMatch) reason = "code_mismatch";
    else if (!evalResult.hasFiscalPeriod) reason = "fiscal_period_not_found";
    else reason = `financial_rows_or_metrics_not_found rows=${evalResult.financialRowCount} metrics=${evalResult.foundMetricLabels.join("|")}`;
  }
  return {
    code: codeUpper,
    ok,
    reason,
    checks,
    stock_name: extractStockName(text, codeUpper),
    latest_period_in_raw: extractLatestPeriodInRaw(text),
    monex_data_updated_at: extractMonexUpdatedAt(text),
    text_chars: text.length
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const code = args.code;
  const textPath = args.text;
  if (!code || !textPath) {
    console.error("usage: --code <code> --text <path> [--html <path>] [--min-chars 3000]");
    process.exit(1);
  }
  const minChars = Math.max(0, Number.parseInt(args["min-chars"] || "3000", 10));
  let text = "";
  let html = "";
  try {
    text = fs.readFileSync(textPath, "utf8");
    if (args.html && fs.existsSync(args.html)) html = fs.readFileSync(args.html, "utf8");
  } catch (error) {
    console.log(JSON.stringify({ code, ok: false, reason: `read_error:${error.message}` }));
    process.exit(1);
  }
  const result = validate(code, text, html, minChars);
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 2);
}

module.exports = { validate, extractStockName, extractLatestPeriodInRaw, extractMonexUpdatedAt };

if (require.main === module) main();
