const fs = require("fs");
const path = require("path");

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

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeRunLog(logPath, message) {
  ensureDirectory(path.dirname(logPath));
  const timestamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" });
  fs.appendFileSync(logPath, `[${timestamp}] ${message}\n`, "utf8");
}

function getPlaywright(logPath) {
  try {
    return require("playwright");
  } catch (error) {
    writeRunLog(logPath, "Playwright起動失敗 error=playwright package is not installed");
    throw error;
  }
}

function launchOptions(chromeExecutable) {
  return {
    executablePath: chromeExecutable,
    headless: false,
    locale: "ja-JP",
    args: [
      "--disable-background-networking",
      "--disable-default-apps",
      "--no-first-run",
      "--no-default-browser-check"
    ]
  };
}

async function openLogin(args) {
  const logPath = args["log-path"] || "logs/run_log.txt";
  const userDataDir = args["user-data-dir"] || "data/playwright-profile/monex-login-profile";
  const loginUrl = args["login-url"] || "https://www.monex.co.jp/";
  const chromeExecutable = args["chrome-executable"];
  const { chromium } = getPlaywright(logPath);

  ensureDirectory(userDataDir);
  writeRunLog(logPath, `Playwright専用ログインプロファイルChrome起動 mode=login userDataDir=${userDataDir}`);

  const context = await chromium.launchPersistentContext(userDataDir, launchOptions(chromeExecutable));
  const page = context.pages()[0] || await context.newPage();
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  writeRunLog(logPath, `マネックスログインページ表示 url=${loginUrl}`);
  writeRunLog(logPath, "手動ログイン待機中 note=ログイン後にChromeウィンドウを閉じるとプロファイルへ保存されます");

  await new Promise((resolve) => {
    context.on("close", resolve);
  });

  writeRunLog(logPath, "Playwright専用ログインプロファイルChrome終了 note=次回取得で同じプロファイルを使用します");
}

async function fetchTarget(args) {
  const logPath = args["log-path"] || "logs/run_log.txt";
  const bcode = args.bcode || "4063";
  const userDataDir = args["user-data-dir"] || "data/playwright-profile/monex-login-profile";
  const url = args.url || `https://monex.ifis.co.jp/index.php?sa=report_zaimu&bcode=${bcode}`;
  const chromeExecutable = args["chrome-executable"];
  const rawDir = args["raw-dir"] || "data/raw";
  const htmlPath = path.join(rawDir, `${bcode}.html`);
  const textPath = path.join(rawDir, `${bcode}.txt`);
  const { chromium } = getPlaywright(logPath);

  ensureDirectory(rawDir);
  ensureDirectory(userDataDir);

  writeRunLog(logPath, `Playwright専用プロファイル取得開始 bcode=${bcode} url=${url} userDataDir=${userDataDir}`);
  const context = await chromium.launchPersistentContext(userDataDir, launchOptions(chromeExecutable));

  try {
    const page = context.pages()[0] || await context.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    const status = response ? response.status() : "unknown";
    writeRunLog(logPath, `URLアクセス成功 status=${status} bcode=${bcode} via=playwright-dedicated-profile`);

    try {
      await page.waitForLoadState("networkidle", { timeout: 10000 });
    } catch (_) {
      writeRunLog(logPath, `networkidle待機タイムアウト bcode=${bcode} note=HTML保存を継続`);
    }

    const html = await page.content();
    fs.writeFileSync(htmlPath, html, "utf8");
    writeRunLog(logPath, `HTML取得成功 path=${htmlPath} bytes=${Buffer.byteLength(html, "utf8")} via=playwright-dedicated-profile`);

    const text = await page.locator("body").innerText({ timeout: 10000 });
    fs.writeFileSync(textPath, text, "utf8");
    writeRunLog(logPath, `本文テキスト取得成功 path=${textPath} chars=${text.length} via=playwright-dedicated-profile`);

    if (text.includes("認証されたユーザのみ")) {
      writeRunLog(logPath, `取得判定失敗 bcode=${bcode} reason=認証されたユーザのみ`);
      process.exitCode = 2;
      return;
    }

    if (text.includes("通期業績推移")) {
      writeRunLog(logPath, `取得判定成功 bcode=${bcode} reason=通期業績推移 found`);
      return;
    }

    writeRunLog(logPath, `取得判定失敗 bcode=${bcode} reason=通期業績推移 not found`);
    process.exitCode = 3;
  } finally {
    await context.close();
    writeRunLog(logPath, `Playwright専用プロファイル取得終了 bcode=${bcode}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "login") {
    await openLogin(args);
    return;
  }
  if (args.mode === "fetch") {
    await fetchTarget(args);
    return;
  }
  throw new Error("--mode must be login or fetch");
}

main().catch((error) => {
  const args = parseArgs(process.argv.slice(2));
  writeRunLog(args["log-path"] || "logs/run_log.txt", `Playwright専用プロファイル処理失敗 error=${error.message}`);
  process.exit(1);
});
