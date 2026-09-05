const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn: spawnProcess } = require("child_process");
// 認証判定(auth_detect.js)は monex_raw_validate.js 経由で使う(このファイルでは直接呼ばない)

// 108Phase2-B: 05・104-3が共通で参照するマネックス貼付原文の共有ストア。
// viewer/server.js の saveSharedMonexRaw() と同じ保存先・仕様(1銘柄=最新RAW1件のみ)。
const SHARED_RAW_ROOT = path.join(__dirname, "..", "..", "_shared_monex_raw");

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

// 108Phase2-B: 自動取得成功時の原文を _shared_monex_raw/{code}/ へ保存する。
// viewer/server.js の saveSharedMonexRaw() と同じ仕様。05の既存パーサー・CSV出力には
// 一切関与しない、保存処理のみの追加。失敗しても自動取得自体は継続させる(呼び出し側でtry/catch)。
function saveSharedMonexRaw(code, name, text) {
  const dir = path.join(SHARED_RAW_ROOT, code);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  for (const f of fs.readdirSync(dir)) {
    if (/^\d[0-9A-Za-z]*_\d{8}_\d{6}\.txt$/.test(f)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* 削除失敗は無視して続行 */ }
    }
  }

  const capturedAt = nowTokyo();
  const fileStamp = capturedAt.replace(/[-:]/g, "").replace(" ", "_");
  const rawFile = `${code}_${fileStamp}.txt`;
  fs.writeFileSync(path.join(dir, rawFile), text, "utf8");

  const priceMatch = text.match(/現在値\s*[\-0-9.,]+\s*円\(([^)]+)\)/);
  const monexDataUpdatedAt = priceMatch ? priceMatch[1].trim() : null;
  const rawTextHash = "sha256:" + crypto.createHash("sha256").update(text, "utf8").digest("hex");

  const latest = {
    stock_code: code,
    stock_name: name || "",
    source: "monex_stock_scout",
    captured_at: capturedAt,
    monex_data_updated_at: monexDataUpdatedAt,
    raw_text_file: rawFile,
    raw_text_hash: rawTextHash,
  };
  fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(latest, null, 2), "utf8");
  return latest;
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

