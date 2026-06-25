const fs = require("fs");
const path = require("path");
const { detectAuthErrorPage } = require("./auth_detect");

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

function nowTokyo() {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" });
}

function writeRunLog(logPath, message) {
  ensureDirectory(path.dirname(logPath));
  fs.appendFileSync(logPath, `[${nowTokyo()}] ${message}\n`, "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactForLog(text, maxLength = 500) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}


function evaluateFinancialText(text, html = "") {
  const authError = detectAuthErrorPage(text, html);
  const hasFiscalPeriod = /\d{4}\/\d{2}/.test(text);
  const metricLabels = ["売上高", "営業利益", "経常利益", "当期利益", "EPS"];
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

async function cookieDomains(context) {
  const cookies = await context.cookies();
  return [...new Set(cookies.map((cookie) => cookie.domain).filter(Boolean))].sort();
}

async function pageSnapshot(page) {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 3000 });
  } catch (_) {
    // Continue with current DOM.
  }

  let text = "";
  try {
    text = await page.locator("body").innerText({ timeout: 2000 });
  } catch (_) {
    text = "";
  }

  let html = "";
  try {
    html = await page.content();
  } catch (_) {
    html = "";
  }

  let title = "";
  try {
    title = await page.title();
  } catch (_) {
    title = "";
  }

  return { text, html, title };
}

