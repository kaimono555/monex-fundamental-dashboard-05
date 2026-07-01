const fs = require("fs");
const path = require("path");
const readline = require("readline");
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

function withTimeout(promise, timeoutMs, label) {
  if (timeoutMs <= 0) {
    return Promise.reject(new Error(`timeout: ${label}`));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout: ${label}`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function formatSeconds(ms, digits = 1) {
  return (ms / 1000).toFixed(digits);
}

function printRed(message) {
  console.log(`\x1b[31m${message}\x1b[0m`);
}

function compactForLog(text, maxLength = 500) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

async function closePageQuietly(page) {
  if (!page) return;
  try {
    if (!page.isClosed()) await page.close();
  } catch (_) {
    // Best-effort cleanup before retrying with a fresh page.
  }
}

async function writeAuthDiagnostics(page, code, logPath, userDataDir, text) {
  let title = "";
  try {
    title = await page.title();
  } catch (_) {
    title = "";
  }

  writeRunLog(logPath, `auth diagnostics code=${code} currentUrl=${page.url()}`);
  writeRunLog(logPath, `auth diagnostics code=${code} title=${JSON.stringify(title)}`);
  writeRunLog(logPath, `auth diagnostics code=${code} bodyHead500=${JSON.stringify(compactForLog(text, 500))}`);
  writeRunLog(logPath, `auth diagnostics code=${code} chromeProfilePath=${path.resolve(userDataDir)}`);
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function writeCsv(filePath, rows) {
  ensureDirectory(path.dirname(filePath));
  const columns = [
    "code",
    "fetched_at",
    "data_as_of",
    "source_update_date",
    "fetch_status",
    "stale_flag",
    "retry_count",
    "error_type",
    "error_message",
    "stop_reason"
  ];
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column])).join(","));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

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

function extractSourceUpdateDate(text) {
  const patterns = [
    /譖ｴ譁ｰ譌･[:・喀s]*([0-9]{4}[\/.-][0-9]{1,2}[\/.-][0-9]{1,2})/,
    /([0-9]{4}[\/.-][0-9]{1,2}[\/.-][0-9]{1,2})\s*譖ｴ譁ｰ/,
    /繝・・繧ｿ譖ｴ譁ｰ[:・喀s]*([0-9]{4}[\/.-][0-9]{1,2}[\/.-][0-9]{1,2})/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].replace(/[.-]/g, "/");
  }
  return "";
}

async function waitForFinancialPage(page, code, logPath, userDataDir, deadlineMs) {
  let best = { text: "", html: "", result: evaluateFinancialText(""), reason: "empty" };

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      return {
        ...best,
        timedOut: true
      };
    }

    try {
      await withTimeout(page.waitForLoadState("domcontentloaded", { timeout: Math.min(3000, remainingMs) }), remainingMs, "waitForLoadState");
    } catch (_) {
      // Continue with current DOM.
    }

    let text = "";
    try {
      const textTimeoutMs = Math.min(1500, Math.max(0, deadlineMs - Date.now()));
      text = await withTimeout(page.locator("body").innerText({ timeout: textTimeoutMs }), textTimeoutMs, "innerText");
    } catch (_) {
      text = "";
    }

    const htmlTimeoutMs = Math.max(0, deadlineMs - Date.now());
    if (htmlTimeoutMs <= 0) {
      return {
        ...best,
        timedOut: true
      };
    }

    let html = "";
    try {
      html = await withTimeout(page.content(), htmlTimeoutMs, "content");
    } catch (error) {
      if (String(error.message || "").startsWith("timeout:")) {
        return {
          ...best,
          timedOut: true
        };
      }
      throw error;
    }

    const result = evaluateFinancialText(text, html);
    best = { text, html, result, reason: `attempt=${attempt}` };

    if (result.hasAuthError) {
      writeRunLog(logPath, `auth/error page detected code=${code} attempt=${attempt} marker=${result.authMarker}`);
      await writeAuthDiagnostics(page, code, logPath, userDataDir, text);
      return best;
    }
    if (result.ok) return best;

    writeRunLog(logPath, `fetch wait code=${code} attempt=${attempt} textChars=${text.length} hasFiscalPeriod=${result.hasFiscalPeriod} metrics=${result.foundMetricLabels.join("|")} financialRows=${result.financialRowCount}`);
    const sleepMs = Math.min(2000, Math.max(0, deadlineMs - Date.now()));
    if (sleepMs <= 0) {
      return {
        ...best,
        timedOut: true
      };
    }
    await sleep(sleepMs);
  }

  return best;
}

async function fetchOne(context, code, rawDir, logPath, maxRetries, retryDelayMs, userDataDir) {
  const url = `https://monex.ifis.co.jp/index.php?sa=report_zaimu&bcode=${code}`;
  const htmlPath = path.join(rawDir, `${code}.html`);
  const textPath = path.join(rawDir, `${code}.txt`);
  let lastErrorType = "fetch_failed";
  let lastErrorMessage = "";
  let retryCount = 0;
  let page = null;
  const deadlineMs = Date.now() + 60000;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    retryCount = attempt - 1;
    if (Date.now() >= deadlineMs) {
      lastErrorType = "timeout_error";
      lastErrorMessage = "銘柄取得タイムアウト 60秒";
      writeRunLog(logPath, `fetch timeout code=${code} attempt=${attempt} message=${lastErrorMessage}`);
      printRed(`[ERROR] code=${code} 60秒以内に取得できませんでした（タイムアウト）。この銘柄をスキップします。`);
      break;
    }
    try {
      page = await context.newPage();
      writeRunLog(logPath, `fetch start code=${code} attempt=${attempt}/${maxRetries} url=${url}`);
      const remainingBeforeGoto = Math.max(1, deadlineMs - Date.now());
      const response = await withTimeout(
        page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.min(45000, remainingBeforeGoto) }),
        remainingBeforeGoto,
        "page.goto"
      );
      const status = response ? response.status() : "unknown";
      writeRunLog(logPath, `fetch response code=${code} status=${status}`);

      if (status === 403 || status === 429) {
        const stopReason = status === 403 ? "403 Forbidden" : "429 Too Many Requests";
        writeRunLog(logPath, `${status}讀懷・竊貞叙蠕怜●豁｢ code=${code}`);
        await closePageQuietly(page);
        page = null;
        return {
          code,
          fetched_at: nowTokyo(),
          data_as_of: "",
          source_update_date: "",
          fetch_status: "failed",
          stale_flag: "true",
          retry_count: retryCount,
          error_type: status === 403 ? "http_403" : "http_429",
          error_message: stopReason,
          stop_reason: stopReason
        };
      }

      const pageData = await waitForFinancialPage(page, code, logPath, userDataDir, deadlineMs);
      if (pageData.timedOut) {
        lastErrorType = "timeout_error";
        lastErrorMessage = "銘柄取得タイムアウト 60秒";
        writeRunLog(logPath, `fetch timeout code=${code} attempt=${attempt} message=${lastErrorMessage}`);
        printRed(`[ERROR] code=${code} 60秒以内に銘柄スカウター財務ページが表示されませんでした（タイムアウト）。この銘柄をスキップします。`);
        break;
      }
      fs.writeFileSync(htmlPath, pageData.html, "utf8");
      fs.writeFileSync(textPath, pageData.text, "utf8");
      writeRunLog(logPath, `raw saved code=${code} html=${htmlPath} text=${textPath} textChars=${pageData.text.length}`);

      const result = pageData.result;
      if (result.ok) {
        writeRunLog(logPath, `fetch success code=${code} metrics=${result.foundMetricLabels.join("|")} financialRows=${result.financialRowCount}`);
        await closePageQuietly(page);
        page = null;
        return {
          code,
          fetched_at: nowTokyo(),
          data_as_of: "",
          source_update_date: extractSourceUpdateDate(pageData.text),
          fetch_status: "success",
          stale_flag: "false",
          retry_count: retryCount,
          error_type: "",
          error_message: "",
          stop_reason: ""
        };
      }

      if (result.hasAuthError) {
        lastErrorType = "auth_error";
        lastErrorMessage = "authentication page detected";
        printRed("マネックス銘柄スカウターの認証が有効ではありません。");
        printRed("Chromeでマネックス本体にログイン後、必ず本体メニューから銘柄スカウターを開き、");
        printRed("銘柄スカウターの画面が正常表示された状態でEnterを押してください。");
      } else if (!result.hasFiscalPeriod) {
        lastErrorType = "financial_markers_not_found";
        lastErrorMessage = "fiscal period not found";
      } else {
        lastErrorType = "financial_rows_not_found";
        lastErrorMessage = `financial rows or metric labels not found rows=${result.financialRowCount} metrics=${result.foundMetricLabels.join("|")}`;
      }
      writeRunLog(logPath, `fetch attempt failed code=${code} attempt=${attempt} type=${lastErrorType} message=${lastErrorMessage}`);
    } catch (error) {
      lastErrorType = "exception";
      lastErrorMessage = error.message;
      writeRunLog(logPath, `fetch exception code=${code} attempt=${attempt} error=${error.message}`);
    }

    await closePageQuietly(page);
    page = null;

    if (lastErrorType === "timeout_error") {
      break;
    }

    if (attempt < maxRetries) {
      if (lastErrorType === "auth_error") {
        writeRunLog(logPath, `auth_error retry code=${code} nextAttempt=${attempt + 1}/${maxRetries}`);
        continue;
      }
      await sleep(retryDelayMs);
    }
  }

  await closePageQuietly(page);

  return {
    code,
    fetched_at: nowTokyo(),
    data_as_of: "",
    source_update_date: "",
    fetch_status: "failed",
    stale_flag: "true",
    retry_count: retryCount,
    error_type: lastErrorType,
    error_message: lastErrorMessage,
    stop_reason: lastErrorType === "auth_error" ? "認証エラー" : (lastErrorType === "timeout_error" ? "timeout_error" : "")
  };
}

