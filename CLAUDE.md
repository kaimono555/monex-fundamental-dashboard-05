# CLAUDE.md

このファイルはプロジェクトの正本（Single Source of Truth）です。
詳細は各参照先に委譲していますが、意思決定に必要な情報はすべてここに集約しています。

---

## プロジェクト概要

マネックス銘柄スカウター（IFIS Japan）の財務ページから60銘柄の業績データを自動取得し、
ファンダメンタルスコアを算出して **04_強銘柄追随** へ供給する実運用プロジェクトです。

```
04/follow_candidates.csv（60銘柄）
  → 05: 財務データ取得（Playwright + Chrome）
    → data/fundamental_scores.csv
      → 04: 候補銘柄再生成
```

**実績（2026-06-25）:** 60件取得・成功率100%・実行時間 約9分23秒

---

## 基本ルール

* コードを勝手に変更しない
* 大規模なリファクタリングは禁止
* ファイル名・フォルダ構成を変更しない
* 新しいライブラリを勝手に追加しない
* 推測で修正しない。不明点は必ず質問する

### 修正フロー

変更前に必ず以下を説明し、承認を得てからコードを書き換えること。

1. 問題点
2. 原因
3. 修正内容
4. 影響範囲

**作業順序:** 分析 → 提案 → 承認 → 修正 → テスト

---

## Git 運用ルール

* 動作確認後にコミットする（確認前のコミット禁止）
* コミット前に `git diff` で変更が意図した内容のみであることを確認する
* コミット後に `git status` が clean であることを確認する
* スクリプト・設定・仕様書のみがコミット対象
* 自動生成ファイル・ログ・Chromeプロファイルはコミットしない

### Git管理外（.gitignore で除外済み）

`node_modules/` / `data/playwright-profile/` / `data/raw/` / `data/output/` /
生成CSV・レポート・ログ一式

---

## 認証・再ログインの基本方針

### auth_detect.js が唯一の認証判定ロジック

`scripts/auth_detect.js` のみが `detectAuthErrorPage` を定義する。
両スクリプトから `require("./auth_detect")` で参照する。

* 文字化けしたShift-JISマーカーは使用禁止（Codex版のバグ）
* UTF-8の正しいマーカーのみ使用: `認証されたユーザのみ` / `ページを表示できません` 等
* `detectAuthErrorPage` をスクリプト内にローカル定義しない

### 再ログインフロー（Enter入力に依存しない）

`waitForEnterAndClose` モードはポーリングで自動検出する。

1. Chrome が2タブ（monex.co.jp + ifis.co.jp）で開く
2. monex.co.jp タブでログイン
3. ifis.co.jp タブを F5 → 財務データが表示されたらそのまま待つ
4. スクリプトが自動検出 → Chrome が自動で閉じる（Enter不要）
5. バッチフェッチが開始される

**タイムアウト:** 5分 / `relogin_timeout` ログ + `exit(3)` で終了

> `process.stdin` 経由の Enter 待機は subprocess チェーンで機能しない。
> `waitForEnter()` は復活させないこと。

### Chrome終了待機（lockfile 判定）

`launchPersistentContext` の前に `waitForChromeProfileRelease` を必ず実行する。

* 判定: `data/playwright-profile/monex-login-profile/lockfile` の排他オープン試行
* `EBUSY` = まだ使用中 → 待機継続
* 最大30秒・2秒ごと確認・タイムアウト時は `relogin_chrome_still_running` エラー

> `wmic` によるプロセス名検索は日本語パスで機能しないため使用禁止。

### ログインCookieの永続化について（2026-07-17 確認）

* `launchPersistentContext` によりCookie/セッション情報は
  `data/playwright-profile/monex-login-profile` にディスク保存される。
* Windows更新の再起動・PCシャットダウンはChromeプロセスを終了させるだけで、
  このフォルダのCookieファイル自体は消えない。次回起動時にそのまま
  ログイン状態を引き継げる（実績: 2026-07-09 ログイン後、7日以上
  再ログイン不要で継続した例あり）。
* Cookieの有効期限はIFIS/マネックス側サーバーが管理しており、
  こちら側で確認・制御はできない（数時間で切れる場合も、
  1週間以上持つ場合もある）。
* そのため **常時ログイン状態を保証することはできない**。
  切れた場合は従来通り `login_monex_profile_05.ps1` で手動ログインする。

### プロファイル保護ルール（追加）

* `data/playwright-profile/monex-login-profile` フォルダは
  ログイン状態そのものを保持する唯一の場所であるため、
  **明示的な指示がない限り削除・初期化しない**。
* 既存のクリーンアップ処理（`Remove-Monex05LockFiles`）は
  lockファイルのみを対象とし、Cookie本体には触れない設計を維持する。
* ディスククリーンアップ・環境re-buildなどの作業時も、
  このフォルダを削除対象に含めないよう注意する。