// 2026-09-04: 成功判定(evaluateFinancialText)と正本昇格ゲート(validateRawText)は monex_raw_validate.js へ移設
// (判定内容は不変)。request_monex_raw.py 側の validate_monex_raw.js も同じモジュールを使う(別実装しない)。
const { evaluateFinancialText, validateRawText, DEFAULT_MIN_CHARS } = require("./monex_raw_validate");

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
      // 2026-09-04 last good RAW 保護: 取得本文はまず一時ファイル(同一ディレクトリ・.tmp{pid})へ書き、
      // validateRawText(認証エラー無し・財務マーカー・銘柄コード一致・本文長)を通過したときだけ
      // 正本 data/raw/{code}.html|.txt へ原子的に置換(rename)する。不合格なら一時ファイルは作らず、
      // 既存の正常RAW・_shared_monex_raw は一切触らない(日次・on-demand 共通)。
      const tmpHtmlPath = `${htmlPath}.tmp${process.pid}`;
      const tmpTextPath = `${textPath}.tmp${process.pid}`;
      const validation = validateRawText(code, pageData.text, pageData.html, DEFAULT_MIN_CHARS);
      const result = pageData.result;
      if (validation.ok) {
        ensureDirectory(path.dirname(htmlPath));
        fs.writeFileSync(tmpHtmlPath, pageData.html, "utf8");
        fs.writeFileSync(tmpTextPath, pageData.text, "utf8");
        fs.renameSync(tmpHtmlPath, htmlPath);
        fs.renameSync(tmpTextPath, textPath);
        writeRunLog(logPath, `raw saved code=${code} html=${htmlPath} text=${textPath} textChars=${pageData.text.length} (validated, atomic replace)`);
        writeRunLog(logPath, `fetch success code=${code} metrics=${result.foundMetricLabels.join("|")} financialRows=${result.financialRowCount}`);
        try {
          saveSharedMonexRaw(code, "", pageData.text);
        } catch (e) {
          writeRunLog(logPath, `[shared_monex_raw] save failed code=${code} error=${e && e.message || e}`);
        }
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

      writeRunLog(logPath, `raw NOT promoted code=${code} attempt=${attempt} reason=${validation.reason} textChars=${pageData.text.length} (last good RAW kept)`);
      if (result.hasAuthError) {
        lastErrorType = "auth_error";
        lastErrorMessage = "authentication page detected";
        printRed("マネックス銘柄スカウターの認証が有効ではありません。");
        printRed("Chromeでマネックス本体にログイン後、必ず本体メニューから銘柄スカウターを開き、");
        printRed("銘柄スカウターの画面が正常表示された状態にしてください。");
      } else if (!result.hasFiscalPeriod) {
        lastErrorType = "financial_markers_not_found";
        lastErrorMessage = "fiscal period not found";
      } else if (!result.ok) {
        lastErrorType = "financial_rows_not_found";
        lastErrorMessage = `financial rows or metric labels not found rows=${result.financialRowCount} metrics=${result.foundMetricLabels.join("|")}`;
      } else {
        // 財務本文としては成立しているが、銘柄コード不一致 or 本文が短すぎる(別銘柄ページ・不完全取得)
        lastErrorType = "validation_failed";
        lastErrorMessage = validation.reason;
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
// process.stdin / readline によるEnter入力待ちは、update_all_05.ps1 → run_project.ps1 →
// fetch_target_financials.ps1 → node という多段subprocessではEnterがnodeに届かず、
// タイムアウトまで無駄に待ってしまうため使用しない（2026-07判明・修正）。
// 代わりに、対象の銘柄スカウター財務ページのタブを1つ開いた上で、毎回 context.pages() を
// 全走査し、bcode一致するタブすべてを確認する（固定タブ1つだけを見ていると、人間が
// ログイン後に別タブ・新規タブで財務ページを開いた場合や、認証エラー状態のまま残っている
// 開始時タブをF5し忘れた場合に、成功タブを見逃してタイムアウトする問題があったため
// 2026-07に全タブスキャン方式へ修正）。
async function waitForInteractiveLogin(context, code, logPath, timeoutMs) {
  const targetUrl = `https://monex.ifis.co.jp/index.php?sa=report_zaimu&bcode=${code}`;
  const openedPage = await context.newPage();
  await openedPage.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

  const deadlineMs = Date.now() + timeoutMs;
  let lastStatusLogAt = Date.now();
  let success = false;

  while (Date.now() < deadlineMs) {
    const candidatePages = context.pages().filter((page) => isOnExpectedScoutPage(page.url(), code));

    for (const page of candidatePages) {
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: 2000 });
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

      const { ready } = isFinancialScoutPageReady(text, html);
      if (ready) {
        writeRunLog(logPath, `interactive login detected success code=${code} currentUrl=${page.url()}`);
        success = true;
        break;
      }
    }

    if (success) break;

    const now = Date.now();
    if (now - lastStatusLogAt >= 30000) {
      const remainingSec = Math.round((deadlineMs - now) / 1000);
      writeRunLog(logPath, `interactive login waiting code=${code} remaining=${remainingSec}s candidateTabs=${candidatePages.length} totalTabs=${context.pages().length}`);
      console.log(`ログイン完了待機中... 残り ${remainingSec} 秒`);
      lastStatusLogAt = now;
    }

    await sleep(2000);
  }

  if (!success) {
    writeRunLog(logPath, `interactive login wait timed out code=${code} timeout=${Math.round(timeoutMs / 1000)}s totalTabs=${context.pages().length}`);
    console.log("タイムアウトしました。ログイン完了を検出できませんでした。");
  }

  await closePageQuietly(openedPage);
  return success;
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

// 2026-08-15追加: ブラウザを閉じずに使い回す。
// 正常終了(context.close())でブラウザを閉じると、マネックス側のセッションCookie
// (PHPSESSID等、非永続Cookie)が次回起動時に復元されず再ログインが必要になる事象が
// 実機で確認されたため、既存プロファイルはこの回避策を導入する。
// 1) 既にこのポートでChromeが起動中(=前回以前から開きっぱなし)なら、CDP接続して使い回す。
// 2) 起動していなければ、detached(このNodeプロセス終了後も生き続ける)なChromeプロセスを
//    新規起動してCDP接続する。launchPersistentContext()は使わない(Playwrightが管理する
//    子プロセスは起動元のNodeプロセス終了時に一緒に終了してしまい、開きっぱなしを維持できない)。
const CDP_PORT = 9222;

async function isCdpReachable(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch (_) {
    return false;
  }
}

async function getOrCreateContext(chromium, userDataDir, chromeExecutable, logPath) {
  if (await isCdpReachable(CDP_PORT)) {
    writeRunLog(logPath, `既存ブラウザに接続します(開いたまま維持されていたブラウザを再利用) cdpPort=${CDP_PORT}`);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const context = browser.contexts()[0] || (await browser.newContext());
    return { browser, context, launchedFresh: false };
  }

  const resolvedUserDataDir = path.resolve(userDataDir);
  await waitForChromeProfileRelease(resolvedUserDataDir, logPath);

  writeRunLog(logPath, `既存ブラウザが見つからないため新規起動します(今回から開いたままにする) cdpPort=${CDP_PORT}`);
  const execPath = chromeExecutable || chromium.executablePath();
  const child = spawnProcess(execPath, [
    `--user-data-dir=${resolvedUserDataDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "--disable-background-networking",
    "--disable-default-apps",
    "--no-first-run",
    "--no-default-browser-check",
    "--lang=ja-JP",
    "about:blank"
  ], { detached: true, stdio: "ignore" });
  child.unref();

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await isCdpReachable(CDP_PORT)) break;
    await sleep(300);
  }
  if (!(await isCdpReachable(CDP_PORT))) {
    throw new Error("新規Chromeプロセスの起動後もCDPエンドポイントに接続できませんでした。");
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0] || (await browser.newContext());
  return { browser, context, launchedFresh: true };
}

function isOnExpectedScoutPage(currentUrl, code) {
  let parsed;
  try {
    parsed = new URL(currentUrl);
  } catch (_) {
    return false;
  }
  if (parsed.hostname !== "monex.ifis.co.jp") return false;
  if (parsed.pathname !== "/index.php") return false;

  const params = parsed.searchParams;
  const sa = params.get("sa");
  const codeStr = String(code);

  // 財務ページ（表内タブ）
  if (sa === "report_zaimu" && params.get("bcode") === codeStr) return true;
  // 銘柄スカウター検索結果ページ（ログイン直後にここへ着地するケースがある）
  if (sa === "find" && params.get("ta") === "n" && params.get("wd") === codeStr) return true;

  return false;
}

// ログイン済み・銘柄スカウター表示済みの判定専用の追加キーワード。
// evaluateFinancialText の ok 判定（財務テーブル行の存在）はfetchOneの取得成功判定に
// そのまま使うため変更しない。sa=find検索結果ページ等、テーブル行が揃う前でも
// 「ログインは完了し銘柄スカウターが表示されている」と分かる状態を拾うための緩い判定。
const SCOUT_PAGE_READY_MARKERS = [
  "PER", "PBR", "ROE", "ROA", "予想経常利益", "財務データ", "財務データ等更新日", "業績", "経常利益"
];

function isFinancialScoutPageReady(text, html = "") {
  const result = evaluateFinancialText(text, html);
  if (result.hasAuthError) return { ready: false, result };
  const ready = result.ok || SCOUT_PAGE_READY_MARKERS.some((marker) => text.includes(marker));
  return { ready, result };
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
    let lastReady = false;
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
      const scoutPageReady = isFinancialScoutPageReady(text, html);
      lastResult = scoutPageReady.result;
      lastReady = scoutPageReady.ready;
      onExpectedPage = isOnExpectedScoutPage(page.url(), code);

      if (lastResult.hasAuthError) break;
      if (lastReady && onExpectedPage) break;

      await sleep(1500);
    }

    const ok = lastReady && onExpectedPage;
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
  const { browser, context, launchedFresh } = await getOrCreateContext(chromium, userDataDir, chromeExecutable, logPath);
  writeRunLog(logPath, `context ready launchedFresh=${launchedFresh}`);

  const results = [];
  try {
    let loginReady = await ensureLoginReady(context, codes[0], logPath, userDataDir);
    if (!loginReady && allowInteractiveLogin) {
      writeRunLog(logPath, "login not ready; interactive mode (manual run) enabled, opening login page and polling for manual login completion");
      const loginPage = context.pages()[0] || (await context.newPage());
      await loginPage.goto("https://www.monex.co.jp/", { waitUntil: "domcontentloaded", timeout: 45000 });
      console.log("");
      console.log("=========================================");
      console.log("05専用マネックスプロファイルが未ログイン、またはログイン切れです。");
      console.log("開いたChromeでマネックスにログイン後、銘柄スカウターの財務ページ（表示中のタブでも新しいタブでも可）が");
      console.log("表示される状態にしてください。Enterキーの入力は不要です。ログインを自動検出します。");
      console.log("=========================================");
      loginReady = await waitForInteractiveLogin(context, codes[0], logPath, interactiveLoginTimeoutMs);
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
          const breakMs = Math.round(randomBetween(10000, 15000));
          writeRunLog(logPath, `${processedCount}銘柄処理完了`);
          writeRunLog(logPath, `休憩開始: ${Math.round(breakMs / 1000)}秒`);
          await sleep(breakMs);
          writeRunLog(logPath, "休憩終了");
          writeRunLog(logPath, "取得再開");
        } else {
          const waitMs = randomBetween(1500, 2500);
          writeRunLog(logPath, `銘柄間ランダム待機: ${formatSeconds(waitMs)}秒`);
          await sleep(waitMs);
        }
      }
    }
  } finally {
    // 2026-08-15追加: ブラウザは閉じない(開いたまま維持する)。閉じるとマネックス側の
    // セッションCookieが次回起動時に復元されない事象が確認されたため。
    writeRunLog(logPath, "batch fetch: ブラウザは閉じずに開いたままにします");
    writeCsv(resultsPath, results);
    const failures = results.filter((row) => row.fetch_status !== "success").map((row) => row.code);
    writeRunLog(logPath, `batch fetch end count=${codes.length} success=${results.length - failures.length} failures=${failures.join(",")}`);
    // 2026-08-17追加: connectOverCDP()の接続を保持したままだとCDPのWebSocketが
    // Nodeのイベントループを生存させ、取得成功時にプロセスが終了しない
    // (親のPowerShellが待ち続け、generate以降が実行されない)。
    // browser.close()は外部起動(detached)ChromeへのCDP接続では「切断」のみで、
    // Chrome本体(CDP:9222)とログイン状態はそのまま残る。
    try {
      await browser.close();
      writeRunLog(logPath, "batch fetch: CDP接続を切断しました(Chrome本体は開いたまま維持)");
    } catch (error) {
      writeRunLog(logPath, `batch fetch: CDP切断でエラー error=${error.message}`);
    }
  }

  if (results.some((row) => row.fetch_status !== "success")) {
    process.exitCode = 2;
  }
}

// 2026-09-04 共通RAW取得センター化: 他スクリプト(validate_monex_raw.js /
// playwright_fetch_monex_topix_news.js)が同じ判定・同じブラウザ接続処理を再利用できるよう
// 関数をexportする。CLIとして直接実行された場合のみ main() を走らせる(挙動は従来どおり)。
// 認証判定・取得ロジックを別ファイルへコピーして二重実装しないための最小リファクタ。
module.exports = {
  evaluateFinancialText,
  validateRawText,
  fetchOne,
  extractSourceUpdateDate,
  isOnExpectedScoutPage,
  isFinancialScoutPageReady,
  getOrCreateContext,
  checkLoginReady,
  waitForChromeProfileRelease,
  isCdpReachable,
  closePageQuietly,
  writeRunLog,
  nowTokyo,
  saveSharedMonexRaw,
  CDP_PORT
};

if (require.main === module) {
  main().catch((error) => {
    const args = parseArgs(process.argv.slice(2));
    writeRunLog(args["log-path"] || "logs/run_log.txt", `batch fetch fatal error=${error.message}`);
    process.exit(1);
  });
}
