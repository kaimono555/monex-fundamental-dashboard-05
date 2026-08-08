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
    quality_rank: s.quality_rank,
    quality_score: Number(s.quality_score) || 0,
    growth: Number(s.growth) || 0,
    profitability: Number(s.profitability) || 0,
    financial: Number(s.financial) || 0,
    roe: s.fundamentals ? s.fundamentals.roe : "",
    equity_ratio: s.fundamentals ? s.fundamentals.equity_ratio : "",
    data_as_of: s.data_as_of || "",
    fetched_at: s.fetched_at || "",
    watch09: !!s.watch09,   // 09の自動決済監視に登録あり
    holding: !!s.holding,   // うち保有中（数量>0）
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
        <td class="l"><a href="stock.html?code=${encodeURIComponent(r.code)}">${r.name}</a>${r.watch09 ? `<span class="hold-badge ${r.holding ? "hold" : "watch"}">${r.holding ? "保有" : "監視"}</span>` : ""}</td>
        <td><span class="rank-${r.quality_rank}">${r.quality_rank}</span></td>
        <td>${r.quality_score}</td>
        <td>${r.growth}</td>
        <td>${r.profitability}</td>
        <td>${r.financial}</td>
        <td>${r.roe !== "" ? r.roe + "%" : "-"}</td>
        <td>${r.equity_ratio !== "" ? r.equity_ratio + "%" : "-"}</td>
        <td class="l">${r.data_as_of}</td>
        <td class="l">${r.fetched_at}</td>
      </tr>`).join("");
    document.getElementById("count").textContent = `${view.length} / ${rows.length} 銘柄`;
  }

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
