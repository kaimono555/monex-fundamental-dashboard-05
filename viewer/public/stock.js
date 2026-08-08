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

  // ---- 通期業績テーブル（本家同様に前期比%列付き。会社予想行は「予」付きで末尾に表示） ----
  (function renderFinTable() {
    if (!finAll.length) { document.getElementById("finTable").innerHTML = `<span class="muted">データなし</span>`; return; }
    const pctCols = ["売上高", "営業利益", "経常利益", "当期利益"];
    // 本家スカウターと同じ「|前期|を分母」方式（赤字→黒字の213.5%等も一致する）
    const pct = (cur, prev) => {
      const c = num(cur), p = num(prev);
      if (c == null || p == null || isNaN(c) || isNaN(p) || p === 0) return "";
      return (((c - p) / Math.abs(p)) * 100).toFixed(1) + "%";
    };
    const head = "<tr><th>決算期</th>" +
      pctCols.map(c => `<th>${c}</th><th class="pct">(前期比)</th>`).join("") +
      "<th>EPS</th><th>BPS</th></tr>";
    const body = finAll.map((r, i) => {
      const prev = i > 0 ? finAll[i - 1] : null;
      let cells = `<td>${r["決算期"]}</td>`;
      for (const c of pctCols) {
        const n = num(r[c]);
        cells += `<td class="${n != null && n < 0 ? "neg" : ""}">${fmt(r[c])}</td>`;
        const pv = prev ? pct(r[c], prev[c]) : "";
        cells += `<td class="pct ${pv.startsWith("-") ? "neg" : ""}">${pv || "-"}</td>`;
      }
      const yen = v => { const n = num(v); return (n == null || isNaN(n)) ? "－円" : `${fmt(v)}円`; };
      cells += `<td class="${num(r["EPS"]) < 0 ? "neg" : ""}">${yen(r["EPS"])}</td>`;
      cells += `<td>${yen(r["BPS"])}</td>`;
      return `<tr>${cells}</tr>`;
    }).join("");
    document.getElementById("finTable").innerHTML =
      `<table class="data"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  })();

  // ---- 決算発表予定 ----
  if (d.announce) {
    document.getElementById("announcePanel").style.display = "";
    const boldNum = s => s.replace(/([0-9,\.]+)(百万円|%)/g, "<b>$1$2</b>");
    document.getElementById("announceBody").innerHTML =
      (d.announce.recent ? `<p>${boldNum(d.announce.recent)}</p>` : "") +
      (d.announce.progress ? `<p>${boldNum(d.announce.progress)}</p>` : "");
  }

  // ---- 速報値（New行・前期比%込み）: 通期／四半期(3か月)／四半期(累積) ----
  function renderFlash(containerId, block) {
    const el = document.getElementById(containerId);
    if (!el || !block) return;
    const isNegPct = s => /^-/.test(s);
    const rowsHtml = block.rows.map(cells => {
      let label = cells[0];
      let rest = cells.slice(1);
      const kubun = rest.length && /^(本|中|[1-4]Q)$/.test(rest[0]) ? rest.shift() : "";
      label = label
        .replace(/New/, `<span class="flash-new">New</span>`)
        .replace(/予/, `<span class="flash-new">予</span>`);
      let tds = `<td class="l">${label}</td>`;
      if (block.hasKubun) tds += `<td>${kubun || "-"}</td>`;
      for (const c of rest) {
        const isPct = c.includes("%");
        const neg = /-/.test(c);
        tds += `<td class="${isPct ? "pct" : ""} ${neg ? "neg" : ""}">${c}</td>`;
      }
      return `<tr>${tds}</tr>`;
    }).join("");
    // 通期の速報値は前期比、四半期（区分あり）の速報値は前年比（本家表記に合わせる）
    const pctLabel = block.hasKubun ? "(前年比)" : "(前期比)";
    const heads = ["決算期"];
    if (block.hasKubun) heads.push("区分");
    heads.push("売上高", pctLabel, "営業利益", pctLabel, "経常利益", pctLabel, "当期利益", pctLabel);
    el.innerHTML =
      `<div class="flash-title">速報値（${block.date}）</div>` +
      `<div class="tbl-scroll"><table class="data"><thead><tr>${heads.map((h, i) =>
        `<th class="${h === pctLabel ? "pct" : ""}${i === 0 ? " l" : ""}">${h}</th>`).join("")}</tr></thead>` +
      `<tbody>${rowsHtml}</tbody></table></div>`;
  }
  for (const block of (d.flash || [])) {
    block.hasKubun = block.rows.some(cells => cells.some(c => /^(本|中|[1-4]Q)$/.test(c)));
    if (block.section === "annual") renderFlash("flashAnnual", block);
    else if (block.section === "q3") renderFlash("flashQ3", block);
    else if (block.section === "qcum") renderFlash("flashQcum", block);
  }

  // ---- 四半期業績推移（3か月・累積）: データがある場合のみ表示 ----
  // 年度（区分「本」で区切る）ごとに交互グレー帯を敷いて1年の区切りを分かりやすくする（本家スカウターと同様）
  function fiscalYearBandsPlugin(rows) {
    const groups = [];
    let start = 0;
    rows.forEach((r, i) => {
      if (r["区分"] === "本") { groups.push({ start, end: i }); start = i + 1; }
    });
    if (start < rows.length) groups.push({ start, end: rows.length - 1 });
    return {
      id: "fiscalYearBands",
      beforeDatasetsDraw(chart) {
        const { ctx, chartArea, scales: { x } } = chart;
        if (!chartArea || !x) return;
        ctx.save();
        ctx.fillStyle = "rgba(110, 110, 140, 0.08)";
        groups.forEach((g, gi) => {
          if (gi % 2 === 0) return; // 1年度おきに帯を敷く
          const left = g.start === 0 ? chartArea.left
            : (x.getPixelForValue(g.start - 1) + x.getPixelForValue(g.start)) / 2;
          const right = g.end >= rows.length - 1 ? chartArea.right
            : (x.getPixelForValue(g.end) + x.getPixelForValue(g.end + 1)) / 2;
          ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);
        });
        ctx.restore();
      },
    };
  }

  function renderQuarterly(prefix, rows) {
    if (!rows.length) return;
    document.getElementById(`${prefix}Panel`).style.display = "";
    const bands = fiscalYearBandsPlugin(rows);
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
      plugins: [bands],
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
      plugins: [bands],
    });
    // 前年比（前年同四半期比・|前年|分母方式）付きテーブル
    (function renderQtrTable() {
      const metrics = ["売上高", "営業利益", "経常利益", "当期利益"];
      const byPeriod = new Map(rows.map(r => [r["決算期"], r]));
      const yoyPrev = period => {
        const m = String(period).match(/^(\d{4})\/(\d{1,2})/);
        return m ? byPeriod.get(`${m[1] - 1}/${m[2]}`) : null;
      };
      const pct = (cur, prev) => {
        const c = num(cur), p = prev ? num(prev) : null;
        if (c == null || p == null || isNaN(c) || isNaN(p) || p === 0) return "";
        return (((c - p) / Math.abs(p)) * 100).toFixed(1) + "%";
      };
      const head = "<tr><th>決算期</th><th>区分</th>" +
        metrics.map(c => `<th>${c}</th><th class="pct">(前年比)</th>`).join("") + "</tr>";
      const body = rows.map(r => {
        const prev = yoyPrev(r["決算期"]);
        let cells = `<td>${r["決算期"]}</td><td>${r["区分"] || "-"}</td>`;
        for (const c of metrics) {
          const n = num(r[c]);
          cells += `<td class="${n != null && n < 0 ? "neg" : ""}">${fmt(r[c])}</td>`;
          const pv = prev ? pct(r[c], prev[c]) : "";
          cells += `<td class="pct ${pv.startsWith("-") ? "neg" : ""}">${pv || "-"}</td>`;
        }
        return `<tr>${cells}</tr>`;
      }).join("");
      document.getElementById(`${prefix}Table`).innerHTML =
        `<table class="data"><thead>${head}</thead><tbody>${body}</tbody></table>`;
    })();
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

  // ---- マネックス取得データ（全文）: 開いたときだけ読み込み、タブ区切り行は表に整形 ----
  (function setupSourceView() {
    const btn = document.getElementById("srcToggleBtn");
    const body = document.getElementById("srcBody");
    let loaded = false;
    const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const SECTION_KWS = ["企業情報", "銘柄カルテ", "決算発表予定", "今期進捗状況", "通期業績推移", "平均成長率", "平均利益率",
      "四半期業績推移（3か月）", "四半期業績推移（累積）", "キャッシュフロー推移", "貸借対照表",
      "設備投資・減価償却費・研究開発費", "有利子負債", "各種回転率", "従業員数・1人当り業績", "指標一覧", "同業他社情報"];
    function renderSource(text, sectionTables) {
      // グラフ描画用ノイズを除去: タブ無しで数値だけの行（軸目盛）と、直前と同一の行（凡例の重複）
      const rawLines = text.split(/\r?\n/);
      const lines = [];
      let prevTrim = null;
      for (const line of rawLines) {
        const t = line.trim();
        if (!line.includes("\t") && /^[-－0-9,\.]+$/.test(t) && t !== "") continue; // 軸目盛
        if (t !== "" && t === prevTrim) continue; // 連続重複
        lines.push(line);
        prevTrim = t;
      }
      const out = [];
      let table = null;
      const flushTable = () => {
        if (!table) return;
        out.push(`<div class="tbl-scroll"><table class="data"><tbody>` +
          table.map(cells => `<tr>${cells.map(c => {
            const t = c.trim();
            const isNum = /^[-－]?[\d,\.]+[%円倍株人回期]?$/.test(t);
            const neg = /^-|^▲/.test(t);
            return `<td class="${isNum ? "" : "l "}${neg ? "neg" : ""}">${esc(t) || "&nbsp;"}</td>`;
          }).join("")}</tr>`).join("") + `</tbody></table></div>`);
        table = null;
      };
      for (const line of lines) {
        const t = line.trim();
        if (!t) { flushTable(); continue; }
        if (line.includes("\t")) {
          (table = table || []).push(line.split("\t"));
          continue;
        }
        flushTable();
        if (SECTION_KWS.some(k => t === k || t.startsWith(k))) {
          out.push(`<h3 class="chart-title">${esc(t)}</h3>`);
          // raw HTMLの非表示詳細テーブルがあるセクションは、実数値の表をここに挿入する
          const sec = Object.keys(sectionTables).find(k => t === k || t.startsWith(k));
          if (sec && sectionTables[sec]) {
            for (const rows of sectionTables[sec]) {
              out.push(`<div class="tbl-scroll"><table class="data"><tbody>` +
                rows.map((cells, ri) => `<tr>${cells.map(c => {
                  const isNum = /^[-－]?[\d,\.]+[%円倍株人回期]?$/.test(c);
                  const neg = /^-/.test(c);
                  const tag = ri === 0 ? "th" : "td";
                  return `<${tag} class="${isNum ? "" : "l "}${neg ? "neg" : ""}">${esc(c) || "&nbsp;"}</${tag}>`;
                }).join("")}</tr>`).join("") + `</tbody></table></div>`);
            }
            delete sectionTables[sec]; // 同名セクションの二重挿入防止
          }
        } else {
          out.push(`<p style="margin:4px 0; font-size:12px">${esc(t)}</p>`);
        }
      }
      flushTable();
      body.innerHTML = out.join("");
    }
    btn.addEventListener("click", async () => {
      if (!loaded) {
        btn.textContent = "読み込み中...";
        try {
          const res = await fetch(`/api/source/${encodeURIComponent(code)}`);
          const s = await res.json();
          if (s.text) renderSource(s.text, s.tables || {});
          else body.innerHTML = `<span class="muted">元テキストがありません（raw未取得・貼付未実施の銘柄）</span>`;
          loaded = true;
        } catch (e) {
          body.innerHTML = `<span class="muted">読み込みに失敗しました: ${e}</span>`;
        }
      }
      const open = body.style.display === "none";
      body.style.display = open ? "" : "none";
      btn.textContent = open ? "▲ 全文を閉じる" : "▼ 全文を表示";
    });
  })();

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
