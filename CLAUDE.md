# CLAUDE.md

## このプロジェクトについて

マネックス銘柄スカウターの財務ページから業績データを自動取得し、ファンダメンタルスコアを算出するシステムです。
04_強銘柄追随と連携して動作します（04の `follow_candidates.csv` → 05の `target_codes.csv` → 財務データ取得 → 04の候補再生成）。

## 基本ルール

* コードを勝手に変更しない
* 大規模なリファクタリングは禁止
* ファイル名・フォルダ構成を変更しない
* 新しいライブラリを勝手に追加しない
* 推測で修正しない
* 不明点は質問する

## 修正ルール

変更前に必ず

1. 問題点
2. 原因
3. 修正内容
4. 影響範囲

を説明し、承認を得てからコードを書き換えること。

## セキュリティ・認証まわり

* `data/playwright-profile/` にはChromeセッション情報が含まれる。絶対にGitにコミットしない
* ログインID・パスワード・Cookie・セッション情報はコード・ログ・設定ファイルに保存しない
* `fetch_target_financials.ps1` や `playwright_batch_fetch_financials.js` はブラウザ起動を伴う。実行前にログイン済みセッションが必要
* ログイン待ちやブラウザ待機が発生した場合、勝手に長時間待機せず状況を報告する

## 実行方法

### メインパイプライン（全工程）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_project.ps1
```

事前条件: `data/playwright-profile/monex-login-profile` にログイン済みChromeプロファイルが存在すること

### 単体実行

```powershell
# 財務データ取得
powershell -ExecutionPolicy Bypass -File .\scripts\fetch_target_financials.ps1

# ファンダメンタル集計
powershell -ExecutionPolicy Bypass -File .\scripts\generate_fundamentals.ps1

# スコア算出
powershell -ExecutionPolicy Bypass -File .\scripts\generate_fundamental_scores.ps1

# レポート生成
powershell -ExecutionPolicy Bypass -File .\scripts\generate_fundamental_report.ps1

# サマリー
powershell -ExecutionPolicy Bypass -File .\scripts\generate_fundamental_fetch_summary.ps1
```

### ログイン済みセッションの準備（初回・セッション切れ時）

```powershell
# ログイン画面を開く
powershell -ExecutionPolicy Bypass -File .\scripts\open_monex_login_profile.ps1
# → 開いたChromeで手動ログイン → Chromeを閉じる
```

### 単一銘柄テスト取得

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\open_monex_login_watch_4063.ps1 -BCode 4063
```

### バッチ取得（複数銘柄）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fetch_monex_batch_with_login_profile.ps1 -BCodes 8035,7735,4062
```

## 出力ファイル（Gitで管理しない）

| ファイル | 内容 |
|---------|------|
| `data/raw/{code}.html` | 取得済みHTMLキャッシュ |
| `data/raw/{code}.txt` | 本文テキスト |
| `data/output/{code}_financials.csv` | 銘柄別財務CSV |
| `data/fetch_results.csv` | 取得結果一覧 |
| `data/fetch_status.csv` | 取得ステータス |
| `data/fundamentals.csv` | 集計財務データ |
| `data/fundamental_scores.csv` | スコア一覧 |
| `data/run_log.txt` | 実行ログ |
| `reports/` | 生成レポート |

## プロジェクト間連携

| 方向 | スクリプト | 内容 |
|------|-----------|------|
| 04 → 05 | `04/scripts/generate_handoff_to_05.ps1` | `follow_candidates.csv` → `data/target_codes.csv` |
| 05 → 04 | `04/scripts/generate_follow_candidates.ps1` | `data/fundamental_scores.csv` → 04候補再生成 |

## Gitコミット方針

* 自動生成ファイル・ログ・Chromeプロファイルはコミットしない
* スクリプト変更・ルール変更・設定変更のみコミット対象
* コミット前に必ず `git status` でトラッキング対象を確認する

## 作業フロー

分析 → 提案 → 承認 → 修正 → テスト

この順番を必ず守ること。