// 手動実行モード（[Console]::IsInputRedirected が false）でのみ呼び出される。
// stdinが実コンソールに接続されている場合のみEnter入力が意味を持つため、
// 無人実行モード（stdinリダイレクト）ではこの関数自体を呼び出さない設計とする。
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
      writeRunLog(logPath, `interactive login wait remaining=${remaining}s`);
    }, 30000);

    const timeoutTimer = setTimeout(() => {
      console.log("タイムアウトしました。Enterキーが押されませんでした。");
      finish(false);
    }, timeoutMs);
  });
}

async function waitForChromeProfileRelease(resolvedProfilePath, logPath) {
  const lockPath = path.join(resolvedProfilePath, "lockfile");
  const timeoutMs = 30000;
  const intervalMs = 2000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!fs.existsSync(lockPath)) return;
    let locked = false;
    try {
      const fd = fs.openSync(lockPath, "r+");
      fs.closeSync(fd);
      locked = false;
    } catch (_) {
      locked = true;
    }
    if (!locked) return;
    writeRunLog(logPath, `batch fetch waiting for Chrome profile release profilePath=${resolvedProfilePath}`);
    await sleep(intervalMs);
  }

  writeRunLog(logPath, `relogin_chrome_still_running profilePath=${resolvedProfilePath} timeout=${timeoutMs / 1000}s`);
  throw new Error(`relogin_chrome_still_running: Chrome still using profile after ${timeoutMs / 1000}s`);
}

