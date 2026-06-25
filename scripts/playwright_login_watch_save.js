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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function evaluateSuccess(text) {
  const hasAuthError = text.includes("認証されたユーザのみ");
  const hasFiscalPeriod = text.includes("2007/03") || text.includes("2026/03");
  const metricLabels = ["売上高", "営業利益", "経常利益", "当期利益", "EPS"];
  const foundMetricLabels = metricLabels.filter((label) => text.includes(label));

  return {
    ok: !hasAuthError && hasFiscalPeriod && foundMetricLabels.length > 0,
    hasAuthError,
    hasFiscalPeriod,
    foundMetricLabels
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bcode = args.bcode || "4063";
  const loginUrl = args["login-url"] || "https://www.monex.co.jp/";
  const targetUrl = args["target-url"] || `https://monex.ifis.co.jp/index.php?sa=report_zaimu&bcode=${bcode}`;
  const userDataDir = args["user-data-dir"] || "data/playwright-profile/monex-login-profile";
  const chromeExecutable = args["chrome-executable"];
  const rawDir = args["raw-dir"] || "data/raw";
  const logPath = args["log-path"] || "logs/run_log.txt";
  const htmlPath = path.join(rawDir, `${bcode}.html`);
  const textPath = path.join(rawDir, `${bcode}.txt`);

  ensureDirectory(userDataDir);
  ensureDirectory(rawDir);

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (error) {
    writeRunLog(logPath, "ログイン監視起動失敗 error=playwright package is not installed");
    throw error;
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromeExecutable,
    headless: false,
    locale: "ja-JP",
    args: [
      "--disable-background-networking",
      "--disable-default-apps",
      "--no-first-run",
      "--no-default-browser-check"
    ]
  });

  let saved = false;
  let lastSavedTextHash = "";

  context.on("close", () => {
    writeRunLog(logPath, `ログイン監視Chrome終了 bcode=${bcode} saved=${saved}`);
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  writeRunLog(logPath, `ログイン監視開始 bcode=${bcode} loginUrl=${loginUrl} targetUrl=${targetUrl} mode=single-playwright-process`);
  writeRunLog(logPath, "手動操作待機 note=同じChromeでログイン後に4063財務ページへ移動してください");

  while (true) {
    const pages = context.pages();
    for (const candidate of pages) {
      let currentUrl = "";
      try {
        currentUrl = candidate.url();
      } catch (_) {
        continue;
      }

      const isTargetPage = currentUrl.includes("monex.ifis.co.jp")
        && currentUrl.includes("sa=report_zaimu")
        && currentUrl.includes(`bcode=${bcode}`);

      if (!isTargetPage) {
        continue;
      }

      try {
        await candidate.waitForLoadState("domcontentloaded", { timeout: 5000 });
      } catch (_) {
        // Continue with the current DOM state.
      }

      let text = "";
      try {
        text = await candidate.locator("body").innerText({ timeout: 5000 });
      } catch (_) {
        text = "";
      }

      const html = await candidate.content();
      const textHash = `${text.length}:${text.slice(0, 200)}:${text.slice(-200)}`;
      if (textHash === lastSavedTextHash) {
        continue;
      }
      lastSavedTextHash = textHash;

      fs.writeFileSync(htmlPath, html, "utf8");
      fs.writeFileSync(textPath, text, "utf8");
      saved = true;

      writeRunLog(logPath, `ログイン済みページ保存 path=${htmlPath} bytes=${Buffer.byteLength(html, "utf8")} textPath=${textPath} chars=${text.length}`);

      const result = evaluateSuccess(text);
      if (result.ok) {
        writeRunLog(logPath, `取得判定成功 bcode=${bcode} reason=auth-error absent, fiscal-period found, metric found metrics=${result.foundMetricLabels.join("|")}`);
      } else if (result.hasAuthError) {
        writeRunLog(logPath, `取得判定失敗 bcode=${bcode} reason=認証されたユーザのみ`);
      } else if (!result.hasFiscalPeriod) {
        writeRunLog(logPath, `取得判定失敗 bcode=${bcode} reason=2007/03 or 2026/03 not found`);
      } else if (result.foundMetricLabels.length === 0) {
        writeRunLog(logPath, `取得判定失敗 bcode=${bcode} reason=financial metric labels not found`);
      } else if (text.includes("通期業績推移")) {
        writeRunLog(logPath, `取得判定保留 bcode=${bcode} reason=通期業績推移 found but full success criteria not satisfied`);
      } else {
        writeRunLog(logPath, `取得判定保留 bcode=${bcode} reason=target page saved but expected marker not found`);
      }

      writeRunLog(logPath, `ログイン監視継続 bcode=${bcode} note=Chromeは自動で閉じません`);
    }

    await sleep(saved ? 10000 : 2000);
  }
}

main().catch((error) => {
  const args = parseArgs(process.argv.slice(2));
  writeRunLog(args["log-path"] || "logs/run_log.txt", `ログイン監視処理失敗 error=${error.message}`);
  process.exit(1);
});
