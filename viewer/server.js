"use strict";
// 05 ローカルビューアサーバー（依存ゼロ・読み取り専用）
// 起動: node viewer/server.js  → http://<このPCのIP>:8055/
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8055;
const HOST = "0.0.0.0";
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); field = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvToObjects(file) {
  if (!fs.existsSync(file)) return null;
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  if (rows.length < 1) return [];
  const header = rows[0];
  return rows.slice(1).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i] !== undefined ? r[i] : ""; });
    return o;
  });
}

function toCsv(header, rows) {
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [header.map(esc).join(",")];
  for (const r of rows) lines.push(header.map(h => esc(r[h])).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// 貼付テキスト解析: 決算期で始まる行を業績データとして取り込む
const FIN_COLS = ["決算期", "売上高", "営業利益", "経常利益", "当期利益", "EPS", "BPS"];
const COL_ALIASES = {
  "売上高": ["売上高", "売上"],
  "営業利益": ["営業利益", "営業益"],
  "経常利益": ["経常利益", "経常益"],
  "当期利益": ["当期利益", "最終益", "純利益", "当期純利益"],
  "EPS": ["EPS", "1株益", "修正1株益", "一株益"],
  "BPS": ["BPS", "1株純資産", "一株純資産"],
};
function normNum(s) {
  const t = String(s ?? "").trim()
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，,]/g, "").replace(/[－―—‐]/g, "-").replace(/円$/, "");
  if (t === "" || t === "-" || t === "--") return "";
  return /^-?\d+(\.\d+)?$/.test(t) ? t : null; // null = 数値でない
}
function parsePastedFinancials(text) {
  const lines = text.split(/\r?\n/);
  let colOrder = FIN_COLS.slice(1); // ヘッダー未検出時の既定順
  for (const line of lines) {
    const cells = line.split(/\t|\s{2,}| /).map(c => c.trim()).filter(Boolean);
    if (!cells.some(c => c.includes("決算期"))) continue;
    const mapped = [];
    for (const c of cells) {
      for (const col of Object.keys(COL_ALIASES)) {
        if (COL_ALIASES[col].some(a => c.replace(/（.*?）|\(.*?\)/g, "") === a)) { mapped.push(col); break; }
      }
    }
    if (mapped.length >= 4) { colOrder = mapped; break; }
  }
  const rows = [];
  for (const line of lines) {
    const cells = (line.includes("\t") ? line.split("\t") : line.trim().split(/\s+/)).map(c => c.trim());
    if (!cells.length || !/^\d{4}\/\d{1,2}/.test(cells[0])) continue;
    const period = cells[0];
    const nums = cells.slice(1).map(normNum).filter(v => v !== null);
    if (!nums.length) continue;
    const row = { "決算期": period };
    colOrder.forEach((col, i) => { row[col] = nums[i] !== undefined ? nums[i] : ""; });
    for (const col of FIN_COLS) if (!(col in row)) row[col] = "";
    rows.push(row);
  }
  return rows;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => { buf += c; if (buf.length > 2 * 1024 * 1024) reject(new Error("payload too large")); });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

async function apiManual(req, res) {
  const body = JSON.parse(await readBody(req) || "{}");
  const code = safeCode(String(body.code || "").trim());
  if (!code) return sendJson(res, 400, { error: "銘柄コードが不正です（英数字1〜6桁）" });
  const rows = parsePastedFinancials(String(body.text || ""));
  if (!rows.length) return sendJson(res, 400, { error: "業績データ行が見つかりません（「2025/03 253,136 ...」のような決算期で始まる行が必要です）" });

  const file = path.join(DATA_DIR, "output", `${code}_financials.csv`);
  const existing = csvToObjects(file) || [];
  const byPeriod = new Map(existing.map(r => [r["決算期"], r]));
  let added = 0, updated = 0;
  for (const r of rows) {
    if (byPeriod.has(r["決算期"])) updated++; else added++;
    byPeriod.set(r["決算期"], r);
  }
  const merged = [...byPeriod.values()].sort((a, b) => String(a["決算期"]).localeCompare(String(b["決算期"])));
  fs.writeFileSync(file, toCsv(FIN_COLS, merged), "utf8");

  const name = String(body.name || "").trim();
  if (name) {
    const namesFile = path.join(DATA_DIR, "manual_names.csv");
    const names = csvToObjects(namesFile) || [];
    const m = new Map(names.map(r => [r.code, r.name]));
    m.set(code, name);
    fs.writeFileSync(namesFile, toCsv(["code", "name"], [...m.entries()].map(([c, n]) => ({ code: c, name: n }))), "utf8");
  }
  sendJson(res, 200, { code, added, updated, total: merged.length, rows });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(body);
}

