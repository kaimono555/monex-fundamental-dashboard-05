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

function htmlToText(html) {
  let text = html;
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "\n");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|tr|li|h[1-6]|table|section|article)>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/(\r?\n\s*){2,}/g, "\n");
  return text.trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bcode = args.bcode || "4063";
  const url = args.url || `https://monex.ifis.co.jp/index.php?sa=report_zaimu&bcode=${bcode}`;
  const userDataDir = args["user-data-dir"];
  const profileDirectory = args["profile-directory"] || "Default";
  const chromeExecutable = args["chrome-executable"];
  const rawDir = args["raw-dir"] || "data/raw";
  const logPath = args["log-path"] || "logs/run_log.txt";
  const htmlPath = path.join(rawDir, `${bcode}.html`);
  const textPath = path.join(rawDir, `${bcode}.txt`);

  ensureDirectory(rawDir);

  if (!userDataDir) {
    throw new Error("--user-data-dir is required");
  }
  if (!chromeExecutable) {
    throw new Error("--chrome-executable is required");
  }

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (error) {
    writeRunLog(logPath, `Playwright起動失敗 bcode=${bcode} error=playwright package is not installed`);
    throw error;
  }

  writeRunLog(logPath, `Playwright persistent context起動開始 bcode=${bcode} userDataDir=${userDataDir} profile=${profileDirectory}`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromeExecutable,
    headless: false,
    locale: "ja-JP",
    args: [
      `--profile-directory=${profileDirectory}`,
      "--disable-background-networking",
      "--disable-default-apps",
      "--no-first-run",
      "--no-default-browser-check"
    ]
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    const status = response ? response.status() : "unknown";
    writeRunLog(logPath, `URLアクセス成功 status=${status} bcode=${bcode} via=playwright-persistent`);

    try {
      await page.waitForLoadState("networkidle", { timeout: 10000 });
    } catch (_) {
      writeRunLog(logPath, `networkidle待機タイムアウト bcode=${bcode} note=HTML保存を継続`);
    }

    const html = await page.content();
    fs.writeFileSync(htmlPath, html, "utf8");
    writeRunLog(logPath, `HTML取得成功 path=${htmlPath} bytes=${Buffer.byteLength(html, "utf8")} via=playwright-persistent`);

    let text = "";
    try {
      text = await page.locator("body").innerText({ timeout: 10000 });
    } catch (_) {
      text = htmlToText(html);
    }

    fs.writeFileSync(textPath, text, "utf8");
    writeRunLog(logPath, `本文テキスト取得成功 path=${textPath} chars=${text.length} via=playwright-persistent`);

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
    writeRunLog(logPath, `Playwright persistent context終了 bcode=${bcode}`);
  }
}

main().catch((error) => {
  const args = parseArgs(process.argv.slice(2));
  writeRunLog(args["log-path"] || "logs/run_log.txt", `Playwright取得失敗 error=${error.message}`);
  process.exit(1);
});
