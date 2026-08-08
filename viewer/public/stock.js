"use strict";
(async () => {
  const code = new URLSearchParams(location.search).get("code");
  if (!code) { document.getElementById("head").textContent = "コード未指定"; return; }
  const res = await fetch(`/api/stock/${encodeURIComponent(code)}`);
  if (!res.ok) { document.getElementById("head").textContent = `データが見つかりません (${code})`; return; }
  const d = await res.json();

  const C = { c1: "#3B6FC9", c2: "#C4661C", c3: "#1F9E77", c4: "#A054C8" };
  const num = v => (v === "" || v == null) ? null : Number(v);
  const fmt = v => v == null || v === "" || isNaN(v) ? "-" : Number(v).toLocaleString("ja-JP");

  // ---- ヘッダー ----
  const name = (d.fundamentals && d.fundamentals.name) || (d.score && d.score.name) || d.manual_name || "";
  const asOf = d.fundamentals ? d.fundamentals.data_as_of : "";
  document.title = `${code} ${name} | 05 ローカルビューア`;
  document.getElementById("head").innerHTML = `
    <span class="code">${code}</span><span class="name">${name}</span>
    ${asOf ? `<span class="badge">決算期 ${asOf}</span>` : ""}
    ${d.fundamentals && d.fundamentals.fetched_at ? `<span class="badge">取得 ${d.fundamentals.fetched_at}</span>` : ""}
    ${d.manual_updated_at ? `<span class="badge">手動更新 ${d.manual_updated_at}</span>` : ""}`;

  // ---- スコア ----
  const sg = document.getElementById("scoreGrid");
  if (d.score) {
    const s = d.score;
    sg.innerHTML = [
      ["総合ランク", s.quality_rank], ["総合スコア", s.quality_score],
      ["成長性", s.growth], ["収益性", s.profitability], ["財務", s.financial],
      ["順位", s.rank !== "" && s.rank != null ? `${s.rank} 位` : "-"],
    ].map(([k, v]) => `<div class="ind-cell"><span class="k">${k}</span><span class="v">${v !== "" && v != null ? v : "-"}</span></div>`).join("") +
    (s.viewer_computed ? `<div class="muted" style="grid-column:1/-1">※ 手動貼付データからビューアが同一式で再算出した参考値${s.rank !== "" && s.rank != null ? "（順位はパイプライン算出時点のもの）" : "（60銘柄ランキングの順位対象外）"}</div>` : "");
  } else sg.innerHTML = `<span class="muted">スコアなし（業績データのみ。指標を含む銘柄ページ全文を貼付するとスコアが算出されます）</span>`;

  // ---- 通期業績推移（3グラフ常時表示・会社予想は半透明で末尾に表示） ----
  const fin = d.financials || [];
  const finAll = fin.concat((d.forecast || []).map(r => ({ ...r, _forecast: true })));
  const labels = finAll.map(r => r["決算期"]);
  const alpha = hex => hex + "66"; // 予想バーは40%透過
  const barColors = hex => finAll.map(r => r._forecast ? alpha(hex) : hex);
  const commonScales = {
    x: { grid: { display: false }, ticks: { color: "#57606a", maxRotation: 60, minRotation: 45 } },
    y: { grid: { color: "#ecece6" }, ticks: { color: "#57606a", callback: v => v.toLocaleString("ja-JP") } },
  };
  new Chart(document.getElementById("salesChart"), {
    type: "bar",
    data: { labels, datasets: [{
      label: "売上高", data: finAll.map(r => num(r["売上高"])),
      backgroundColor: barColors(C.c1), maxBarThickness: 26, borderRadius: 4, borderSkipped: false,
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: commonScales,
    },
  });
  new Chart(document.getElementById("profitChart"), {
    type: "bar",
    data: { labels, datasets: [
      { label: "営業利益", data: finAll.map(r => num(r["営業利益"])), backgroundColor: barColors(C.c2), maxBarThickness: 12, borderRadius: 4, borderSkipped: false },
      { label: "経常利益", data: finAll.map(r => num(r["経常利益"])), backgroundColor: barColors(C.c3), maxBarThickness: 12, borderRadius: 4, borderSkipped: false },
      { label: "当期利益", data: finAll.map(r => num(r["当期利益"])), backgroundColor: barColors(C.c4), maxBarThickness: 12, borderRadius: 4, borderSkipped: false },
    ]},
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "top", labels: { color: "#1f2328", boxWidth: 12 } } },
      scales: commonScales,
    },
  });
  new Chart(document.getElementById("epsChart"), {
    type: "line",
    data: { labels, datasets: [
      { label: "EPS", data: finAll.map(r => num(r["EPS"])), borderColor: C.c1, backgroundColor: C.c1, borderWidth: 2, pointRadius: 3, tension: 0.2, spanGaps: true },
      { label: "BPS", data: finAll.map(r => num(r["BPS"])), borderColor: C.c3, backgroundColor: C.c3, borderWidth: 2, pointRadius: 3, tension: 0.2, spanGaps: true },
    ]},
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "top", labels: { color: "#1f2328", boxWidth: 12 } } },
      scales: commonScales,
    },
  });

  // ---- 通期業績テーブル（会社予想行は「予」付き決算期のまま末尾に表示） ----
  const finCols = ["決算期", "売上高", "営業利益", "経常利益", "当期利益", "EPS", "BPS"];
  document.getElementById("finTable").innerHTML = tableHtml(finCols, finAll);

  // ---- 四半期業績推移（3か月・累積）: データがある場合のみ表示 ----
  function renderQuarterly(prefix, rows) {
    if (!rows.length) return;
    document.getElementById(`${prefix}Panel`).style.display = "";
    const qLabels = rows.map(r => r["決算期"] + (r["区分"] ? ` ${r["区分"]}` : ""));
    new Chart(document.getElementById(`${prefix}SalesChart`), {
      type: "bar",
      data: { labels: qLabels, datasets: [{
        label: "売上高", data: rows.map(r => num(r["売上高"])),
        backgroundColor: C.c1, maxBarThickness: 26, borderRadius: 4, borderSkipped: false,
      }]},
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: commonScales,
      },
    });
    new Chart(document.getElementById(`${prefix}ProfitChart`), {
      type: "bar",
      data: { labels: qLabels, datasets: [
        { label: "営業利益", data: rows.map(r => num(r["営業利益"])), backgroundColor: C.c2, maxBarThickness: 12, borderRadius: 4, borderSkipped: false },
        { label: "経常利益", data: rows.map(r => num(r["経常利益"])), backgroundColor: C.c3, maxBarThickness: 12, borderRadius: 4, borderSkipped: false },
        { label: "当期利益", data: rows.map(r => num(r["当期利益"])), backgroundColor: C.c4, maxBarThickness: 12, borderRadius: 4, borderSkipped: false },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "top", labels: { color: "#1f2328", boxWidth: 12 } } },
        scales: commonScales,
      },
    });
    document.getElementById(`${prefix}Table`).innerHTML =
      tableHtml(["決算期", "区分", "売上高", "営業利益", "経常利益", "当期利益"], rows);
    document.getElementById(`${prefix}Note`).textContent =
      "※ 自動取得済みの履歴（raw HTML内の詳細テーブル）に、貼付で取り込んだ速報値・四半期を重ねて表示しています";
  }
  renderQuarterly("qtr", d.quarterly || []);
  renderQuarterly("qtrCum", d.quarterly_cum || []);

  // ---- キャッシュフロー ----
  const cf = d.cashflow || [];
  if (cf.length) {
    const cfLabels = cf.map(r => r["決算期"]);
    new Chart(document.getElementById("cfChart"), {
      data: {
        labels: cfLabels,
        datasets: [
          { type: "bar", label: "営業CF", data: cf.map(r => num(r["営業CF"])), backgroundColor: C.c1, maxBarThickness: 14, borderRadius: 4, borderSkipped: false },
          { type: "bar", label: "投資CF", data: cf.map(r => num(r["投資CF"])), backgroundColor: C.c2, maxBarThickness: 14, borderRadius: 4, borderSkipped: false },
          { type: "bar", label: "財務CF", data: cf.map(r => num(r["財務CF"])), backgroundColor: C.c3, maxBarThickness: 14, borderRadius: 4, borderSkipped: false },
          { type: "line", label: "現金同等物", data: cf.map(r => num(r["現金同等物"])), borderColor: C.c4, backgroundColor: C.c4, borderWidth: 2, pointRadius: 3, tension: 0.2 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "top", labels: { color: "#1f2328", boxWidth: 12 } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: "#57606a", maxRotation: 60, minRotation: 45 } },
          y: { grid: { color: "#ecece6" }, ticks: { color: "#57606a", callback: v => v.toLocaleString("ja-JP") } },
        },
      },
    });
    const cfCols = ["決算期", "営業CF", "投資CF", "財務CF", "フリーCF", "現金同等物"];
    document.getElementById("cfTable").innerHTML = tableHtml(cfCols, cf);
  } else {
    document.getElementById("cfChart").closest(".panel").querySelector(".body").innerHTML =
      `<span class="muted">キャッシュフローデータなし</span>`;
    document.getElementById("cfTable").innerHTML = `<span class="muted">データなし</span>`;
  }

  // ---- 指標一覧 ----
  const ind = d.indicators || {};
  const f = d.fundamentals || {};
  const pct = v => (v === "" || v == null) ? "-" : `${v}%`;
  const raw = v => (v === "" || v == null) ? "-" : v;
  const epsF = (d.eps_forecast && d.eps_forecast[0]) || null;
  document.getElementById("indGrid").innerHTML = [
    ["ROE", pct(ind["ROE"] ?? f.roe)], ["ROIC", pct(ind["ROIC"] ?? f.roic)],
    ["PER（予想）", raw(ind["PER予想"])], ["PBR", raw(ind["PBR"])],
    ["自己資本比率", pct(ind["自己資本比率"] ?? f.equity_ratio)],
    ["有利子負債比率", pct(ind["有利子負債比率"] ?? f.interest_bearing_debt_ratio)],
    ["ネットD/Eレシオ", pct(ind["ネットD_Eレシオ"])],
    ["アナリスト評価", raw(f.analyst_rating)],
    ["目標株価乖離", pct(f.target_price_gap)],
    ["進捗率", pct(f.progress_rate)],
    ["売上成長率(3年)", pct(f.sales_growth_3y)], ["売上成長率(5年)", pct(f.sales_growth_5y)],
    ["営業利益成長率(3年)", pct(f.operating_growth_3y)], ["営業利益率(3年平均)", pct(f.operating_margin_3y)],
    ["連続黒字年数", raw(f["黒字継続年数"])], ["連続増配年数", raw(f.dividend_increase_years)],
    ["EPS予想", epsF ? `${epsF["EPS予想"]} 円 (${epsF["決算期"]})` : "-"],
  ].map(([k, v]) => `<div class="ind-cell"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("");

  // ---- 共通: テーブル生成 ----
  function tableHtml(cols, rows) {
    if (!rows.length) return `<span class="muted">データなし</span>`;
    const head = `<tr>${cols.map(c => `<th>${c}</th>`).join("")}</tr>`;
    const body = rows.map(r => `<tr>${cols.map((c, i) => {
      const v = r[c];
      if (i === 0) return `<td>${v ?? ""}</td>`;
      const n = num(v);
      if (n == null || isNaN(n)) return `<td>${v || "-"}</td>`; // 区分など数値でない列はそのまま表示
      return `<td class="${n < 0 ? "neg" : ""}">${fmt(v)}</td>`;
    }).join("")}</tr>`).join("");
    return `<table class="data"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }
})();
