"use strict";
(async () => {
  let rows = [];
  let registrySummary = null;
  const expanded = new Set(); // 展開中(管理パネル表示中)のcode

  async function loadData() {
    const res = await fetch("/api/stocks");
    const data = await res.json();
    rows = data.stocks.map(s => mapRow(s));
    registrySummary = data.registry_summary || null;
    const asOf = rows.length ? (data.stocks[0].fetched_at || "") : "";
    document.getElementById("meta").textContent = asOf ? `データ取得: ${asOf}` : "";
    renderSummaryBar();
    populateProjectFilter();
    updateRunButtonLabel();
  }

  const MODE_CLASS = { daily: "daily", on_demand: "on_demand", inactive: "inactive" };

  const mapRow = s => ({
    rank: Number(s.rank) || 9999,
    rankLabel: s.rank !== "" && s.rank != null ? s.rank : "-",
    code: s.code,
    name: s.name,
    current_price: Number(s.current_price) || 0,
    price_as_of: s.price_as_of || "",
    quality_rank: s.quality_rank,
    quality_score: Number(s.quality_score) || 0,
    growth: Number(s.growth) || 0,
    profitability: Number(s.profitability) || 0,
    financial: Number(s.financial) || 0,
    // 2026-08-11 バリュエーション評価追加: total_rank_100/total_score_100は
    // valuation_status=insufficient_dataの場合は空文字（未算出＝「-」表示）。
    total_rank_100: s.total_rank_100 || "",
    total_score_100: s.total_score_100 !== undefined && s.total_score_100 !== "" ? Number(s.total_score_100) : -1,
    total_score_100_label: s.total_score_100 !== undefined && s.total_score_100 !== "" ? s.total_score_100 : "-",
    valuation_score: s.valuation_score !== undefined && s.valuation_score !== "" ? Number(s.valuation_score) : null,
    valuation_status: s.valuation_status || "",
    roe: s.fundamentals ? s.fundamentals.roe : "",
    equity_ratio: s.fundamentals ? s.fundamentals.equity_ratio : "",
    data_as_of: s.data_as_of || "",
    fetched_at: s.fetched_at || "",
    watch09: !!s.watch09,   // 09の自動決済監視に登録あり
    holding: !!s.holding,   // うち保有中（数量>0）
    fallback_used: !!s.fallback_used, // 今回の最新取得に失敗し、前回データを使用中
    code_source: s.code_source || "", // "manual"=業績データ貼付で追加した銘柄、"09_holding"=09保有経由で追加、"registry_only"=registryのみ
    // ── 共通RAW取得センターregistry(2026-09-04〜)由来の管理情報 ─────────
    registry_present: !!s.registry_present,
    pinned: !!s.pinned,
    effective_update_mode: s.effective_update_mode || "",
    effective_update_mode_label: s.effective_update_mode_label || "-",
    raw_present: !!s.raw_present,
    registry_last_fetch: s.registry_last_fetch || "",
    registry_fetch_status: s.registry_fetch_status || "",
    registry_last_error: s.registry_last_error || "",
    active_projects: s.active_projects || [], // [{project,group,mode,mode_label,last_required,reason}]
    usages: s.usages || [],                    // active/inactive両方（履歴確認用）
    // 05銘柄別解析データの状態(2026-09-05): parsed / raw_unparsed / raw_parse_error / raw_missing / ""
    parse_state: s.parse_state || "",
    parse_state_label: s.parse_state_label || "",
    parse_error: s.parse_error || "",
    eff_group: (s.active_projects || []).map(p => p.group).sort().join(","),
  });

  function renderSummaryBar() {
    const el = document.getElementById("registrySummary");
    if (!registrySummary) { el.textContent = ""; return; }
    const s = registrySummary;
    el.innerHTML = `
      <span class="rs-item"><b>${s.total}</b> 全登録</span>
      <span class="rs-item rs-daily"><b>${s.daily}</b> 毎日</span>
      <span class="rs-item rs-on_demand"><b>${s.on_demand}</b> 必要時</span>
      <span class="rs-item rs-inactive"><b>${s.inactive}</b> 停止</span>
      <span class="rs-item"><b>${s.raw_present}</b> RAWあり</span>
      <span class="rs-item"><b>${s.pinned}</b> 固定</span>
      <span class="muted">（共通RAW取得センター registry より集計。fundamental_scores.csv に無い銘柄も含む）</span>`;
  }

  function updateRunButtonLabel() {
    const btn = document.getElementById("runUpdateBtn");
    if (!btn || !registrySummary) return;
    // 旧「60銘柄」の固定表示をやめ、registryのdaily件数（05の日次取得対象の正本）をそのまま表示する。
    btn.textContent = `▶ 毎日更新を実行（${registrySummary.daily}銘柄）`;
  }

  function populateProjectFilter() {
    const sel = document.getElementById("fProject");
    const cur = sel.value;
    const groups = new Set();
    rows.forEach(r => r.active_projects.forEach(p => groups.add(p.group)));
    const preferred = ["05", "111", "109", "104-3"];
    const ordered = [...preferred.filter(g => groups.has(g)), ...[...groups].filter(g => !preferred.includes(g)).sort()];
    sel.innerHTML = `<option value="">Project: 全て</option>` +
      ordered.map(g => `<option value="${g}">${g}</option>`).join("");
    if (ordered.includes(cur)) sel.value = cur;
  }

  const tbody = document.querySelector("#tbl tbody");
  const q = document.getElementById("q");
  const fProject = document.getElementById("fProject");
  const fMode = document.getElementById("fMode");
  const fFetchStatus = document.getElementById("fFetchStatus");
  let sortKey = "rank", sortAsc = true;

  function projectBadgesHtml(r) {
    if (!r.registry_present) return `<span class="muted">-</span>`;
    if (!r.active_projects.length) return `<span class="muted" title="現在どのProjectもこの銘柄を必要としていません（RAW・過去利用履歴は保持）">-</span>`;
    const groups = [...new Set(r.active_projects.map(p => p.group))];
    const badges = groups.map(g => {
      const items = r.active_projects.filter(p => p.group === g);
      const title = items.map(p => `${p.project}: ${p.mode_label}${p.reason ? " (" + p.reason + ")" : ""}`).join(" / ");
      return `<span class="proj-badge proj-${cssSafe(g)}" title="${escAttr(title)}">${g}</span>`;
    }).join(" ");
    const expandBtn = r.usages.length > groups.length || r.usages.some(u => !u.active)
      ? `<button type="button" class="expand-btn" data-code="${r.code}" title="利用履歴の詳細（停止中のProjectも含む）">▾</button>` : "";
    return badges + expandBtn;
  }

  function modeBadgeHtml(r) {
    if (!r.registry_present) return `<span class="muted">-</span>`;
    const cls = MODE_CLASS[r.effective_update_mode] || "";
    return `<span class="mode-badge mode-${cls}">${r.effective_update_mode_label}</span>`;
  }

  function pinCellHtml(r) {
    if (!r.registry_present) return `<span class="muted">-</span>`;
    return `<button type="button" class="pin-btn ${r.pinned ? "pinned" : ""}" data-code="${r.code}" data-pinned="${r.pinned ? "1" : "0"}"
      title="${r.pinned ? "固定を解除する（他Projectの利用状況に応じた通常判定に戻る）" : "常に毎日取得するよう固定する"}">${r.pinned ? "📌" : "☆"}</button>`;
  }

  // 解析CSVが無い銘柄だけ「RAW未取得」「RAW取得済み / 05解析未生成」「05解析エラー」を明示する
  // (解析済みなら通常どおり詳細画面へ遷移できるのでバッジは出さない)
  function parseStateBadgeHtml(r) {
    if (!r.parse_state || r.parse_state === "parsed") return "";
    const cls = { raw_missing: "parse-missing", raw_unparsed: "parse-unparsed", raw_parse_error: "parse-error" }[r.parse_state] || "";
    const title = r.parse_state === "raw_parse_error" && r.parse_error ? escAttr(r.parse_error) : escAttr(r.parse_state_label);
    return `<span class="hold-badge ${cls}" title="${title}">${escHtml(r.parse_state_label)}</span>`;
  }

  function fetchStatusBadgeHtml(r) {
    if (!r.registry_present || !r.registry_fetch_status) return `<span class="muted">-</span>`;
    const ok = r.registry_fetch_status === "success";
    const title = !ok && r.registry_last_error ? escAttr(r.registry_last_error) : "";
    return `<span class="fs-badge ${ok ? "fs-ok" : "fs-err"}" ${title ? `title="${title}"` : ""}>${r.registry_fetch_status}</span>`;
  }

  function detailRowHtml(r) {
    const usageRows = r.usages.length
      ? r.usages.map(u => `
          <tr>
            <td class="l">${u.project}</td>
            <td>${u.active ? `<span class="fs-badge fs-ok">active</span>` : `<span class="muted">inactive</span>`}</td>
            <td>${u.mode_label}</td>
            <td class="l">${u.last_required || "-"}</td>
            <td class="l">${(u.reason || "-")}</td>
            <td>${u.active
              ? `<button type="button" class="mini-btn deactivate-btn" data-code="${r.code}" data-project="${escAttr(u.project)}">この利用を停止</button>`
              : ""}</td>
          </tr>`).join("")
      : `<tr><td colspan="6" class="muted">利用履歴なし</td></tr>`;
    return `
      <tr class="detail-row" data-detail-for="${r.code}">
        <td colspan="20">
          <div class="detail-panel">
            <div class="detail-title">${r.code} ${escHtml(r.name || r.registry_name || "")} の利用状況（registry）</div>
            <table class="detail-tbl">
              <thead><tr><th class="l">Project</th><th>状態</th><th>モード</th><th class="l">最終依頼</th><th class="l">理由</th><th></th></tr></thead>
              <tbody>${usageRows}</tbody>
            </table>
            <p class="muted detail-note">
              「この利用を停止」は、そのProjectの利用状態だけをinactiveにします（他Projectの毎日/必要時設定やRAW本体には影響しません）。
              05の毎日取得を止めたい場合はこの操作では戻らないことがあります（04由来の対象リストで次回日次に再登録されるため）。恒久的に対象から外すには対象リスト側の管理が必要です。
            </p>
            <p class="detail-danger">
              <a href="#" class="danger-link" data-code="${r.code}" data-name="${escAttr(r.name || r.registry_name || "")}">🗑 RAW・キャッシュ・スコア一覧をすべて完全削除する（取得停止ではなく物理削除・元に戻せません）</a>
            </p>
          </div>
        </td>
      </tr>`;
  }

  function cssSafe(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, "_"); }
  function escHtml(s) { return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
  function escAttr(s) { return escHtml(s).replace(/"/g, "&quot;"); }

  function render() {
    const kw = q.value.trim().toLowerCase();
    const pj = fProject.value;
    const md = fMode.value;
    const fs = fFetchStatus.value;
    let view = rows.filter(r => {
      if (kw && !(r.code.toLowerCase().includes(kw) || (r.name || "").toLowerCase().includes(kw))) return false;
      if (pj && !r.active_projects.some(p => p.group === pj)) return false;
      if (md && r.effective_update_mode !== md) return false;
      if (fs === "__none__" && r.registry_fetch_status) return false;
      if (fs && fs !== "__none__" && r.registry_fetch_status !== fs) return false;
      return true;
    });
    view.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv : String(av).localeCompare(String(bv), "ja");
      return sortAsc ? cmp : -cmp;
    });
    tbody.innerHTML = view.map(r => {
      const main = `
      <tr data-code="${r.code}">
        <td>${r.rankLabel}</td>
        <td class="l"><a href="stock.html?code=${encodeURIComponent(r.code)}">${r.code}</a></td>
        <td class="l"><a href="stock.html?code=${encodeURIComponent(r.code)}">${escHtml(r.name || r.registry_name || "")}</a>${r.watch09 ? `<span class="hold-badge ${r.holding ? "hold" : "watch"}">${r.holding ? "保有" : "監視"}</span>` : ""}${r.fallback_used ? `<span class="hold-badge fallback" title="最新取得に失敗し、前回データを表示中">再取得待ち</span>` : ""}${r.code_source === "manual" ? `<span class="hold-badge manual" title="業績データ貼付機能で手動追加した銘柄です">手動</span>` : ""}${r.code_source === "registry_only" ? `<span class="hold-badge registry-only" title="共通RAW取得センター(registry)が管理する銘柄で、05の日次取得・ランキング(fundamental_scores.csv)の対象ではありません">registry</span>` : ""}${parseStateBadgeHtml(r)}</td>
        <td class="l proj-cell">${projectBadgesHtml(r)}</td>
        <td>${modeBadgeHtml(r)}</td>
        <td>${pinCellHtml(r)}</td>
        <td class="l">${r.registry_last_fetch || "-"}</td>
        <td>${fetchStatusBadgeHtml(r)}</td>
        <td><button type="button" class="manage-btn" data-code="${r.code}">⚙ 管理</button></td>
        <td title="${r.price_as_of}">${r.current_price ? r.current_price.toLocaleString("ja-JP") + "円" : "-"}</td>
        <td><span class="rank-${r.total_rank_100}">${r.total_rank_100 || "-"}</span></td>
        <td title="${r.valuation_status ? '内訳: 品質' + r.quality_score + ' + 割安' + (r.valuation_score != null ? r.valuation_score : '-') + '（' + r.valuation_status + '）' : ''}">${r.total_score_100_label}</td>
        <td>${r.growth}</td>
        <td>${r.profitability}</td>
        <td>${r.financial}</td>
        <td title="${r.valuation_status || ''}">${r.valuation_score != null ? r.valuation_score : (r.valuation_status === "insufficient_data" ? "評価不能" : "-")}</td>
        <td>${r.roe !== "" ? r.roe + "%" : "-"}</td>
        <td>${r.equity_ratio !== "" ? r.equity_ratio + "%" : "-"}</td>
        <td class="l">${r.data_as_of}</td>
        <td class="l">${r.fetched_at}</td>
      </tr>`;
      return expanded.has(r.code) ? main + detailRowHtml(r) : main;
    }).join("");
    document.getElementById("count").textContent = `${view.length} / ${rows.length} 銘柄`;
  }

  async function callApi(url, body) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    return d;
  }

  tbody.addEventListener("click", async (e) => {
    const expandBtn = e.target.closest(".expand-btn, .manage-btn");
    if (expandBtn) {
      const code = expandBtn.dataset.code;
      if (expanded.has(code)) expanded.delete(code); else expanded.add(code);
      render();
      return;
    }
    const pinBtn = e.target.closest(".pin-btn");
    if (pinBtn) {
      const code = pinBtn.dataset.code;
      const nextPinned = pinBtn.dataset.pinned !== "1";
      pinBtn.disabled = true;
      try {
        await callApi("/api/registry/pin", { code, pinned: nextPinned });
        await loadData(); render();
      } catch (err) {
        alert(`固定の変更に失敗しました: ${err.message}`);
        pinBtn.disabled = false;
      }
      return;
    }
    const deactivateBtn = e.target.closest(".deactivate-btn");
    if (deactivateBtn) {
      const code = deactivateBtn.dataset.code;
      const project = deactivateBtn.dataset.project;
      if (!confirm(`${code}: Project「${project}」の利用を停止（inactive）にしますか？\n（RAWは削除されません。他Projectの利用状況には影響しません）`)) return;
      deactivateBtn.disabled = true;
      try {
        await callApi("/api/registry/deactivate-usage", { code, project });
        await loadData(); render();
      } catch (err) {
        alert(`停止に失敗しました: ${err.message}`);
        deactivateBtn.disabled = false;
      }
      return;
    }
    const dangerLink = e.target.closest(".danger-link");
    if (dangerLink) {
      e.preventDefault();
      const code = dangerLink.dataset.code;
      const name = dangerLink.dataset.name || "";
      if (!confirm(`【物理削除・元に戻せません】\n${code} ${name} のRAW・キャッシュ・一覧行をすべて削除しますか？\n\nこれは「毎日更新をやめる」操作ではありません。日次から外すだけなら管理パネルの「この利用を停止」を使ってください。\n（取得対象リストに残っている場合は次回の自動取り込みで再取得され一覧に戻ります）`)) return;
      dangerLink.textContent = "削除中...";
      try {
        const res = await fetch("/api/delete-stock", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadData(); render();
      } catch (err) {
        alert(`削除に失敗しました: ${err.message}`);
      }
      return;
    }
  });

  document.querySelectorAll("#tbl th[data-k]").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.k;
      if (sortKey === k) sortAsc = !sortAsc;
      else { sortKey = k; sortAsc = true; }
      render();
    });
  });
  q.addEventListener("input", render);
  fProject.addEventListener("change", render);
  fMode.addEventListener("change", render);
  fFetchStatus.addEventListener("change", render);

  // 貼付パネル(paste.js)が保存完了後に一覧を更新するためのフック
  window.refreshStockList = async () => { await loadData(); render(); };

  await loadData();
  render();
})();
