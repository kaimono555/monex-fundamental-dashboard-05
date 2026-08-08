"use strict";
// 業績データ貼付パネル（index.html 最下部に設置）
(() => {
  let blockCount = 0;
  const statusEl = document.getElementById("status");
  function setStatus(msg, cls) { statusEl.textContent = msg; statusEl.className = cls || ""; }

  function addBlock() {
    blockCount += 1;
    const wrap = document.createElement("div");
    wrap.className = "paste-block";
    wrap.innerHTML =
      '<div class="paste-block-head">' +
        '<span class="paste-block-label">銘柄 ' + blockCount + '</span>' +
        '<button type="button" class="remove-block-btn">削除</button>' +
      '</div>' +
      '<textarea placeholder="ここにマネックス銘柄スカウターの銘柄ページのテキストを貼り付けてください（銘柄コードは自動判別）"></textarea>';
    wrap.querySelector(".remove-block-btn").addEventListener("click", () => {
      if (document.querySelectorAll(".paste-block").length <= 1) {
        setStatus("最低1つは貼付欄が必要です。", "err");
        return;
      }
      wrap.remove();
      renumber();
    });
    document.getElementById("pasteBlocks").appendChild(wrap);
  }
  function renumber() {
    document.querySelectorAll(".paste-block").forEach((b, i) => {
      b.querySelector(".paste-block-label").textContent = "銘柄 " + (i + 1);
    });
  }
  document.getElementById("addBlockBtn").addEventListener("click", addBlock);
  addBlock();

  const runBtn = document.getElementById("runBtn");
  runBtn.addEventListener("click", async () => {
    if (runBtn.disabled) return;
    const texts = Array.from(document.querySelectorAll(".paste-block textarea"))
      .map(ta => ta.value).filter(t => t.trim().length > 0);
    if (!texts.length) {
      setStatus("テキストが空です。銘柄ページのテキストを貼り付けてから実行してください。", "err");
      return;
    }
    runBtn.disabled = true;
    const resultPanel = document.getElementById("resultPanel");
    const resultList = document.getElementById("resultList");
    resultPanel.style.display = "";
    resultList.innerHTML = "";
    let ok = 0, ng = 0;
    try {
      for (let i = 0; i < texts.length; i++) {
        setStatus(`処理中... (${i + 1}/${texts.length})`, "");
        const row = document.createElement("div");
        row.className = "result-row";
        try {
          const res = await fetch("/api/manual", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: texts[i] }),
          });
          const d = await res.json();
          if (!res.ok) {
            ng++;
            row.innerHTML = `<span class="code">銘柄 ${i + 1}</span><span class="err">${d.error || "エラー"}</span>`;
          } else {
            ok++;
            const notes = [];
            if (d.cf) notes.push(`CF: 追加 ${d.cf.added} 期・上書き ${d.cf.updated} 期`);
            if (d.qtr) notes.push(`四半期: 追加 ${d.qtr.added}・上書き ${d.qtr.updated}`);
            if (d.qtrCum) notes.push(`四半期累積: 追加 ${d.qtrCum.added}・上書き ${d.qtrCum.updated}`);
            if (d.forecast) notes.push(`会社予想 ${d.forecast} 期`);
            if (d.indicators) notes.push(`指標 ${d.indicators} 項目`);
            if (d.extras) notes.push(`その他指標 ${d.extras} 項目`);
            if (d.eps_forecast) notes.push(`EPS予想 ${d.eps_forecast} 件`);
            row.innerHTML =
              `<span class="code">${d.code}</span><span>${d.name || ""}</span>` +
              `<span class="ok">保存OK（業績: 追加 ${d.fin.added} 期・上書き ${d.fin.updated} 期・合計 ${d.fin.total} 期` +
              (notes.length ? " ／ " + notes.join(" ／ ") : "") + `）</span>` +
              `<a href="stock.html?code=${encodeURIComponent(d.code)}" target="_blank">詳細ページを開く</a>`;
          }
        } catch (e) {
          ng++;
          row.innerHTML = `<span class="code">銘柄 ${i + 1}</span><span class="err">通信エラー: ${e}</span>`;
        }
        resultList.appendChild(row);
      }
      setStatus(`完了: 成功 ${ok} 件 / 失敗 ${ng} 件`, ng ? "err" : "ok");
      if (ok && typeof window.refreshStockList === "function") window.refreshStockList();
    } finally {
      runBtn.disabled = false;
    }
  });
})();
