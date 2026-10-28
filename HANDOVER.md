# トーク（キャラチャット）引き継ぎメモ

最終更新：第40版（2026-10-28 LINE風とノベル画面の統合）

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
| アプリ画面 | `chat/`（index.html・**novel.html（立ち絵のノベル画面）**・sw.js・manifest.json・アイコン） | GitHub Pages：https://koara1012.github.io/chat/ （main に push すると自動で公開） |
| 試作の置き場 | `lab/`（index.html・novel.html は `chat/` と**同じファイル**。置き場所で保存の名前が変わる：`lab.*`・IndexedDB `akariLab`、通知なし） | https://koara1012.github.io/lab/ |
| サーバー | `server/worker.js`・`server/wrangler.jsonc` | Cloudflare Workers Builds が GitHub の main を見て自動デプロイ（Root directory = `server`） |
| テスト | `tests/` | 手元で `node --no-warnings tests/run-all.mjs` |

- サーバーURL：Cloudflare の Workers の画面で確認できます（公開リポジトリなので、ここには書きません）。
- アプリの設定画面で「サーバーURL」と「合言葉（APP_TOKEN）」を入れて使います。この2つは iPhone の中だけに保存されます。
- 画面とサーバーは、それぞれ版の文字列を持っています（`chat/index.html` の `APP_VERSION`、`server/worker.js` の `VERSION`）。更新するときは両方そろえます。
- **第40版から、LINE風アプリとノベル画面（伊達朱里などの立ち絵の会話）は1つのアプリ**です。`chat/index.html`（LINE風）と `chat/novel.html`（ノベル。引き継ぎは `AKARI_HANDOVER.md`）は別ファイルで、トーク画面の［立ち絵］・帯の［会いに行く］・通知のタップでノベルへ、ノベルの［‹ LINE風へ］で戻ります。サーバーURL・合言葉は `chat.cfg` を共有。
- `chat/` を直したら `lab/` にも同じファイルを写します（`cp chat/index.html chat/novel.html lab/`）。中身は `IS_LAB`（置き場所）で切り替わります。

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
- `runAppointments`：会う約束（試作・設定 `meetFeature` がオンのときだけ）。20分前「そろそろ待ち合わせ」・時刻に「〇〇さんが待っています」の二段の通知（タップでノベル画面 `lab/novel.html?meet=<id>`。Web Push は `url`、Bark は `url`）。モードがオフのまま時刻を過ぎたら延期、通知して2時間来なければ「来なかった」、会っている状態が6時間続いたら自動で終える
- `runDisasters`：地震・速報（P2P地震情報）。ほかの災害の確認は間をあけて行う
- `backupStep`：月2回の自動バックアップと、復元の続き（R2 があるときだけ）
- `tick` も毎分動きます。ただし、1人ずつ見ると13分（`TICK_MIN`）に1回の見回りです。キャラごとに、13分の中の担当の分が均等にずらしてあります（`tickDue`）。何人も同じ瞬間に動かないようにするためです。担当の子だけ、次のことを判定します。
  - 毎日の様子と記憶の整理
  - 自分からの話しかけ（届くのは `proj:` で、さらに4分以上ずらす）
  - スタンプ（🥺・😴）
  - TLの投稿
- TLのいいね・コメント・返信（`tl_jobs`）は、毎分、時刻が来たものから実行します（1分に5件まで）。

### 表と裏
- **表**：LINE風のトーク。くらし（記憶・予定表・天気・災害・誕生日など）が働きます。AIは既定で Gemini です。
- **裏**：実際に会っている場面のロールプレイで、表とは別の世界線です。ナレーションがあり、AIは既定で Grok です。
- 裏の会話は `char_id` の末尾に `#ura` が付きます。
- **グループ**（裏だけ）：id は `grp-…` で、会話は `grp-…#ura` です。
  - グループのデータ（`groups.data`）：名前、メンバー、あらすじ `synopsis`（画面に出る）、グループ設定 `prompt`（AIだけが読む）、メンバーごとの立場 `roles`（{キャラid: 文}）、ナレーション、長さ、吹き出し数
  - グループ設定とメンバーの立場は、各キャラの設定より優先されます（関係・立場・ルール）。口調・一人称など、食い違わない部分は各キャラの設定のままです。
