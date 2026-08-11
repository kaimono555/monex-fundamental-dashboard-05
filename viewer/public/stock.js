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
  // code_source="manual"は自動取得(target_codes.csv)に組み込み済みの元手動貼付銘柄、
  // viewer_computedはまだ組み込み前（ビューアがその場でスコア再算出中）の手動貼付銘柄を示す。
  const isManualOrigin = (d.fundamentals && d.fundamentals.code_source === "manual") || (d.score && d.score.viewer_computed);
  document.getElementById("head").innerHTML = `
    <span class="code">${code}</span><span class="name">${name}</span>
    ${isManualOrigin ? `<span class="badge" title="業績データ貼付機能で手動追加した銘柄です">手動追加</span>` : ""}
    ${asOf ? `<span class="badge">決算期 ${asOf}</span>` : ""}
    ${d.fundamentals && d.fundamentals.fetched_at ? `<span class="badge">取得 ${d.fundamentals.fetched_at}</span>` : ""}
    ${d.manual_updated_at ? `<span class="badge">手動更新 ${d.manual_updated_at}</span>` : ""}`;

  // ---- スコア ----
  // 2026-08-11 バリュエーション評価追加: total_score_100(=quality_score(80)+valuation_score(20))と
  // 内訳A〜Eを表示。quality_score/quality_rank(80点満点・従来どおり不変)も引き続き参照可能にする。
  const sg = document.getElementById("scoreGrid");
  if (d.score) {
    const s = d.score;
    const hasTotal = s.total_score_100 !== "" && s.total_score_100 != null;
    const statusLabel = { normal: "通常", reference: "参考", insufficient_data: "評価不能" }[s.valuation_status] || s.valuation_status || "-";
    // CSV由来(fundamental_scores.csv)はbooleanが文字列"True"/"False"で来るため、
    // 手動貼付経路の実booleanと両対応で真偽判定する（"False"文字列はJSではtruthyな点に注意）。
    const isTrue = v => v === true || v === "True" || v === "TRUE";
    sg.innerHTML = [
      ["総合ランク(100点)", hasTotal ? s.total_rank_100 : "-"], ["総合スコア(100点)", hasTotal ? s.total_score_100 : "評価不能(データ不足)"],
      ["旧品質ランク(80点)", s.quality_rank], ["旧品質スコア(80点)", s.quality_score],
      ["成長性", s.growth], ["収益性", s.profitability], ["財務", s.financial],
      ["割安度(20点)", s.valuation_score !== "" && s.valuation_score != null ? s.valuation_score : "-"],
      ["割安度カバレッジ", s.valuation_coverage !== "" && s.valuation_coverage != null ? s.valuation_coverage + "%" : "-"],
      ["割安度ステータス", statusLabel],
      ["順位", s.rank !== "" && s.rank != null ? `${s.rank} 位` : "-"],
    ].map(([k, v]) => `<div class="ind-cell"><span class="k">${k}</span><span class="v">${v !== "" && v != null ? v : "-"}</span></div>`).join("") +
    `<div class="ind-cell"><span class="k">A 自社過去PER相対(6点)</span><span class="v">${isTrue(s.valuation_a_available) ? s.valuation_a_score : "評価対象外"}</span></div>` +
    `<div class="ind-cell"><span class="k">B PEG(5点)</span><span class="v">${isTrue(s.valuation_b_available) ? s.valuation_b_score + (s.valuation_b_source ? ` (${s.valuation_b_source})` : "") : "評価対象外"}</span></div>` +
    `<div class="ind-cell"><span class="k">C EV/EBITDA(4点)</span><span class="v">${isTrue(s.valuation_c_available) ? s.valuation_c_score : "評価対象外"}</span></div>` +
    `<div class="ind-cell"><span class="k">D PBR/ROE(3点)</span><span class="v">${isTrue(s.valuation_d_available) ? s.valuation_d_score : "評価対象外"}</span></div>` +
    `<div class="ind-cell"><span class="k">E 52週株価水準(2点)</span><span class="v">${isTrue(s.valuation_e_available) ? s.valuation_e_score : "評価対象外"}</span></div>` +
    (s.target_price ? `<div class="ind-cell"><span class="k">目標株価（参考）</span><span class="v">${Number(s.target_price).toLocaleString("ja-JP")}円${s.target_price_gap !== "" && s.target_price_gap != null ? ` (乖離率${Number(s.target_price_gap) >= 0 ? "+" : ""}${s.target_price_gap}%・参考)` : ""}</span></div>` : "") +
    (s.viewer_computed ? `<div class="muted" style="grid-column:1/-1">※ 手動貼付データからビューアが同一式で再算出した参考値${s.rank !== "" && s.rank != null ? "（順位はパイプライン算出時点のもの）" : "（60銘柄ランキングの順位対象外）"}</div>` : "") +
    (s.valuation_status === "reference" ? `<div class="muted" style="grid-column:1/-1">※ 割安度は評価可能項目が少なく（カバレッジ${s.valuation_coverage}%）、参考値として扱ってください</div>` : "") +
    (s.valuation_status === "insufficient_data" ? `<div class="muted" style="grid-column:1/-1">※ 割安度は評価可能なデータが不足しているため算出していません（総合スコアも未算出）</div>` : "");
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
    // マネックス画面風の整形表示: ノイズ除去 + 分割された行の結合 + ヘッダ再構成
    const DROP_EXACT = new Set([
      "株価を見る", "四季報を見る", "詳細チャートを見る", "詳細を見る", "詳細：", "[20分ディレイ株価]",
      "企業分析", "チャート", "セグメント・海外", "業績予想修正", "配当・株主還元", "アナリスト予想",
      "株価指標", "理論株価", "業績ニュース", "適時開示",
      "業績", "前期比", "前年比", "指数", "利益率", "変動要因", "5期", "10期", "全期間",
      "実績推移", "対売上高比率", "実績", "対総資産比率", "対自己資本比率",
      "直近比較", "項目別推移", "時系列推移", "簡易表示", "詳細表示",
      "前期", "今期", "前期会社実績", "今期会社実績", "最新会社予想", "コンセンサス予想",
      "売上高(右軸)", "従業員数", "▲", "▼",
    ]);
    const DROP_RE = [
      /^[-－0-9,.\/ ]+$/,             // 軸目盛・年月 等（%は継続行の可能性があるため含めない）
      /^[-－\d,.]+ %$/,               // ゲージ目盛 "0 %" "100 %" 等（%前に空白）
      /^[-－\d,.]+[MKB万]$/,          // "80M" 等
      /^[-－\d,.]+(人|回|円|株|倍)$/,  // 単位付き軸目盛（%は継続行の可能性があるため含めない）
      /^\d{4}\/\d{2}(本|予)?$/,       // グラフ横軸の決算期ラベル
      /^(1Q|2Q|3Q|4Q|通期|本決算)$/,
      /^(売上高|営業利益|経常利益|当期利益)\s*進捗率$/,
      /^表示形式/, /^表示：/, /^[　]/,
    ];
    // 貸借対照表はヘッダ行がテキスト化で崩れるため、既知の列構成を使う
    const BS_HDRS = [
      { cap: "資産", cols: ["決算期", "資産", "流動資産", "現金預金", "売上債権", "有価証券", "棚卸資産", "その他流動資産", "固定資産", "有形固定資産", "無形固定資産", "投資その他の資産", "その他資産"] },
      { cap: "負債・純資産", cols: ["決算期", "負債", "流動負債", "買入債務", "その他流動負債", "固定負債", "その他負債", "純資産", "自己資本", "新株予約権等", "非支配株主持分", "その他純資産", "その他"] },
    ];
    function renderSource(text, sectionTables) {
      const all = text.split(/\r?\n/).map(l => l.replace(/​/g, ""));
      // 表示範囲: 銘柄コード行〜フッタ手前
      let s = 0, e = all.length;
      for (let i = 0; i < Math.min(all.length, 60); i++)
        if (/^[0-9][0-9A-Z]{3}\s+\S/.test(all[i].trim())) { s = i; break; }
      for (let i = s; i < all.length; i++)
        if (/^(保有銘柄・配当情報|お気に入り銘柄|メモ銘柄一覧|最近閲覧した銘柄|東証33業種選択|ページトップへ)/.test(all[i].trim())) { e = i; break; }
      // ノイズ除去: グラフ用の凡例・軸目盛・ナビ・「(単位…)〜表示：」区間
      const lines = [];
      let prevTrim = null, inChart = false, chartN = 0;
      for (let i = s; i < e; i++) {
        const line = all[i], t = line.trim();
        if (inChart) {
          if (/^表示：/.test(t)) { inChart = false; continue; }
          if (++chartN > 60) inChart = false; // 保険: 区間が閉じない場合は打ち切り
          else continue;
        }
        if (/^[(（]単位/.test(t)) { inChart = true; chartN = 0; continue; }
        if (!line.includes("\t")) {
          if (t !== "" && t === prevTrim) { prevTrim = t; continue; } // 連続重複（グラフ凡例）
          prevTrim = t;
        } else prevTrim = null;
        if (!line.includes("\t")) {
          if (DROP_EXACT.has(t)) continue;
          if (t !== "" && DROP_RE.some(r => r.test(t))) continue;
        } else if (line.split("\t").every(c => c.trim() === "")) continue;
        lines.push(line);
      }
      // 整形: タブ行=表の行 / 「(予)」「24.6%」等の継続行は直前セルに結合 / ラベル連続はヘッダ・見出しに
      const out = [];
      let table = null;    // { rows: [{cells,hg?,th?}|{cap,text}] }
      let pending = null;  // 組み立て中の行（セル配列）
      let pendingHg = false;
      let buffer = [];     // タブ無しラベルの連続（列ヘッダ or 小見出し候補）
      let headGrid = false, bsMode = false, bsCount = 0;
      const isNumCell = c => c.split("\n").every(sg =>
        sg === "" || sg === "--" || /^[-－(（]?[\d,.\/%円倍株人回期)）\-－]+$/.test(sg));
      const negCls = c => /(^|\n)[-－▲]\d/.test(c) ? "neg" : "";
      const fmtCell = c => (esc(c) || "&nbsp;").replace(/\n/g, "<br>");
      const pushPending = () => {
        if (pending) { (table = table || { rows: [] }).rows.push({ cells: pending, hg: pendingHg }); pending = null; }
      };
      const flushTable = () => {
        pushPending();
        if (!table) return;
        const maxCols = Math.max(...table.rows.map(r => r.cap ? 1 : r.cells.length));
        out.push(`<div class="tbl-scroll"><table class="data src-tbl"><tbody>` + table.rows.map(r => {
          if (r.cap) return `<tr><th colspan="${maxCols}" class="l cap">${fmtCell(r.text)}</th></tr>`;
          if (r.hg) return `<tr>${r.cells.map((c, i) => i % 2 === 0
            ? `<th class="l">${fmtCell(c)}</th>`
            : `<td class="${negCls(c)}">${fmtCell(c)}</td>`).join("")}</tr>`;
          const isTh = r.th || (r.cells.filter(c => c !== "").length >= 3 &&
            r.cells.every(c => c === "" || (!isNumCell(c) && c.length <= 14)));
          return `<tr>${r.cells.map(c => {
            if (isTh) return `<th>${fmtCell(c)}</th>`;
            const num = isNumCell(c) && c !== "";
            const wrap = c.length > 30 ? "wrap " : "";
            return `<td class="${num ? "" : "l "}${wrap}${negCls(c)}">${fmtCell(c)}</td>`;
          }).join("")}</tr>`;
        }).join("") + `</tbody></table></div>`);
        table = null;
      };
      const flushBuffer = () => {
        buffer.forEach(b => out.push(`<p class="${/^現在値/.test(b) ? "src-price" : "src-line"}">${esc(b)}</p>`));
        buffer = [];
      };
      const lastCells = () => {
        if (pending) return pending;
        if (table && table.rows.length) { const r = table.rows[table.rows.length - 1]; if (!r.cap) return r.cells; }
        return null;
      };
      const appendLast = t => {
        const c = lastCells(); if (!c) return false;
        c[c.length - 1] = c[c.length - 1] ? c[c.length - 1] + "\n" + t : t;
        return true;
      };
      const startTableWithBuffer = firstCells => {
        table = { rows: [] };
        if (bsMode) {
          const h = BS_HDRS[bsCount++];
          if (h) {
            table.rows.push({ cap: true, text: h.cap });
            if (firstCells.length === h.cols.length) table.rows.push({ cells: h.cols, th: true });
          }
        } else if (buffer.length >= 3 && buffer.length === firstCells.length) {
          table.rows.push({ cells: buffer, th: true });
        } else if (buffer.length) {
          // 列数不一致の複数ラベルはグラフタブ名等の残骸が多いため、直近のラベルのみ採用
          table.rows.push({ cap: true, text: buffer[buffer.length - 1] });
        }
        buffer = [];
      };
      const emitSection = t => {
        out.push(`<h3 class="chart-title">${esc(t)}</h3>`);
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
      };
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        const hasTab = line.includes("\t");
        if (!hasTab && SECTION_KWS.some(k => t === k || t.startsWith(k))) {
          flushTable(); flushBuffer(); headGrid = false;
          bsMode = t.startsWith("貸借対照表"); if (bsMode) bsCount = 0;
          emitSection(t);
          continue;
        }
        if (!hasTab && t.startsWith("売買単位")) {
          flushTable(); flushBuffer();
          out.push(`<p class="src-line">${esc(t)}</p>`);
          headGrid = true; continue;
        }
        if (!hasTab && /^(※|財務データ等)/.test(t)) {
          flushTable(); flushBuffer();
          if (/^財務データ等/.test(t)) headGrid = false;
          out.push(`<p class="src-note">${esc(t)}</p>`);
          continue;
        }
        if (bsMode && !hasTab) { flushTable(); continue; } // 貸借対照表の崩れたヘッダ断片は捨てる
        if (hasTab) {
          const cells = line.split("\t").map(c => c.trim());
          const cont = (line.startsWith("\t") || /^[(（]/.test(cells[0]) || /%$/.test(cells[0]));
          if (cont && lastCells()) {
            if (!pending && table) {
              const last = table.rows[table.rows.length - 1];
              if (!last.cap && !last.th && !last.hg) { table.rows.pop(); pending = last.cells; pendingHg = false; }
            }
            if (pending) {
              const [first, ...rest] = cells;
              if (first !== "") pending[pending.length - 1] = pending[pending.length - 1] ? pending[pending.length - 1] + "\n" + first : first;
              pending.push(...rest);
              continue;
            }
          }
          const isHdrRow = cells.filter(c => c !== "").length >= 3 &&
            cells.every(c => c === "" || (!isNumCell(c) && c.length <= 14));
          if (!table && !pending) { startTableWithBuffer(cells); }
          else if (isHdrRow) { flushTable(); startTableWithBuffer(cells); }
          else pushPending();
          pending = cells; pendingHg = headGrid;
          continue;
        }
        // タブ無し行
        if (/^[(（]/.test(t) || /^--/.test(t) || /%$/.test(t)) {
          if (appendLast(t)) continue;
          if (buffer.length) { buffer.push(t); continue; }
          out.push(`<p class="src-line">${esc(t)}</p>`); continue;
        }
        if (/^[・･]/.test(t) && appendLast(t)) continue;
        if (t.length > 40) {
          if (pending && pending[pending.length - 1] === "") { pending[pending.length - 1] = t; continue; }
          flushTable(); flushBuffer();
          out.push(`<p class="src-line">${esc(t)}</p>`); continue;
        }
        if (headGrid) { pushPending(); pending = [t]; pendingHg = true; continue; }
        flushTable(); buffer.push(t);
      }
      flushTable(); flushBuffer();
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