function safeCode(raw) {
  return /^[0-9A-Za-z]{1,6}$/.test(raw) ? raw : null;
}

function apiStocks(res) {
  const scores = csvToObjects(path.join(DATA_DIR, "fundamental_scores.csv")) || [];
  const funds = csvToObjects(path.join(DATA_DIR, "fundamentals.csv")) || [];
  const fmap = new Map(funds.map(f => [f.code, f]));
  const list = scores.map(s => ({ ...s, fundamentals: fmap.get(s.code) || null }));

  // 手動追加分（financials CSVはあるがスコア一覧に無い銘柄）も一覧に載せる
  const known = new Set(list.map(s => s.code));
  const manualNames = new Map((csvToObjects(path.join(DATA_DIR, "manual_names.csv")) || []).map(r => [r.code, r.name]));
  const outDir = path.join(DATA_DIR, "output");
  if (fs.existsSync(outDir)) {
    for (const f of fs.readdirSync(outDir)) {
      const m = f.match(/^([0-9A-Za-z]{1,6})_financials\.csv$/);
      if (!m || known.has(m[1])) continue;
      list.push({
        rank: "", code: m[1], name: manualNames.get(m[1]) || "(手動追加)",
        quality_rank: "", quality_score: "", growth: "", profitability: "", financial: "",
        data_as_of: "", fetched_at: "", manual: true,
        fundamentals: fmap.get(m[1]) || null,
      });
    }
  }
  sendJson(res, 200, { stocks: list, generated_at: new Date().toISOString() });
}

function apiStock(res, code) {
  const financials = csvToObjects(path.join(DATA_DIR, "output", `${code}_financials.csv`));
  if (!financials) return sendJson(res, 404, { error: `code ${code} not found` });
  const cashflow = csvToObjects(path.join(DATA_DIR, "output_extended", `${code}_cashflow.csv`));
  const indicators = csvToObjects(path.join(DATA_DIR, "output_extended", `${code}_latest_indicators.csv`));
  const epsForecast = csvToObjects(path.join(DATA_DIR, "output_extended", `${code}_eps_forecast.csv`));
  const funds = csvToObjects(path.join(DATA_DIR, "fundamentals.csv")) || [];
  const scores = csvToObjects(path.join(DATA_DIR, "fundamental_scores.csv")) || [];
  const manualNames = new Map((csvToObjects(path.join(DATA_DIR, "manual_names.csv")) || []).map(r => [r.code, r.name]));
  sendJson(res, 200, {
    code,
    manual_name: manualNames.get(code) || null,
    financials,
    cashflow,
    indicators: indicators && indicators[0] ? indicators[0] : null,
    eps_forecast: epsForecast || [],
    fundamentals: funds.find(f => f.code === code) || null,
    score: scores.find(s => s.code === code) || null,
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  try {
    if (u.pathname === "/api/manual" && req.method === "POST") {
      return apiManual(req, res).catch(e => sendJson(res, 500, { error: String(e && e.message || e) }));
    }
    if (u.pathname === "/api/stocks") return apiStocks(res);
    const m = u.pathname.match(/^\/api\/stock\/([^/]+)$/);
    if (m) {
      const code = safeCode(m[1]);
      if (!code) return sendJson(res, 400, { error: "invalid code" });
      return apiStock(res, code);
    }
    return serveStatic(res, decodeURIComponent(u.pathname));
  } catch (e) {
    return sendJson(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  const nets = require("os").networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === "IPv4" && !n.internal) ips.push(n.address);
    }
  }
  console.log(`[viewer] listening on:`);
  console.log(`  http://localhost:${PORT}/`);
  ips.forEach(ip => console.log(`  http://${ip}:${PORT}/  (LAN)`));
});
