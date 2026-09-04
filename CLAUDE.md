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

---

## 共通「銘柄スカウターRAW取得センター」（2026-09-04 追加）

05は、05・109・104-3・111 が共通で使う **マネックス銘柄スカウターRAW取得の一元窓口** でもある。
他Projectは原則として自分でマネックスを取得せず、05へ「この銘柄のRAWが必要」と依頼する。
マネックスへのログイン・ブラウザ操作（CDP:9222 / `monex-login-profile`）・RAW保存・レジストリ更新は05が行う。

### 設計原則

* **「RAWを保存しているか」と「毎日更新するか」を分離する。** 一度取得した銘柄を永久にdaily対象に残さない。
* 更新モードは3状態: `daily`（05日次で毎回取得）/ `on_demand`（依頼時のみ取得。日次に含めない）/
  `inactive`（どのProjectも要求なし。日次取得しないが RAW・最終取得日時・過去利用Projectは残す）。
* Project別の利用状態（`project_usage`）は独立。111がinactiveにしても109がon_demandならその銘柄はon_demandのまま。
* 依頼時のデフォルトは必ず `on_demand`。**依頼しただけでdailyに昇格しない。**
* 銘柄の「削除」と「日次更新停止」は同義にしない。inactiveでもRAWは削除しない（物理削除は別操作。
  ビューアの「削除」ボタン `POST /api/delete-stock` は data/raw まで消すため、新管理方式では使わない）。

### effective_update_mode の決定（優先順位）

1. `pinned = 1` → daily
2. いずれかのProjectが active かつ daily 要求 → daily
3. いずれかのProjectが active かつ on_demand → on_demand
4. それ以外 → inactive

### レジストリ（SQLite・標準ライブラリのみ）

| ファイル | 内容 |
|---------|------|
| `data/stock_registry.sqlite3` | 正本。`stocks`（code/name/pinned/effective_update_mode/raw_present/raw_path/raw_hash/last_fetch/fetch_status/data_as_of/last_error/created_at/updated_at）/ `project_usage`（code/project/active/requested_mode/last_required/reason/run_id/lease_expires_at）/ `fetch_log` |
| `data/stock_registry_view.csv` / `data/stock_registry_usage_view.csv` | 人間確認用ビュー（書き出し専用。直接編集しない） |
| `scripts/monex_registry.py` | レジストリモジュール兼CLI（`import-existing` / `show` / `list --mode` / `daily-codes` / `set-usage --project X --codes .. [--inactive]` / `pin` / `unpin` / `export-view` / `logs`） |

レジストリへの書き込みは05側のスクリプト経由のみ（他ProjectがCSV/DBを直接書き換えない）。

### 依頼インターフェース

```powershell
python scripts\request_monex_raw.py --project 111 --codes 5803,4062 --reason theme_analysis --run-id <run_id> --max-age-hours 24
python scripts\request_monex_raw.py --project 109 --codes 8306 --page-type topix_news   # 業績ニュースページ(109向け)
```

フロー: レジストリ登録（on_demand）→ 既存RAWの有無・鮮度・本文検証 → 十分新しければ `fresh` で返却 →
無い/古いものだけロック取得 → 既存 `playwright_batch_fetch_financials.js` を一時ディレクトリ
（`data/tmp_fetch/{run_id}/`）向きに実行 → `validate_monex_raw.js`（auth_detect.js + evaluateFinancialText +
銘柄コード一致 + 本文長）を通過したものだけ `data/raw/{code}.txt|.html` へ原子的に昇格（`fetched`）→
レジストリ更新 → 結果JSON（stdout / `--json-out`）。終了コード 0=全件OK / 2=一部失敗 / 3=05ログイン更新が必要 / 4=ロック待ちタイムアウト / 1=致命的。

**失敗時は前回正常RAW（last good RAW）を絶対に上書きしない**（`fetch_status=error` / `last_error` の更新のみ）。
RAW保存先は従来どおり `data/raw/{code}.*`（05正本）と `_shared_monex_raw/{code}/`（共通・`saveSharedMonexRaw` が成功時に保存）。
`--page-type topix_news` は `data/raw_topix/{code}.txt|.html|_news.json`（`scripts/playwright_fetch_monex_topix_news.js`）。

### ロック（同時実行対策）

`data/locks/monex_fetch.lock`（排他作成・JSON {pid, owner, started_at}・保持PID死亡/3時間超でstale奪取）。
`scripts/monex_fetch_lock.py`（Python）と `scripts/monex_fetch_lock.ps1`（PowerShell）は同一プロトコル。
05日次（`fetch_target_financials.ps1` の Invoke-BatchFetch）と on-demand 取得は同じロックで直列化し、
同じChromeプロファイルをPlaywrightで二重に開かない。ロック待ち中に他要求が同一銘柄を取得済みなら再取得しない。

### 05日次との互換（target_codes.csv 互換方式）

`run_project.ps1` は従来どおり 04 → `target_codes.csv`（+09保有・手動貼付）で日次対象を決め、その直後に
`scripts/registry_daily_sync.py` が (1) target の銘柄を project=05/daily としてレジストリへ反映、
(2) target から外れた銘柄の05利用を inactive（RAW・他Project利用は保持）、(3) レジストリ上 daily
（pinned / 他Projectのdaily要求）なのに target に無い銘柄だけ `source="registry"` で追記する。
on_demand / inactive は絶対に追記しない。取得後は `--after-fetch` で `fetch_status.csv` を反映する。
レジストリ側の失敗は日次処理を止めない（非致命）。

### 他Projectからの利用

| Project | 経路 | 旧経路（フォールバック・削除しない） |
|---------|------|------|
| 111 | `scripts/monex_center_111.py` → 05 request（project=`111/{theme}`）。分析後 `+10pt` 通過は on_demand 継続、それ以外は inactive | `monex_fetch_111.py --legacy`（`scripts_node/fetch_monex_111.js`、05のCDP:9222へ直接接続） |
| 109 | `scripts/monex_scout_via_05.js` → 05 request（`topix_news`） | `monex_scout_client.js`（109専用ブラウザ CDP:9223）。`MONEX_SOURCE_109=legacy` で固定可 |
| 104-3 | `handle_104_monex_fetch.ps1` → 05 request（project=104-3）→ `_shared_monex_raw` 読み戻し（従来どおり） | `scripts/monex/fetch_scouter_raw_104.js`（104-3専用ブラウザ CDP:9224）。`scripts/monex/USE_LEGACY_104_FETCH` マーカーで固定可 |

### テスト

```powershell
python -m unittest tests.test_monex_registry tests.test_request_monex_raw tests.test_registry_daily_sync
powershell -NoProfile -ExecutionPolicy Bypass -File tests\test_parse_financials_headers.ps1
```

### ロールバック

* `run_project.ps1` / `fetch_target_financials.ps1` の 2026-09-04 追記ブロック（registry_daily_sync 呼び出し・ロック）を外せば従来挙動に戻る。
  レジストリ（`data/stock_registry.sqlite3`）は Git 管理外で、削除しても既存 CSV/RAW に影響しない。
* 他Projectは上表の旧経路へ切り戻せる。