async function writeDiagnostics(context, page, code, logPath, userDataDir, text, title, result) {
  const domains = await cookieDomains(context);
  writeRunLog(logPath, `login profile check diagnostics code=${code} currentUrl=${page.url()}`);
  writeRunLog(logPath, `login profile check diagnostics code=${code} title=${JSON.stringify(title)}`);
  writeRunLog(logPath, `login profile check diagnostics code=${code} bodyHead500=${JSON.stringify(compactForLog(text, 500))}`);
  writeRunLog(logPath, `login profile check diagnostics code=${code} cookieDomains=${JSON.stringify(domains)}`);
  writeRunLog(logPath, `login profile check diagnostics code=${code} profilePath=${path.resolve(userDataDir)}`);
  writeRunLog(logPath, `login profile check diagnostics code=${code} authMarker=${JSON.stringify(result.authMarker)} hasFiscalPeriod=${result.hasFiscalPeriod} metrics=${result.foundMetricLabels.join("|")} financialRows=${result.financialRowCount}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const code = args.bcode || "7186";
  const loginUrl = args["login-url"] || "https://www.monex.co.jp/";
  const targetUrl = args["target-url"] || `https://monex.ifis.co.jp/index.php?sa=report_zaimu&bcode=${code}`;
  const userDataDir = args["user-data-dir"] || "data/playwright-profile/monex-login-profile";
  const chromeExecutable = args["chrome-executable"];
  const logPath = args["log-path"] || "logs/run_log.txt";
  const resolvedUserDataDir = path.resolve(userDataDir);
  const waitForEnterAndClose = String(args["wait-for-enter-and-close"] || "").toLowerCase() === "true";

  ensureDirectory(userDataDir);

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (error) {
    writeRunLog(logPath, "login profile check failed error=playwright package is not installed");
    throw error;
  }

  writeRunLog(logPath, `login profile check start code=${code} loginUrl=${loginUrl} targetUrl=${targetUrl} userDataDir=${userDataDir} resolvedUserDataDir=${resolvedUserDataDir}`);

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

  context.on("close", () => {
    writeRunLog(logPath, `login profile check browser closed code=${code}`);
  });

  const loginPage = context.pages()[0] || await context.newPage();
  await loginPage.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

  const targetPage = await context.newPage();
  await targetPage.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  writeRunLog(logPath, `login profile check pages opened code=${code} profilePath=${resolvedUserDataDir}`);

  if (waitForEnterAndClose) {
    const reloginTimeoutMs = 5 * 60 * 1000;
    const reloginDeadlineMs = Date.now() + reloginTimeoutMs;
    writeRunLog(logPath, `ユーザーログイン待機中（自動検出モード タイムアウト=${reloginTimeoutMs / 1000}秒）`);
    console.log("=========================================");
    console.log("マネックスのログイン期限が切れています。");
    console.log("");
    console.log("開いたブラウザでマネックスへログインしてください。");
    console.log("銘柄スカウターページが表示されると自動で続行します。");
    console.log(`（最大${reloginTimeoutMs / 60000}分待機）`);
    console.log("=========================================");

    let lastNotReadyLogAt = 0;

    while (Date.now() < reloginDeadlineMs) {
      const pages = context.pages();
      const matchedPages = pages.filter((p) => {
        const url = p.url();
        return url.includes("monex.ifis.co.jp")
          && url.includes("sa=report_zaimu")
          && url.includes(`bcode=${code}`);
      });

      for (const p of matchedPages) {
        const snapshot = await pageSnapshot(p);
        const result = evaluateFinancialText(snapshot.text, snapshot.html);

        if (result.ok) {
          const domains = await cookieDomains(context);
          writeRunLog(logPath, `login profile check success code=${code} currentUrl=${p.url()} cookieDomains=${JSON.stringify(domains)} profilePath=${resolvedUserDataDir}`);
          writeRunLog(logPath, `login profile check success detail code=${code} metrics=${result.foundMetricLabels.join("|")} financialRows=${result.financialRowCount}`);
          writeRunLog(logPath, "ユーザーログイン確認→取得再開");
          try { await context.close(); } catch (_) {}
          await sleep(2000);
          process.exit(0);
        }

        const now = Date.now();
        if (now - lastNotReadyLogAt >= 30000) {
          writeRunLog(logPath, `login profile check not-ready code=${code} auth=${result.hasAuthError} marker=${JSON.stringify(result.authMarker)} hasFiscalPeriod=${result.hasFiscalPeriod} financialRows=${result.financialRowCount}`);
          lastNotReadyLogAt = now;
        }
      }

      await sleep(2000);
    }

    writeRunLog(logPath, `login profile check relogin_timeout code=${code} timeout=${reloginTimeoutMs / 1000}s`);
    try { await context.close(); } catch (_) {}
    await sleep(2000);
    process.exit(3);
  }

  let lastSignature = "";
  while (true) {
    const pages = context.pages();
    const targetPages = pages.filter((page) => {
      const currentUrl = page.url();
      return currentUrl.includes("monex.ifis.co.jp")
        && currentUrl.includes("sa=report_zaimu")
        && currentUrl.includes(`bcode=${code}`);
    });

    for (const page of targetPages) {
      const snapshot = await pageSnapshot(page);
      const result = evaluateFinancialText(snapshot.text, snapshot.html);
      const domains = await cookieDomains(context);
      const signature = [
        page.url(),
        snapshot.title,
        result.ok,
        result.hasAuthError,
        result.financialRowCount,
        domains.join("|"),
        compactForLog(snapshot.text, 160)
      ].join("::");

      if (signature === lastSignature) continue;
      lastSignature = signature;

      if (result.ok) {
        writeRunLog(logPath, `login profile check success code=${code} currentUrl=${page.url()} title=${JSON.stringify(snapshot.title)} cookieDomains=${JSON.stringify(domains)} profilePath=${resolvedUserDataDir}`);
        writeRunLog(logPath, `login profile check success detail code=${code} metrics=${result.foundMetricLabels.join("|")} financialRows=${result.financialRowCount}`);
      } else {
        writeRunLog(logPath, `login profile check not-ready code=${code} auth=${result.hasAuthError} marker=${JSON.stringify(result.authMarker)}`);
        await writeDiagnostics(context, page, code, logPath, userDataDir, snapshot.text, snapshot.title, result);
      }
    }

    await sleep(2000);
  }
}

main().catch((error) => {
  const args = parseArgs(process.argv.slice(2));
  writeRunLog(args["log-path"] || "logs/run_log.txt", `login profile check fatal error=${error.message}`);
  process.exit(1);
});
