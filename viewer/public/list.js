"use strict";
(async () => {
  let rows = [];

  async function loadData() {
    const res = await fetch("/api/stocks");
    const data = await res.json();
    rows = data.stocks.map(s => mapRow(s));
    const asOf = rows.length ? (data.stocks[0].fetched_at || "") : "";
    document.getElementById("meta").textContent = asOf ? `データ取得: ${asOf}` : "";
  }

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
    code_source: s.code_source || "", // "manual"=業績データ貼付で追加した銘柄、"09_holding"=09保有経由で追加
  });

  const tbody = document.querySelector("#tbl tbody");
  const q = document.getElementById("q");
  let sortKey = "rank", sortAsc = true;

  function render() {
    const kw = q.value.trim().toLowerCase();
    let view = rows.filter(r => !kw || r.code.toLowerCase().includes(kw) || (r.name || "").toLowerCase().includes(kw));
    view.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv : String(av).localeCompare(String(bv), "ja");
      return sortAsc ? cmp : -cmp;
    });
    tbody.innerHTML = view.map(r => `
      <tr>
        <td>${r.rankLabel}</td>
        <td class="l"><a href="stock.html?code=${encodeURIComponent(r.code)}">${r.code}</a></td>
        <td class="l"><a href="stock.html?code=${encodeURIComponent(r.code)}">${r.name}</a>${r.watch09 ? `<span class="hold-badge ${r.holding ? "hold" : "watch"}">${r.holding ? "保有" : "監視"}</span>` : ""}${r.fallback_used ? `<span class="hold-badge fallback" title="最新取得に失敗し、前回データを表示中">再取得待ち</span>` : ""}${r.code_source === "manual" ? `<span class="hold-badge manual" title="業績データ貼付機能で手動追加した銘柄です">手動</span>` : ""}</td>
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
        <td><button type="button" class="del-btn" data-code="${r.code}" data-name="${(r.name || "").replace(/"/g, "&quot;")}">削除</button></td>
      </tr>`).join("");
    document.getElementById("count").textContent = `${view.length} / ${rows.length} 銘柄`;
  }

  tbody.addEventListener("click", async (e) => {
    const btn = e.target.closest(".del-btn");
    if (!btn) return;
    const code = btn.dataset.code;
    const name = btn.dataset.name || "";
    if (!confirm(`${code} ${name} を一覧・取得データごと削除しますか？\n（取得対象（target_codes.csv）に残っている銘柄は、次回の自動取り込みで再取得され一覧に戻ります）`)) return;
    btn.disabled = true;
    try {
      const res = await fetch("/api/delete-stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadData();
      render();
    } catch (err) {
      alert(`削除に失敗しました: ${err.message}`);
      btn.disabled = false;
    }
  });

  document.querySelectorAll("#tbl th").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.k;
      if (sortKey === k) sortAsc = !sortAsc;
      else { sortKey = k; sortAsc = true; }
      render();
    });
  });
  q.addEventListener("input", render);

  // 貼付パネル(paste.js)が保存完了後に一覧を更新するためのフック
  window.refreshStockList = async () => { await loadData(); render(); };

  await loadData();
  render();
})();
