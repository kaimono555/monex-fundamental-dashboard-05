#!/usr/bin/env node
/**
 * マネックス銘柄スカウター「業績ニュース」タブ(sa=report_topix&bcode=<code>)の1ページ目を、
 * 05専用プロファイル(CDP:9222 / monex-login-profile)で取得する(2026-09-04 共通RAW取得センター化)。
 *
 * 109_銘柄選定・分析エージェント/scripts/monex_scout_client.js が109専用ブラウザ(CDP:9223)で行っていた
 * 取得を05へ移すためのもの。ブラウザ接続・ログイン判定・認証エラー判定は新しく書かず、
 * playwright_batch_fetch_financials.js(getOrCreateContext / checkLoginReady)と auth_detect.js をそのまま使う。
 * ヘッダー指標・ニュース行の抽出ロジック(extractHeader / extractNewsRows)は109の monex_scout_client.js と
 * 同じ形(同じキー名)で出力し、109側が差し替えなしで受け取れるようにする。
 *
 * 呼び出しは request_monex_raw.py(--page-type topix_news)から行う想定。単体実行:
 *   node scripts/playwright_fetch_monex_topix_news.js --codes 8306 --out-dir data/tmp_fetch/x/raw_topix \
 *        --results-path data/tmp_fetch/x/topix_results.json [--user-data-dir ..] [--chrome-executable ..] [--log-path ..]
 * 出力: {out-dir}/{code}.txt, {code}.html, {code}_news.json ({code, stock_name, header, news, fetched_at, ...})
 * 終了コード: 0=全件成功 / 2=一部または全部失敗 / 3=ログイン未確立 / 1=致命的エラー
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { detectAuthErrorPage } = require("./auth_detect");
const batch = require("./playwright_batch_fetch_financials.js");

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function grab(text, re) {
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

// 109 monex_scout_client.js extractHeader と同じキー・同じ正規表現(109側が無変更で受け取れるようにする)
function extractHeader(bodyText, code) {
  const nameMatch = bodyText.match(new RegExp(`^${code}\\s*(.+)$`, "mi"));
  return {
    stock_name: nameMatch ? nameMatch[1].trim() : null,
    price: grab(bodyText, /現在値([\d,]+\.?\d*)円/),
    price_datetime: grab(bodyText, /現在値[\d,]+\.?\d*円\(([^)]+)\)/),
    day_change: grab(bodyText, /前日比([^(（]+)[（(]/),
    day_change_pct: grab(bodyText, /前日比[^(（]+[（(]([^)）]+)[)）]/),
    market_cap: grab(bodyText, /時価総額[\s\S]{0,10}?([\d,]+億円)/),
    per_forecast: grab(bodyText, /PER[\s\S]{0,20}?\(予\)[\s\S]{0,10}?([\d.－\-]+)\s*倍/),
    pbr_actual: grab(bodyText, /PBR[\s\S]{0,20}?\(実\)[\s\S]{0,10}?([\d.－\-]+)\s*倍/),
    dividend_yield_forecast: grab(bodyText, /配当利回り[\s\S]{0,20}?\(予\)[\s\S]{0,10}?([\d.－\-]+)\s*%/),
    roe_actual: grab(bodyText, /ROE[\s\S]{0,20}?\(実\)[\s\S]{0,10}?([\d.－\-]+)\s*%/),
    roic_actual: grab(bodyText, /ROIC[\s\S]{0,20}?\(実\)[\s\S]{0,10}?([\d.－\-]+)\s*%/),
    roa_actual: grab(bodyText, /ROA[\s\S]{0,20}?\(実\)[\s\S]{0,10}?([\d.－\-]+)\s*%/),
    equity_ratio: grab(bodyText, /自己資本比率[\s\S]{0,10}?([\d.－\-]+)\s*%/),
    forecast_ordinary_income: grab(bodyText, /予想経常利益[\s\S]{0,10}?\(予\)[\s\S]{0,30}?([\d,－\-]+)\s*\n?\(/),
    forecast_ordinary_income_growth: grab(bodyText, /予想経常利益[\s\S]{0,10}?\(予\)[\s\S]{0,30}?[\d,－\-]+\s*\n?\(([^)）]+)[)）]/),
    consensus_ordinary_income: grab(bodyText, /予想経常利益[\s\S]{0,10}?\(コ\)[\s\S]{0,30}?([\d,－\-]+)\s*\n?\(/),
    consensus_ordinary_income_growth: grab(bodyText, /予想経常利益[\s\S]{0,10}?\(コ\)[\s\S]{0,30}?[\d,－\-]+\s*\n?\(([^)）]+)[)）]/),
    rating: grab(bodyText, /レーティング[\s\S]{0,30}?([\d.－\-]+)\s*\(/),
    rating_change: grab(bodyText, /レーティング[\s\S]{0,30}?[\d.－\-]+\s*\(([^)）]+)[)）]/),
    target_price: grab(bodyText, /目標株価[\s\S]{0,30}?([\d,]+)円/),
    target_price_gap: grab(bodyText, /目標株価[\s\S]{0,60}?株価乖離率[\s\S]{0,10}?([\d.\-－]+%)/),
    financial_data_updated_at: grab(bodyText, /財務データ等\s*更新日[：:]\s*([\d\/]+)/),
    captured_at: new Date().toISOString()
  };
}

function detectNewsMarkers(bodyText) {
  return bodyText.includes("業績ニュース履歴") && (bodyText.includes("決算発表") || bodyText.includes("業績予想"));
}

async function extractNewsRows(page, code) {
  return page.evaluate((codeArg) => {
    const rows = Array.from(document.querySelectorAll(".rt_block .line, .rt_block .line_odd"));
    const items = [];
    for (const row of rows) {
      const dateEl = row.querySelector("span.date");
      const dateTimeText = dateEl ? dateEl.textContent.trim() : "";
      const [datePart, timePart] = dateTimeText.split(/\s+/);
      const icons = Array.from(row.querySelectorAll(".topix_icon img"));
      let category = "";
      for (const img of icons) {
        const alt = (img.getAttribute("alt") || img.getAttribute("title") || "").trim();
        if (alt) category = alt;
      }
      const linkEl = row.querySelector(".title a");
      const title = linkEl ? linkEl.textContent.trim() : "";
      const href = linkEl ? linkEl.getAttribute("href") || "" : "";
      const nidMatch = href.match(/[?&]nid=([^&]+)/);
      const nid = nidMatch ? decodeURIComponent(nidMatch[1]) : null;
      const detailUrl = href ? new URL(href, window.location.href).toString() : null;
      if (!datePart && !title) continue;
      items.push({ code: codeArg, nid, date: datePart || "", time: timePart || "", category: category || null, title, detail_url: detailUrl });
    }
    return items;
  }, code);
}

async function readPage(page) {
  let text = "";
  let html = "";
  try { text = await page.locator("body").innerText({ timeout: 2000 }); } catch (_) { text = ""; }
  try { html = await page.content(); } catch (_) { html = ""; }
  return { text, html };
}

async function fetchTopixOne(context, code, outDir, logPath, maxRetries) {
  const url = `https://monex.ifis.co.jp/index.php?sa=report_topix&bcode=${code}`;
  let lastError = "";
  let lastErrorType = "fetch_failed";
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    let page = null;
    try {
      page = await context.newPage();
      batch.writeRunLog(logPath, `topix fetch start code=${code} attempt=${attempt}/${maxRetries} url=${url}`);
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      const status = response ? response.status() : "unknown";
      if (status === 403 || status === 429) {
        await batch.closePageQuietly(page);
        return { code, fetch_status: "failed", error_type: `http_${status}`, error_message: `HTTP ${status}`, stop: true };
      }
      const deadline = Date.now() + 60000;
      let best = { text: "", html: "" };
      let ready = false;
      let auth = { detected: false, marker: "" };
      while (Date.now() < deadline) {
        try { await page.waitForLoadState("domcontentloaded", { timeout: 3000 }); } catch (_) { /* continue */ }
        best = await readPage(page);
        auth = detectAuthErrorPage(best.text, best.html);
        ready = detectNewsMarkers(best.text);
        if (auth.detected || ready) break;
        await sleep(1000);
      }
      if (auth.detected) {
        lastErrorType = "auth_error";
        lastError = `authentication page detected marker=${auth.marker}`;
        batch.writeRunLog(logPath, `topix auth/error page detected code=${code} marker=${auth.marker}`);
        await batch.closePageQuietly(page);
        return { code, fetch_status: "failed", error_type: lastErrorType, error_message: lastError, stop: true };
      }
      if (!ready) {
        lastErrorType = "news_markers_not_found";
        lastError = `業績ニュースページの表示を確認できませんでした textChars=${best.text.length}`;
        batch.writeRunLog(logPath, `topix attempt failed code=${code} attempt=${attempt} type=${lastErrorType}`);
        await batch.closePageQuietly(page);
        continue;
      }
      const header = extractHeader(best.text, code);
      const news = await extractNewsRows(page, code);
      const fetchedAt = batch.nowTokyo();
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `${code}.txt`), best.text, "utf8");
      fs.writeFileSync(path.join(outDir, `${code}.html`), best.html, "utf8");
      const payload = {
        code,
        stock_name: header.stock_name || "",
        source: "monex_stock_scout_topix_news",
        fetched_at: fetchedAt,
        fetched_by: "05",
        page_url: url,
        header,
        news,
        news_count: news.length
      };
      fs.writeFileSync(path.join(outDir, `${code}_news.json`), JSON.stringify(payload, null, 2), "utf8");
      batch.writeRunLog(logPath, `topix fetch success code=${code} news=${news.length} textChars=${best.text.length}`);
      await batch.closePageQuietly(page);
      return { code, fetch_status: "success", error_type: "", error_message: "", stock_name: payload.stock_name,
        news_count: news.length, monex_data_updated_at: header.price_datetime || "", fetched_at: fetchedAt };
    } catch (error) {
      lastErrorType = "exception";
      lastError = error.message;
      batch.writeRunLog(logPath, `topix fetch exception code=${code} attempt=${attempt} error=${error.message}`);
      await batch.closePageQuietly(page);
      if (attempt < maxRetries) await sleep(3000);
    }
  }
  return { code, fetch_status: "failed", error_type: lastErrorType, error_message: lastError };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const codes = (args.codes || "").split(",").map((c) => c.trim()).filter(Boolean);
  const userDataDir = args["user-data-dir"] || "data/playwright-profile/monex-login-profile";
  const chromeExecutable = args["chrome-executable"];
  const outDir = args["out-dir"] || "data/raw_topix";
  const logPath = args["log-path"] || "logs/run_log_ondemand.txt";
  const resultsPath = args["results-path"] || path.join(outDir, "_topix_results.json");
  const maxRetries = Math.max(1, Number.parseInt(args["max-retries"] || "2", 10));
  if (codes.length === 0) {
    console.error("usage: --codes 8306[,7203] --out-dir <dir> --results-path <json>");
    process.exit(1);
  }
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (error) {
    batch.writeRunLog(logPath, "topix fetch failed error=playwright package is not installed");
    throw error;
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  batch.writeRunLog(logPath, `topix batch start count=${codes.length} userDataDir=${userDataDir}`);
  const { browser, context } = await batch.getOrCreateContext(chromium, userDataDir, chromeExecutable, logPath);
  const results = [];
  const writeResults = () => fs.writeFileSync(resultsPath, JSON.stringify({ results }, null, 2), "utf8");
  try {
    // ログイン確認は05日次と同じ checkLoginReady(財務ページ)で行う(判定ロジックを増やさない)
    const loginReady = await batch.checkLoginReady(context, codes[0], logPath, userDataDir);
    if (!loginReady) {
      batch.writeRunLog(logPath, "topix batch aborted: login not ready (run login_monex_profile_05.ps1)");
      writeResults();
      process.exitCode = 3;
      return;
    }
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
      const r = await fetchTopixOne(context, code, outDir, logPath, maxRetries);
      results.push(r);
      writeResults();
      if (r.stop) {
        batch.writeRunLog(logPath, `topix batch stopped early code=${code} type=${r.error_type}`);
        if (r.error_type === "auth_error") process.exitCode = 3;
        break;
      }
      if (i < codes.length - 1) await sleep(1500 + Math.random() * 1000);
    }
  } finally {
    writeResults();
    batch.writeRunLog(logPath, `topix batch end count=${codes.length} success=${results.filter((r) => r.fetch_status === "success").length}`);
    try { await browser.close(); } catch (_) { /* CDP切断のみ。Chrome本体は開いたまま */ }
  }
  if (process.exitCode !== 3 && results.some((r) => r.fetch_status !== "success")) process.exitCode = 2;
  if (process.exitCode !== 3 && results.length < codes.length) process.exitCode = 2;
}

module.exports = { extractHeader, extractNewsRows, detectNewsMarkers };

if (require.main === module) {
  main().catch((error) => {
    const args = parseArgs(process.argv.slice(2));
    batch.writeRunLog(args["log-path"] || "logs/run_log_ondemand.txt", `topix batch fatal error=${error.message}`);
    process.exit(1);
  });
}
