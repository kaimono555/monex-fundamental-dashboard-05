"use strict";
// 手動取り込み実行ボタンと logs/run_log.txt のライブ表示（2秒ポーリング）
(() => {
  const btn = document.getElementById("runUpdateBtn");
  const statusEl = document.getElementById("opsStatus");
  const logBox = document.getElementById("logBox");
  const toggleBtn = document.getElementById("logToggleBtn");
  let offset = -1; // 初回は末尾16KBから
  let wasRunning = false;

  toggleBtn.addEventListener("click", () => {
    logBox.classList.toggle("hidden");
    toggleBtn.textContent = logBox.classList.contains("hidden") ? "ログを表示" : "ログを隠す";
  });

  function setStatus(running) {
    statusEl.innerHTML = running
      ? `<span class="dot running"></span>取り込み実行中`
      : `<span class="dot idle"></span>停止中`;
    btn.disabled = running;
  }

  async function poll() {
    try {
      const res = await fetch(`/api/logs?after=${offset}`);
      const d = await res.json();
      if (d.text) {
        const atBottom = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 20;
        logBox.textContent += d.text;
        // 表示は最新400行程度に制限（メモリ・描画負荷対策）
        const lines = logBox.textContent.split("\n");
        if (lines.length > 400) logBox.textContent = lines.slice(lines.length - 400).join("\n");
        if (atBottom) logBox.scrollTop = logBox.scrollHeight;
      }
      offset = d.offset;
      setStatus(d.running);
      // 実行完了を検知したら銘柄一覧を更新（更新日時・スコアの反映）
      if (wasRunning && !d.running && typeof window.refreshStockList === "function") {
        window.refreshStockList();
      }
      wasRunning = d.running;
    } catch (e) { /* サーバー停止中などは無視して次回ポーリング */ }
  }

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const res = await fetch("/api/run-update", { method: "POST" });
      const d = await res.json();
      if (!res.ok) alert(d.error || "起動に失敗しました");
    } catch (e) {
      alert("通信エラー: " + e);
    }
    poll();
  });

  poll();
  setInterval(poll, 2000);
})();
