# このリポジトリで作業するときの決まりごと

## キャラチャット（`chat/`・`server/`・`tests/`）
- まず `HANDOVER.md`（引き継ぎメモ）を読んでください。全体の仕組み・設定・テスト・落とし穴がまとまっています。
- **機能を変えたら、同じコミットで `HANDOVER.md` も更新してください**（先頭の「最終更新」、§9 の更新履歴、変わった節）。ユーザーからの依頼です。
- 版名は `server/worker.js` の `VERSION` と `chat/index.html` の `APP_VERSION` をそろえて上げます。
- push の前に `node --no-warnings tests/run-all.mjs` が全部成功することを確かめます。新しい機能にはテストを足します。
- 文法の確認は `.mjs` に写してから `node --check` します（`.js` のままだと誤りを見逃します）。
- シークレット（APP_TOKEN・GEMINI_API_KEY・XAI_API_KEY・BARK_DEVICE_KEY・BARK_ENC_KEY）は Cloudflare にだけ置きます。GitHub には絶対に書きません。

## ユーザーとの進め方
- ユーザーが「まだ作業しなくて良い」と言ったときは相談だけにして、実装は「作って」「お願い」と言われてから始めます。
- 公開は `main` へ push します（画面は GitHub Pages、サーバーは Cloudflare Workers Builds が自動でデプロイ）。
