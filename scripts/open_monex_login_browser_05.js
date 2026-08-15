#!/usr/bin/env node
/**
 * 05専用の「マネックスログイン」ボタン用スクリプト。
 *
 * playwright_batch_fetch_financials.js が使っているのと同じ方式
 * (CDPポート9222で開いたままのブラウザがあれば再利用、無ければdetachedな
 * Chromeを新規起動してそのまま開いたままにする)で、05専用プロファイルの
 * ブラウザを確実に用意し、マネックスのトップページを開いて人間のログイン操作を
 * 促すだけの軽量スクリプト。取得処理(financialsのfetch)は一切行わない。
 *
 * このスクリプト自体はブラウザを起動/接続したらすぐ終了してよい
 * (detached起動のためNodeプロセスの生死とブラウザは無関係)。
 *
 * 使い方: node scripts/open_monex_login_browser_05.js
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PROFILE_DIR = path.join(ROOT, "data", "playwright-profile", "monex-login-profile");
const CDP_PORT = 9222;

async function isCdpReachable(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch (_) {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (error) {
    console.error("playwrightがインストールされていません。");
    process.exit(1);
  }

  if (await isCdpReachable(CDP_PORT)) {
    console.log(`既に開いたままのブラウザが見つかりました(cdpPort=${CDP_PORT})。そのウィンドウでログイン状態を確認してください。`);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const context = browser.contexts()[0];
    if (context) {
      const page = await context.newPage();
      await page.goto("https://www.monex.co.jp/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      console.log("マネックストップページを新しいタブで開きました。");
    }
    process.exit(0);
  }

  console.log("開いたままのブラウザが見つからないため、新規に起動します(今回から閉じずに維持します)。");
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const execPath = chromium.executablePath();
  const child = spawn(execPath, [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "--disable-background-networking",
    "--disable-default-apps",
    "--no-first-run",
    "--no-default-browser-check",
    "--lang=ja-JP",
    "https://www.monex.co.jp/"
  ], { detached: true, stdio: "ignore" });
  child.unref();

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await isCdpReachable(CDP_PORT)) {
      console.log("ブラウザを起動しました。開いたウィンドウでマネックスにログインしてください。");
      console.log("このウィンドウは閉じずにそのままにしておいてください。");
      process.exit(0);
    }
    await sleep(300);
  }

  console.error("ブラウザの起動を確認できませんでした(タイムアウト)。");
  process.exit(1);
}

main().catch((error) => {
  console.error(`失敗しました: ${error.message}`);
  process.exit(1);
});
