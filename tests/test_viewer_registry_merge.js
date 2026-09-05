#!/usr/bin/env node
/**
 * viewer/server.js のregistry統合ロジック（mergeRegistryIntoList / computeRegistrySummary）の単体テスト。
 * 実ファイル(data/stock_registry_view.csv等)には一切触れず、合成データのみで検証する。
 * 本番registry・RAWへの書き込みは行わない。
 *
 * 実行: node tests/test_viewer_registry_merge.js
 */
"use strict";
const assert = require("assert");
const { mergeRegistryIntoList, computeRegistrySummary, formatRegistryFields } = require("../viewer/server.js");

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`PASS: ${name}`); }
  catch (e) { fail++; console.log(`FAIL: ${name} -- ${e.message}`); }
}

function regRow(over) {
  return {
    code: "0000", name: "", pinned: "0", effective_update_mode: "inactive", active_projects: "",
    raw_present: "0", raw_path: "", raw_hash: "", last_fetch: "", fetch_status: "", data_as_of: "",
    monex_data_updated_at: "", last_error: "", created_at: "", updated_at: "", ...over,
  };
}
function usageRow(over) {
  return {
    code: "0000", project: "05", active: "1", requested_mode: "daily", last_required: "", reason: "",
    run_id: "", lease_expires_at: "", created_at: "", updated_at: "", ...over,
  };
}

// ── computeRegistrySummary: 固定値を使わず件数を集計する ──────────────
check("summary: counts by effective_update_mode", () => {
  const stocks = [
    regRow({ code: "1", effective_update_mode: "daily", raw_present: "1", pinned: "1" }),
    regRow({ code: "2", effective_update_mode: "daily", raw_present: "1" }),
    regRow({ code: "3", effective_update_mode: "on_demand", raw_present: "0" }),
    regRow({ code: "4", effective_update_mode: "inactive", raw_present: "1" }),
  ];
  const s = computeRegistrySummary(stocks);
  assert.strictEqual(s.total, 4);
  assert.strictEqual(s.daily, 2);
  assert.strictEqual(s.on_demand, 1);
  assert.strictEqual(s.inactive, 1);
  assert.strictEqual(s.raw_present, 3);
  assert.strictEqual(s.pinned, 1);
});

check("summary: empty registry -> all zero (no fixed fallback numbers)", () => {
  const s = computeRegistrySummary([]);
  assert.strictEqual(s.total, 0);
  assert.strictEqual(s.daily, 0);
  assert.strictEqual(s.on_demand, 0);
  assert.strictEqual(s.inactive, 0);
});

// ── mergeRegistryIntoList: codeでJOIN、registry-only銘柄の追加 ──────────
check("merge: existing scored stock gets registry fields attached", () => {
  const list = [{ code: "7203", name: "トヨタ自動車", rank: "1" }];
  const registryStocks = [regRow({ code: "7203", name: "トヨタ自動車", effective_update_mode: "daily", raw_present: "1" })];
  const usagesByCode = new Map([["7203", [usageRow({ code: "7203", project: "05", requested_mode: "daily" })]]]);
  const merged = mergeRegistryIntoList(list, registryStocks, usagesByCode);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].rank, "1"); // 既存スコア情報は保持
  assert.strictEqual(merged[0].effective_update_mode, "daily");
  assert.strictEqual(merged[0].effective_update_mode_label, "毎日");
  assert.strictEqual(merged[0].raw_present, true);
});

check("merge: registry-only stock (not in fundamental_scores) is added as a new row", () => {
  const list = [{ code: "7203", name: "トヨタ自動車", rank: "1" }];
  const registryStocks = [
    regRow({ code: "7203", effective_update_mode: "daily" }),
    regRow({ code: "4275", name: "カーリット", effective_update_mode: "on_demand", raw_present: "1" }),
  ];
  const usagesByCode = new Map([
    ["4275", [usageRow({ code: "4275", project: "104-3", requested_mode: "on_demand", reason: "104-3_auto_fetch" })]],
  ]);
  const merged = mergeRegistryIntoList(list, registryStocks, usagesByCode);
  assert.strictEqual(merged.length, 2);
  const only = merged.find(r => r.code === "4275");
  assert.ok(only, "4275 (registry-only) must appear in merged list");
  assert.strictEqual(only.rank, "");
  assert.strictEqual(only.quality_score, "");
  assert.strictEqual(only.code_source, "registry_only");
  assert.strictEqual(only.effective_update_mode, "on_demand");
  assert.strictEqual(only.active_projects.length, 1);
  assert.strictEqual(only.active_projects[0].project, "104-3");
  assert.strictEqual(only.active_projects[0].group, "104-3");
});

