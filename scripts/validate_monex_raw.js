#!/usr/bin/env node
/**
 * 取得済みRAW(text/html)が「銘柄スカウター財務ページの正常本文」かを判定して JSON で返す CLI。
 *
 * 判定ロジックは monex_raw_validate.js(唯一の正本。auth_detect.js + evaluateFinancialText +
 * 銘柄コード一致 + 本文長)をそのまま使う。playwright_batch_fetch_financials.js の fetchOne が
 * 正本RAWへ昇格させる前に使う判定と同一。request_monex_raw.py からサブプロセスとして呼ばれる。
 *
 * 使い方:
 *   node scripts/validate_monex_raw.js --code 5803 --text path/to/5803.txt [--html path/to/5803.html] [--min-chars 3000]
 * 出力(標準出力1行JSON):
 *   {"code":"5803","ok":true,"checks":{...},"stock_name":"フジクラ","latest_period_in_raw":"2026/06","monex_data_updated_at":"09/03 15:30","text_chars":34554}
 * 終了コード: 0=ok / 2=検証NG / 1=引数・入出力エラー
 */
"use strict";
const fs = require("fs");
const {
  validateRawText, extractStockName, extractLatestPeriodInRaw, extractMonexUpdatedAt, DEFAULT_MIN_CHARS
} = require("./monex_raw_validate");

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

function validate(code, text, html, minChars) {
  const r = validateRawText(code, text, html, minChars);
  const { evalResult, ...rest } = r; // CLI出力は従来どおり(evalResultは内部用)
  return rest;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const code = args.code;
  const textPath = args.text;
  if (!code || !textPath) {
    console.error("usage: --code <code> --text <path> [--html <path>] [--min-chars 3000]");
    process.exit(1);
  }
  const minChars = Math.max(0, Number.parseInt(args["min-chars"] || String(DEFAULT_MIN_CHARS), 10));
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