- **裏だけのキャラ**：`uraOnly: true`。表の処理（`inOmote()` で絞る）からは外れます。

### 表と裏で別々にあるもの
- 名前、アイコン、キャラ設定、タイムライン（投稿・いいね・コメント・予定）

### D1 の表
`chars` `groups` `messages` `reads` `kv` `subs` `ura_icons` `me_icons` `tl_posts` `tl_comments` `tl_likes` `tl_jobs` `memories` `char_state` `images` `ai_cost`

- 列の追加は `ensureSchema` の `ALTER TABLE`（失敗は無視）で行います。
- `messages` の主な列：`sender`（me / char / narr）、`image`、`retracted`、`reaction`、`reply_to`（引用返信）、`kind`（call＝不在着信）、`speaker`（グループで話した子）、`face`（裏のセリフの立ち絵の表情。ノベル画面用・第38版）
- `char_state`：キャラごとの毎日の様子を JSON で持っています。
  - 気分、予定表 `plan`、日記、`story`、`project`（長く続けていること）、`condition`（数日続く体調）、ひとこと `statusMsg`／`statusEmoji` など

### kv の主なキー
- 設定と共通：`settings`、`worldbook`（共通の世界観）、`log`（エラー記録30件）、`vapid`、`origin`
- 予約：`reply:` `replygo:` `proj:` `projLast` `ps:`
- スタンプ：`usleep:` `ulater:`
- キャラの性質：`rhythm:`（生活リズム・毎週の習慣）、`jealous:`、`meet:<日付>`（キャラ同士の約束）
- 立ち絵の表情：`faces:<キャラid>`（裏用）・`facesO:<キャラid>`（表＝会う場面用） = [{ name, desc }]（ノベル画面が `POST /faces` で登録。2つ以上のときだけ。画像は持たない）
- 会う約束（試作）：`appt:<キャラid>` = { date, time, place, at, status（set／postponed／replan／meeting／done／missed）, n1, n2, metAt, doneAt, summary }、`meetlog:<キャラid>`（会っている場面の会話。終えたら消す）。キャラ同士の `meet:<日付>` とは別物
- ニュース：`newsKw:` `news:` `newsUsed:`
- AIのクレジット切れ：`aiAlert:gemini` `aiAlert:grok`（料金まわりのエラーで作られ、次に呼び出しが成功すると消える）
- 天気・災害：`weather` `forecast` `air` `dis:state` `disjob:`
- バックアップ：`bk:job` `bk:restore` `bk:lock` `bk:status` `bk:upload` `bk:userdel` `bk:lease` `bk:manual`（最後に手動で保存した日時）