function isOnExpectedScoutPage(currentUrl, code) {
  return currentUrl.includes("monex.ifis.co.jp")
    && currentUrl.includes("sa=report_zaimu")
    && currentUrl.includes(`bcode=${code}`);
}

// ログイン状態の確認は、実際に取得に使う context で直接該当銘柄ページを開いて行う。
// 別contextで確認してからこのcontextへ引き継ぐ方式は、ブラウザ再起動を挟むとIFIS側の
// 認証が失われることが判明したため使用しない（context closeを伴う再起動をしない）。
// 財務テーブルはJS描画が完了するまで時間がかかることがあるため、fetchOneと同様に
// 数回ポーリングしてから判定する（1回限りの即時判定だと未ログインと誤判定しやすい）。
async function checkLoginReady(context, code, logPath, userDataDir) {
  const url = `https://monex.ifis.co.jp/index.php?sa=report_zaimu&bcode=${code}`;
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    const deadlineMs = Date.now() + 15000;
    let lastText = "";
    let lastResult = evaluateFinancialText("");
    let onExpectedPage = isOnExpectedScoutPage(page.url(), code);

    while (Date.now() < deadlineMs) {
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
      lastText = text;
      lastResult = evaluateFinancialText(text, html);
      onExpectedPage = isOnExpectedScoutPage(page.url(), code);

      if (lastResult.hasAuthError) break;
      if (lastResult.ok && onExpectedPage) break;

      await sleep(1500);
    }

    const ok = lastResult.ok && onExpectedPage;
    if (!ok) {
      writeRunLog(logPath, `login readiness check failed code=${code} currentUrl=${page.url()} onExpectedPage=${onExpectedPage} authMarker=${JSON.stringify(lastResult.authMarker)} hasFiscalPeriod=${lastResult.hasFiscalPeriod} metrics=${lastResult.foundMetricLabels.join("|")} financialRows=${lastResult.financialRowCount}`);
      await writeAuthDiagnostics(page, code, logPath, userDataDir, lastText);
    } else {
      writeRunLog(logPath, `login readiness check ok code=${code} currentUrl=${page.url()}`);
    }
    return ok;
  } finally {
    await closePageQuietly(page);
  }
}