---

## 待機ルール

進捗がない場合は待機し続けず、原因調査へ移行する。

| フェーズ | 最大待機時間 |
|---------|------------|
| PowerShell 起動 | 10秒 |
| Node 起動 | 20秒 |
| Playwright 起動 | 30秒 |
| Chrome 起動 | 30秒 |
| ログイン待ち | 60秒 |
| データ取得開始 | 60秒 |
| **進捗がない場合** | **原因調査へ移行** |

**ログ確認先:** `logs/run_log.txt`

| 症状 | 原因 |
|------|------|
| `textChars=1634` が続く | 認証エラーページ（セッション切れ） |
| `batch fetch fatal error=browserType.launchPersistentContext` | Chromeプロファイルがロック中 |
| ログが `ユーザーログイン待機中` で停止 | stdin 不通（旧フロー）— 発生しないはずだが確認要 |

※ 上記「ログイン待ち60秒」は自動取得スクリプト内のポーリング判定の話。
  手動ログインスクリプト（login_monex_profile_05.ps1）実行後にChromeを
  閉じずに5〜6分置くのは、それとは別の運用上の待機であり矛盾しない。

---

## セキュリティ

* `data/playwright-profile/` にはChromeセッション情報が含まれる。絶対にGitにコミットしない
* ログインID・パスワード・Cookie・セッション情報はコード・ログ・設定ファイルに保存しない

---

## 実行方法

### メインパイプライン（通常運用）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_project.ps1
```

セッション切れ時は自動的に Chrome が開き、ログイン後に自動再開する。

### セッション事前確認・ログイン（セッション切れが予想される場合）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\check_monex_login_profile.ps1
```

Chrome が開いたら: monex.co.jp でログイン → ifis タブを F5 → 財務データを確認 → 自動で閉じる

### 手動ログイン時の運用手順（推奨・確定版 2026-07-09）

login_monex_profile_05.ps1 実行後、Chromeを閉じずに5〜6分放置してから
update_all_05.ps1 を実行すると、IFIS側認証セッションが安定し取得成功率が上がる
ことを実地テストで確認済み（60/60成功）。

1. login_monex_profile_05.ps1 を実行
2. ブラウザ上で通常どおりログイン
3. ログイン後、PowerShellコンソールでEnterは押さない
4. Chromeも閉じない
5. 5〜6分放置する
6. Chromeを開いたまま、別PowerShellから update_all_05.ps1 を実行する
7. 60件取得完了後、必要ならChromeを閉じてよい

※ ログインID・パスワード・認証情報・Cookie/セッションの中身は、この手順・
  自動化スクリプトのいずれにおいても取得・記録・表示しない。
  人間がブラウザ上で通常どおりログインするのみで、自動化側は
  成功/失敗の判定結果のみをログに残す。

### 単体実行

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fetch_target_financials.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\generate_fundamentals.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\generate_fundamental_scores.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\generate_fundamental_report.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\generate_fundamental_fetch_summary.ps1
```

### バッチ取得（複数銘柄・単独テスト）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fetch_monex_batch_with_login_profile.ps1 -BCodes 8035,7735,4062
```

---

## プロジェクト間連携

| 方向 | スクリプト | 内容 |
|------|-----------|------|
| 04 → 05 | `04/scripts/generate_handoff_to_05.ps1` | `follow_candidates.csv` → `data/target_codes.csv` |
| 05 → 04 | `04/scripts/generate_follow_candidates.ps1` | `data/fundamental_scores.csv` → 04候補再生成 |

---

## 出力ファイル（Git管理外）

| ファイル | 内容 |
|---------|------|
| `data/raw/{code}.html` | 取得済みHTMLキャッシュ |
| `data/raw/{code}.txt` | 本文テキスト |
| `data/output/{code}_financials.csv` | 銘柄別財務CSV |
| `data/fetch_results.csv` | 取得結果一覧 |
| `data/fetch_status.csv` | 取得ステータス |
| `data/fundamentals.csv` | 集計財務データ |
| `data/fundamental_scores.csv` | スコア一覧 |
| `logs/run_log.txt` | 実行ログ |
| `reports/` | 生成レポート |

---

## 詳細ドキュメント

以下はプロジェクトメモリとして Claude Code が参照するドキュメントです。

| ドキュメント | 内容 |
|-------------|------|
| `project-overview.md` | プロジェクト概要・パイプライン構成・実績詳細 |
| `feedback-dev-rules.md` | 開発・Git運用ルール・Codex版との関係 |
| `feedback-auth-and-relogin.md` | 認証判定・再ログインフロー・Chrome終了待機の確定ルール |
| `feedback-wait-limits.md` | 待機上限・トラブルシュートの手順 |

> 上記ファイルは `~/.claude/projects/.../memory/` に保存されています。
