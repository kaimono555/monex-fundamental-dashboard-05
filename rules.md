# rules

## Purpose

マネックス銘柄スカウターの財務ページから、1銘柄だけ業績データを取得できるか検証する。

## Scope

- 対象銘柄: `4063` 信越化学工業
- 対象URL: `https://monex.ifis.co.jp/index.php?sa=report_zaimu&bcode=4063`
- 本番プロジェクトには組み込まない。
- 成功後に `8035`, `7735`, `4062`, `285A`, `3436` へ拡張できる構成にする。

## Security

- ログインID、パスワード、Cookie、セッション情報は保存しない。
- 認証が必要な画面へ遷移した場合は、取得失敗として記録する。
- 保存対象は検証用HTML、本文テキスト、抽出CSV、実行ログのみとする。
- Playwright persistent context 検証では、既存 Chrome プロファイルを直接操作しないため、既定では検証用コピーを使う。
- 元の Chrome プロファイルを直接使う場合は `-UseOriginalProfile` を明示する。
- コピー済み Chrome プロファイル方式が失敗した場合は、`data/playwright-profile/monex-login-profile` を Playwright 専用ログインプロファイルとして使う。
- Playwright 専用ログインプロファイル方式でも ID・パスワードはコード、ログ、設定ファイルに保存しない。
- Chrome を閉じるとセッションが切れる場合は、1つの Playwright プロセスで開いた Chrome を維持したまま、表示中の 4063 ページから HTML/TXT を保存する。

## Outputs

- HTML: `data/raw/4063.html`
- 本文テキスト: `data/raw/4063.txt`
- 業績CSV: `data/output/4063_financials.csv`
- ログ: `logs/run_log.txt`

## Success Criteria

- URLアクセス結果をログに残せる。
- HTML取得可否をログに残せる。
- ページ本文テキスト取得可否をログに残せる。
- 「通期業績推移」相当のテーブル抽出可否をログに残せる。
- CSVに `year`, `sales`, `operating_profit`, `ordinary_profit`, `net_income`, `eps`, `bps` を出力できる。
- ログイン済み Chrome セッション検証では、`data/raw/4063.txt` に `通期業績推移` が含まれる場合を成功とする。
- `認証されたユーザのみ` が含まれる場合は失敗としてログに記録する。
- Playwright 専用ログインプロファイル検証では、`認証されたユーザのみ` が含まれず、かつ `通期業績推移` が含まれる場合を成功とする。
- 開いたログインセッション監視方式では、`認証されたユーザのみ` が含まれず、`2007/03` または `2026/03` が含まれ、かつ `売上高`, `営業利益`, `経常利益`, `当期利益`, `EPS` のいずれかが含まれる場合を成功とする。