// ログインが有効ならすぐtrueを返す。無効な場合、呼び出し元はallowInteractiveLoginが
// trueのときのみEnter待ちに入り、falseのとき（無人実行）はそのままfalseを返して終了する。
async function ensureLoginReady(context, code, logPath, userDataDir) {
  const ok = await checkLoginReady(context, code, logPath, userDataDir);
  if (!ok) {
    writeRunLog(logPath, `login not ready code=${code} (automated mode, no human wait. run login_monex_profile_05.ps1)`);
  }
  return ok;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const codes = (args.codes || "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
  const userDataDir = args["user-data-dir"] || "data/playwright-profile/monex-login-profile";
  const chromeExecutable = args["chrome-executable"];
  const rawDir = args["raw-dir"] || "data/raw";
  const logPath = args["log-path"] || "logs/run_log.txt";
  const resultsPath = args["results-path"] || "data/fetch_results.csv";
  const maxRetries = Math.max(1, Number.parseInt(args["max-retries"] || "3", 10));
  const retryDelayMs = Math.max(0, Number.parseInt(args["retry-delay-ms"] || "5000", 10));
  const requestDelayMs = Math.max(0, Number.parseInt(args["request-delay-ms"] || "1500", 10));
  // 呼び出し元のfetch_target_financials.ps1が[Console]::IsInputRedirectedで判定した結果を
  // 引き継ぐ。無人実行（stdinリダイレクト）では必ず"false"が渡され、待機は行わない。
  const allowInteractiveLogin = (args["allow-interactive-login"] || "false").toLowerCase() === "true";
  const interactiveLoginTimeoutMs = 300000;
  const resolvedUserDataDir = path.resolve(userDataDir);

  ensureDirectory(userDataDir);
  ensureDirectory(rawDir);
  ensureDirectory(path.dirname(resultsPath));

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (error) {
    writeRunLog(logPath, "fetch failed error=playwright package is not installed");
    throw error;
  }

  writeRunLog(logPath, `batch fetch start count=${codes.length} userDataDir=${userDataDir} resolvedUserDataDir=${resolvedUserDataDir}`);
  await waitForChromeProfileRelease(resolvedUserDataDir, logPath);
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

  const results = [];
  try {
    let loginReady = await ensureLoginReady(context, codes[0], logPath, userDataDir);
    if (!loginReady && allowInteractiveLogin) {
      writeRunLog(logPath, "login not ready; interactive mode (manual run) enabled, opening login page and waiting for Enter");
      const loginPage = context.pages()[0] || (await context.newPage());
      await loginPage.goto("https://www.monex.co.jp/", { waitUntil: "domcontentloaded", timeout: 45000 });
      const confirmed = await waitForEnterWithCountdown(
        [
          "",
          "=========================================",
          "05専用マネックスプロファイルが未ログイン、またはログイン切れです。",
          "右側のブラウザでマネックスにログインしてください。",
          "ログイン完了後、このコンソール画面で Enter を押してください。",
          "========================================="
        ],
        interactiveLoginTimeoutMs,
        logPath
      );
      if (confirmed) {
        loginReady = await ensureLoginReady(context, codes[0], logPath, userDataDir);
      } else {
        writeRunLog(logPath, "interactive login wait timed out, no Enter pressed");
      }
    }
    if (!loginReady) {
      writeRunLog(logPath, "batch fetch aborted: login not ready before start");
      process.exitCode = 3;
      return;
    }

    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
      console.log(`[${i + 1}/${codes.length}] fetch ${code}`);
      let result = await fetchOne(context, code, rawDir, logPath, maxRetries, retryDelayMs, userDataDir);

      if (result.error_type === "auth_error") {
        writeRunLog(logPath, `batch fetch detected auth_error mid-run code=${code}; attempting in-context relogin recovery`);
        const recovered = await ensureLoginReady(context, code, logPath, userDataDir);
        if (recovered) {
          writeRunLog(logPath, `batch fetch relogin recovered code=${code}; retrying fetch`);
          result = await fetchOne(context, code, rawDir, logPath, maxRetries, retryDelayMs, userDataDir);
        }
      }

      results.push(result);
      writeCsv(resultsPath, results);
      if (result.error_type === "auth_error") {
        writeRunLog(logPath, `batch fetch stopped early due to repeated auth_error code=${code}`);
        break;
      }
      if (result.error_type === "timeout_error") {
        writeRunLog(logPath, "銘柄取得タイムアウト→該当銘柄を失敗扱いとして継続");
      }
      if (result.error_type === "http_403") {
        writeRunLog(logPath, "403検出→取得停止");
        break;
      }
      if (result.error_type === "http_429") {
        writeRunLog(logPath, "429検出→取得停止");
        break;
      }
      if (i < codes.length - 1) {
        const processedCount = i + 1;
        if (processedCount % 20 === 0) {
          const breakMs = Math.round(randomBetween(20000, 30000));
          writeRunLog(logPath, `${processedCount}銘柄処理完了`);
          writeRunLog(logPath, `休憩開始: ${Math.round(breakMs / 1000)}秒`);
          await sleep(breakMs);
          writeRunLog(logPath, "休憩終了");
          writeRunLog(logPath, "取得再開");
        } else {
          const waitMs = randomBetween(3000, 5000);
          writeRunLog(logPath, `銘柄間ランダム待機: ${formatSeconds(waitMs)}秒`);
          await sleep(waitMs);
        }
      }
    }
  } finally {
    await context.close();
    writeCsv(resultsPath, results);
    const failures = results.filter((row) => row.fetch_status !== "success").map((row) => row.code);
    writeRunLog(logPath, `batch fetch end count=${codes.length} success=${results.length - failures.length} failures=${failures.join(",")}`);
  }

  if (results.some((row) => row.fetch_status !== "success")) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  const args = parseArgs(process.argv.slice(2));
  writeRunLog(args["log-path"] || "logs/run_log.txt", `batch fetch fatal error=${error.message}`);
  process.exit(1);
});
