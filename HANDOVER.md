# トーク（キャラチャット）引き継ぎメモ

最終更新：第33版（2026-10-23 裏だけのキャラ）

iPhoneのホーム画面に置いて使う、キャラクターとのLINE風チャットアプリ（PWA）です。
このメモは、次に作業する人（または Claude）が、ここだけ読めば全体をつかめるように書いています。
**機能を変えたら、このメモも一緒に更新してください**（「更新履歴」と、変わった節）。

このリポジトリ（koara1012/koara1012.github.io）には、別のツールも入っています。
- `index.html`（ゲーム動画の台詞の文字起こし）と `voice.html`（ボイス収集）は、このチャットアプリとは別物です。

---

## 1. 全体の仕組み

```
iPhone（PWA）  ──HTTPS──▶  Cloudflare Worker「chara-chat」 ──▶ D1（データベース）
 chat/index.html            server/worker.js                   ├─ R2（自動バックアップ。つないだ場合）
 GitHub Pagesで公開           毎分 cron で動く                  ├─ Gemini（表のAI）/ xAI Grok（裏のAI）
                                                              └─ Web Push / Bark（通知）
```

| 部分 | 場所 | 公開のされ方 |
|---|---|---|
| アプリ画面 | `chat/`（index.html・sw.js・manifest.json・アイコン） | GitHub Pages：https://koara1012.github.io/chat/ （main に push すると自動で公開） |
| サーバー | `server/worker.js`・`server/wrangler.jsonc` | Cloudflare Workers Builds が GitHub の main を見て自動デプロイ（Root directory = `server`） |
| テスト | `tests/` | 手元で `node --no-warnings tests/run-all.mjs` |

- サーバーURL：Cloudflare の Workers の画面で確認できます（公開リポジトリなので、ここには書きません）。
- アプリの設定画面で「サーバーURL」と「合言葉（APP_TOKEN）」を入れて使います。この2つは iPhone の中だけに保存されます。
- 画面とサーバーは、それぞれ版の文字列を持っています（`chat/index.html` の `APP_VERSION`、`server/worker.js` の `VERSION`）。更新するときは両方そろえます。

## 2. Cloudflare の設定

### シークレット（Cloudflare の画面でだけ設定。GitHub には絶対に書かない）
| 名前 | 用途 |
|---|---|
| `APP_TOKEN` | アプリからの合言葉（`X-App-Token` ヘッダー） |
| `GEMINI_API_KEY` | 表のAI（Gemini）・写真の生成 |
| `XAI_API_KEY` | 裏のAI（Grok） |
| `BARK_DEVICE_KEY` | Bark 通知の宛先 |
| `BARK_ENC_KEY` | Bark 通知の暗号化キー（AES-128-CBC。IVは通知ごとにランダム） |

任意の環境変数：`GEMINI_MODEL`・`GEMINI_IMAGE_MODEL`・`XAI_MODEL`・`BARK_SERVER`・`VAPID_SUBJECT`

### バインディング（`server/wrangler.jsonc`）
- `DB`：D1「chara-chat-db」
- `BACKUP`：R2「chara-chat-backup」。**まだコメントアウト中**です。バケットを作ってから `//` を外します。バケットが無いまま有効にすると、デプロイに失敗します。
- cron：`* * * * *`（毎分）

## 3. サーバーの動き（`server/worker.js`）

### 毎分（`scheduled`）
- `runDueReplies`：予定に合わせて後回しにした返事（kv `reply:`）を送る
- `runDueProactive`：時間をずらした話しかけ（kv `proj:`）を送る
- `runDuePostscripts`：追伸・不在着信のあとの言葉（kv `ps:`）を送る
- `runDisasters`：地震・速報（P2P地震情報）。ほかの災害の確認は間をあけて行う
- `backupStep`：月2回の自動バックアップと、復元の続き（R2 があるときだけ）
- 13分ごと（`TICK_MIN`）に `tick` も動きます：
  - 毎日の様子と記憶の整理
  - 自分からの話しかけ
  - TLの投稿と反応

