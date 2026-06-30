const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { detectAuthErrorPage } = require("./auth_detect");

// 05専用Chromeプロファイル（monex-login-profile）への手動ログイン更新専用スクリプト。
// 自動実行モード（playwright_batch_fetch_financials.js）からは呼び出されない。
// 必ず人間が直接実行し、stdinがリダイレクトされていない通常コンソールで使う。

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

// ターミナルに進捗を一定間隔で表示しながらEnterキー入力を待つ。
// 本スクリプトは常に人間が直接実行する想定のため、Enter待ちはここでのみ行う。
function waitForEnterWithCountdown(promptLines, timeoutMs, logPath) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let finished = false;
    const deadline = Date.now() + timeoutMs;

    const finish = (confirmed) => {
      if (finished) return;
      finished = true;
      clearInterval(statusTimer);
      clearTimeout(timeoutTimer);
      rl.close();
      resolve(confirmed);
    };

    promptLines.forEach((line) => console.log(line));

    rl.question("", () => finish(true));

    const statusTimer = setInterval(() => {
      const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      console.log(`ログイン完了待機中... 残り ${remaining} 秒`);
      writeRunLog(logPath, `manual login wait remaining=${remaining}s`);
    }, 30000);

    const timeoutTimer = setTimeout(() => {
      console.log("タイムアウトしました。Enterキーが押されませんでした。");
      finish(false);
    }, timeoutMs);
  });
}

async function verifyLogin(context, checkCode, logPath) {
  const url = `https://monex.ifis.co.jp/index.php?sa=report_zaimu&bcode=${checkCode}`;
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(2000);
    let text = "";
    let html = "";
    try {
      text = await page.locator("body").innerText({ timeout: 5000 });
    } catch (_) {
      text = "";
    }
    try {
      html = await page.content();
    } catch (_) {
      html = "";
    }
    const authResult = detectAuthErrorPage(text, html);
    const ok = !authResult.detected;
    writeRunLog(logPath, `manual login verify code=${checkCode} ok=${ok} authMarker=${authResult.marker}`);
    return ok;
  } catch (error) {
    writeRunLog(logPath, `manual login verify error code=${checkCode} error=${error.message}`);
    return false;
  } finally {
    try {
      if (!page.isClosed()) await page.close();
    } catch (_) {
      // best-effort cleanup
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userDataDir = args["user-data-dir"] || "data/playwright-profile/monex-login-profile";
  const chromeExecutable = args["chrome-executable"];
  const logPath = args["log-path"] || "logs/run_log.txt";
  const checkCode = args["check-code"] || "6871";
  const timeoutMs = Math.max(30000, Number.parseInt(args["timeout-ms"] || "600000", 10));

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (error) {
    console.error("playwrightパッケージがインストールされていません。");
    writeRunLog(logPath, "manual login failed error=playwright package is not installed");
    process.exitCode = 1;
    return;
  }

  ensureDirectory(userDataDir);
  writeRunLog(logPath, `manual login start userDataDir=${userDataDir}`);

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

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto("https://www.monex.co.jp/", { waitUntil: "domcontentloaded", timeout: 45000 });

    const confirmed = await waitForEnterWithCountdown(
      [
        "",
        "=========================================",
        "05専用Chromeでマネックスを開きました。",
        "右側のブラウザでマネックスにログインしてください。",
        "ログイン完了後、このPowerShell画面で Enter を押してください。",
        "Enter後、Chromeを閉じてログイン状態を保存します。",
        "========================================="
      ],
      timeoutMs,
      logPath
    );

    if (!confirmed) {
      writeRunLog(logPath, "manual login timeout, no Enter pressed");
      console.log("Enterが押されなかったため、ログイン更新を中止します。");
      process.exitCode = 1;
      return;
    }

    console.log("");
    console.log("ログイン状態を確認しています...");
    const ok = await verifyLogin(context, checkCode, logPath);
    if (ok) {
      console.log(`ログイン状態を確認できました（銘柄コード${checkCode}の財務ページが正常に表示されました）。`);
    } else {
      console.log("警告: ログイン状態を確認できませんでした。マネックス本体メニューから銘柄スカウターを開き、");
      console.log("      財務ページが正常に表示される状態にしてから、本スクリプトを再実行してください。");
      process.exitCode = 2;
    }
  } finally {
    await context.close();
    writeRunLog(logPath, "manual login profile chrome closed");
    console.log("");
    console.log("Chromeを閉じました。ログイン状態は05専用プロファイルに保存されました。");
  }
}

main().catch((error) => {
  const args = parseArgs(process.argv.slice(2));
  writeRunLog(args["log-path"] || "logs/run_log.txt", `manual login fatal error=${error.message}`);
  console.error(`ログイン更新処理に失敗しました: ${error.message}`);
  process.exit(1);
});
