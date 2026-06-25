# plan

## Step 1: Access

`scripts/fetch_monex_scout_test.ps1` で対象URLへアクセスする。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fetch_monex_scout_test.ps1 -BCode 4063
```

## Step 2: Save HTML

取得できたHTMLを `data/raw/4063.html` に保存する。

## Step 3: Save Page Text

HTMLから `script`, `style`, タグを除去し、本文テキストを `data/raw/4063.txt` に保存する。

## Step 4: Extract Financial Table

`scripts/parse_financials.ps1` で `data/raw/4063.html` を解析し、「通期業績推移」付近または業績行を含むテーブルからCSVを出力する。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\parse_financials.ps1 -BCode 4063
```

出力先:

```text
data/output/4063_financials.csv
```

列:

```text
year,sales,operating_profit,ordinary_profit,net_income,eps,bps
```

## Step 5: Log

`logs/run_log.txt` に以下を記録する。

- URLアクセス成功/失敗
- HTML取得成功/失敗
- 本文テキスト取得成功/失敗
- テーブル抽出成功/失敗
- エラー内容

## Step 6: Playwright Persistent Context

事前に通常の Chrome でマネックスに手動ログインしておく。

既存 Chrome プロファイルを直接壊さないため、既定では Chrome User Data を `data/playwright-profile/4063-user-data` にコピーし、そのコピーを Playwright persistent context で起動する。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fetch_monex_scout_with_chrome_session.ps1 -BCode 4063 -ProfileDirectory Default
```

Chrome プロファイルが `Default` 以外の場合:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fetch_monex_scout_with_chrome_session.ps1 -BCode 4063 -ProfileDirectory "Profile 1"
```

成功判定:

```text
data/raw/4063.txt に「通期業績推移」が含まれる
```

失敗判定:

```text
data/raw/4063.txt に「認証されたユーザのみ」が含まれる
```

## Step 7: Playwright Dedicated Login Profile

この方式は、Chrome を閉じることでセッションが切れる可能性があるため非推奨。後続検証では Step 8 の単一プロセス監視方式を使う。

専用プロファイル:

```text
data/playwright-profile/monex-login-profile
```

ログイン画面を開く:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\open_monex_login_profile.ps1
```

開いた Chrome で手動ログインし、ログイン完了後に Chrome ウィンドウを閉じる。

同じ専用プロファイルで対象URLを取得する:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fetch_monex_with_login_profile.ps1 -BCode 4063
```

成功判定:

```text
data/raw/4063.txt に「認証されたユーザのみ」が含まれず、「通期業績推移」が含まれる
```

この方式では ID・パスワードをコードやログに保存しない。

## Step 8: Watch Open Login Session

Chrome を閉じることでセッションが切れる場合は、1つの Playwright プロセス内で Chrome を開き、ログイン後の表示中ページから HTML/TXT を保存する。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\open_monex_login_watch_4063.ps1 -BCode 4063
```

手順:

- 起動した Chrome でマネックスに手動ログインする。
- 同じ Chrome で `https://monex.ifis.co.jp/index.php?sa=report_zaimu&bcode=4063` を開く。
- スクリプトが 4063 ページを検出すると `data/raw/4063.html` と `data/raw/4063.txt` を保存する。
- Chrome は自動で閉じない。

成功判定:

```text
「認証されたユーザのみ」が含まれない
2007/03 または 2026/03 が含まれる
売上高、営業利益、経常利益、当期利益、EPS のいずれかが含まれる
```

## Extension

後続銘柄は `-BCode` を変更して同じスクリプトを実行する。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fetch_monex_scout_test.ps1 -BCode 8035
powershell -ExecutionPolicy Bypass -File .\scripts\parse_financials.ps1 -BCode 8035
```

ログイン済み Playwright 専用プロファイルで複数銘柄を連続取得する場合:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fetch_monex_batch_with_login_profile.ps1 -BCodes 8035,7735,4062,3436,285A
```

出力:

```text
data/raw/{code}.html
data/raw/{code}.txt
data/output/{code}_financials.csv
```
