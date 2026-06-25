# project summary

## Purpose

マネックス銘柄スカウターの財務ページから、1銘柄ずつ業績データを取得し、検証用に `html` / `txt` / `csv` を保存する。

## Results

- 4063 を対象に、ログイン済み Chrome セッションを使った単一プロセス方式で取得に成功した。
- 8035, 7735, 4062, 3436, 285A の5銘柄を連続取得した。
- `data/raw/{code}.html` と `data/raw/{code}.txt` を保存できた。
- `data/output/{code}_financials.csv` を作成できた。
- `growth_metrics.csv` を作成し、成長率の集計値を保存できた。
- `score_rules.csv` を用意し、`build_growth_score.ps1` で将来のスコア生成に進める状態にした。

## How To Run

### 取得

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\open_monex_login_watch_4063.ps1 -BCode 4063
```

ログイン後に対象URLへ移動すると、同じ Playwright プロセス内で HTML と TXT を保存する。

### 複数銘柄取得

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fetch_monex_batch_with_login_profile.ps1 -BCodes 8035,7735,4062,3436,285A
```

### 財務CSV生成

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\parse_financials.ps1 -BCode 4063
```

### 成長率集計

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_growth_score.ps1
```

## Expansion Ideas

- `revision_status` を実データから取得する処理を追加する。
- `eps_score` / `revision_score` / `final_growth_score` を `growth_metrics.csv` から本格算出する。
- 対象銘柄を増やして `score_rules.csv` のルールを検証する。
- 取得失敗時の再試行や描画待ちの安定化を追加する。