### 表と裏
- **表**：LINE風のトーク。くらし（記憶・予定表・天気・災害・誕生日など）が働きます。AIは既定で Gemini です。
- **裏**：実際に会っている場面のロールプレイで、表とは別の世界線です。ナレーションがあり、AIは既定で Grok です。
- 裏の会話は `char_id` の末尾に `#ura` が付きます。
- **グループ**（裏だけ）：id は `grp-…` で、会話は `grp-…#ura` です。
- **裏だけのキャラ**：`uraOnly: true`。表の処理（`inOmote()` で絞る）からは外れます。

### 表と裏で別々にあるもの
- 名前、アイコン、キャラ設定、タイムライン（投稿・いいね・コメント・予定）

### D1 の表
`chars` `groups` `messages` `reads` `kv` `subs` `ura_icons` `me_icons` `tl_posts` `tl_comments` `tl_likes` `tl_jobs` `memories` `char_state` `images` `ai_cost`

- 列の追加は `ensureSchema` の `ALTER TABLE`（失敗は無視）で行います。
- `messages` の主な列：`sender`（me / char / narr）、`image`、`retracted`、`reaction`、`reply_to`（引用返信）、`kind`（call＝不在着信）、`speaker`（グループで話した子）
- `char_state`：キャラごとの毎日の様子を JSON で持っています。
  - 気分、予定表 `plan`、日記、`story`、`project`（長く続けていること）、`condition`（数日続く体調）、ひとこと `statusMsg`／`statusEmoji` など

### kv の主なキー
- 設定と共通：`settings`、`worldbook`（共通の世界観）、`log`（エラー記録30件）、`vapid`、`origin`
- 予約：`reply:` `replygo:` `proj:` `projLast` `ps:`
- スタンプ：`usleep:` `ulater:`
- キャラの性質：`rhythm:`（生活リズム・毎週の習慣）、`jealous:`、`meet:<日付>`（キャラ同士の約束）
- ニュース：`newsKw:` `news:` `newsUsed:`
- 天気・災害：`weather` `forecast` `air` `dis:state` `disjob:`
- バックアップ：`bk:job` `bk:restore` `bk:lock` `bk:status` `bk:upload` `bk:userdel` `bk:lease`

### 主なAPI（すべて `X-App-Token` が必要。`/icon/<id>/<署名>.png` だけは公開）
- 同期：`GET /sync`
- トーク：`POST /send` `/reply` `/reply/decide` `/react`（スタンプ） `/read` `/clear` `/messages/delete`
- キャラとグループ：`POST /char`、`DELETE /char`、`POST /group`、`DELETE /group`
- TL：`GET /tl`、`POST /tl/post`（写真可） `/tl/comment` `/tl/like` `/tl/delete` `/tl/clear`
- くらし：`GET /life`、`POST /memory/delete`、`GET/POST /world`、`GET /disaster`、`POST /outage`
- 写真：`GET /img`、`POST /img/replace`（キャラの写真のPNGをJPEGに差し替え）
- バックアップ：`GET /export`、`/backup/*`（status・check・step・now・cancel・restore・upload・download）
- 通知：`GET /vapid`、`POST /subscribe`、`POST /test-push`、`POST /test-bark`、`GET /bark/status`
- テスト用：`POST /poke`、`POST /tl/poke`、`POST /disaster/test`

## 4. 守っていること（ユーザーとの約束）
- シークレットは Cloudflare にだけ置きます。GitHub、テスト、バックアップのファイルには入れません。
- 性的な内容は書きません。キャラが未成年の設定なら、なおさらです。
- キャラが送る写真には、キャラ本人も人物も写しません。料理・景色・持ち物などだけです。ユーザーの写真の加工はしてよいです。
- 災害の話で「公式の情報を確認してください」のような言い回しはしません（没入感のため）。
- 表の予定表（いつ何をしているか）は、ユーザーには見せません。
- AIの料金は、表と裏それぞれ `ai_cost` に記録して、画面上部に目安を出しています。

