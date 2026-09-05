#!/usr/bin/env node
/**
 * playwright_batch_fetch_financials.js の fetchOne が「一時ファイル → validate → 原子的置換」で
 * last good RAW を保護することの単体テスト。ブラウザ・マネックスには接続しない
 * (Playwright の context/page を偽物に差し替える)。本番 data/raw には触れない(一時ディレクトリ)。
 *
 * 実行: node tests/test_batch_fetch_raw_protection.js
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const batch = require("../scripts/playwright_batch_fetch_financials.js");

const CODE = "5803";
const OTHER = "4062";

function goodText(code, name = "テスト社") {
  const header = `銘柄スカウター\n\n${code} ${name}\n東証プライム\n現在値1,000.0円(09/03 15:30)前日比+1.0\n売上高 営業利益 経常利益 純利益 EPS\n`;
  const rows = Array.from({ length: 10 }, (_, i) => `${2017 + i}/03\t` + Array(9).fill("100").join("\t")).join("\n");
  return header + rows + "\n" + "財務データ等更新日：2026/09/03\n".repeat(120);
}

// 偽 Playwright: goto→status 200、innerText/content が与えた本文を返す
function fakeContext(text, html, status = 200) {
  return {
    newPage: async () => ({
      goto: async () => ({ status: () => status }),
      waitForLoadState: async () => {},
      locator: () => ({ innerText: async () => text }),
      content: async () => html,
      url: () => `https://monex.ifis.co.jp/index.php?sa=report_zaimu&bcode=${CODE}`,
      title: async () => "t",
      isClosed: () => false,
      close: async () => {}
    }),
    pages: () => []
  };
}

function sha(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }

async function run() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "rawprot_"));
  const rawDir = path.join(work, "raw");
  fs.mkdirSync(rawDir);
  const logPath = path.join(work, "log.txt");
  // 共有RAW保存先は本番を汚さない: saveSharedMonexRaw は SHARED_RAW_ROOT(05/../_shared_monex_raw)へ書くため、
  // ここでは成功ケースの銘柄コードに本番に存在しないダミーを使わず、代わりに成功ケースを最後に1回だけ実行して
  // 共有RAWへの副作用を確認後に元へ戻す(下記 restoreShared)。
  const htmlPath = path.join(rawDir, `${CODE}.html`);
  const txtPath = path.join(rawDir, `${CODE}.txt`);
  const goodBody = goodText(CODE, "フジクラ");
  fs.writeFileSync(htmlPath, "<html>" + goodBody + "</html>", "utf8");
  fs.writeFileSync(txtPath, goodBody, "utf8");
  const h0 = { html: sha(htmlPath), txt: sha(txtPath) };

  let pass = 0, fail = 0;
  const check = (cond, name) => { if (cond) { pass++; console.log("PASS:", name); } else { fail++; console.log("FAIL:", name); } };

  const badCases = {
    auth_page: { text: "認証されたユーザのみ\n".repeat(300), html: "<html>認証されたユーザのみ</html>", errType: "auth_error" },
    empty: { text: "", html: "", errType: "financial_markers_not_found" },
    // 財務本文としては成立(指標ラベル・行あり)しているが本文が短すぎる(不完全取得を模擬) → validation_failed
    too_short: { text: `${CODE} フジクラ\n売上高 営業利益 経常利益 純利益 EPS\n2026/03\t` + Array(9).fill("1").join("\t"), html: "<html></html>", errType: "validation_failed" },
    other_code: { text: goodText(OTHER, "イビデン"), html: "<html></html>", errType: "validation_failed" },
    no_financial_rows: { text: `${CODE} フジクラ\n売上高 営業利益 経常利益 EPS 2026/03\n` + "x".repeat(5000), html: "<html></html>", errType: "financial_rows_not_found" },
    http_403: { text: goodBody, html: "<html></html>", status: 403, errType: "http_403" }
  };
  for (const [label, c] of Object.entries(badCases)) {
    const ctx = fakeContext(c.text, c.html, c.status || 200);
    const r = await batch.fetchOne(ctx, CODE, rawDir, logPath, 1, 0, work);
    check(r.fetch_status === "failed", `${label}: fetch_status=failed (got ${r.fetch_status})`);
    check(r.error_type === c.errType, `${label}: error_type=${c.errType} (got ${r.error_type})`);
    check(sha(htmlPath) === h0.html && sha(txtPath) === h0.txt, `${label}: last good RAW hash unchanged`);
    check(!fs.readdirSync(rawDir).some((f) => f.includes(".tmp")), `${label}: no temp files left`);
  }

  // 成功ケース: 新しい正常本文で正本が置き換わる(原子的置換)。共有RAWへの書き込みは本番フォルダなので、
  // 事前に既存 latest.json を退避し、終了後に復元する。
  const sharedDir = path.join(__dirname, "..", "..", "_shared_monex_raw", CODE);
  const backup = fs.existsSync(sharedDir) ? fs.readdirSync(sharedDir).map((f) => [f, fs.readFileSync(path.join(sharedDir, f))]) : null;
  try {
    const newBody = goodText(CODE, "フジクラ") + "\n更新\n";
    const r = await batch.fetchOne(fakeContext(newBody, "<html>new</html>"), CODE, rawDir, logPath, 1, 0, work);
    check(r.fetch_status === "success", "good: fetch_status=success");
    check(fs.readFileSync(txtPath, "utf8") === newBody, "good: txt replaced with new body");
    check(fs.readFileSync(htmlPath, "utf8") === "<html>new</html>", "good: html replaced with new body");
    check(!fs.readdirSync(rawDir).some((f) => f.includes(".tmp")), "good: no temp files left");
    const log = fs.readFileSync(logPath, "utf8");
    check(/raw saved code=5803 .*validated, atomic replace/.test(log), "good: log records validated atomic replace");
    check((log.match(/raw NOT promoted code=5803/g) || []).length === Object.keys(badCases).length - 1, "bad: every rejected attempt logged as NOT promoted (http_403 returns before)");
  } finally {
    if (backup) {
      for (const f of fs.readdirSync(sharedDir)) fs.unlinkSync(path.join(sharedDir, f));
      for (const [f, buf] of backup) fs.writeFileSync(path.join(sharedDir, f), buf);
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n==== raw protection test: PASS=${pass} FAIL=${fail} ====`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