check("merge: alphanumeric code (285A) survives untouched as a string key", () => {
  const list = [{ code: "285A", name: "キオクシアホールディングス", rank: "3" }];
  const registryStocks = [regRow({ code: "285A", effective_update_mode: "daily" })];
  const merged = mergeRegistryIntoList(list, registryStocks, new Map());
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].code, "285A");
  assert.strictEqual(typeof merged[0].code, "string");
});

check("merge: theme-scoped project (111/defense) groups under base project name", () => {
  const list = [];
  const registryStocks = [regRow({ code: "4274", effective_update_mode: "on_demand" })];
  const usagesByCode = new Map([
    ["4274", [usageRow({ code: "4274", project: "111/defense", requested_mode: "on_demand", active: "1" })]],
  ]);
  const merged = mergeRegistryIntoList(list, registryStocks, usagesByCode);
  const row = merged.find(r => r.code === "4274");
  assert.strictEqual(row.active_projects[0].project, "111/defense");
  assert.strictEqual(row.active_projects[0].group, "111");
  // 詳細(usages)側でも元project名がそのまま確認できる
  assert.strictEqual(row.usages[0].project, "111/defense");
});

check("merge: inactive usage history is kept in `usages` but excluded from `active_projects`", () => {
  const list = [];
  const registryStocks = [regRow({ code: "9647", effective_update_mode: "inactive" })];
  const usagesByCode = new Map([
    ["9647", [usageRow({ code: "9647", project: "111/defense", requested_mode: "on_demand", active: "0" })]],
  ]);
  const merged = mergeRegistryIntoList(list, registryStocks, usagesByCode);
  const row = merged.find(r => r.code === "9647");
  assert.strictEqual(row.active_projects.length, 0);
  assert.strictEqual(row.usages.length, 1);
  assert.strictEqual(row.usages[0].active, false);
});

check("merge: 4275 (104-3 real E2E fetch) shows project=104-3, mode=on_demand, matching last_fetch", () => {
  const list = [];
  const registryStocks = [regRow({
    code: "4275", name: "カーリット", effective_update_mode: "on_demand", raw_present: "1",
    last_fetch: "2026-09-05 12:06:33", fetch_status: "success",
  })];
  const usagesByCode = new Map([
    ["4275", [
      usageRow({ code: "4275", project: "104-3", active: "1", requested_mode: "on_demand", reason: "104-3_auto_fetch" }),
      usageRow({ code: "4275", project: "111/defense", active: "0", requested_mode: "on_demand" }),
    ]],
  ]);
  const merged = mergeRegistryIntoList(list, registryStocks, usagesByCode);
  const row = merged.find(r => r.code === "4275");
  assert.ok(row);
  assert.strictEqual(row.effective_update_mode, "on_demand");
  assert.strictEqual(row.registry_last_fetch, "2026-09-05 12:06:33");
  assert.strictEqual(row.registry_fetch_status, "success");
  assert.strictEqual(row.active_projects.length, 1);
  assert.strictEqual(row.active_projects[0].project, "104-3");
  assert.strictEqual(row.usages.length, 2); // 104-3(active) + 111/defense(inactive履歴)も残る
});

check("merge: code not present in registry at all gets safe empty defaults (no crash)", () => {
  const list = [{ code: "9999", name: "未登録テスト", rank: "50" }];
  const merged = mergeRegistryIntoList(list, [], new Map());
  assert.strictEqual(merged[0].registry_present, false);
  assert.strictEqual(merged[0].effective_update_mode_label, "-");
  assert.deepStrictEqual(merged[0].active_projects, []);
});

console.log(`\n==== viewer registry merge test: PASS=${pass} FAIL=${fail} ====`);
process.exit(fail ? 1 : 0);