## 5. テスト
```
node --no-warnings tests/run-all.mjs            # 全部（今は24本）
node --no-warnings tests/run-all.mjs t_group     # 名前で絞る
```
- 本物のAI・D1・通知にはつながりません（`tests/fake.mjs` の偽物を使います）。鍵も不要です。
- `run-all.mjs` は `server/worker.js` に `export` を足した写し `tests/worker.mjs`（git管理外）を作り、時計を日本時間14時ごろにずらして（`daytime.mjs`）1本ずつ動かします。
- **注意**：`node --check server/worker.js` は、文法の誤りを見逃すことがあります（ESMの `.js` だと終了コード0になる）。確かめるときは `.mjs` に写してから `node --check` してください。テストは `.mjs` を読むので、誤りがあれば全部失敗して気づけます。
- 画面の確認には Playwright（Chromium）を使っていました（作業場所の一時ファイルで、リポジトリには入っていません）。

## 6. よくある落とし穴
- `hidden` 属性は、CSSで `display` を指定した要素には効きません。そのため `[hidden]{display:none!important}` を入れてあります。
- テストに日付を直書きすると、日がたつと落ちます。時刻は「今」から相対で作るか、全部固定します。
- 文字列の中の改行は、`\n` と書きます（本物の改行を入れると文法エラーになります）。
- D1 は「読んだ行数」で数えるので、全件を読む問い合わせには索引を付けます（第27版で対応済み）。

## 7. 更新のしかた（いつもの手順）
1. `server/worker.js` と `chat/index.html` を直します。`VERSION` と `APP_VERSION` を同じ版名にします（例：`第34版（YYYY-MM-DD HH:MM:SS 更新・内容）`）。
2. 必要ならテストを足して、`node --no-warnings tests/run-all.mjs` が全部成功するのを確かめます。
3. このメモの「更新履歴」と、変わった節を直します。
4. `main` に push します。すると、画面は GitHub Pages、サーバーは Workers Builds で自動公開されます。
5. iPhone のアプリを閉じて開き直すと、新しい版になります。

## 8. まだやっていないこと・保留
- R2 のバインディング（バケット作成待ち。§2）
- 背景画像の着せかえ（相談のみ。キャラごと／共通、表裏別、置き場所をどうするか未定）
- アプリのアイコンの変更（相談のみ。変えたら、ホーム画面から削除して追加し直す必要あり）
- 表の返事の長さ設定（保留）

## 9. 更新履歴（新しい順）
- **第33版**：裏だけに登場するキャラ（`uraOnly`）
- **第32版**：裏のグループ（メンバー選択・あらすじ・物語を始める・リセット）。表に出ていたリセットボタンを修正
- **第31版**：TLに写真を投稿（AIが写真を言葉にして、キャラが中身に反応）
- **第30版**：キャラごとの誕生日
- **第29版**：日常感
  - 何週間も続ける趣味、内輪ネタ、引用返信、追伸、ひとこと＋絵文字
  - 数日続く体調、キャラ同士の約束、不在着信、毎週の習慣
- **第28版**：自動バックアップ（月2回・R2・1日用／15日用）、中身の確認、戻す機能（戻す前の状態を自動保存）、キャラの写真をJPEGに
- **第27版**：同期の索引、手動バックアップ、テストをリポジトリへ
- **第26版**：スタンプ（👍❤️😴🏃👀❓😂🥺🙏、表のみ）
- **第25版**：裏の自動を止めるボタン
- **第24版**：ニュースのキーワードを15個まで
- **第23版**：AI料金の表示、話しかけを時間差に
- **第22版**：遠くの災害は本物の警報だけ・1〜2人だけが話す
- **第20〜21版**：Bark 通知（キャラごとのアイコン・暗号化）
- **第19版**：災害・季節・停電
- **第18版**：1日の予定表、遅れて返す、既読だけ、昼寝
- **第17版**：共通の世界観
- **第16版**：裏の返事の長さ
- **第15版**：メッセージを選んで消す
- **第10〜14版**：くらし、TLの充実、静かな時間など
- それ以前：表と裏・タイムライン・Grok対応・ニュースなど