### 主なAPI（すべて `X-App-Token` が必要。`/icon/<id>/<署名>.png` だけは公開）
- 同期：`GET /sync`
- トーク：`POST /send` `/reply` `/reply/decide` `/react`（スタンプ） `/read` `/clear` `/messages/delete`
- キャラとグループ：`POST /char`、`DELETE /char`、`POST /group`、`DELETE /group`
- TL：`GET /tl`、`POST /tl/post`（写真可） `/tl/comment` `/tl/like` `/tl/delete` `/tl/clear`
- くらし：`GET /life`、`POST /memory/delete`、`GET/POST /world`、`GET /disaster`、`POST /outage`
- 写真：`GET /img`、`POST /img/replace`（キャラの写真のPNGをJPEGに差し替え）
- 立ち絵の表情（ノベル画面から）：`POST /faces` { charId, kind:'ura'|'omote', faces:[{name, desc}] }（1つ以下なら消す）
- 会う約束（試作）：`GET /meet?charId=`、`POST /meet/start`（会えた場面から始める）・`/meet/say`・`/meet/end`（まとめを `memories` の fact に）、`POST /appt` { action:'cancel'|'replan' }。`/sync` に `appts`
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
node --no-warnings tests/run-all.mjs            # 全部（今は26本）
node --no-warnings tests/run-all.mjs t_group     # 名前で絞る
```
- 本物のAI・D1・通知にはつながりません（`tests/fake.mjs` の偽物を使います）。鍵も不要です。
- `run-all.mjs` は `server/worker.js` に `export` を足した写し `tests/worker.mjs`（git管理外）を作り、時計を日本時間14時ごろにずらして（`daytime.mjs`）1本ずつ動かします。
- **注意**：`node --check server/worker.js` は、文法の誤りを見逃すことがあります（ESMの `.js` だと終了コード0になる）。確かめるときは `.mjs` に写してから `node --check` してください。テストは `.mjs` を読むので、誤りがあれば全部失敗して気づけます。
- 画面の確認には Playwright（Chromium）を使っていました（作業場所の一時ファイルで、リポジトリには入っていません）。

## 6. よくある落とし穴
- 表のトークが急に動かなくなったら、まず設定の「診断情報をコピー」の「サーバーの記録」を見ます。
  - `Gemini 402 … prepayment credits are depleted` などは、AIのクレジット切れです。プログラムの不具合ではありません。
  - 第34版から、一覧とトーク画面の上に赤い帯が出て、1日1回通知も届きます。チャージすれば自動で元に戻ります。
- GitHub Pages は HTML を10分ほどキャッシュさせます。公開直後にホーム画面のアプリが古いままになるので、`chat/sw.js` で画面の読み込み（navigate）だけ毎回サーバーに確かめる（`cache: 'no-cache'`）ようにしました（第40版の補足）。新しい sw.js が効くのは、入ったあと次にアプリを開いたときからです。
- `hidden` 属性は、CSSで `display` を指定した要素には効きません。そのため `[hidden]{display:none!important}` を入れてあります。
- テストに日付を直書きすると、日がたつと落ちます。時刻は「今」から相対で作るか、全部固定します。
- 文字列の中の改行は、`\n` と書きます（本物の改行を入れると文法エラーになります）。
- D1 は「読んだ行数」で数えるので、全件を読む問い合わせには索引を付けます（第27版で対応済み）。

## 7. 更新のしかた（いつもの手順）
1. `server/worker.js` と `chat/index.html` を直します。`VERSION` と `APP_VERSION` を同じ版名にします（例：`第34版（YYYY-MM-DD HH:MM:SS 更新・内容）`）。
2. 必要ならテストを足して、`node --no-warnings tests/run-all.mjs` が全部成功するのを確かめます。
3. このメモの「更新履歴」と、変わった節を直します。
4. `main` に push します。すると、画面は GitHub Pages、サーバーは Workers Builds で自動公開されます。
   - **push の前に必ず `git fetch origin main` → `git rebase origin/main`**。このリポジトリには、別の会話のClaude（ノベル風アプリ `akari.html` の担当）も push しています。
   - **force push はしない**。
   - 大きな作業の作りかけは `lab` などの別ブランチに置き、動く区切りで `main` に入れます（`CLAUDE.md`）。
5. iPhone のアプリを閉じて開き直すと、新しい版になります。

### ノベル風アプリとの統合に向けて（作業の前に確認）
- `akari.html`・`akari-icon.png`・`AKARI_HANDOVER.md` は別アプリなので、触らない。
- 統合の計画は `AKARI_HANDOVER.md` §9 にあります。主な内容は次の通りです。
  - 表トーク：会う約束の自動検出と二段構えの通知、トーク画面の帯、会う約束モード
  - 裏トーク：裏タブと会話を共有
  - バックアップ：第37版と同じ形
- 統合ではサーバーに機能を**足す**方針です。既存のAPIや、`messages`・`groups`・`kv` のデータの形を大きく変えるときは、このメモに必ず書きます。
- 「会う約束」「裏の会話やグループ」「バックアップ」まわりを変えるときは、§9 の計画とぶつからないか先に確かめます。
- kv の `meet:<日付>`（キャラ同士の約束）は、ユーザーとの会う約束とは別物として残します。
- ゲーム素材（立ち絵など）は、リポジトリにもサーバーにも置きません（今は自動バックアップにも入れない）。

## 8. まだやっていないこと・保留
- R2 のバインディング（バケット作成待ち。§2）
- 背景画像の着せかえ（相談のみ。キャラごと／共通、表裏別、置き場所をどうするか未定）
- アプリのアイコンの変更（相談のみ。変えたら、ホーム画面から削除して追加し直す必要あり）
- 表の返事の長さ設定（保留）
- ノベル画面との統合は第40版で済み（`AKARI_HANDOVER.md` §9）。`akari.html`（単独のノベル画面）は残してある

## 9. 更新履歴（新しい順）
- **第40版の補足**：`chat/sw.js` で画面（HTML）を毎回サーバーに確かめて開く（公開直後に古い画面が出るのを防ぐ）
- **第40版**：LINE風とノベル画面の統合（段階4）。`chat/novel.html` を追加（試作 `lab/` と同じファイル）。LINE風にも［立ち絵］ボタン・会う約束の帯と設定。通知のタップ先 `MEET_URL` を `chat/novel.html` に（`sw.js` はアプリが開いていればその画面で開き直す）。ノベル画面の会話・設定（素材・AIのキー・合言葉は除く）を `POST /novel/save` で kv `novel:data` に預かる（自動バックアップに入る。急に減ったら `novel:prev` に前のもの）・`GET /novel/data`。ノベルの手動バックアップの記録 `POST /backup/novel-manual`（`bk:novelManual`、`/backup/status` の `novelManual`）。テスト `t_novel`
- **第39版**：会う約束（試作・設定 `meetFeature`、既定オフ）。表の返事を作るとき、ユーザーが話した直後なら `meet_status/date/time/place` も答えてもらい `appt:` に記録（`callOmoteRich` の `opt.meet`）。表のプロンプトに約束の状態（約束あり・忙しくて保留・延期で決め直し・来なかった・会っている・会った内容）を足す（`apptContext`）。会う約束モードは全員（`meetOn`）とキャラごと（`meetOffChars`）。オンに戻すと延期中の約束を `replan` に。二段の通知（`runAppointments`）。会う場面（ノベル画面の表トーク）の返事は表のAIで、トークの最近の会話・くらしを渡す（`meetReply`）。終えたら要約を記憶に（`meetEnd`）。`chat/sw.js` は通知の `url` を開く。画面は `lab/index.html`（帯・設定）と `lab/novel.html`（表トーク）だけ。テスト `t_meet`
- **第38版**：裏の返事に立ち絵の表情（ノベル画面用）。ノベル画面が `POST /faces` で表情の名前・説明を登録したキャラだけ、裏の返事（1人・グループ）でAIにセリフの先頭へ《表情名》を付けてもらい、保存時に外して `messages.face` に入れる（`/sync`・`/reply` で返す。次の会話ではAIに《》付きで渡す）。表情が無いキャラ・表は今までどおり。LINE風の画面には出ない。テスト `t_faces`
- **第37版**：手動バックアップの欄に「最後に手動で保存した日時」を表示（保存し終えたときにサーバーへ記録）
- **第36版**：見回りをキャラごとに13分の中でずらす（投稿・スタンプ・もらいそびれた返事が重なりにくく）。TLの反応は毎分実行
- **第35版**：裏のグループに「グループ設定（AIだけが読む）」と「メンバーごとの立場」を追加（グループ側を優先）
- **第34版**：AIのクレジット切れ・利用上限を見つけたら、一覧とトーク画面に赤い帯で表示し、1日1回通知（直れば自動で消える）
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
