// =====================================================================
//  キャラチャット サーバー（Cloudflare Workers）
//  必要な設定（Cloudflareの画面で設定）:
//    ・D1データベース を「DB」という名前で結び付ける
//    ・シークレット GEMINI_API_KEY … GeminiのAPIキー
//    ・シークレット APP_TOKEN      … アプリとサーバーの合言葉（自分で決めた文字列）
//    ・（任意）変数 GEMINI_MODEL   … 使うモデル名。未設定なら gemini-flash-latest
//    ・（Grokを使うとき）シークレット XAI_API_KEY … xAI（Grok）のAPIキー
//    ・（任意）変数 XAI_MODEL      … Grokのモデル名。アプリの設定画面で指定したものが優先
//    ※ Gemini / Grok は「表」「裏」それぞれアプリの設定画面で選ぶ（既定：表＝Gemini、裏＝Grok）
//    ※ 裏（実際に会う場面）の会話は char_id に「#ura」を付けて保存し、表とは履歴・既読を完全に分ける
//    ※ タイムライン（TL）も表と裏で完全に別（tl_posts.world が 'omote' / 'ura'）。AIは各世界の設定に従う。通知は表のTLだけ
//    ※ 表で話題を切り替えるとき、ときどき Google ニュース（RSS）からキャラが興味を持ちそうな最近のニュースを探して話題にする
//    ・Cron トリガー  * * * * *  （毎分。実際に動くのは13分おき）
// =====================================================================

const VERSION = '第34版（2026-10-26 23:59:00 更新・AIのクレジット切れの表示）';
const DEFAULT_MODEL = 'gemini-flash-latest';
const DEFAULT_GROK_MODEL = 'grok-4.7';                 // X（Twitter）の Grok と同じ最新世代
const FALLBACK_GROK_MODEL = 'grok-4-fast-non-reasoning'; // 上が使えないときの予備
const JST = 9 * 3600 * 1000;
const TICK_MIN = 13;              // 起きる間隔（分）。Cronは毎分鳴らし、ちょうど13分ごとのときだけ動く
const MAX_UNREAD = 8;             // 未読がこれ以上たまったら送らない
const REPLY_WAIT = 90 * 1000;
const URA = '#ura';              // 裏タブの会話は char_id にこれを付けて別に保存する     // ユーザーの送信後、アプリが返信を取りに来なかった場合にサーバーが代わりに返すまでの時間

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-App-Token',
  'Access-Control-Max-Age': '86400',
};

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    try {
      if (!env.DB) throw new HttpError(500, 'D1データベースが「DB」という名前で結び付けられていません');
      if (!env.APP_TOKEN) throw new HttpError(500, 'シークレット APP_TOKEN（合言葉）が設定されていません');
      // Barkの通知に出すキャラのアイコン（推測できない長い名前のアドレスだけ、合言葉なしで見られる）
      const im = url.pathname.match(/^\/icon\/([\w-]{1,64})\/([0-9a-f]{32})\.png$/);
      if (req.method === 'GET' && im) return await publicIcon(env, im[1], im[2]);
      if (req.headers.get('X-App-Token') !== env.APP_TOKEN) throw new HttpError(401, '合言葉が違います');
      if (ctx && ctx.waitUntil) ctx.waitUntil(rememberOrigin(env, url.origin).catch(() => {}));
      await ensureSchema(env);
      // バックアップから戻しているあいだは、ほかの操作を止める（途中の状態に書き込まないように）
      if (!url.pathname.startsWith('/backup/') && await kvGet(env, 'bk:lock', 0)) throw new HttpError(503, 'バックアップから戻している最中です。終わるまでお待ちください');
      const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
      return await route(req.method + ' ' + url.pathname, url, body, env, ctx);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.status || 500);
    }
  },

  async scheduled(event, env, ctx) {
    // Cronの書き方では「13分ごと」をぴったり指定できないので、毎分呼ばれて13分おきのときだけ動く
    const minute = Math.floor(Number(event && event.scheduledTime) / 60000);
    if (env.BACKUP) {
      const locked = await kvGet(env, 'bk:lock', 0).catch(() => 0);
      ctx.waitUntil(backupStep(env, { cron: true }).catch((e) => log(env, 'バックアップ: ' + e.message))); // 月2回の自動バックアップ・戻す作業の続き
      if (locked) return; // 戻しているあいだは、返事も話しかけも止める
    }
    ctx.waitUntil(runDueReplies(env).catch((e) => log(env, 'あとで返す返事: ' + e.message))); // 予約した返事は毎分確認（軽い）
    ctx.waitUntil(runDueProactive(env).catch((e) => log(env, '自動送信: ' + e.message))); // 時間をずらした話しかけ
    ctx.waitUntil(runDuePostscripts(env).catch((e) => log(env, '追伸: ' + e.message))); // 追伸・不在着信のあとの言葉
    ctx.waitUntil(runDisasters(env, minute).catch((e) => log(env, '災害の確認: ' + e.message))); // 地震・速報は毎分、ほかは間をあけて確認
    if (Number.isFinite(minute) && minute % TICK_MIN !== 0) return;
    ctx.waitUntil(tick(env).catch((e) => log(env, 'tick全体: ' + e.message)));
  },
};

// ---------------------------------------------------------------- DB
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS chars (id TEXT PRIMARY KEY, data TEXT NOT NULL, icon TEXT, icon_ver INTEGER DEFAULT 0, created INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, char_id TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_msg_char ON messages(char_id, id)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS reads (char_id TEXT PRIMARY KEY, at INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, data TEXT NOT NULL, created INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS ura_icons (char_id TEXT PRIMARY KEY, icon TEXT, ver INTEGER NOT NULL)'), // 裏のアイコン
    // タイムライン
    env.DB.prepare('CREATE TABLE IF NOT EXISTS tl_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, world TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, planned INTEGER NOT NULL DEFAULT 0)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tl_posts ON tl_posts(world, id)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS tl_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, world TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, reply_to INTEGER, at INTEGER NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tl_comments ON tl_comments(post_id, id)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS tl_likes (post_id INTEGER NOT NULL, author TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (post_id, author))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS tl_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, world TEXT NOT NULL, char_id TEXT NOT NULL, kind TEXT NOT NULL, post_id INTEGER NOT NULL, comment_id INTEGER, due INTEGER NOT NULL, note TEXT)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tl_jobs ON tl_jobs(due)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS me_icons (world TEXT PRIMARY KEY, icon TEXT, ver INTEGER NOT NULL)'), // あなたのTL用アイコン
    // くらし（表）
    env.DB.prepare("CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, char_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, due TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', created INTEGER NOT NULL, followed INTEGER NOT NULL DEFAULT 0)"),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_memories ON memories(char_id, id)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS char_state (char_id TEXT PRIMARY KEY, data TEXT NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS images (id TEXT NOT NULL, part INTEGER NOT NULL, mime TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (id, part))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, data TEXT NOT NULL, created INTEGER)'), // 裏のグループ
    env.DB.prepare('CREATE TABLE IF NOT EXISTS ai_cost (world TEXT NOT NULL, month TEXT NOT NULL, usd REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, tin INTEGER NOT NULL DEFAULT 0, tout INTEGER NOT NULL DEFAULT 0, images INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (world, month))'), // AIの利用料金（目安）
  ]);
  // 既存の messages に写真・送信取り消し用の列を足す（2回目以降は「もうある」で失敗するので無視）
  for (const col of ['image TEXT', 'alt TEXT', 'retracted INTEGER NOT NULL DEFAULT 0', 'retract_at INTEGER', 'reaction TEXT', 'reacted_at INTEGER', 'reply_to INTEGER', 'kind TEXT', 'speaker TEXT']) {
    try { await env.DB.prepare('ALTER TABLE messages ADD COLUMN ' + col).run(); } catch (_) {}
  }
  // TLの投稿に写真を付けられるようにする
  for (const col of ['image TEXT', 'alt TEXT']) {
    try { await env.DB.prepare('ALTER TABLE tl_posts ADD COLUMN ' + col).run(); } catch (_) {}
  }
  // 件数が増えても全件を読み直さないための索引（D1は「読んだ行数」で数えるので、ここが効く）
  await env.DB.batch([
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_msg_rx ON messages(reacted_at) WHERE reacted_at IS NOT NULL'), // 同期：スタンプ
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_msg_rt ON messages(at) WHERE retracted=1'), // 同期：取り消し
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_msg_rtq ON messages(retract_at) WHERE retracted=0 AND retract_at IS NOT NULL'), // 取り消し待ち
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_msg_char_from ON messages(char_id, at) WHERE sender='char'"), // 未読の数
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_msg_me_at ON messages(char_id, at) WHERE sender='me'"), // 最後に話しかけた時刻
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tl_unplanned ON tl_posts(id) WHERE planned=0'), // 反応をまだ決めていない投稿
  ]);
  schemaReady = true;
}

async function kvGet(env, k, def) {
  const r = await env.DB.prepare('SELECT v FROM kv WHERE k=?').bind(k).first();
  return r ? JSON.parse(r.v) : def;
}
async function kvSet(env, k, v) {
  await env.DB.prepare('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, JSON.stringify(v)).run();
}

// ---------------------------------------------------------------- 共通の世界観（全キャラ共通・表裏共通）
// 項目はあとから増やせるように一覧で持つ。今は「舞台」と「用語」
const WORLD_SECTIONS = [
  { key: 'stage', title: '舞台', hint: '物語の舞台・時代・場所・暮らしている施設や部屋の様子など' },
  { key: 'terms', title: '用語', hint: '1行に1つ「用語：説明」の形で' },
];
const WORLD_MAX = 20000; // 1項目あたりの上限（文字）
let worldMemo = null;
async function loadWorld(env) {
  if (worldMemo && Date.now() - worldMemo.at < 60e3) return worldMemo.v;
  const v = await kvGet(env, 'worldbook', {});
  worldMemo = { at: Date.now(), v };
  return v;
}
function normWorld(body) {
  const v = {};
  for (const s of WORLD_SECTIONS) v[s.key] = String((body && body[s.key]) || '').replace(/\r\n?/g, '\n').trim().slice(0, WORLD_MAX);
  return v;
}
// 用語は、量が少なければ全部、多ければ今の話に出てくる言葉の分だけ渡す
function pickTerms(text, ctx) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (text.length <= 1500) return lines.join('\n');
  const c = String(ctx || '');
  return lines.filter((l) => {
    const m = l.match(/^(.+?)\s*[：:]/);
    if (!m) return true; // 「用語：説明」の形でない行は、いつも渡す
    return m[1].split(/[／/、,・]/).map((w) => w.trim()).filter((w) => w.length >= 1).some((w) => c.includes(w));
  }).join('\n');
}
// AIへの指示の先頭に付ける。毎回同じ文章で始まるので、割引（キャッシュ）も効きやすい
async function worldBlock(env, ctx) {
  let w;
  try { w = await loadWorld(env); } catch (_) { return ''; }
  const parts = [];
  for (const s of WORLD_SECTIONS) {
    const t = s.key === 'terms' ? pickTerms(w[s.key] || '', ctx) : (w[s.key] || '').trim();
    if (t) parts.push(`## ${s.title}\n${t}`);
  }
  if (!parts.length) return '';
  return `# 作品の世界観（登場するキャラクター全員に共通。キャラクター個人の設定と食い違うときは個人の設定を優先する）\n${parts.join('\n\n')}\n\n`;
}

async function log(env, msg) {
  try {
    const arr = await kvGet(env, 'log', []);
    arr.push({ at: Date.now(), msg: String(msg).slice(0, 500) });
    await kvSet(env, 'log', arr.slice(-30));
  } catch (_) {}
}

// 表のTLの通知（4項目を個別にオン／オフ）。裏のTLとトークは通知しない
const NOTIFY_DEFAULT = { tlComment: true, tlLike: true, tlCharPost: true, tlReply: true };
const DEFAULT_SETTINGS = {
  quietEnabled: true, quietStart: 1, quietEnd: 7, omoteProvider: 'gemini', uraProvider: 'grok', grokModel: '',
  meName: '', meNameUra: '', meIconVer: 0, meUraIconVer: 0, // あなたのTLでの名前（表・裏）とアイコンの版
  newsEnabled: true, // 表で話題を切り替えるとき、最近のニュースも話題にする
  uraPaused: false, lifeEnabled: true, imagesEnabled: true, delayEnabled: true, disasterEnabled: true, quakeMin: '4', notifyVia: 'web', barkSound: '', yen: 150, cost: {}, birthday: '', // くらし（記憶・毎日の様子など）、写真、あなたの誕生日 MM-DD
  weatherLat: 35.927, weatherLon: 139.604, weatherPlace: '埼玉県さいたま市北区日進町',
};
async function getSettings(env) {
  const s = { ...DEFAULT_SETTINGS, ...(await kvGet(env, 'settings', {})) };
  s.notify = { ...NOTIFY_DEFAULT, ...(s.notify || {}) };
  return s;
}

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

function normChar(c) {
  return {
    id: typeof c.id === 'string' && /^[\w-]{1,64}$/.test(c.id) ? c.id : crypto.randomUUID(),
    name: String(c.name || '名無し').trim().slice(0, 40) || '名無し',
    prompt: String(c.prompt || '').slice(0, 20000),
    perDay: clamp(num(c.perDay, 3), 0, 24),          // 自分から話しかける回数（1日あたりの目安）
    nudgeRate: clamp(num(c.nudgeRate, 50), 0, 100),  // 既読スルー時に催促する確率（％）。残りは別の話題
    maxSplit: clamp(Math.round(num(c.maxSplit, 3)), 1, 5), // 吹き出しの最大数
    typing: ['slow', 'normal', 'fast'].includes(c.typing) ? c.typing : 'normal',
    // 裏（実際に会う場面）用
    uraName: String(c.uraName || '').trim().slice(0, 40),       // 裏での名前（空なら表と同じ）
    uraCharPrompt: String(c.uraCharPrompt || '').slice(0, 20000), // 裏のキャラ設定（空なら表と同じ prompt を使う）
    uraPrompt: String(c.uraPrompt || '').slice(0, 20000),    // 裏だけの追加設定（関係性など）
    uraScene: String(c.uraScene || '').slice(0, 2000),       // いまの場面
    uraNarration: c.uraNarration !== false,                  // ナレーションを入れるか
    uraLength: ['short', 'normal', 'long'].includes(c.uraLength) ? c.uraLength : 'normal', // 裏の返事の長さ：短め／ふつう／長め（小説風）
    uraMaxSplit: clamp(Math.round(num(c.uraMaxSplit, 5)), 1, 8),
    // タイムライン用
    affinity: clamp(Math.round(num(c.affinity, 60)), 0, 100),     // あなたとの仲の良さ
    snsActivity: clamp(Math.round(num(c.snsActivity, 50)), 0, 100), // SNSでの反応のしやすさ
    tlPerDay: clamp(num(c.tlPerDay, 2), 0, 12),                   // 表のTLに自分から投稿する回数（1日の目安）
    uraTlPerDay: clamp(num(c.uraTlPerDay, 1), 0, 12),             // 裏のTLに投稿する回数
    newsKeywords: String(c.newsKeywords || '').slice(0, 200),     // 興味のあるニュースのキーワード（空ならキャラ設定からAIが考える）
    replySpeed: ['fast', 'normal', 'slow'].includes(c.replySpeed) ? c.replySpeed : 'auto', // 返事の早さ：おまかせ（設定から判断）／すぐ返す／ふつう／のんびり
    jealous: ['yes', 'no'].includes(c.jealous) ? c.jealous : 'auto', // 嫉妬する：おまかせ（設定から判断）／する／しない
    birthday: validMD(c.birthday) ? c.birthday : '', // キャラの誕生日 "MM-DD"（空なら決めていない）
    uraOnly: !!c.uraOnly, // 裏だけに登場する（表のトーク・表のTL・くらしには出てこない）
  };
}
function validMD(v) { const m = /^(\d{2})-(\d{2})$/.exec(String(v || '')); return !!m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][+m[1] - 1]; }
const mdText = (md) => `${+md.slice(0, 2)}月${+md.slice(3)}日`;
const bdayLine = (c) => (c.birthday ? `\n（あなたの誕生日：${mdText(c.birthday)}）` : '');
// 誕生日まであと何日か（今日なら0）。うるう年の2/29は、平年は2/28に祝う
function daysToMD(md, now) {
  const today = jstDay(now), y = +today.slice(0, 4);
  for (const yy of [y, y + 1]) {
    let d = `${yy}-${md}`;
    if (md === '02-29' && !(yy % 4 === 0 && (yy % 100 !== 0 || yy % 400 === 0))) d = `${yy}-02-28`;
    const n = dayDiff(today, d);
    if (n >= 0) return n;
  }
  return 999;
}

// "abc#ura" → { base: 'abc', world: 'ura', key: 'abc#ura' }
function splitCid(cid) {
  const s = String(cid || '');
  const ura = s.endsWith(URA);
  const base = ura ? s.slice(0, -URA.length) : s;
  return { base, world: ura ? 'ura' : 'omote', key: ura ? base + URA : base };
}

const CHAR_COLS = 'c.id,c.data,c.icon_ver,c.created,u.ver AS ura_ver FROM chars c LEFT JOIN ura_icons u ON u.char_id=c.id';
const rowToChar = (r) => ({ ...JSON.parse(r.data), id: r.id, iconVer: r.icon_ver || 0, uraIconVer: r.ura_ver || 0, created: r.created });
async function loadChars(env) {
  const { results } = await env.DB.prepare(`SELECT ${CHAR_COLS} ORDER BY c.created`).all();
  return results.map(rowToChar);
}
// 裏のグループ（id は "grp-" で始まる）
const isGroupId = (id) => String(id || '').startsWith('grp-');
function normGroup(g) {
  return {
    id: typeof g.id === 'string' && /^grp-[\w-]{1,60}$/.test(g.id) ? g.id : 'grp-' + crypto.randomUUID(),
    name: String(g.name || '').trim().slice(0, 40) || 'グループ',
    members: [...new Set((Array.isArray(g.members) ? g.members : []).map(String))].slice(0, 10),
    synopsis: String(g.synopsis || '').slice(0, 6000),        // あらすじ（物語の導入）
    narration: g.narration !== false,                          // ナレーションを入れるか
    length: ['short', 'normal', 'long'].includes(g.length) ? g.length : 'normal',
    maxSplit: clamp(Math.round(num(g.maxSplit, 6)), 2, 12),   // 1回の返事の吹き出しの最大数
  };
}
async function loadGroups(env) {
  const { results } = await env.DB.prepare('SELECT id,data,created FROM groups ORDER BY created').all();
  return results.map((r) => ({ ...JSON.parse(r.data), id: r.id, created: r.created }));
}
async function getGroup(env, id) {
  const r = await env.DB.prepare('SELECT id,data,created FROM groups WHERE id=?').bind(String(id || '')).first();
  if (!r) throw new HttpError(404, 'グループが見つかりません');
  return { ...JSON.parse(r.data), id: r.id, created: r.created };
}
// トークの相手（キャラかグループ）を確かめる。グループは裏だけ
async function getOwner(env, base, world) {
  if (isGroupId(base)) {
    if (world !== 'ura') throw new HttpError(400, 'グループは裏のトークだけです');
    return { group: await getGroup(env, base) };
  }
  const char = await getChar(env, base);
  if (world === 'omote' && char.uraOnly) throw new HttpError(400, 'このキャラは裏だけに登場します');
  return { char };
}
const inOmote = (c) => !c.uraOnly; // 表に登場するキャラか

async function getChar(env, id) {
  const r = await env.DB.prepare(`SELECT ${CHAR_COLS} WHERE c.id=?`).bind(String(id || '')).first();
  if (!r) throw new HttpError(404, 'キャラが見つかりません');
  return rowToChar(r);
}
const rowToMsg = (r) => ({ id: r.id, charId: r.char_id, sender: r.sender, text: r.retracted ? '' : r.text, at: r.at,
  ...(r.image && !r.retracted ? { image: r.image } : {}), ...(r.alt ? { alt: r.alt } : {}), ...(r.retracted ? { retracted: 1, origText: r.text } : {}),
  ...(r.reaction ? { reaction: r.reaction, reactedAt: r.reacted_at || 0 } : {}),
  ...(r.reply_to ? { replyTo: r.reply_to } : {}), ...(r.kind ? { kind: r.kind } : {}), ...(r.speaker ? { speaker: r.speaker } : {}) });
const MSG_COLS = 'id,char_id,sender,text,at,image,alt,retracted,reaction,reacted_at,reply_to,kind,speaker';

// ---------------------------------------------------------------- スタンプ（表のトークだけ）
// キャラの吹き出しにはユーザーが、ユーザーの吹き出しにはキャラが付ける（1つのメッセージに1つ）
const STAMPS = {
  '👍': { close: 1, user: '了解。この話題はここで一区切り', char: 'ユーザーの話に納得したとき、話が自然に終わったとき（了解・一区切り）' },
  '❤️': { close: 1, user: 'この話題はここで一区切り。そこに好意（楽しみにしてる・ありがとう・好きだよ、など。どれかは前後の会話から読み取る）が込められている', char: '一区切りに、楽しみ・感謝・好き などの好意的な気持ちを込めたいときだけ' },
  '😴': { close: 1, user: '眠い・もう寝る（この話はここで一区切り。朝まで話しかけを控えてほしい）', char: '眠くなった・もう寝るとき' },
  '🏃': { later: 1, user: '今は忙しい。あとで返事する（しばらく待っていてほしい）', char: '手が離せないときにメッセージを読んだ。あとで返す' },
  '👀': { cont: 1, user: 'その話、気になる。続きや詳しいことを聞かせてほしい', char: 'ユーザーの話に興味を持って、続きを聞きたいとき' },
  '❓': { cont: 1, user: 'よくわからない。言い方を変えてもう一度説明してほしい', char: 'ユーザーの言ったことがわからなかったとき' },
  '😂': { cont: 1, user: '笑った・面白かった', char: 'ユーザーの話が面白かったとき' },
  '🥺': { cont: 1, user: 'さみしい・かまってほしい・寄り添ってほしい', char: 'さみしいとき、かまってほしいとき（返事がしばらく来ないときの、控えめな「かまって」）' },
  '🙏': { cont: 1, user: 'ごめんね・お願い', char: '謝るとき、お願いがあるとき' },
};
const stampLine = (r, who) => `${r}（${STAMPS[r] ? STAMPS[r][who] : ''}）`;
async function setReaction(env, id, r) {
  await env.DB.prepare('UPDATE messages SET reaction=?, reacted_at=? WHERE id=?').bind(r || null, Date.now(), id).run();
}
// ユーザーが最後のキャラのメッセージに付けたスタンプ（付けて30分以内）
function lastUserStamp(hist, now, within = 30 * MIN) {
  const last = hist[hist.length - 1];
  if (!last || last.sender !== 'char' || !last.reaction) return null;
  if (within && now - (last.reactedAt || 0) > within) return null;
  return last.reaction;
}

async function recent(env, charId, n) {
  const { results } = await env.DB.prepare(`SELECT ${MSG_COLS} FROM messages WHERE char_id=? ORDER BY id DESC LIMIT ?`).bind(charId, n).all();
  return results.reverse().map(rowToMsg);
}
async function getRead(env, charId) {
  const r = await env.DB.prepare('SELECT at FROM reads WHERE char_id=?').bind(charId).first();
  return r ? r.at : 0;
}
async function setRead(env, charId, at) {
  await env.DB.prepare('INSERT INTO reads (char_id,at) VALUES (?,?) ON CONFLICT(char_id) DO UPDATE SET at=MAX(reads.at, excluded.at)').bind(charId, at).run();
}
async function totalUnread(env) {
  // 表の未読（キャラごとに、既読の時刻より新しいキャラの発言だけを索引で数える）
  const r = await env.DB.prepare("SELECT SUM((SELECT COUNT(*) FROM messages m WHERE m.char_id=c.id AND m.sender='char' AND m.at > COALESCE((SELECT at FROM reads WHERE char_id=c.id),0))) AS n FROM chars c").first();
  return r ? r.n : 0;
}

// ---------------------------------------------------------------- ルート
async function route(key, url, body, env, ctx) {
  switch (key) {
    case 'GET /ping': {
      const subs = await env.DB.prepare('SELECT COUNT(*) AS n FROM subs').first();
      const st = await getSettings(env);
      return json({
        ok: true, version: VERSION,
        omoteProvider: st.omoteProvider, uraProvider: st.uraProvider,
        omoteModel: modelFor(env, st, 'omote'), uraModel: modelFor(env, st, 'ura'),
        model: modelFor(env, st, 'omote'),
        geminiModel: env.GEMINI_MODEL || DEFAULT_MODEL, grokModel: grokModelFor(env, st),
        hasGeminiKey: !!env.GEMINI_API_KEY, hasXaiKey: !!env.XAI_API_KEY, subs: subs.n,
        log: await kvGet(env, 'log', []), lastTick: await kvGet(env, 'lastTick', null),
      });
    }

    case 'GET /sync': {
      await applyRetracts(env); // 時間が来た送信取り消しを先に反映
      const since = num(url.searchParams.get('since'), 0);
      const chars = await loadChars(env);
      let messages = [], more = false;
      if (since <= 0) {
        for (const c of chars) {
          messages.push(...(await recent(env, c.id, 200)));
          messages.push(...(await recent(env, c.id + URA, 200)));
        }
        for (const g of await loadGroups(env)) messages.push(...(await recent(env, g.id + URA, 200)));
      } else {
        const { results } = await env.DB.prepare(`SELECT ${MSG_COLS} FROM messages WHERE id>? ORDER BY id LIMIT 501`).bind(since).all();
        more = results.length > 500;
        messages = results.slice(0, 500).map(rowToMsg);
      }
      const { results: rr } = await env.DB.prepare('SELECT char_id,at FROM reads').all();
      const reads = Object.fromEntries(rr.map((r) => [r.char_id, r.at]));
      const { results: rt } = await env.DB.prepare('SELECT id FROM messages WHERE retracted=1 AND at>?').bind(Date.now() - 7 * 864e5).all();
      // スタンプ（付けた・外した）を7日分
      const { results: rx } = await env.DB.prepare('SELECT id,reaction FROM messages WHERE reacted_at>?').bind(Date.now() - 7 * 864e5).all();
      const reactions = Object.fromEntries(rx.map((r) => [r.id, r.reaction || '']));
      // 表：返事はまだだけど、もう読んだ（既読だけ付いている）
      const charRead = {};
      const { results: pr } = await env.DB.prepare("SELECT v FROM kv WHERE k >= 'reply:' AND k < 'reply;'").all();
      for (const r of pr) { try { const p = JSON.parse(r.v); if (p.readAt <= Date.now()) charRead[p.key] = p.readAt; } catch (_) {} }
      // アプリの表示用に、記憶ではない原文は返さない
      messages = messages.map((m) => { const { origText, ...rest } = m; return rest; });
      const dis = await kvGet(env, 'dis:state', null);
      // プロフィールのひとこと・アイコンの絵文字（表）
      const status = {};
      if ((await getSettings(env)).lifeEnabled) {
        const { results: ss } = await env.DB.prepare("SELECT char_id, json_extract(data,'$.statusMsg') AS m, json_extract(data,'$.statusEmoji') AS e FROM char_state").all();
        for (const r of ss) if (r.m || r.e) status[r.char_id] = { msg: r.m || '', emoji: r.e || '' };
      }
      return json({ chars, groups: await loadGroups(env), aiAlerts: await aiAlerts(env), messages, more, reads, charRead, reactions, status, cost: await costSummary(env).catch(() => null), outage: dis && dis.outage ? dis.outage : null, retracted: rt.map((r) => r.id), settings: await getSettings(env), now: Date.now(), version: VERSION });
    }

    // ---- 裏のグループ
    case 'POST /group': { // 作る・変える
      const old = body.group && body.group.id && isGroupId(body.group.id) ? await env.DB.prepare('SELECT created FROM groups WHERE id=?').bind(body.group.id).first() : null;
      const g = normGroup({ ...(body.group || {}), id: old ? body.group.id : undefined });
      const chars = await loadChars(env);
      g.members = g.members.filter((id) => chars.some((c) => c.id === id));
      if (!g.members.length) throw new HttpError(400, 'メンバーを1人以上選んでください');
      const { id, ...data } = g;
      await env.DB.prepare('INSERT INTO groups (id,data,created) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').bind(id, JSON.stringify(data), old ? old.created : Date.now()).run();
      return json({ group: await getGroup(env, id) });
    }
    case 'DELETE /group': {
      const id = url.searchParams.get('id') || '';
      if (!isGroupId(id)) throw new HttpError(400, 'グループではありません');
      await noteUserDelete(env);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM groups WHERE id=?').bind(id),
        env.DB.prepare('DELETE FROM messages WHERE char_id=?').bind(id + URA),
        env.DB.prepare('DELETE FROM reads WHERE char_id=?').bind(id + URA),
      ]);
      return json({ ok: true });
    }

    case 'GET /export': return exportAll(env, url.searchParams.get('images') === '1');

    // ---- バックアップ（自動・確認・戻す）
    case 'GET /backup/status': return json(await bkView(env));
    case 'GET /backup/check': return json(await bkIntegrity(env)); // 手動の書き出しのあとの確かめ
    case 'POST /backup/step': { await backupStep(env, {}); return json(await bkView(env)); } // アプリを開いているあいだは早めに進める
    case 'POST /backup/now': { // 今の期間（1日用／15日用）の分を今すぐ取る。force=true なら減っていても保存
      needR2(env);
      if ((await kvGet(env, 'bk:job', null)) || (await kvGet(env, 'bk:restore', null))) throw new HttpError(409, 'バックアップか復元の途中です');
      const c = bkCycle(Date.now());
      if (!(await bkLease(env))) throw new HttpError(409, 'バックアップの準備中です。少し待ってからもう一度');
      try {
        if (body.force) { const st = await bkStatus(env); if (st.cycles && st.cycles[c.cycle]) delete st.cycles[c.cycle].blocked; await kvSet(env, 'bk:status', st); }
        await bkStartJob(env, { kind: 'auto', slot: c.slot, cycle: c.cycle, force: !!body.force });
      } finally { await bkRelease(env); }
      return json(await bkView(env));
    }
    case 'POST /backup/cancel': { // 自動バックアップ中・戻す前の保存中だけ止められる（データを消し始めたら止めない）
      const rs = await kvGet(env, 'bk:restore', null);
      if (rs && rs.phase !== 'snapshot' && rs.phase !== 'verify') throw new HttpError(409, '戻している途中なので止められません。終わるまでお待ちください');
      if (!(await bkLease(env))) throw new HttpError(409, '処理中です。少し待ってからもう一度');
      try {
        const job = await kvGet(env, 'bk:job', null);
        if (job) { await bkDeleteGen(env, job.gen).catch(() => {}); await bkFinishJob(env, job, false, { error: '止めました', cancelled: true }); }
        if (rs) { await env.DB.prepare("DELETE FROM kv WHERE k IN ('bk:restore','bk:lock')").run(); await bkRestoreResult(env, false, '戻すのを止めました（データはそのままです）'); }
      } finally { await bkRelease(env); }
      return json(await bkView(env));
    }
    case 'POST /backup/restore': { // 戻す：まず今の状態を「戻す前の状態」に保存 → 消す → 入れ直す
      needR2(env);
      if (String(body.confirm || '').trim() !== '戻す') throw new HttpError(400, '確認のため「戻す」と入力してください');
      if (await kvGet(env, 'bk:restore', null)) throw new HttpError(409, 'すでに戻している途中です');
      let gen, label;
      if (BK_SLOT_NAME[body.source]) {
        const sl = (await bkSlots(env))[body.source];
        if (!sl) throw new HttpError(404, BK_SLOT_NAME[body.source] + 'のバックアップはまだありません');
        gen = sl.gen; label = BK_SLOT_NAME[body.source] + `（${jstDate(sl.at)}）`;
      } else if (body.source === 'upload') {
        const up = await kvGet(env, 'bk:upload', null);
        if (!up || !up.done) throw new HttpError(400, 'ファイルの読み込みが済んでいません');
        gen = up.gen; label = '選んだファイル';
      } else throw new HttpError(400, '戻す元を選んでください');
      const m = await bkManifest(env, gen);
      if (!(await bkLease(env))) throw new HttpError(409, '処理中です。少し待ってからもう一度');
      try {
        const job = await kvGet(env, 'bk:job', null);
        if (job) { await bkDeleteGen(env, job.gen).catch(() => {}); await bkFinishJob(env, job, false, { error: '戻す操作のため中断しました', cancelled: true }); } // 自動バックアップは次の機会に
        await kvSet(env, 'bk:lock', 1);
        // ①戻す元をすべて読んで確かめる → ②今の状態を保存 → ③消す → ④入れ直す
        await kvSet(env, 'bk:restore', { phase: 'verify', vi: 0, srcGen: gen, label, images: !!m.images, parts: m.parts, started: Date.now() });
      } finally { await bkRelease(env); }
      return json(await bkView(env));
    }
    case 'POST /backup/upload/start': { // ファイルから戻す：中身をいったんR2に置く
      needR2(env);
      const old = await kvGet(env, 'bk:upload', null);
      const rs = await kvGet(env, 'bk:restore', null);
      if (old && !(rs && rs.srcGen === old.gen)) await bkDeleteGen(env, old.gen).catch(() => {});
      const gen = 'up-' + new Date(Date.now() + 9 * 3600e3).toISOString().replace(/\D/g, '').slice(0, 14) + '-' + randomAlnum(6);
      await kvSet(env, 'bk:upload', { gen, parts: [], counts: {}, images: !!body.images, done: false });
      return json({ gen });
    }
    case 'POST /backup/upload/part': {
      needR2(env);
      const up = await kvGet(env, 'bk:upload', null);
      if (!up || up.gen !== body.gen || up.done) throw new HttpError(400, '読み込みをやり直してください');
      if (num(body.seq, -1) !== up.parts.length) return json({ ok: true, seq: up.parts.length }); // 送り直し（もう受け取った分）
      const t = String(body.table || '');
      if (!BK_TABLES.includes(t) || !Array.isArray(body.rows) || !body.rows.length) throw new HttpError(400, 'ファイルの中身が正しくありません');
      const key = `${BK_PREFIX}gens/${up.gen}/p${String(up.parts.length).padStart(5, '0')}.json`;
      const { sha, bytes } = await bkPutVerified(env, key, JSON.stringify({ table: t, rows: body.rows }));
      up.parts.push({ key, sha, bytes, table: t, rows: body.rows.length });
      up.counts[t] = (up.counts[t] || 0) + body.rows.length;
      await kvSet(env, 'bk:upload', up);
      return json({ ok: true, seq: up.parts.length });
    }
    case 'POST /backup/upload/finish': {
      needR2(env);
      const up = await kvGet(env, 'bk:upload', null);
      if (!up || up.gen !== body.gen) throw new HttpError(400, '読み込みをやり直してください');
      const want = body.counts || {};
      const bad = Object.keys(want).filter((t) => (up.counts[t] || 0) !== num(want[t], 0));
      if (bad.length) throw new HttpError(400, '受け取った件数が合いません（' + bad.join('・') + '）。もう一度お試しください');
      if (!up.counts.chars) throw new HttpError(400, 'キャラが1人も入っていないファイルです');
      await bkPutVerified(env, `${BK_PREFIX}gens/${up.gen}/manifest.json`, JSON.stringify({ app: 'トーク', version: String(body.version || ''), at: num(body.exportedAt, Date.now()), kind: 'upload', images: up.images, counts: up.counts, parts: up.parts }));
      up.done = true;
      await kvSet(env, 'bk:upload', up);
      return json({ ok: true, counts: up.counts });
    }
    case 'GET /backup/download': { // 自動バックアップをiPhoneに保存
      needR2(env);
      const slot = url.searchParams.get('slot') || '';
      const sl = BK_SLOT_NAME[slot] && (await bkSlots(env))[slot];
      if (!sl) throw new HttpError(404, 'そのバックアップはまだありません');
      return bkDownload(env, sl.gen, url.searchParams.get('images') === '1', { a: '1st', b: '15th', pre: 'before-restore' }[slot]);
    }

    case 'POST /img/replace': { // キャラの写真（PNG）を、アプリで作ったJPEGに差し替えて軽くする
      if (await kvGet(env, 'bk:job', null)) return json({ skip: 'busy' }); // バックアップ中は後回し
      const id = String(body.id || '');
      const { results } = await env.DB.prepare('SELECT part,mime,length(data) AS n FROM images WHERE id=? ORDER BY part').bind(id).all();
      if (!results.length) throw new HttpError(404, '写真が見つかりません');
      if (results[0].mime !== 'image/png') return json({ skip: 'not-png' });
      const m = String(body.data || '').match(/^data:image\/jpeg;base64,(\/9j\/[A-Za-z0-9+/=]+)$/); // JPEGの頭（FF D8 FF）で始まること
      if (!m) throw new HttpError(400, 'JPEGの形式が正しくありません');
      const oldLen = results.reduce((a, r) => a + r.n, 0);
      if (m[1].length >= oldLen * 0.9) return json({ skip: 'not-smaller' });
      const stmts = [];
      for (let i = 0, n = 0; i < m[1].length; i += IMG_CHUNK, n++) {
        const part = m[1].slice(i, i + IMG_CHUNK);
        stmts.push(n < results.length
          ? env.DB.prepare("UPDATE images SET mime='image/jpeg', data=? WHERE id=? AND part=?").bind(part, id, n)
          : env.DB.prepare("INSERT INTO images (id,part,mime,data) VALUES (?,?,'image/jpeg',?)").bind(id, n, part));
      }
      stmts.push(env.DB.prepare('DELETE FROM images WHERE id=? AND part>=?').bind(id, Math.ceil(m[1].length / IMG_CHUNK)));
      await env.DB.batch(stmts);
      return json({ ok: true, before: oldLen, after: m[1].length });
    }

    case 'GET /icons': {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 50);
      if (!ids.length) return json({ icons: {} });
      // 「id#ura」は裏のアイコン
      const icons = {};
      // 「@me」「@me#ura」は、あなたのTL用アイコン
      for (const id of ids.filter((i) => i.startsWith('@me'))) {
        const w = id.endsWith(URA) ? 'ura' : 'omote';
        const r = await env.DB.prepare('SELECT icon,ver FROM me_icons WHERE world=?').bind(w).first();
        icons[id] = { ver: r ? r.ver : 0, data: r ? r.icon : null };
      }
      const charIds = ids.filter((i) => !i.startsWith('@'));
      const omote = charIds.filter((i) => !i.endsWith(URA)), ura = charIds.filter((i) => i.endsWith(URA)).map((i) => i.slice(0, -URA.length));
      if (omote.length) {
        const { results } = await env.DB.prepare(`SELECT id,icon,icon_ver FROM chars WHERE id IN (${omote.map(() => '?').join(',')})`).bind(...omote).all();
        for (const r of results) icons[r.id] = { ver: r.icon_ver || 0, data: r.icon || null };
      }
      if (ura.length) {
        const { results } = await env.DB.prepare(`SELECT char_id,icon,ver FROM ura_icons WHERE char_id IN (${ura.map(() => '?').join(',')})`).bind(...ura).all();
        for (const id of ura) icons[id + URA] = { ver: 0, data: null };
        for (const r of results) icons[r.char_id + URA] = { ver: r.ver || 0, data: r.icon || null };
      }
      return json({ icons });
    }

    case 'POST /char': {
      const src = body.char || {};
      const c = normChar(src);
      const exists = await env.DB.prepare('SELECT id FROM chars WHERE id=?').bind(c.id).first();
      if (exists) await env.DB.prepare('UPDATE chars SET data=? WHERE id=?').bind(JSON.stringify(c), c.id).run();
      else await env.DB.prepare('INSERT INTO chars (id,data,icon_ver,created) VALUES (?,?,0,?)').bind(c.id, JSON.stringify(c), Date.now()).run();
      if (typeof src.icon === 'string' && src.icon.startsWith('data:image/')) {
        if (src.icon.length > 500000) throw new HttpError(400, 'アイコン画像が大きすぎます');
        await env.DB.prepare('UPDATE chars SET icon=?, icon_ver=? WHERE id=?').bind(src.icon, Date.now(), c.id).run();
      } else if (src.icon === null) {
        await env.DB.prepare('UPDATE chars SET icon=NULL, icon_ver=? WHERE id=?').bind(Date.now(), c.id).run();
      }
      if (typeof src.uraIcon === 'string' && src.uraIcon.startsWith('data:image/')) {
        if (src.uraIcon.length > 500000) throw new HttpError(400, '裏のアイコン画像が大きすぎます');
        await env.DB.prepare('INSERT INTO ura_icons (char_id,icon,ver) VALUES (?,?,?) ON CONFLICT(char_id) DO UPDATE SET icon=excluded.icon, ver=excluded.ver').bind(c.id, src.uraIcon, Date.now()).run();
      } else if (src.uraIcon === null) {
        await env.DB.prepare('DELETE FROM ura_icons WHERE char_id=?').bind(c.id).run();
      }
      return json({ char: await getChar(env, c.id) });
    }

    case 'DELETE /char': {
      const id = url.searchParams.get('id') || '';
      await noteUserDelete(env);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM chars WHERE id=?').bind(id),
        env.DB.prepare('DELETE FROM kv WHERE k IN (?,?,?,?,?)').bind('reply:' + id, 'rhythm:' + id, 'jealous:' + id, 'proj:' + id, 'ps:' + id),
        env.DB.prepare('DELETE FROM messages WHERE char_id=? OR char_id=?').bind(id, id + URA),
        env.DB.prepare('DELETE FROM reads WHERE char_id=? OR char_id=?').bind(id, id + URA),
        env.DB.prepare('DELETE FROM ura_icons WHERE char_id=?').bind(id),
        // タイムライン：このキャラの投稿（とそれへのコメント・いいね）、コメント、いいね、予定
        env.DB.prepare('DELETE FROM tl_comments WHERE post_id IN (SELECT id FROM tl_posts WHERE author=?)').bind(id),
        env.DB.prepare('DELETE FROM tl_likes WHERE post_id IN (SELECT id FROM tl_posts WHERE author=?)').bind(id),
        env.DB.prepare('DELETE FROM tl_jobs WHERE char_id=? OR post_id IN (SELECT id FROM tl_posts WHERE author=?)').bind(id, id),
        env.DB.prepare('DELETE FROM tl_posts WHERE author=?').bind(id),
        env.DB.prepare('DELETE FROM tl_comments WHERE author=?').bind(id),
        env.DB.prepare('DELETE FROM tl_likes WHERE author=?').bind(id),
      ]);
      for (const g of await loadGroups(env)) if (g.members.includes(id)) {
        const { id: gid, created, ...data } = g;
        await env.DB.prepare('UPDATE groups SET data=? WHERE id=?').bind(JSON.stringify({ ...data, members: g.members.filter((x) => x !== id) }), gid).run();
      }
      return json({ ok: true });
    }

    case 'POST /clear': { // 表・裏それぞれ別に消す（charId に #ura が付いていれば裏）
      const { base, world, key } = splitCid(body.charId);
      await noteUserDelete(env);
      await getOwner(env, base, world);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM messages WHERE char_id=?').bind(key),
        env.DB.prepare('DELETE FROM reads WHERE char_id=?').bind(key),
        env.DB.prepare('DELETE FROM kv WHERE k IN (?,?,?)').bind('reply:' + key, 'proj:' + key, 'ps:' + key),
      ]);
      return json({ ok: true });
    }

    case 'GET /disaster': { // 災害・停電の様子（設定画面用）
      const s = await disLoad(env);
      const now = Date.now();
      return json({
        outage: s.outage || null,
        saga: s.saga ? { type: s.saga.type, name: s.saga.name, phase: s.saga.phase } : null,
        recent: (s.events || []).filter((e) => now - e.at < 3 * 864e5).map((e) => ({ type: e.type, at: e.at, level: e.level || '', phase: e.phase || '', outcome: e.outcome || '', sim: !!e.sim })).slice(-6),
        checks: { quake: s.mon && s.mon.quakeOk || 0, forecast: s.mon && s.mon.fcOk || 0, warn: s.mon && s.mon.warnOk || 0, typhoon: s.mon && s.mon.tcOk || 0, news: s.mon && s.mon.newsOk || 0, tepcoBad: !!(s.mon && s.mon.tepcoBad) },
      });
    }

    case 'POST /outage': { // 停電中の切り替え（手動）
      const st = await getSettings(env);
      const s = await disLoad(env);
      const now = Date.now(), evs = [];
      setOutage(s, !!body.on, 'manual', null, now, evs);
      if (disOn(st)) for (const ev of evs) await addEvent(env, st, s, ev, now);
      await disSave(env, s);
      return json({ ok: true, outage: s.outage || null });
    }

    case 'POST /disaster/test': { // テスト：模擬の災害（反応は早め）
      const st = await getSettings(env);
      if (!disOn(st)) throw new HttpError(400, '設定で「くらし」と「災害・停電」をオンにしてください');
      const s = await disLoad(env);
      const now = Date.now();
      const t = String(body.type || '');
      const map = {
        quake: { type: 'quake', scale: 45, level: '5弱', place: '埼玉県南部' },
        eew_false: { type: 'eew', eid: 'test' + now, place: '', simOutcome: 'false' },
        typhoon: { type: 'typhoon', phase: body.phase || 'hit', name: '台風', days: 2 },
        snow: { type: 'snow', phase: 'hit', name: '雪' },
        rain: { type: 'rain', detail: '1時間に50ミリほどの激しい雨' },
      };
      if (!map[t]) throw new HttpError(400, 'テストの種類が正しくありません');
      const ev = { ...map[t], at: now, sim: true };
      await addEvent(env, st, s, ev, now);
      if (ev.simOutcome) { ev.testResolveAt = now + 90e3; }
      await disSave(env, s);
      return json({ ok: true });
    }

    case 'GET /world': { // 共通の世界観
      return json({ world: normWorld(await loadWorld(env)), sections: WORLD_SECTIONS, max: WORLD_MAX });
    }

    case 'POST /world': {
      const v = normWorld(body.world || {});
      await kvSet(env, 'worldbook', v);
      worldMemo = { at: Date.now(), v };
      return json({ ok: true, world: v });
    }

    case 'POST /messages/delete': { // 選んだメッセージだけ消す（表・裏それぞれ）
      const { base, world, key } = splitCid(body.charId);
      await noteUserDelete(env);
      await getOwner(env, base, world);
      const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((x) => num(x, 0)).filter((x) => x > 0))].slice(0, 2000);
      if (!ids.length) throw new HttpError(400, '消すメッセージが選ばれていません');
      let deleted = 0;
      for (let i = 0; i < ids.length; i += 90) { // D1 のパラメータ数の上限に合わせて分ける
        const part = ids.slice(i, i + 90);
        const qs = part.map(() => '?').join(',');
        const { results: imgs } = await env.DB.prepare(`SELECT image FROM messages WHERE char_id=? AND image IS NOT NULL AND id IN (${qs})`).bind(key, ...part).all();
        for (const im of imgs) await env.DB.prepare('DELETE FROM images WHERE id=?').bind(im.image).run(); // 写真も一緒に消す
        const r = await env.DB.prepare(`DELETE FROM messages WHERE char_id=? AND id IN (${part.map(() => '?').join(',')})`).bind(key, ...part).run();
        deleted += (r.meta && r.meta.changes) || 0;
      }
      return json({ ok: true, deleted });
    }

    case 'POST /send': {
      const { base, world, key } = splitCid(body.charId);
      await getOwner(env, base, world);
      const text = String(body.text || '').trim().slice(0, 4000);
      let image = null;
      if (typeof body.image === 'string' && body.image) {
        if (body.image.length > 4000000) throw new HttpError(400, '写真が大きすぎます');
        image = await saveImage(env, body.image);
      }
      if (!text && !image) throw new HttpError(400, 'メッセージが空です');
      const at = Date.now();
      const r = await env.DB.prepare('INSERT INTO messages (char_id,sender,text,at,image) VALUES (?,?,?,?,?)').bind(key, 'me', text, at, image).run();
      await setRead(env, key, at); // 返信する＝それまでの相手のメッセージは読んだ
      return json({ message: { id: r.meta.last_row_id, charId: key, sender: 'me', text, at, ...(image ? { image } : {}) } });
    }

    case 'POST /reply': {
      const { base, world, key } = splitCid(body.charId);
      if (isGroupId(base)) { // 裏のグループ
        const { group } = await getOwner(env, base, world);
        if ((await getSettings(env)).uraPaused) return json({ messages: [], paused: true });
        const hist = await recent(env, key, 60);
        const last = hist[hist.length - 1];
        if (!(body.start && !hist.length) && (!last || last.sender !== 'me')) return json({ messages: [] }); // start：あらすじから物語を始める
        return json({ messages: await groupReply(env, group, hist, key) });
      }
      const c = (await getOwner(env, base, world)).char;
      const hist = await recent(env, key, 60);
      const last = hist[hist.length - 1];
      const stamp = world === 'omote' ? lastUserStamp(hist, Date.now()) : null; // スタンプへの返事
      if (!last || (last.sender !== 'me' && !(stamp && (STAMPS[stamp].cont || stamp === '😴')))) return json({ messages: [] });
      if (world === 'ura' && (await getSettings(env)).uraPaused) return json({ messages: [], paused: true }); // 裏は止めている（再開したら返す）
      // 表：その子が今していることによって、すぐ返す／あとで返す（あとで返す分はサーバーが毎分確認して送る）
      const d = { mode: 'reply' };
      if (last.sender !== 'me' && stamp) d.stamp = stamp;
      if (world === 'omote' && delayOn(await getSettings(env)) && !d.stamp) {
        const t = await decideReply(env, c, hist, Date.now());
        await env.DB.prepare('DELETE FROM kv WHERE k=?').bind('replygo:' + c.id).run();
        if (!t.now) return json({ messages: [], delayed: true });
        if (t.pend) { // 予約の時間が来ていた
          const claimed = await env.DB.prepare('DELETE FROM kv WHERE k=? RETURNING k').bind('reply:' + c.id).first();
          if (!claimed) return json({ messages: [], delayed: true }); // ほかの処理がもう返している
          d.late = t.pend;
        }
      }
      const msgs = await generateAndStore(env, c, d, hist, await getRead(env, key), world);
      return json({ messages: msgs });
    }

    case 'POST /react': { // スタンプを付ける・外す（表のトークだけ。キャラのメッセージに）
      const { base, world, key } = splitCid(body.charId);
      if (world !== 'omote') throw new HttpError(400, 'スタンプは表のトークだけで使えます');
      await getChar(env, base);
      const r = body.reaction ? String(body.reaction) : null;
      if (r && !STAMPS[r]) throw new HttpError(400, 'そのスタンプは使えません');
      const m = await env.DB.prepare("SELECT id,sender FROM messages WHERE id=? AND char_id=?").bind(num(body.id, 0), key).first();
      if (!m || m.sender !== 'char') throw new HttpError(404, 'キャラのメッセージが見つかりません');
      await setReaction(env, m.id, r);
      const now = Date.now();
      if (r === '😴') { // 寝る：朝まで話しかけを控える
        const st = await getSettings(env);
        const wakeH = st.quietEnabled ? st.quietEnd : 7;
        let t = jstDayStart(jstDay(now)) + wakeH * 3600e3;
        if (t <= now + 2 * 3600e3) t += 864e5;
        await kvSet(env, 'usleep:' + base, t);
      }
      if (r === '🏃') await kvSet(env, 'ulater:' + base, now + 3 * 3600e3); // あとで返す：3時間は催促しない
      // 続ける系は返事をする。寝るときは半分くらい「おやすみ」と短く返す
      const reply = !!(r && (STAMPS[r].cont || (r === '😴' && Math.random() < 0.5)));
      return json({ ok: true, reply });
    }

    case 'POST /reply/decide': { // 表：すぐ返すかどうかだけ先に決める（アプリが「既読」「入力中…」を出すため）
      const { base, world, key } = splitCid(body.charId);
      if (isGroupId(base)) return json({ now: !(await getSettings(env)).uraPaused });
      const c = await getChar(env, base);
      if (world === 'ura' && (await getSettings(env)).uraPaused) return json({ now: false, paused: true });
      if (world !== 'omote' || !delayOn(await getSettings(env))) return json({ now: true });
      const hist = await recent(env, key, 60);
      const last = hist[hist.length - 1];
      if (last && last.sender === 'char' && lastUserStamp(hist, Date.now())) return json({ now: true }); // スタンプへの返事は、その場で
      if (!last || last.sender !== 'me') return json({ now: false });
      const t = await decideReply(env, c, hist, Date.now());
      return json({ now: !!t.now });
    }

    case 'POST /read': {
      const { base, world, key } = splitCid(body.charId);
      await getOwner(env, base, world);
      await setRead(env, key, Date.now());
      return json({ ok: true, badge: await totalUnread(env) });
    }

    case 'POST /poke': { // テスト用：今すぐ自分から話しかけさせる（表のみ）
      const c = (await getOwner(env, splitCid(body.charId).base, 'omote')).char;
      const hist = await recent(env, c.id, 60);
      const lastRead = await getRead(env, c.id);
      let d = decide(c, hist, lastRead, Date.now(), await getSettings(env), true) || { mode: 'topic' };
      if (body.news) d = { mode: 'topic', since: hist.length ? hist[hist.length - 1].at : Date.now(), forceNews: true };
      if (body.flavor) d = { mode: 'topic', since: hist.length ? hist[hist.length - 1].at : Date.now(), flavor: String(body.flavor) };
      if (d.mode === 'topic' && !d.flavor) await attachNews(env, c, d, await getSettings(env));
      if (d.mode === 'topic' && !d.flavor) await chooseFlavor(env, c, d, await getSettings(env), Date.now());
      const msgs = await generateAndStore(env, c, d, hist, lastRead);
      await lifeAfterSend(env, c, d, Date.now());
      ctx.waitUntil(pushToAll(env, c, msgs).catch((e) => log(env, 'push: ' + e.message)));
      return json({ messages: msgs, mode: d.mode, flavor: d.flavor || null, news: d.newsUsed || null, newsCandidates: (d.news || []).length });
    }

    case 'POST /settings': {
      // 送られてきた項目だけ更新する（静かな時間とAIの設定は別々に保存される）
      const s = body.settings || {};
      const v = await getSettings(env);
      if ('quietEnabled' in s) v.quietEnabled = !!s.quietEnabled;
      if ('quietStart' in s) v.quietStart = clamp(Math.round(num(s.quietStart, 1)), 0, 23);
      if ('quietEnd' in s) v.quietEnd = clamp(Math.round(num(s.quietEnd, 7)), 0, 23);
      if ('omoteProvider' in s) v.omoteProvider = s.omoteProvider === 'grok' ? 'grok' : 'gemini';
      if ('uraProvider' in s) v.uraProvider = s.uraProvider === 'gemini' ? 'gemini' : 'grok';
      delete v.provider; // 旧設定（表裏共通）は使わない
      if ('grokModel' in s) v.grokModel = String(s.grokModel || '').trim().slice(0, 80);
      if ('newsEnabled' in s) v.newsEnabled = !!s.newsEnabled;
      if ('lifeEnabled' in s) v.lifeEnabled = !!s.lifeEnabled;
      if ('imagesEnabled' in s) v.imagesEnabled = !!s.imagesEnabled;
      if ('delayEnabled' in s) v.delayEnabled = !!s.delayEnabled;
      if ('uraPaused' in s) v.uraPaused = !!s.uraPaused; // 裏の自動（TLの投稿・反応、トークの返事）を止める
      if ('notifyVia' in s && ['web', 'bark', 'both'].includes(s.notifyVia)) v.notifyVia = s.notifyVia;
      if ('yen' in s) v.yen = clamp(num(s.yen, 150), 50, 500);
      if (s.cost && typeof s.cost === 'object') { // 単価の上書き（空ならモデルに合わせて自動）
        const cst = {};
        for (const k of ['geminiIn', 'geminiOut', 'grokIn', 'grokOut', 'image']) { const x = s.cost[k]; if (x !== '' && x != null && Number.isFinite(Number(x)) && Number(x) >= 0) cst[k] = Number(x); }
        v.cost = cst;
      }
      if ('barkSound' in s) v.barkSound = String(s.barkSound || '').trim().replace(/\.(caf|m4a|mp3|wav)$/i, '').slice(0, 60);
      if ('disasterEnabled' in s) v.disasterEnabled = !!s.disasterEnabled;
      if ('quakeMin' in s && QUAKE_MIN[s.quakeMin]) v.quakeMin = s.quakeMin;
      if ('birthday' in s) v.birthday = /^\d{2}-\d{2}$/.test(String(s.birthday)) ? String(s.birthday) : '';
      if (s.notify && typeof s.notify === 'object') {
        for (const k of Object.keys(NOTIFY_DEFAULT)) if (k in s.notify) v.notify[k] = !!s.notify[k];
      }
      await kvSet(env, 'settings', v);
      return json({ settings: v });
    }

    // ---- あなたのTLでの名前とアイコン（表・裏で別）
    case 'POST /me': {
      const world = body.world === 'ura' ? 'ura' : 'omote';
      const v = await getSettings(env);
      if ('name' in body) v[world === 'ura' ? 'meNameUra' : 'meName'] = String(body.name || '').trim().slice(0, 40);
      const verKey = world === 'ura' ? 'meUraIconVer' : 'meIconVer';
      if (typeof body.icon === 'string' && body.icon.startsWith('data:image/')) {
        if (body.icon.length > 500000) throw new HttpError(400, 'アイコン画像が大きすぎます');
        v[verKey] = Date.now();
        await env.DB.prepare('INSERT INTO me_icons (world,icon,ver) VALUES (?,?,?) ON CONFLICT(world) DO UPDATE SET icon=excluded.icon, ver=excluded.ver').bind(world, body.icon, v[verKey]).run();
      } else if (body.icon === null) {
        v[verKey] = Date.now();
        await env.DB.prepare('DELETE FROM me_icons WHERE world=?').bind(world).run();
      }
      await kvSet(env, 'settings', v);
      return json({ settings: v });
    }

    // ---- タイムライン
    case 'GET /tl': {
      const world = url.searchParams.get('world') === 'ura' ? 'ura' : 'omote';
      ctx.waitUntil(runTlJobs(env, 3).catch((e) => log(env, 'TL: ' + e.message))); // アプリを開いている間は、予定の反応を少しずつ進める
      return json({ world, posts: await loadTimeline(env, world, 60), now: Date.now() });
    }

    case 'POST /tl/post': {
      const world = body.world === 'ura' ? 'ura' : 'omote';
      const text = String(body.text || '').trim().slice(0, 1000);
      let image = null;
      if (typeof body.image === 'string' && body.image) {
        if (body.image.length > 4000000) throw new HttpError(400, '写真が大きすぎます');
        image = await saveImage(env, body.image);
      }
      if (!text && !image) throw new HttpError(400, '投稿が空です');
      const at = Date.now();
      // 写真付きは、AIが写真の中身を言葉にしてから反応を決める（それまでは planned=1 で待たせる）
      const r = await env.DB.prepare('INSERT INTO tl_posts (world,author,text,at,planned,image) VALUES (?,?,?,?,?,?)').bind(world, ME, text, at, image ? 1 : 0, image).run();
      const post = { id: r.meta.last_row_id, world, author: ME, text, at, planned: 0, ...(image ? { image } : {}) };
      ctx.waitUntil((async () => {
        if (image) {
          let alt = '';
          try { alt = await describePhoto(env, world, image, text); } catch (e) { await log(env, 'TLの写真の説明: ' + e.message); }
          await env.DB.prepare('UPDATE tl_posts SET alt=?, planned=0 WHERE id=?').bind(alt || '（写真。内容はよくわからない）', post.id).run();
        }
        await runTlJobs(env, 2); // 誰がどう反応するかをすぐに決める
      })().catch((e) => log(env, 'TL: ' + e.message)));
      return json({ post: { ...post, likes: [], comments: [] } });
    }

    case 'POST /tl/comment': {
      const post = await getPost(env, body.postId);
      const text = String(body.text || '').trim().slice(0, 1000);
      if (!text) throw new HttpError(400, 'コメントが空です');
      let replyTo = null;
      if (body.replyTo != null) {
        const rc = await env.DB.prepare('SELECT * FROM tl_comments WHERE id=? AND post_id=?').bind(num(body.replyTo, 0), post.id).first();
        if (!rc) throw new HttpError(404, '返信先のコメントが見つかりません');
        replyTo = rc;
      }
      const at = Date.now();
      const r = await env.DB.prepare('INSERT INTO tl_comments (post_id,world,author,text,reply_to,at) VALUES (?,?,?,?,?,?)')
        .bind(post.id, post.world, ME, text, replyTo ? replyTo.id : null, at).run();
      const comment = { id: r.meta.last_row_id, postId: post.id, author: ME, text, replyTo: replyTo ? replyTo.id : null, at };
      await planReplyToMe(env, post, comment, replyTo);
      ctx.waitUntil(runTlJobs(env, 2).catch((e) => log(env, 'TL: ' + e.message)));
      return json({ comment });
    }

    case 'POST /tl/like': {
      const post = await getPost(env, body.postId);
      if (body.on === false) await env.DB.prepare('DELETE FROM tl_likes WHERE post_id=? AND author=?').bind(post.id, ME).run();
      else await env.DB.prepare('INSERT OR IGNORE INTO tl_likes (post_id,author,at) VALUES (?,?,?)').bind(post.id, ME, Date.now()).run();
      return json({ ok: true });
    }

    case 'POST /tl/delete': { // 自分の投稿・コメントだけ消せる
      await noteUserDelete(env);
      if (body.commentId != null) {
        const c = await env.DB.prepare('SELECT * FROM tl_comments WHERE id=?').bind(num(body.commentId, 0)).first();
        if (!c || c.author !== ME) throw new HttpError(403, '自分のコメントだけ消せます');
        await env.DB.batch([
          env.DB.prepare('DELETE FROM tl_jobs WHERE comment_id=?').bind(c.id),
          env.DB.prepare('DELETE FROM tl_comments WHERE id=? OR reply_to=?').bind(c.id, c.id),
        ]);
        return json({ ok: true });
      }
      const post = await getPost(env, body.postId);
      if (post.author !== ME) throw new HttpError(403, '自分の投稿だけ消せます');
      await deletePosts(env, 'id=?', [post.id]);
      return json({ ok: true });
    }

    case 'POST /tl/clear': { // その世界のTLを全部消す
      await noteUserDelete(env);
      const world = body.world === 'ura' ? 'ura' : 'omote';
      await deletePosts(env, 'world=?', [world]);
      return json({ ok: true });
    }

    case 'POST /tl/poke': { // テスト用：今すぐTLに投稿してもらう
      const world = body.world === 'ura' ? 'ura' : 'omote';
      const c = (await getOwner(env, splitCid(body.charId).base, world)).char;
      const post = await charPostNow(env, c, world, await getSettings(env));
      ctx.waitUntil(runTlJobs(env, 2).catch((e) => log(env, 'TL: ' + e.message)));
      return json({ post });
    }

    // ---- 写真
    case 'GET /img': {
      const im = await loadImage(env, url.searchParams.get('id'));
      if (!im) throw new HttpError(404, '写真が見つかりません');
      const bin = Uint8Array.from(atob(im.b64), (ch) => ch.charCodeAt(0));
      return new Response(bin, { headers: { ...CORS, 'Content-Type': im.mime, 'Cache-Control': 'private, max-age=31536000, immutable' } });
    }

    // ---- キャラが覚えていること・今日の様子（キャラ編集画面で見る・消す）
    case 'GET /life': {
      const c = await getChar(env, url.searchParams.get('charId'));
      const mems = await loadMemories(env, c.id, 200);
      const state = await getState(env, c.id);
      return json({
        memories: mems.map((m) => ({ id: m.id, kind: m.kind, label: MEM_LABEL[m.kind] || m.kind, text: m.text, due: m.due, status: m.status, at: m.created })),
        today: state.day ? { day: state.day, mood: state.mood, moodReason: state.moodReason, today: state.today, story: state.story || null, diary: (state.diary || []).slice(-5), project: state.project || null, condition: state.condition || null, statusMsg: state.statusMsg || '' } : null,
        affinity: nz(c.affinity, 60),
      });
    }

    case 'POST /memory/delete': {
      await noteUserDelete(env);
      await env.DB.prepare('DELETE FROM memories WHERE id=?').bind(num(body.id, 0)).run();
      return json({ ok: true });
    }

    case 'GET /vapid': {
      const v = await getVapid(env);
      return json({ publicKey: v.pub });
    }

    case 'POST /subscribe': {
      const s = body.subscription;
      if (!s || !s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) throw new HttpError(400, '通知の登録情報が不正です');
      await env.DB.prepare('INSERT INTO subs (endpoint,data,created) VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET data=excluded.data')
        .bind(s.endpoint, JSON.stringify({ endpoint: s.endpoint, keys: s.keys }), Date.now()).run();
      return json({ ok: true });
    }

    case 'POST /unsubscribe': {
      await env.DB.prepare('DELETE FROM subs WHERE endpoint=?').bind(String(body.endpoint || '')).run();
      return json({ ok: true });
    }

    case 'POST /test-bark': { // Barkにテスト通知
      const st = await getSettings(env);
      const c = body.charId ? (await loadChars(env)).find((x) => x.id === body.charId) : (await loadChars(env))[0];
      const r = await sendBark(env, st, { title: c ? c.name : 'テスト', body: 'Barkからの通知は届いていますか？', cid: c ? c.id : null, group: c ? c.name : 'トーク' });
      return json({ ok: true, ...r });
    }

    case 'GET /bark/status': {
      return json({ deviceKey: !!env.BARK_DEVICE_KEY, encrypted: !!env.BARK_ENC_KEY, origin: !!(await kvGet(env, 'origin', '')) });
    }

    case 'POST /test-push': {
      const res = await pushPayload(env, { title: 'テスト通知', body: '通知は届いています！', badge: await totalUnread(env) });
      return json({ results: res });
    }
  }
  throw new HttpError(404, '不明な操作です: ' + key);
}

// ---------------------------------------------------------------- 自発メッセージの判定
function jstParts(ts) {
  const d = new Date(ts + JST);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), w: '日月火水木金土'[d.getUTCDay()] };
}
function quietSpan(s) {
  if (!s.quietEnabled || s.quietStart === s.quietEnd) return 0;
  return (s.quietEnd - s.quietStart + 24) % 24;
}
// 静かな時間（深夜・早朝）も完全には止めず、ふだんの1割ほどの確率で話しかけ・投稿・反応をする
const QUIET_RATE = 0.12;
function nightNote(now) {
  const h = jstParts(now).h;
  const when = h >= 22 || h < 4 ? '深夜' : '早朝';
  return when === '深夜'
    ? `今は${when}（${h}時台）。この時間ならではの内容にする：眠れない、夜更かししている、ふと目が覚めた、静かな夜の空気、月や夜空、夜食、夜中に考えてしまうこと、など。相手は寝ているかもしれないので、起こさない気づかいや「起きてたら」「朝読んでくれればいい」という気持ちがにじむとよい。`
    : `今は${when}（${h}時台）。この時間ならではの内容にする：早く目が覚めた、夜明けや朝焼け、まだ静かな街、朝ごはんの支度、寝ぼけている、など。相手はまだ寝ているかもしれないので、起こさない気づかいがにじむとよい。`;
}
function isQuiet(ts, s) {
  if (!quietSpan(s)) return false;
  const h = jstParts(ts).h;
  return s.quietStart < s.quietEnd ? h >= s.quietStart && h < s.quietEnd : h >= s.quietStart || h < s.quietEnd;
}

// 戻り値: null（送らない）または { mode, ... }
function decide(c, hist, lastRead, now, settings, force = false, factor = 1) {
  const last = hist[hist.length - 1];
  if (!force && last && last.sender === 'me') {
    return now - last.at > REPLY_WAIT ? { mode: 'reply' } : null; // アプリが閉じられて返信しそびれた分
  }
  if (!force) {
    if (c.perDay <= 0) return null;
    if (last && now - last.at < 20 * 60 * 1000) return null; // 会話の直後は割り込まない
  }
  const activeTicks = Math.max(1, ((24 - quietSpan(settings)) * 60) / TICK_MIN);
  const p = (c.perDay / activeTicks) * (!force && isQuiet(now, settings) ? QUIET_RATE : 1) * (force ? 1 : factor); // 1回のCronで話しかける確率（静かな時間は大幅に下げる・今していることで変わる）
  const roll = (q) => force || Math.random() < q;

  if (!last) return roll(p * 4) ? { mode: 'first' } : null;

  // 最後の自分の発言以降に送ったキャラの未読メッセージ
  let unread = 0, firstUnreadAt = 0;
  for (const m of hist) {
    if (m.sender === 'char' && m.at > lastRead) { unread++; if (!firstUnreadAt) firstUnreadAt = m.at; }
  }
  if (unread > 0) {
    if (!force) {
      if (unread >= MAX_UNREAD) return null;
      if (now - last.at < unread * 45 * 60 * 1000) return null; // 未読が増えるほど間をあける
    }
    return roll(p * 1.5) ? { mode: 'unread', unread, since: firstUnreadAt } : null;
  }
  // 既読スルー
  if (!force && now - last.at < 60 * 60 * 1000) return null;
  if (!roll(p)) return null;
  return { mode: Math.random() * 100 < c.nudgeRate ? 'nudge' : 'topic', since: last.at };
}

async function tick(env) {
  await ensureSchema(env);
  const now = Date.now();
  const settings = await getSettings(env);
  const allChars = await loadChars(env);
  const chars = allChars.filter(inOmote); // 表の話しかけ・くらしは、表に登場する子だけ
  const done = [];
  await applyRetracts(env).catch(() => {});
  // くらし：毎日の様子と記憶の整理（話しかける前に）
  const ctxAll = { chars, lastUserActive: 0 };
  if (settings.lifeEnabled) {
    const a = await env.DB.prepare("SELECT MAX((SELECT MAX(at) FROM messages WHERE char_id=c.id AND sender='me')) AS t FROM chars c").first();
    const b = await env.DB.prepare("SELECT MAX(at) AS t FROM reads WHERE char_id NOT LIKE '%#ura'").first();
    ctxAll.lastUserActive = Math.max((a && a.t) || 0, (b && b.t) || 0);
    for (const c of chars) {
      try { if (!isQuiet(now, settings) && (await dailyUpdate(env, c, settings, now))) done.push(c.name + ':今日の様子'); } catch (e) { await log(env, `今日の様子（${c.name}）: ${e.message}`); }
      try { if (await extractMemories(env, c, settings, now)) done.push(c.name + ':記憶'); } catch (e) { await log(env, `記憶（${c.name}）: ${e.message}`); }
    }
  }
  for (const c of chars) {
    try {
      const hist = await recent(env, c.id, 60);
      const lastRead = await getRead(env, c.id);
      let d = await lifeDecide(env, c, hist, lastRead, now, settings, ctxAll).catch((e) => { log(env, `くらし（${c.name}）: ${e.message}`); return null; });
      let boost = { f: 1 };
      if (!d) {
        boost = await activityBoost(env, c, settings, now).catch(() => ({ f: 1 }));
        d = decide(c, hist, lastRead, now, settings, false, boost.f);
        if (d && d.mode === 'reply' && delayOn(settings)) { // アプリが閉じられて返事をもらいそびれた分も、予定に合わせて返す
          const t = await decideReply(env, c, hist, now);
          await env.DB.prepare('DELETE FROM kv WHERE k=?').bind('replygo:' + c.id).run();
          if (!t.now) d = null;
          else if (t.pend) { await env.DB.prepare('DELETE FROM kv WHERE k=?').bind('reply:' + c.id).run(); d.late = t.pend; }
        }
      }
      // スタンプ：ユーザーが寝た（😴）・あとで返す（🏃）・一区切り（👍❤️）
      if (d && d.mode !== 'reply') d = await stampGate(env, c, d, hist, now);
      // キャラが寝る時刻になったら、返事をしていないユーザーのメッセージに 😴 を付けて眠る
      await sleepStamp(env, c, hist, now, settings).catch(() => {});
      if (!d) continue;
      if (d.mode !== 'reply' && (await kvGet(env, 'proj:' + c.id, null))) continue; // もう話しかける予定が入っている
      // 既読スルーの催促は、ときどき文字ではなく 🥺 だけにする
      if (d.mode === 'nudge' && settings.lifeEnabled) {
        const lastMe = [...hist].reverse().find((m) => m.sender === 'me');
        if (lastMe && !lastMe.reaction && Math.random() < 0.3) { await setReaction(env, lastMe.id, '🥺'); done.push(c.name + ':🥺'); continue; }
      }
      if (d.mode !== 'reply' && boost.justDone) d.justDone = boost.justDone;
      if (d.mode !== 'reply' && isQuiet(now, settings)) d.night = true; // 深夜・早朝らしい内容に
      if (d.mode === 'topic') await attachNews(env, c, d, settings); // ときどき最近のニュースも話題の候補に
      if (d.mode === 'topic' && settings.lifeEnabled) await chooseFlavor(env, c, d, settings, now);
      if (d.mode !== 'reply') { // 自分から話しかけるときは、ほかの子と時間をずらして送る（何人も同時に届かないように）
        const due = await nextProactiveSlot(env, now);
        await kvSet(env, 'proj:' + c.id, { d, due, at: now });
        done.push(c.name + ':' + d.mode + (d.flavor ? '/' + d.flavor : '') + `（${Math.round((due - now) / MIN)}分後）`);
        continue;
      }
      const msgs = await generateAndStore(env, c, d, hist, lastRead);
      if (msgs.length) await pushToAll(env, c, msgs);
      await lifeAfterSend(env, c, d, now);
      done.push(c.name + ':' + d.mode + (d.flavor ? '/' + d.flavor : ''));
    } catch (e) {
      await log(env, `自動送信（${c.name}）: ${e.message}`);
    }
  }
  // タイムライン：キャラが自分からつぶやく（表・裏それぞれ。裏だけの子は裏だけ）
  for (const c of allChars) {
    for (const world of ['omote', 'ura']) {
      try {
        if (!(await shouldCharPost(env, c, world, now, settings))) continue;
        await charPostNow(env, c, world, settings);
        done.push(`${c.name}:TL投稿(${world === 'ura' ? '裏' : '表'})`);
      } catch (e) {
        await log(env, `TL投稿（${c.name}）: ${e.message}`);
      }
    }
  }
  // タイムライン：予定していた いいね・コメント・返信 を実行
  try {
    const n = await runTlJobs(env, 15);
    if (n) done.push(`TL反応:${n}件`);
  } catch (e) {
    await log(env, 'TL反応: ' + e.message);
  }
  await kvSet(env, 'lastTick', { at: now, done });
}

// ---------------------------------------------------------------- Gemini
function fmtTime(ts) { const p = jstParts(ts); return `${p.mo}/${p.d}(${p.w}) ${p.h}:${String(p.mi).padStart(2, '0')}`; }
function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}分`;
  const h = Math.round(m / 60);
  if (h < 24) return `約${h}時間`;
  return `約${Math.round(h / 24)}日`;
}

function situation(d, hist, now) {
  const lastChar = [...hist].reverse().find((m) => m.sender === 'char');
  const lastMe = [...hist].reverse().find((m) => m.sender === 'me');
  switch (d.mode) {
    case 'reply': {
      if (d.stamp) {
        return d.stamp === '😴'
          ? 'ユーザーがあなたのメッセージにスタンプ 😴（眠い・もう寝る）を付けた。「おやすみなさい」の気持ちを、キャラクターらしく短い一言（吹き出し1つ）だけで返す。話を広げない。'
          : `ユーザーがあなたの最後のメッセージにスタンプ ${stampLine(d.stamp, 'user')} を付けた。その意味を受け止めて、キャラクターらしく返事をする。`;
      }
      const firstNew = (() => { let i = hist.length - 1; while (i > 0 && hist[i - 1].sender === 'me') i--; return hist[i]; })();
      let s = 'ユーザーからメッセージが届きました。キャラクターとして返信してください。';
      if (lastChar && firstNew && firstNew.at - lastChar.at > 3 * 3600e3) {
        s += `（あなたの最後のメッセージから${fmtDur(firstNew.at - lastChar.at)}たってからの返信です。待たされた・放置されていた場合は、キャラクターらしく反応してよい）`;
      }
      return s;
    }
    case 'first':
      return 'まだ一度もやり取りしていません。あなたから最初のメッセージを送ってください。';
    case 'unread':
      return `あなたが送ったメッセージ${d.unread}件が、まだ読まれていません（未読のまま${fmtDur(now - d.since)}経過）。` +
        'キャラクターらしく、返信の催促・寂しさ・不満・拗ね・怒りなどを表現してください。未読の件数と経過時間が多いほど感情を強めてください。' +
        '前回までと同じ言い回しの繰り返しは避けてください。';
    case 'nudge':
      if (d.afterLater) return `ユーザーは「🏃（今は忙しい。あとで返す）」と言っていたが、${fmtDur(now - d.since)}たっても返事がない。責めたり催促したりせず、「落ち着いたらで大丈夫です」のように、そっと声をかける。`;
      return `ユーザーはあなたの最後のメッセージを読みましたが、返信がありません（既読スルー、${fmtDur(now - d.since)}経過）。` +
        'キャラクターらしく返信を催促してください。ただし直前の会話が自然に終わっていた場合（おやすみ・またね等）は、催促ではなく新しい話題で話しかけてください。';
    case 'special': case 'absent': case 'followup': case 'jealous':
      return lifeSituation(d, now);
    case 'call':
      return `あなたはたった今、ユーザーに電話をかけた（声が聞きたくなった・直接話したいことがあった、など。理由はキャラクターらしく、今の様子や続いている出来事に合わせる）が、ユーザーは出なかった。最後のやり取りから${fmtDur(now - (d.since || now))}たっている。` +
        '電話に出てもらえなかったことに触れつつ、キャラクターらしく短く送る（吹き出し1〜2つ）。性格によって、さみしさ・拗ね・気づかい・独占欲などをにじませる。責めすぎない。「電話」という言葉を使ってよい。';
    case 'event':
      return eventSituation(d, now);
    case 'topic':
    default:
      return (d.afterStamp ? `前の話題は、ユーザーがスタンプ ${stampLine(d.afterStamp, 'user')} で一区切りにした。その話題は蒸し返さない${d.afterStamp === '❤️' ? '（もらったハートのうれしさは、態度や言葉の端ににじませてよい）' : ''}。\n` : '') +
        (d.flavor && flavorText(d) ? flavorText(d) + '\n' : '') + `最後のやり取りから${fmtDur(now - (hist.length ? hist[hist.length - 1].at : now))}たっています。` +
        '直前の話題の催促はせず、キャラクターらしい別の新しい話題で話しかけてください（今していること、ふと思ったこと、時間帯や季節に合った話、ユーザーへの質問など）。' +
        (d.news && d.news.length ? newsBlock(d.news, now) : '') +
        (lastMe ? '' : '');
  }
}

function buildSystem(c, d, hist, now, tlInfo = '', lifeInfo = '') {
  return `あなたは次のキャラクターになりきって、ユーザーとスマホのメッセージアプリ（LINEのようなチャット）でやり取りしています。

# キャラクター: ${c.name}
${c.prompt || '（設定なし）'}${bdayLine(c)}
${tlInfo}${lifeInfo}
# やり取りのルール（キャラクター設定に別の指示があればそちらを優先）
- 実際にスマホでメッセージを打っているように、短く自然な話し言葉で書く。
- 返答は1〜${c.maxSplit}個の吹き出しに分ける。一言で済むなら1個でよい。何個に分けるかはキャラクターの性格と内容に合わせる。
- 地の文・ト書き・括弧での動作描写は書かない。
- 自分がAIであることには触れない。
- 会話履歴の先頭にある[ ]は送信時刻。返答には時刻を書かない。
- 現在の時刻や、前のメッセージからの経過時間を自然に意識する。

# 現在日時
${fmtTime(now)}

# 今の状況
${situation(d, hist, now)}${d.night ? '\n' + nightNote(now) : ''}${d.mode === 'reply' && d.late ? '\n' + lateNote(d.late, hist, now) : ''}${d.justDone ? `\n（ちょうど「${d.justDone}」が終わって、ひと段落したところ。それをきっかけに話しかけてもよい）` : ''}

出力は {"messages": ["吹き出し1", "吹き出し2"]} の形のJSONのみ。`;
}

function buildContents(hist, world = 'omote', images = {}) {
  const turns = [];
  for (const m of hist) {
    const role = m.sender === 'me' ? 'user' : 'model';
    let body = m.retracted ? `（送信を取り消したメッセージ：${m.origText || ''}）` : m.kind === 'call' ? '（電話をかけたが、ユーザーは出なかった）' : m.text;
    if (m.image || (m.alt && !m.retracted)) body = (m.sender === 'me' ? '（写真を送りました）' : `（写真を送った：${m.alt || ''}）`) + (body ? ' ' + body : '');
    // 裏は現実の時刻とは別の時間軸なので時刻は付けない。ナレーションは「＊」付きで渡す
    const line = world === 'ura' ? (m.sender === 'narr' ? '＊' + body : body) : `[${fmtTime(m.at)}] ${body}`;
    const t = turns[turns.length - 1];
    const parts = [];
    if (m.image && images[m.image]) parts.push({ inlineData: { mimeType: images[m.image].mime, data: images[m.image].b64 } });
    parts.push({ text: line });
    if (t && t.role === role) {
      const lastText = t.parts[t.parts.length - 1];
      if (parts.length === 1 && lastText.text != null) lastText.text += '\n' + line;
      else t.parts.push(...parts);
    } else turns.push({ role, parts });
    // スタンプ：キャラのメッセージにはユーザーが、ユーザーのメッセージにはキャラが付けたもの
    if (world !== 'ura' && m.reaction && STAMPS[m.reaction]) {
      const r2 = m.sender === 'me' ? 'model' : 'user';
      const note = m.sender === 'me'
        ? `（あなたはユーザーのこのメッセージに スタンプ ${stampLine(m.reaction, 'char')} を付けた）`
        : `（ユーザーがあなたのこのメッセージに スタンプ ${stampLine(m.reaction, 'user')} を付けた）`;
      const t2 = turns[turns.length - 1];
      if (t2 && t2.role === r2 && t2.parts[t2.parts.length - 1].text != null) t2.parts[t2.parts.length - 1].text += '\n' + note;
      else turns.push({ role: r2, parts: [{ text: note }] });
    }
  }
  if (turns.length && turns[0].role === 'model') turns.unshift({ role: 'user', parts: [{ text: '（会話の始まり）' }] });
  if (!turns.length || turns[turns.length - 1].role === 'model') {
    turns.push({ role: 'user', parts: [{ text: world === 'ura'
      ? '（場面の始まり。あなたから自然に始めてください）'
      : '（ユーザーからの新しいメッセージはありません。「今の状況」に沿って、あなたから送るメッセージを作ってください）' }] });
  }
  return turns;
}

// 裏：実際に会っている場面のロールプレイ（表のSNSとは完全に別の時間軸・別の記憶）
function buildUraSystem(c, tlInfo = '') {
  const own = c.uraCharPrompt && c.uraCharPrompt.trim();
  const alias = !own && c.uraName && c.uraName !== c.name ? `\n（キャラクター設定では「${c.name}」と書かれていますが、この場面では「${c.uraName}」として振る舞います）` : '';
  const len = c.uraLength || 'normal';
  const narr = c.uraNarration
    ? {
      short: `- 情景・キャラクターの動作・表情・しぐさなどの描写（ナレーション）は、先頭に「＊」を付けた別の吹き出しとして書く。三人称・現在形で、1〜3文程度の短さにする。
- セリフの吹き出しには描写や（ ）書きを混ぜず、キャラクターが口にする言葉だけを書く。セリフは短めに。
- ナレーションは場面が伝わるときに挟む程度でよい。毎回入れなくてよい。`,
      normal: `- 情景・キャラクターの動作・表情・しぐさ・心の動きなどの描写（ナレーション）は、先頭に「＊」を付けた別の吹き出しとして書く。三人称・現在形で、2〜5文ほど。
- セリフの吹き出しには描写や（ ）書きを混ぜず、キャラクターが口にする言葉だけを書く。気持ちが伝わるよう、ほどよく言葉を尽くす。
- ほとんどの返答にナレーションを入れ、場面の空気が伝わるようにする。`,
      long: `- 小説のような、地の文の多い長めの返答にする。全体でおおよそ400〜1000字。
- 地の文（ナレーション）は先頭に「＊」を付けた吹き出しとして書く。三人称・現在形で、情景・光や音・距離感・表情・しぐさ・キャラクターの心の動きを、段落としてじっくり描く（1つの吹き出しに4〜10文ほど）。地の文の中に「」でキャラクターのセリフを織り交ぜてもよい。
- 地の文の吹き出しとセリフだけの吹き出しを交互に組み合わせてよい。セリフだけの吹き出しには描写や（ ）書きを混ぜない。
- これまでの返答が短くても、その長さに合わせず、毎回しっかり描写する。`,
    }[len]
    : {
      short: '- ナレーションや地の文、（ ）での動作描写は書かず、キャラクターのセリフだけで表現する。セリフは短めに。',
      normal: '- ナレーションや地の文、（ ）での動作描写は書かず、キャラクターのセリフだけで表現する。気持ちが伝わるよう、ほどよく言葉を尽くす。',
      long: '- ナレーションや地の文、（ ）での動作描写は書かず、キャラクターのセリフだけで表現する。ただし長めに、気持ちや考えをじっくり言葉にする（全体で300〜700字ほど）。これまでの返答が短くても、その長さに合わせない。',
    }[len];
  return `あなたは次のキャラクターになりきって、ユーザーと「実際に同じ場所で会っている場面」のロールプレイをしています。
これはスマホのメッセージアプリ（SNS）でのやり取りとは完全に別の時間軸・別の世界線の出来事です。SNSでの会話の内容は知らないものとして振る舞ってください。

# キャラクター: ${c.uraName || c.name}${alias}
${own ? c.uraCharPrompt : (c.prompt || '（設定なし）')}${bdayLine(c)}
${c.uraPrompt ? `
# この場面（対面）での追加設定
${c.uraPrompt}
` : ''}
# いまの場面
${c.uraScene || '（特に指定なし。これまでの流れやユーザーの言動から自然に判断する）'}
${tlInfo}
# ルール（キャラクター設定に別の指示があればそちらを優先）
- 返答は1〜${c.uraMaxSplit}個の吹き出しに分ける。
${narr}
- ユーザーの発言のうち（ ）で書かれた部分は、ユーザーの行動や状況の描写として受け取る。
- ユーザーの行動・発言・気持ちを勝手に決めて書かない。ユーザーが次にどうするかの余地を残す。
- 自分がAIであることには触れない。
- キャラクターが未成年の設定である場合、性的な内容や描写は一切しない。

出力は {"messages": ["吹き出し1", "吹き出し2"]} の形のJSONのみ。`;
}

function providerFor(st, world) {
  return world === 'ura' ? (st.uraProvider || 'grok') : (st.omoteProvider || 'gemini');
}
function modelFor(env, st, world = 'omote') {
  return providerFor(st, world) === 'grok' ? grokModelFor(env, st) : (env.GEMINI_MODEL || DEFAULT_MODEL);
}
function grokModelFor(env, st) {
  return (st && st.grokModel) || env.XAI_MODEL || DEFAULT_GROK_MODEL;
}

// AIの返答テキスト（JSON）→ 吹き出しの配列
function parseMessages(text, maxSplit, label) {
  let arr;
  try { arr = JSON.parse(text).messages; } catch (_) {
    const m = String(text).match(/\{[\s\S]*\}/);
    try { arr = m ? JSON.parse(m[0]).messages : null; } catch (_) { arr = null; }
    if (!arr) arr = String(text).split(/\n+/);
  }
  if (!Array.isArray(arr)) arr = [String(arr || '')];
  arr = arr.map((s) => String(s).replace(/^\s*\[[^\]]{1,30}\]\s*/, '').trim()).filter(Boolean);
  if (arr.length > maxSplit) arr = arr.slice(0, maxSplit - 1).concat(arr.slice(maxSplit - 1).join('\n'));
  if (!arr.length) throw new Error(label + 'の返答からメッセージを取り出せませんでした');
  return arr;
}

// ---------------------------------------------------------------- Grok（xAI・OpenAI互換API）
// 会話履歴は Gemini 用の contents と同じものを受け取り、OpenAI 形式（user / assistant）に変換して送る
const MSG_SCHEMA = { type: 'object', properties: { messages: { type: 'array', items: { type: 'string' } } }, required: ['messages'], additionalProperties: false };

async function callGrok(env, model, system, contents, maxSplit, opts) {
  return parseMessages(await grokText(env, model, system, contents, MSG_SCHEMA, 'chat_reply', opts), maxSplit, 'Grok');
}

// Grok に送って、返答の文字列（JSON）をそのまま返す
async function grokText(env, model, system, contents, schema, schemaName, opts) {
  if (!env.XAI_API_KEY) throw new Error('シークレット XAI_API_KEY が設定されていません');
  const messages = [{ role: 'system', content: system }].concat(
    contents.map((t) => ({
      role: t.role === 'model' ? 'assistant' : 'user',
      content: t.parts.some((p) => p.inlineData)
        ? t.parts.map((p) => (p.inlineData ? { type: 'image_url', image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } } : { type: 'text', text: p.text }))
        : t.parts.map((p) => p.text).join('\n'),
    })));
  const schemaFormat = { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } };
  let format = schemaFormat, data, lastErr;
  // 考えるモデル（grok-4.7 など）は、チャットの返事が遅くならないよう思考を軽めにする
  let effort = /^grok-4\.[5-9]|^grok-[5-9]/.test(model) ? ((opts && opts.effort) || 'low') : null; // 長め（小説風）のときは少し多めに考える
  const world = (opts && opts.world) || 'omote';
  for (let attempt = 0; attempt < 5; attempt++) {
    const req = { model, messages, temperature: 1.0, response_format: format };
    if (effort) req.reasoning_effort = effort;
    const r = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.XAI_API_KEY },
      body: JSON.stringify(req),
    });
    data = await r.json().catch(() => null);
    if (r.ok) break;
    const msg = (data && ((data.error && (data.error.message || data.error)) || data.message)) || '不明なエラー';
    lastErr = `Grok ${r.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
    // 構造化出力に対応していないモデルなら、JSON指定をゆるめて再試行
    if (r.status === 400 && effort && /reasoning/i.test(lastErr)) { effort = null; data = null; continue; }
    if (r.status === 400 && format === schemaFormat && /response_format|json_schema|schema/i.test(lastErr)) { format = { type: 'json_object' }; data = null; continue; }
    // 既定のモデルが使えないキーなら、予備のモデルで続ける
    if ([400, 403, 404].includes(r.status) && model === DEFAULT_GROK_MODEL && /model/i.test(lastErr)) {
      await log(env, `Grok: ${model} が使えないため ${FALLBACK_GROK_MODEL} を使いました（${lastErr.slice(0, 120)}）`);
      model = FALLBACK_GROK_MODEL; effort = null; data = null; continue;
    }
    if (![429, 500, 502, 503, 504].includes(r.status) || isBillingError(r.status, lastErr)) { await aiAlertFail(env, 'grok', r.status, lastErr); throw new Error(lastErr); }
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    data = null;
  }
  if (!data) { await aiAlertFail(env, 'grok', 429, lastErr); throw new Error(lastErr); }
  await aiAlertOk(env, 'grok');
  const ch = data.choices && data.choices[0];
  const text = ch && ch.message && typeof ch.message.content === 'string' ? ch.message.content : '';
  const u = data.usage || {};
  const reasoning = nz(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens, 0);
  // 考えた分（reasoning）も出力として請求される。completion_tokens に含まれていなければ足す
  const inCompletion = nz(u.total_tokens, 0) <= nz(u.prompt_tokens, 0) + nz(u.completion_tokens, 0);
  const outTok = nz(u.completion_tokens, 0) + (inCompletion ? 0 : reasoning);
  await recordCost(env, world, 'grok', data.model || model, nz(u.prompt_tokens, 0), nz(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens, 0), outTok).catch(() => {});
  if (!text) throw new Error('Grokの返答が空でした（' + ((ch && ch.finish_reason) || '理由不明') + '）');
  return text;
}

// JSON Schema（OpenAI形式）→ Gemini の responseSchema 形式
function toGeminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalProperties') continue;
    if (k === 'type') out.type = String(v).toUpperCase();
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    else if (k === 'items') out.items = toGeminiSchema(v);
    else out[k] = v;
  }
  return out;
}

function parseJsonLoose(text, label) {
  try { return JSON.parse(text); } catch (_) {}
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  throw new Error(label + 'の返答をJSONとして読めませんでした');
}

// その世界（表／裏）のAIに、決まった形のJSONで答えてもらう（タイムライン用）
async function aiJson(env, world, system, userText, schema, schemaName) {
  return callAIObj(env, world, system, [{ role: 'user', parts: [{ text: userText }] }], schema, schemaName);
}
async function callAIObj(env, world, system, contents, schema, schemaName, opts) {
  const st = await getSettings(env);
  if (providerFor(st, world) === 'grok') {
    return parseJsonLoose(await grokText(env, grokModelFor(env, st), system, contents, schema, schemaName, { ...(opts || {}), world }), 'Grok');
  }
  return parseJsonLoose(await geminiText(env, system, contents, toGeminiSchema(schema), world), 'Gemini');
}

// ---------------------------------------------------------------- 使うAIを選んで呼ぶ
async function callAI(env, world, system, contents, maxSplit, opts) {
  const st = await getSettings(env);
  if (providerFor(st, world) === 'grok') return callGrok(env, grokModelFor(env, st), system, contents, maxSplit, { ...(opts || {}), world });
  return callGemini(env, system, contents, maxSplit, world);
}

async function callGemini(env, system, contents, maxSplit, world = 'omote') {
  return parseMessages(await geminiText(env, system, contents, toGeminiSchema(MSG_SCHEMA), world), maxSplit, 'Gemini');
}

// Gemini に送って、返答の文字列（JSON）をそのまま返す
async function geminiText(env, system, contents, responseSchema, world = 'omote') {
  if (!env.GEMINI_API_KEY) throw new Error('シークレット GEMINI_API_KEY が設定されていません');
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const req = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      temperature: 1.0,
      responseMimeType: 'application/json',
      responseSchema,
    },
    safetySettings: ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
      .map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
  };
  let data, lastErr, lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(req),
    });
    data = await r.json().catch(() => null);
    if (r.ok) break;
    lastErr = `Gemini ${r.status}: ${(data && data.error && data.error.message) || '不明なエラー'}`;
    lastStatus = r.status;
    if (![429, 500, 502, 503, 504].includes(r.status) || isBillingError(r.status, lastErr)) { await aiAlertFail(env, 'gemini', r.status, lastErr); throw new Error(lastErr); }
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    data = null;
  }
  if (!data) { await aiAlertFail(env, 'gemini', lastStatus, lastErr); throw new Error(lastErr); }
  await aiAlertOk(env, 'gemini');
  const cand = data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const text = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  const u = data.usageMetadata || {};
  await recordCost(env, world, 'gemini', data.modelVersion || model, nz(u.promptTokenCount, 0), nz(u.cachedContentTokenCount, 0), nz(u.candidatesTokenCount, 0) + nz(u.thoughtsTokenCount, 0)).catch(() => {});
  if (!text) throw new Error('Geminiの返答が空でした（' + ((cand && cand.finishReason) || (data.promptFeedback && data.promptFeedback.blockReason) || '理由不明') + '）');
  return text;
}

// ---- AIのクレジット切れ・使用量の上限（料金まわりのエラー）を覚えて、アプリに知らせる
// 次にそのAIの呼び出しが成功したら、自動で消える
function isBillingError(status, msg) {
  const m = String(msg || '');
  if (status === 402) return true; // 前払いクレジットの使い切り など
  if (/prepay|credit|billing|spending limit|spend limit|insufficient (funds|balance)|exceeded your current quota|RESOURCE_EXHAUSTED.*(billing|plan)/i.test(m)) return true;
  return false;
}
const aiAlertMemo = {}; // この実行の中で「警告なし」と分かっているもの（毎回DBを読まないため）
async function aiAlertFail(env, provider, status, msg) {
  if (!isBillingError(status, msg)) return;
  try {
    const k = 'aiAlert:' + provider, now = Date.now();
    const cur = await kvGet(env, k, null);
    const v = { at: cur ? cur.at : now, last: now, status, msg: String(msg).slice(0, 300), notified: cur ? cur.notified || 0 : 0 };
    const notify = now - v.notified > 24 * 3600e3; // 通知は1日1回まで
    if (notify) v.notified = now;
    await kvSet(env, k, v);
    aiAlertMemo[provider] = true;
    if (notify) {
      const label = provider === 'gemini' ? 'Gemini（Google AI Studio）' : 'Grok（xAI）';
      await bkNotify(env, `${label}のクレジット（利用枠）が切れているため、AIの返事が止まっています。チャージすると自動で元に戻ります。`, 'トーク（AIの料金）').catch(() => {});
    }
  } catch (_) {}
}
async function aiAlertOk(env, provider) {
  if (aiAlertMemo[provider] === false) return;
  try {
    await env.DB.prepare('DELETE FROM kv WHERE k=?').bind('aiAlert:' + provider).run();
    aiAlertMemo[provider] = false;
  } catch (_) {}
}
async function aiAlerts(env) {
  const { results } = await env.DB.prepare("SELECT k,v FROM kv WHERE k >= 'aiAlert:' AND k < 'aiAlert;'").all();
  const out = {};
  for (const r of results) { try { const v = JSON.parse(r.v); out[r.k.slice(8)] = { at: v.at, last: v.last, status: v.status, msg: v.msg }; } catch (_) {} }
  return out;
}

// ---- AIの利用料金（目安）。返事ごとに使った量 × 単価を足していく
const PRICE = { // 1Mトークンあたりのドル（入力・読み込み済みの入力・出力）
  gemini: [[/flash-lite/, 0.10, 0.01, 0.40], [/gemini-3|flash-latest/, 0.50, 0.05, 3.00], [/2\.5-pro|pro/, 1.25, 0.125, 10.00], [/flash/, 0.30, 0.03, 2.50]],
  grok: [[/fast/, 0.20, 0.05, 0.50], [/grok-4\.[5-9]|grok-[5-9]/, 2.00, 0.50, 6.00], [/grok-3-mini/, 0.30, 0.075, 0.50], [/grok/, 3.00, 0.75, 15.00]],
};
const IMAGE_USD = 0.039; // 写真1枚（Gemini 2.5 Flash Image）
function priceFor(provider, model, st) {
  const ov = (st && st.cost) || {};
  const row = (PRICE[provider] || []).find((r) => r[0].test(String(model || ''))) || [null, 0.3, 0.03, 2.5];
  const pIn = ov[provider + 'In'] != null ? ov[provider + 'In'] : row[1];
  const pOut = ov[provider + 'Out'] != null ? ov[provider + 'Out'] : row[3];
  return { pIn, pCache: ov[provider + 'In'] != null ? pIn * (row[2] / row[1]) : row[2], pOut };
}
async function recordCost(env, world, provider, model, tin, tcached, tout, images = 0) {
  const st = await getSettings(env).catch(() => ({}));
  const p = priceFor(provider, model, st);
  const usd = images ? images * (st.cost && st.cost.image != null ? st.cost.image : IMAGE_USD)
    : ((tin - tcached) * p.pIn + tcached * p.pCache + tout * p.pOut) / 1e6;
  const month = jstDay(Date.now()).slice(0, 7);
  await env.DB.prepare('INSERT INTO ai_cost (world,month,usd,calls,tin,tout,images) VALUES (?,?,?,?,?,?,?) ON CONFLICT(world,month) DO UPDATE SET usd=usd+excluded.usd, calls=calls+excluded.calls, tin=tin+excluded.tin, tout=tout+excluded.tout, images=images+excluded.images')
    .bind(world === 'ura' ? 'ura' : 'omote', month, usd, images ? 0 : 1, tin, tout, images).run();
}
async function costSummary(env) {
  const month = jstDay(Date.now()).slice(0, 7);
  const { results } = await env.DB.prepare('SELECT world,month,usd,calls,images FROM ai_cost').all();
  const out = { omote: { month: 0, total: 0, calls: 0, images: 0 }, ura: { month: 0, total: 0, calls: 0, images: 0 } };
  for (const r of results) {
    const o = out[r.world] || (out[r.world] = { month: 0, total: 0, calls: 0, images: 0 });
    o.total += r.usd; if (r.month === month) { o.month += r.usd; o.calls += r.calls; o.images += r.images; }
  }
  return out;
}

async function generateAndStore(env, c, d, hist, lastRead, world = 'omote') {
  const now = Date.now();
  const ura = world === 'ura';
  const key = ura ? c.id + URA : c.id;
  // 同じ世界のタイムラインでの出来事も伝える（トークとTLはつながっている）
  const tlInfo = await tlContextForTalk(env, c, world).catch(() => '');
  let texts, rich = null;
  if (ura) {
    const wb = await worldBlock(env, c.prompt + '\n' + (c.uraCharPrompt || '') + '\n' + (c.uraScene || '') + '\n' + hist.slice(-20).map((m) => m.text).join('\n'));
    texts = (await callAI(env, 'ura', wb + buildUraSystem(c, tlInfo), buildContents(hist, 'ura'), c.uraMaxSplit + 4, c.uraLength === 'long' ? { effort: 'medium' } : null))
      .flatMap((t) => t.split(/\n(?=\s*[＊*])/)); // ナレーションとセリフが1つにまとまっていたら分ける
  } else {
    const st = await getSettings(env);
    if (disOn(st)) { // 停電中は、充電を節約して短く返す
      const dis = await kvGet(env, 'dis:state', null).catch(() => null);
      if (dis && dis.outage && dis.outage.on) c = { ...c, maxSplit: Math.min(c.maxSplit, 2) };
    }
    const lifeInfo = await lifeContext(env, c, st, now).catch(() => '');
    // ユーザーが送ったばかりの写真は、AIに見せる
    const lastCharIdx = hist.map((m) => m.sender).lastIndexOf('char');
    const newPhotos = hist.slice(lastCharIdx + 1).filter((m) => m.sender === 'me' && m.image).slice(-2);
    const images = {};
    for (const m of newPhotos) { const im = await loadImage(env, m.image); if (im) images[m.image] = im; }
    const special = d.mode === 'special';
    if (d.mode === 'call') { // 不在着信：先に「着信」を置いて、少しあとに言葉を送る
      const at = Date.now();
      const rc = await env.DB.prepare("INSERT INTO messages (char_id,sender,text,at,kind) VALUES (?, 'char', '', ?, 'call')").bind(key, at).run();
      d.callMsg = { id: rc.meta.last_row_id, charId: key, sender: 'char', text: '', at, kind: 'call' };
      hist = [...hist, d.callMsg];
    }
    const lastMeMsg = [...hist].reverse().find((m) => m.sender === 'me');
    const canStamp = st.lifeEnabled && !special && (d.mode === 'reply' || d.mode === 'event') && lastMeMsg && !lastMeMsg.reaction && hist[hist.length - 1].sender === 'me';
    const opt = {
      react: canStamp,
      news: !!(d.news && d.news.length),
      photo: st.imagesEnabled && d.flavor === 'photo',
      edit: st.imagesEnabled && newPhotos.length > 0 && Object.keys(images).length > 0,
      typo: st.lifeEnabled && !special && Math.random() < 0.05,
      retract: st.lifeEnabled && !special && Math.random() < 0.05,
      quote: st.lifeEnabled && !special && d.mode === 'reply' ? quoteCandidates(hist) : null,
      ps: st.lifeEnabled && !special && d.mode !== 'call' && Math.random() < 0.12,
    };
    const wb = await worldBlock(env, c.prompt + '\n' + hist.slice(-20).map((m) => m.text).join('\n'));
    const system = wb + buildSystem(c, special ? { ...d } : d, hist, now, tlInfo, lifeInfo);
    const contents = buildContents(hist, 'omote', images);
    if (opt.news || opt.photo || opt.edit || opt.typo || opt.retract || opt.react || opt.quote || opt.ps || special) {
      rich = await callOmoteRich(env, { ...c, maxSplit: special ? 2 : c.maxSplit }, d, system, contents, opt);
      texts = rich.texts;
      rich.srcImage = newPhotos.length ? images[newPhotos[newPhotos.length - 1].image] : null;
      if (opt.news && Number.isInteger(rich.usedNews) && rich.usedNews >= 0 && d.news[rich.usedNews]) {
        d.newsUsed = d.news[rich.usedNews].title;
        const used = await kvGet(env, 'newsUsed:' + c.id, []);
        used.push(d.newsUsed);
        await kvSet(env, 'newsUsed:' + c.id, used.slice(-40)); // 同じニュースを何度も話さない
      }
    } else {
      texts = await callAI(env, 'omote', system, contents, c.maxSplit);
    }
  }
  // 裏では「＊」で始まる吹き出しをナレーションとして保存する
  const items = texts.map((t) => {
    const m = ura && t.match(/^\s*[＊*]+\s*([\s\S]*)$/);
    return m ? { sender: 'narr', text: m[1].trim() } : { sender: 'char', text: ura ? t.replace(/^「([\s\S]*)」$/, '$1') : t };
  }).filter((x) => x.text);
  // スタンプ（表）：ユーザーの最後のメッセージに付ける
  if (rich && rich.stamp) {
    const lastMe = [...hist].reverse().find((m) => m.sender === 'me');
    if (lastMe) await setReaction(env, lastMe.id, rich.stamp);
    if (!items.length) return [];
  }
  if (!items.length) throw new Error('返答が空でした');
  // 写真（表）：料理や景色の写真、送られた写真の加工。人物は写さない
  if (rich && (rich.photo || (rich.edit && rich.srcImage))) {
    try {
      const dataUrl = rich.photo ? await makeCharPhoto(env, rich.photo) : await editUserPhoto(env, rich.srcImage, rich.edit);
      const imgId = await saveImage(env, dataUrl);
      const pos = rich.photo ? Math.min(1, items.length) : items.length; // 自分の写真は最初のひとことのあと、加工した写真は最後
      items.splice(pos, 0, { sender: 'char', text: '', image: imgId, alt: rich.photo || '加工した写真：' + rich.edit });
    } catch (e) { await log(env, '写真: ' + e.message); }
  }
  // 引用返信：最初の言葉の吹き出しに、どのメッセージへの返事かを付ける
  if (rich && rich.quoteId) { const q = items.find((x) => !x.image); if (q) q.replyTo = rich.quoteId; }
  // 不在着信のあとの言葉は、1〜2分あけて届ける
  if (d.mode === 'call' && d.callMsg) {
    await kvSet(env, 'ps:' + key, { texts: items.filter((x) => !x.image).map((x) => x.text), due: Date.now() + (60 + Math.random() * 90) * 1000, after: d.callMsg.id });
    return [d.callMsg];
  }
  const t0 = Date.now();
  const res = await env.DB.batch(items.map((x, i) =>
    env.DB.prepare('INSERT INTO messages (char_id,sender,text,at,image,alt,reply_to) VALUES (?,?,?,?,?,?,?)').bind(key, x.sender, x.text, t0 + i, x.image || null, x.alt || null, x.replyTo || null)));
  const out = items.map((x, i) => ({ id: res[i].meta.last_row_id, charId: key, sender: x.sender, text: x.text, at: t0 + i, ...(x.image ? { image: x.image, alt: x.alt } : {}), ...(x.replyTo ? { replyTo: x.replyTo } : {}) }));
  // 追伸：数分後に、思い出したように一言
  if (rich && rich.postscript && !ura) await kvSet(env, 'ps:' + key, { texts: [rich.postscript], due: Date.now() + (2 + Math.random() * 5) * MIN, after: out[out.length - 1].id });
  // 送信取り消し（数分後に取り消す）
  if (rich && Number.isInteger(rich.retract) && rich.retract >= 0) {
    const target = out.filter((m) => !m.image)[rich.retract];
    if (target) await env.DB.prepare('UPDATE messages SET retract_at=? WHERE id=?').bind(Date.now() + (1 + Math.random() * 5) * MIN, target.id).run();
  }
  return out;
}

// ================================================================ 裏のグループ：何人かと同じ場面で
const GROUP_SCHEMA = {
  type: 'object',
  properties: { messages: { type: 'array', items: { type: 'object', properties: { who: { type: 'string' }, text: { type: 'string' } }, required: ['who', 'text'], additionalProperties: false } } },
  required: ['messages'], additionalProperties: false,
};
const NARR_WHO = ['ナレーション', 'narration', 'narr', '地の文', '＊', '*'];
function buildGroupSystem(g, members, st, start) {
  const nm = (c) => c.uraName || c.name;
  const narr = g.narration
    ? { short: '- 情景・動作・表情の描写（ナレーション）は who を "ナレーション" にして、三人称・現在形で1〜3文。セリフは短めに。',
      normal: '- 情景・動作・表情・心の動きの描写（ナレーション）は who を "ナレーション" にして、三人称・現在形で2〜5文。ほとんどの返答にナレーションを入れて、場の空気や誰が誰を見ているかが伝わるようにする。',
      long: '- 小説のように地の文の多い長めの返答にする（全体で500〜1200字）。地の文は who を "ナレーション" にして、情景・光や音・距離感・表情・しぐさ・それぞれの心の動きを段落としてじっくり描く（1つに4〜10文。地の文の中に「」でセリフを織り交ぜてもよい）。これまでの返答が短くても合わせない。' }[g.length]
    : { short: '- ナレーションは書かず、セリフだけで表現する。短めに。', normal: '- ナレーションは書かず、セリフだけで表現する。', long: '- ナレーションは書かず、セリフだけで表現する。ただし長めに、それぞれの気持ちをじっくり言葉にする。' }[g.length];
  const me = st.meNameUra || st.meName || '';
  return `あなたは、ユーザーと次の登場人物たちが「実際に同じ場所にいる場面」のロールプレイを、物語の語り手として進めています。
これはスマホのメッセージアプリ（SNS）でのやり取りとは別の時間軸・別の世界線の出来事です。SNSでの会話の内容は知らないものとして扱ってください。

# 登場人物（ユーザー以外）
${members.map((c) => `## ${nm(c)}
${charPersona(c, 'ura', Math.max(800, Math.floor(6000 / members.length)))}`).join('\n\n')}

# ユーザー
${me ? `名前：${me}（登場人物たちからの呼ばれ方は、それぞれのキャラクター設定に従う）` : '（名前は登場人物たちのキャラクター設定での呼び方に従う）'}

# あらすじ（物語の導入・いまの状況）
${g.synopsis || '（特になし。これまでの流れやユーザーの言動から自然に判断する）'}

# ルール
- 1回の返答は、吹き出し${Math.max(2, Math.min(g.maxSplit, 12))}個まで。吹き出しごとに who（話す人の名前。上の登場人物の名前どおり）と text を書く。
- 全員が毎回話す必要はない。場面の流れ・それぞれの性格・ユーザーとの距離に合わせて、話す人と順番を自然に選ぶ（登場人物どうしの掛け合いや、ユーザーの取り合いもあってよい）。
- 登場人物それぞれの口調・一人称・ユーザーの呼び方を守り、混ぜない。
${narr}
- セリフの text には、その人が口にする言葉だけを書く（「」や（ ）書きは付けない）。
- ユーザーの発言のうち（ ）で書かれた部分は、ユーザーの行動や状況の描写として受け取る。
- ユーザーの行動・発言・気持ちを勝手に決めて書かない。ユーザーが次にどうするかの余地を残す。
- 自分がAIであることには触れない。
- 登場人物が未成年の設定である場合、性的な内容や描写は一切しない。
${start ? '\n# 今回\nまだ物語は始まっていません。あらすじを受けて、小説の書き出しのように場面を描き、登場人物が自然に動き出すところまでを書いてください（ユーザーが最初の行動を選べる余地を残す）。' : ''}

出力は {"messages": [{"who": "ナレーション", "text": "…"}, {"who": "${members[0] ? nm(members[0]) : '名前'}", "text": "…"}]} の形のJSONのみ。`;
}
function buildGroupContents(hist, members, st) {
  const nameOf = (id) => { const c = members.find((x) => x.id === id); return c ? c.uraName || c.name : '（もういない人）'; };
  const turns = [];
  for (const m of hist) {
    const role = m.sender === 'me' ? 'user' : 'model';
    const line = m.sender === 'me' ? (m.image ? '（写真を見せた）' : '') + m.text : m.sender === 'narr' ? '＊' + m.text : `【${nameOf(m.speaker)}】${m.text}`;
    const t = turns[turns.length - 1];
    if (t && t.role === role) t.parts[0].text += '\n' + line;
    else turns.push({ role, parts: [{ text: line }] });
  }
  if (!turns.length || turns[turns.length - 1].role !== 'user') turns.push({ role: 'user', parts: [{ text: '（物語を始めてください）' }] });
  return turns;
}
async function groupReply(env, g, hist, key) {
  const st = await getSettings(env);
  const members = (await loadChars(env)).filter((c) => g.members.includes(c.id));
  if (!members.length) throw new HttpError(400, 'このグループにはメンバーがいません');
  const start = !hist.length;
  const wb = await worldBlock(env, members.map((c) => c.prompt).join('\n') + '\n' + g.synopsis + '\n' + hist.slice(-20).map((m) => m.text).join('\n'));
  const r = await callAIObj(env, 'ura', wb + buildGroupSystem(g, members, st, start), buildGroupContents(hist, members, st), GROUP_SCHEMA, 'group_reply', g.length === 'long' ? { effort: 'medium' } : null);
  const byName = (w) => {
    const s = String(w || '').trim().replace(/^[【「]|[】」]$/g, '');
    return members.find((c) => s === (c.uraName || c.name) || s === c.name) || members.find((c) => s && (s.includes(c.uraName || c.name) || (c.uraName || c.name).includes(s)));
  };
  const items = [];
  for (const x of (r && r.messages) || []) {
    const text = String(x.text || '').trim().replace(/^「([\s\S]*)」$/, '$1');
    if (!text) continue;
    const who = String(x.who || '').trim();
    if (NARR_WHO.includes(who) || /^[＊*]/.test(text)) { items.push({ sender: 'narr', text: text.replace(/^[＊*]+\s*/, '') }); continue; }
    const c = byName(who);
    items.push(c ? { sender: 'char', text, speaker: c.id } : { sender: 'narr', text: `${who}「${text}」` }); // 登場人物にいない名前は、地の文として残す
  }
  const out = items.slice(0, Math.min(g.maxSplit, 12) + 2);
  if (!out.length) throw new Error('返答が空でした');
  const t0 = Date.now();
  const res = await env.DB.batch(out.map((x, i) => env.DB.prepare('INSERT INTO messages (char_id,sender,text,at,speaker) VALUES (?,?,?,?,?)').bind(key, x.sender, x.text, t0 + i, x.speaker || null)));
  return out.map((x, i) => ({ id: res[i].meta.last_row_id, charId: key, sender: x.sender, text: x.text, at: t0 + i, ...(x.speaker ? { speaker: x.speaker } : {}) }));
}

// 引用返信の候補：最近のユーザーのメッセージ（続けて2つ以上送られたときや、少し前の話があるとき）
function quoteCandidates(hist) {
  const mine = hist.slice(-20).filter((m) => m.sender === 'me' && m.text && !m.retracted);
  if (mine.length < 2) return null;
  let burst = 0;
  for (let i = hist.length - 1; i >= 0 && hist[i].sender === 'me'; i--) burst++;
  if (burst < 2 && Math.random() > 0.15) return null; // 1つだけのときは、ときどき（前の話に戻るとき用）
  return mine.slice(-6);
}
// 追伸・不在着信のあとの言葉（毎分確認）。その間にやり取りが進んでいたら送らない
async function runDuePostscripts(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare("SELECT k,v FROM kv WHERE k >= 'ps:' AND k < 'ps;'").all();
  if (!results.length) return 0;
  const chars = await loadChars(env);
  let n = 0;
  for (const row of results) {
    let p; try { p = JSON.parse(row.v); } catch (_) { p = null; }
    if (p && p.due > now) continue;
    const claimed = await env.DB.prepare('DELETE FROM kv WHERE k=? RETURNING k').bind(row.k).first();
    if (!claimed || !p) continue;
    const key = row.k.slice(3), c = chars.find((x) => x.id === key);
    if (!c) continue;
    const later = await env.DB.prepare('SELECT 1 FROM messages WHERE char_id=? AND id>? LIMIT 1').bind(key, p.after).first();
    if (later) continue;
    const texts = (p.texts || []).map((t) => String(t).trim()).filter(Boolean);
    if (!texts.length) continue;
    const t0 = Date.now();
    const res = await env.DB.batch(texts.map((t, i) => env.DB.prepare("INSERT INTO messages (char_id,sender,text,at) VALUES (?, 'char', ?, ?)").bind(key, t, t0 + i)));
    await pushToAll(env, c, texts.map((t, i) => ({ id: res[i].meta.last_row_id, text: t })));
    n++;
  }
  return n;
}

// あなたがTLに載せた写真を、キャラたちが反応できるように短い言葉にする（1回だけ）
async function describePhoto(env, world, imageId, text) {
  const im = await loadImage(env, imageId);
  if (!im) return '';
  const contents = [{ role: 'user', parts: [{ inlineData: { mimeType: im.mime, data: im.b64 } }, { text: `SNSに投稿された写真です。${text ? `本文は「${trunc(text, 200)}」。` : ''}写っているものを、見た人が反応しやすいように具体的に1〜2文で説明してください（何が・どんな様子か・雰囲気。人物が写っていれば、人数やしていることだけを書き、見た目の特徴は書かない）。` }] }];
  const r = await callAIObj(env, world, 'あなたは写真の内容を短く正確に説明する係です。', contents,
    { type: 'object', properties: { alt: { type: 'string' } }, required: ['alt'], additionalProperties: false }, 'photo_alt');
  return String((r && r.alt) || '').trim().slice(0, 200);
}

async function applyRetracts(env) {
  await env.DB.prepare('UPDATE messages SET retracted=1 WHERE retract_at IS NOT NULL AND retract_at<=? AND retracted=0').bind(Date.now()).run();
}

// ================================================================ バックアップ（全データの書き出し・自動バックアップ・確認・復元）
// 通知の宛先（subs）と、この端末・このサーバー専用の値（通知の鍵 vapid、アドレス origin、バックアップ自身の記録 bk:*）は含めない。
// 合言葉やAPIキーはDBに無いので、ファイルにも入らない。
const EXPORT_TABLES = ['chars', 'groups', 'messages', 'reads', 'kv', 'char_state', 'memories', 'ura_icons', 'me_icons', 'tl_posts', 'tl_comments', 'tl_likes', 'tl_jobs', 'ai_cost'];
const BK_TABLES = [...EXPORT_TABLES, 'images'];
const KV_LOCAL_SQL = "(k < 'bk:' OR k >= 'bk;') AND k NOT IN ('vapid','origin')"; // 書き出し・消去・復元の対象にする kv
const kvRowOk = (r) => !(String(r.k).startsWith('bk:') || r.k === 'vapid' || r.k === 'origin');
const tblWhere = (t) => (t === 'kv' ? ' AND ' + KV_LOCAL_SQL : '');
function exportAll(env, withImages) {
  const tables = withImages ? BK_TABLES : EXPORT_TABLES;
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter(), enc = new TextEncoder();
  const put = (t) => w.write(enc.encode(t));
  (async () => {
    try {
      const counts = {};
      await put(`{"app":"トーク","version":${JSON.stringify(VERSION)},"exportedAt":${Date.now()},"images":${withImages},"tables":{`);
      for (let ti = 0; ti < tables.length; ti++) {
        const t = tables[ti];
        await put(`${ti ? ',' : ''}${JSON.stringify(t)}:[`);
        let last = -1, n = 0;
        for (;;) { // rowid順に少しずつ読む（写真があっても一度に抱えない）
          const { results } = await env.DB.prepare(`SELECT rowid AS _r, * FROM ${t} WHERE rowid>?${tblWhere(t)} ORDER BY rowid LIMIT ${t === 'images' ? 20 : 500}`).bind(last).all();
          if (!results.length) break;
          for (const { _r, ...row } of results) { await put((n ? ',' : '') + JSON.stringify(row)); n++; last = _r; }
        }
        counts[t] = n;
        await put(']');
      }
      await put(`},"counts":${JSON.stringify(counts)}}`); // 受け取った側で、途中で欠けていないか数え合わせる
      await w.close();
    } catch (e) { await w.abort(e).catch(() => {}); }
  })();
  return fileResponse(readable, `talk-backup-${jstDate(Date.now())}${withImages ? '-photos' : ''}.json`);
}
const jstDate = (t) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const fileResponse = (body, name) => new Response(body, { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Access-Control-Expose-Headers': 'Content-Disposition' } });

// ---- 自動バックアップ（R2）
// 置き方：talk/slots.json（1日用 a・15日用 b・戻す前 pre がそれぞれどれを指すか）と talk/gens/<世代>/p00000.json …（中身を小分けにしたもの）・manifest.json
// 新しい世代を全部書いて確かめ終わってから slots.json を書き換え、古い世代を消す（途中で失敗しても、前のバックアップは残る）
const BK_PREFIX = 'talk/';
const BK_SLOT_NAME = { a: '1日用', b: '15日用', pre: '戻す前の状態' };
const BK_ROWS = (t) => (t === 'images' ? 2 : 500); // 1回の処理を軽く（無料プランの計算時間の上限に余裕を持たせる）
const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (bytes) => hexOf(await crypto.subtle.digest('SHA-256', bytes));
function bkCycle(now) { // 今が「1日用」「15日用」のどちらの期間か
  const d = new Date(now + 9 * 3600e3), day = d.getUTCDate(), slot = day >= 15 ? 'b' : 'a';
  return { cycle: d.toISOString().slice(0, 7) + '-' + slot, slot, day, hour: d.getUTCHours() };
}
async function bkSlots(env) {
  const o = await env.BACKUP.get(BK_PREFIX + 'slots.json');
  if (!o) return {};
  try { return JSON.parse(await o.text()) || {}; } catch (_) { return {}; }
}
async function bkPutVerified(env, key, text) { // 指紋つきで書き、読み戻して同じか確かめる
  const bytes = new TextEncoder().encode(text);
  const sha = await sha256Hex(bytes);
  await env.BACKUP.put(key, bytes, { sha256: sha, httpMetadata: { contentType: 'application/json' } });
  const o = await env.BACKUP.get(key);
  if (!o) throw new Error('書き込んだファイルが見つかりません');
  if (await sha256Hex(await o.arrayBuffer()) !== sha) throw new Error('読み戻した中身が書いたものと一致しません');
  return { sha, bytes: bytes.length };
}
async function bkReadPart(env, p) { // 1つ読んで指紋を確かめる
  const o = await env.BACKUP.get(p.key);
  if (!o) throw new Error('バックアップの一部が見つかりません（' + p.key.split('/').pop() + '）');
  const buf = await o.arrayBuffer();
  if (await sha256Hex(buf) !== p.sha) throw new Error('バックアップの一部が壊れています（' + p.key.split('/').pop() + '）');
  return new TextDecoder().decode(buf);
}
async function bkDeleteGen(env, gen) {
  if (!gen) return;
  let cursor;
  do {
    const l = await env.BACKUP.list({ prefix: `${BK_PREFIX}gens/${gen}/`, cursor, limit: 1000 });
    const keys = l.objects.map((o) => o.key);
    if (keys.length) await env.BACKUP.delete(keys);
    cursor = l.truncated ? l.cursor : null;
  } while (cursor);
}
async function bkLease(env, ms = 55e3) { // cronとアプリが同時に進めないように
  const now = Date.now();
  const r = await env.DB.prepare("INSERT INTO kv (k,v) VALUES ('bk:lease',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v WHERE CAST(kv.v AS INTEGER) < ? RETURNING k").bind(String(now + ms), now).first();
  return !!r;
}
const bkRelease = (env) => env.DB.prepare("DELETE FROM kv WHERE k='bk:lease'").run();

async function bkStartJob(env, { kind, slot, force = false, cycle = '', keepGen = '' }) {
  // 始めた時点の各表の最後の行までを書き出す（書き出し中に増えた分は次回）
  const mx = await env.DB.prepare(`SELECT ${BK_TABLES.map((t) => `(SELECT COALESCE(MAX(rowid),0) FROM ${t}) AS ${t}`).join(',')}`).first();
  const ct = await env.DB.prepare(`SELECT ${BK_TABLES.map((t) => `(SELECT COUNT(*) FROM ${t} WHERE rowid<=?${tblWhere(t)}) AS ${t}`).join(',')}`).bind(...BK_TABLES.map((t) => mx[t])).first();
  const job = {
    gen: new Date(Date.now() + 9 * 3600e3).toISOString().replace(/\D/g, '').slice(0, 14) + '-' + randomAlnum(6),
    kind, slot, force: !!force, cycle, keepGen, started: Date.now(), phase: 'export', ti: 0, last: -1, seq: 0,
    max: { ...mx }, expect: { ...ct }, counts: {}, parts: [], bytes: 0,
  };
  await kvSet(env, 'bk:job', job);
  return job;
}
async function bkExportPart(env, job) {
  const t = BK_TABLES[job.ti];
  const { results } = await env.DB.prepare(`SELECT rowid AS _r, * FROM ${t} WHERE rowid>? AND rowid<=?${tblWhere(t)} ORDER BY rowid LIMIT ${BK_ROWS(t)}`).bind(job.last, job.max[t]).all();
  if (!results.length) { job.ti++; job.last = -1; return; }
  job.last = results[results.length - 1]._r;
  const rows = results.map(({ _r, ...r }) => r);
  const key = `${BK_PREFIX}gens/${job.gen}/p${String(job.seq++).padStart(5, '0')}.json`;
  const { sha, bytes } = await bkPutVerified(env, key, JSON.stringify({ table: t, rows }));
  job.parts.push({ key, sha, bytes, table: t, rows: rows.length });
  job.counts[t] = (job.counts[t] || 0) + rows.length;
  job.bytes += bytes;
}

// 中身の確かめ（自動バックアップのたび・手動の書き出しのあと）
async function bkIntegrity(env) {
  const problems = [], warnings = [];
  let quick = 'skip';
  try {
    const { results } = await env.DB.prepare('PRAGMA quick_check').all();
    const v = results.map((r) => String(Object.values(r)[0]));
    quick = v.length === 1 && v[0] === 'ok' ? 'ok' : 'ng';
    if (quick === 'ng') problems.push('データベースの検査で異常が見つかりました：' + v.slice(0, 3).join(' / '));
  } catch (_) { quick = 'skip'; } // 使えない環境では飛ばす
  const { results: cs } = await env.DB.prepare('SELECT id,data FROM chars').all();
  const bad = cs.filter((c) => { try { JSON.parse(c.data); return false; } catch (_) { return true; } });
  if (bad.length) problems.push(`キャラ設定が読めません（${bad.length}人）`);
  const one = async (sql) => ((await env.DB.prepare(sql).first()) || {}).n || 0;
  const orphan = await one(`SELECT COUNT(*) AS n FROM messages WHERE char_id NOT IN (SELECT id FROM chars) AND char_id NOT IN (SELECT id || '${URA}' FROM chars) AND char_id NOT IN (SELECT id || '${URA}' FROM groups)`);
  if (orphan) warnings.push(`持ち主のいないメッセージが${orphan}件あります`);
  const brokenImg = await one('SELECT COUNT(*) AS n FROM (SELECT id FROM images GROUP BY id HAVING COUNT(*)<>MAX(part)+1 OR COUNT(DISTINCT mime)>1)');
  if (brokenImg) warnings.push(`欠けている写真が${brokenImg}枚あります`);
  const lost = await one("SELECT (SELECT COUNT(*) FROM messages WHERE image IS NOT NULL AND image<>'' AND retracted=0 AND image NOT IN (SELECT id FROM images)) + (SELECT COUNT(*) FROM tl_posts WHERE image IS NOT NULL AND image<>'' AND image NOT IN (SELECT id FROM images)) AS n");
  if (lost) warnings.push(`見つからない写真が${lost}枚あります`);
  const { results: kvs } = await env.DB.prepare('SELECT k,v FROM kv').all();
  const badKv = kvs.filter((r) => { try { JSON.parse(r.v); return false; } catch (_) { return true; } });
  if (badKv.length) warnings.push(`読めない内部データが${badKv.length}件あります`);
  const photos = await one('SELECT COUNT(DISTINCT id) AS n FROM images');
  return { problems, warnings, quick, photos };
}
const BK_DROP = [['messages', 'メッセージ'], ['tl_posts', 'TLの投稿'], ['tl_comments', 'TLのコメント'], ['photos', '写真'], ['chars', 'キャラ']];
function bkDrops(prev, cur) { // 前のバックアップより急に減っていないか
  const out = [];
  if (!prev || !prev.counts) return out;
  for (const [t, label] of BK_DROP) {
    const p = t === 'photos' ? prev.photos || 0 : prev.counts[t] || 0, c = t === 'photos' ? cur.photos || 0 : cur.counts[t] || 0;
    if (t === 'chars' ? c < p : p >= 50 && c < p * 0.8 && p - c >= 20) out.push(`${label}が${p}→${c}に減っています`);
  }
  return out;
}

async function bkStatus(env) { return kvGet(env, 'bk:status', { cycles: {} }); }
async function bkFinishJob(env, job, ok, info) {
  const st = await bkStatus(env);
  st.cycles = st.cycles || {};
  st.last = { at: Date.now(), ok, kind: job.kind, slot: job.slot, ...info };
  if (job.kind === 'auto' && job.cycle) {
    const c = st.cycles[job.cycle] || {};
    if (ok) st.cycles[job.cycle] = { ok: true, at: Date.now() };
    else st.cycles[job.cycle] = { ...c, attempts: (c.attempts || 0) + 1, lastTry: Date.now(), blocked: !!info.blocked };
    const keys = Object.keys(st.cycles).sort();
    for (const k of keys.slice(0, -6)) delete st.cycles[k];
  }
  await kvSet(env, 'bk:status', st);
  await env.DB.prepare("DELETE FROM kv WHERE k='bk:job'").run();
  if (!ok && job.kind === 'auto' && !info.cancelled) await bkNotify(env, info.blocked ? 'バックアップを保存しませんでした（' + (info.problems || []).concat(info.drops || []).slice(0, 2).join('、') + '）。前のバックアップはそのまま残しています。' : 'バックアップに失敗しました：' + (info.error || '')).catch(() => {});
}
async function bkNotify(env, body, title = 'トーク（バックアップ）') { // 問題があったときだけ知らせる
  const st = await getSettings(env);
  if (st.notifyVia !== 'bark') await pushPayload(env, { title, body });
  if (st.notifyVia !== 'web' && env.BARK_DEVICE_KEY) await sendBark(env, st, { title, body, group: 'お知らせ' }).catch(() => {});
}
async function bkCheckAndCommit(env, job) {
  // ① 件数：始めた時点の件数（以下）と今の件数（以上）のあいだに収まっているか（書き出し中に消された分だけずれてよい）
  const ct = await env.DB.prepare(`SELECT ${BK_TABLES.map((t) => `(SELECT COUNT(*) FROM ${t} WHERE rowid<=?${tblWhere(t)}) AS ${t}`).join(',')}`).bind(...BK_TABLES.map((t) => job.max[t])).first();
  const miss = BK_TABLES.filter((t) => { const n = job.counts[t] || 0; return n > job.expect[t] || n < ct[t]; });
  if (miss.length) throw new Error('書き出した件数が合いません（' + miss.join('・') + '）');
  // ② 中身の確かめ
  const integ = await bkIntegrity(env);
  const cur = { counts: job.counts, photos: integ.photos };
  // ③ 急に減っていないか（自動のときだけ。前の自動バックアップと比べる）
  const slots = await bkSlots(env);
  let drops = [];
  if (job.kind === 'auto') {
    const prev = ['a', 'b'].map((s) => slots[s]).filter(Boolean).sort((x, y) => y.at - x.at)[0];
    drops = bkDrops(prev, cur);
    if (drops.length && prev && (await kvGet(env, 'bk:userdel', 0)) > prev.at) { // ご自身で消した分なら、知らせるだけにする
      integ.warnings.push(...drops.map((d) => d + '（消した分）')); drops = [];
    }
  }
  if (!job.force && job.kind === 'auto' && (integ.problems.length || drops.length)) {
    await bkDeleteGen(env, job.gen);
    await bkFinishJob(env, job, false, { blocked: true, problems: integ.problems, drops, warnings: integ.warnings });
    return false;
  }
  const at = Date.now();
  const info = { gen: job.gen, at, kind: job.kind, counts: job.counts, photos: integ.photos, bytes: job.bytes, parts: job.parts.length, warnings: [...integ.problems, ...drops, ...integ.warnings], quick: integ.quick, images: true };
  await bkPutVerified(env, `${BK_PREFIX}gens/${job.gen}/manifest.json`, JSON.stringify({ app: 'トーク', version: VERSION, ...info, parts: job.parts }));
  const old = slots[job.slot];
  slots[job.slot] = info;
  await env.BACKUP.put(BK_PREFIX + 'slots.json', JSON.stringify(slots));
  if (old && old.gen !== job.gen && old.gen !== job.keepGen && !Object.values(slots).some((s) => s && s.gen === old.gen)) await bkDeleteGen(env, old.gen);
  await bkFinishJob(env, job, true, { counts: job.counts, photos: integ.photos, bytes: job.bytes, warnings: info.warnings, forced: job.force });
  return true;
}

// 1回分だけ進める（cronは毎分・アプリは開いているあいだ続けて呼ぶ）
async function backupStep(env, { cron = false, budgetMs = 20e3, maxParts = cron ? 4 : 6 } = {}) {
  if (!env.BACKUP) return { noR2: true };
  await ensureSchema(env); // 新しい表（グループなど）ができてから数える
  let job = await kvGet(env, 'bk:job', null);
  let rs = await kvGet(env, 'bk:restore', null);
  if (!job && !rs) {
    if (!cron) return { idle: true };
    const c = bkCycle(Date.now()), st = await bkStatus(env), cy = (st.cycles || {})[c.cycle] || {};
    const due = !cy.ok && !cy.blocked && (cy.attempts || 0) < 3 && (cy.attempts ? Date.now() - cy.lastTry >= 6 * 3600e3 : !(c.day === 1 || c.day === 15) || c.hour >= 4);
    if (!due) return { idle: true };
    if (!(await bkLease(env))) return { busy: true };
    try { job = await bkStartJob(env, { kind: 'auto', slot: c.slot, cycle: c.cycle }); } finally { await bkRelease(env); }
    return { started: true };
  }
  if (!(await bkLease(env))) return { busy: true };
  const t0 = Date.now();
  try {
    if (job) {
      try {
        for (let n = 0; job.phase === 'export' && n < maxParts && Date.now() - t0 < budgetMs; n++) {
          if (job.ti >= BK_TABLES.length) { job.phase = 'check'; break; }
          await bkExportPart(env, job);
          if (job.ti >= BK_TABLES.length) job.phase = 'check';
        }
        await kvSet(env, 'bk:job', job);
        if (job.phase === 'check' && Date.now() - t0 < budgetMs) {
          const ok = await bkCheckAndCommit(env, job);
          if (rs && job.kind === 'pre') { // 戻す前の保存が済んだら、消して入れ直す段階へ
            rs = ok ? { ...rs, phase: 'wipe' } : null;
            if (rs) await kvSet(env, 'bk:restore', rs);
          }
        }
      } catch (e) {
        await bkDeleteGen(env, job.gen).catch(() => {});
        await bkFinishJob(env, job, false, { error: e.message });
        await log(env, 'バックアップ: ' + e.message);
        if (rs && job.kind === 'pre') { // 戻す前の保存ができなければ、何も変えずにやめる
          await env.DB.prepare("DELETE FROM kv WHERE k IN ('bk:restore','bk:lock')").run();
          await bkRestoreResult(env, false, '戻す前の状態を保存できなかったため、中止しました（データはそのままです）：' + e.message);
        }
      }
      return { job: true };
    }
    await bkRestoreStep(env, rs, t0, budgetMs, maxParts);
    return { restore: true };
  } finally { await bkRelease(env); }
}

// ---- 復元（戻す）
async function bkRestoreResult(env, ok, msg) {
  const st = await bkStatus(env);
  st.restore = { at: Date.now(), ok, msg };
  await kvSet(env, 'bk:status', st);
}
const colsMemo = {};
async function tableCols(env, t) {
  if (!colsMemo[t]) colsMemo[t] = (await env.DB.prepare(`PRAGMA table_info(${t})`).all()).results.map((r) => r.name);
  return colsMemo[t];
}
async function bkInsertRows(env, t, rows) {
  if (t === 'kv') rows = rows.filter(kvRowOk);
  if (!rows.length) return;
  const have = new Set(await tableCols(env, t));
  const cols = Object.keys(rows[0]).filter((c) => have.has(c));
  const sql = `INSERT OR REPLACE INTO ${t} (${cols.join(',')}) SELECT ${cols.map((c) => `json_extract(value,'$.${c}')`).join(',')} FROM json_each(?)`;
  const stmts = [];
  let chunk = [], size = 0;
  for (const r of rows) { // 1回に渡す量を1.2MBほどまでに分ける（D1の上限より小さく）
    const s = JSON.stringify(Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
    if (chunk.length && size + s.length > 1.2e6) { stmts.push(env.DB.prepare(sql).bind('[' + chunk.join(',') + ']')); chunk = []; size = 0; }
    chunk.push(s); size += s.length;
  }
  if (chunk.length) stmts.push(env.DB.prepare(sql).bind('[' + chunk.join(',') + ']'));
  for (let i = 0; i < stmts.length; i += 20) await env.DB.batch(stmts.slice(i, i + 20));
}
async function bkRestoreStep(env, rs, t0, budgetMs, maxParts) {
  if (rs.phase === 'verify') { // 消す前に、戻す元が全部そろっていて壊れていないか確かめる
    try {
      for (let n = 0; rs.vi < rs.parts.length && n < maxParts * 2 && Date.now() - t0 < budgetMs; n++) {
        const p = rs.parts[rs.vi];
        const d = JSON.parse(await bkReadPart(env, p));
        if (d.table !== p.table || !Array.isArray(d.rows) || d.rows.length !== p.rows) throw new Error('バックアップの一部の中身が合いません');
        rs.vi++;
      }
    } catch (e) {
      await env.DB.prepare("DELETE FROM kv WHERE k IN ('bk:restore','bk:lock')").run();
      await bkRestoreResult(env, false, '戻す元のバックアップに問題があったため、中止しました（データはそのままです）：' + e.message);
      return;
    }
    if (rs.vi < rs.parts.length) { await kvSet(env, 'bk:restore', rs); return; }
    rs.phase = 'snapshot';
    await kvSet(env, 'bk:restore', rs);
    await bkStartJob(env, { kind: 'pre', slot: 'pre', keepGen: rs.srcGen });
    return;
  }
  if (rs.phase === 'snapshot') { await bkStartJob(env, { kind: 'pre', slot: 'pre', keepGen: rs.srcGen }); return; } // 保存の途中で記録が消えていたら、やり直す
  if (rs.phase === 'wipe') {
    const stmts = EXPORT_TABLES.filter((t) => t !== 'kv').map((t) => env.DB.prepare(`DELETE FROM ${t}`));
    stmts.push(env.DB.prepare(`DELETE FROM kv WHERE ${KV_LOCAL_SQL}`));
    if (rs.images) stmts.push(env.DB.prepare('DELETE FROM images')); // 写真の入っていないバックアップなら、今の写真は残す
    await env.DB.batch(stmts);
    rs.phase = 'insert'; rs.pi = 0;
    await kvSet(env, 'bk:restore', rs);
    return;
  }
  if (rs.phase === 'insert') {
    for (let n = 0; rs.pi < rs.parts.length && n < maxParts && Date.now() - t0 < budgetMs; n++) {
      const p = rs.parts[rs.pi];
      if (p.table !== 'tl_jobs' && (p.table !== 'images' || rs.images) && BK_TABLES.includes(p.table)) {
        const d = JSON.parse(await bkReadPart(env, p));
        await bkInsertRows(env, p.table, d.rows || []);
      }
      rs.pi++;
      await kvSet(env, 'bk:restore', rs);
    }
    if (rs.pi < rs.parts.length) return;
    rs.phase = 'finish';
  }
  if (rs.phase === 'finish') {
    // 古い予約（返事・話しかけ・災害の反応・TLの反応）は持ち込まない
    await env.DB.batch([
      env.DB.prepare("DELETE FROM kv WHERE (k >= 'reply:' AND k < 'reply;') OR (k >= 'replygo:' AND k < 'replygo;') OR (k >= 'proj:' AND k < 'proj;') OR (k >= 'disjob:' AND k < 'disjob;') OR (k >= 'ps:' AND k < 'ps;')"),
      env.DB.prepare('DELETE FROM tl_jobs'),
      env.DB.prepare('UPDATE tl_posts SET planned=1'),
      env.DB.prepare("DELETE FROM kv WHERE k IN ('bk:restore','bk:lock')"),
    ]);
    worldMemo = null;
    const slots = await bkSlots(env);
    if (rs.srcGen && !Object.values(slots).some((s) => s && s.gen === rs.srcGen)) await bkDeleteGen(env, rs.srcGen).catch(() => {});
    await env.DB.prepare("DELETE FROM kv WHERE k='bk:upload'").run();
    await bkRestoreResult(env, true, `${rs.label}から戻しました`);
  }
}
async function bkManifest(env, gen) {
  const o = await env.BACKUP.get(`${BK_PREFIX}gens/${gen}/manifest.json`);
  if (!o) throw new HttpError(404, 'バックアップが見つかりません');
  return JSON.parse(await o.text());
}
// バックアップを1つのファイル（手動の書き出しと同じ形）にしてiPhoneへ
async function bkDownload(env, gen, withImages, label) {
  const m = await bkManifest(env, gen);
  const parts = m.parts.filter((p) => withImages || p.table !== 'images');
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter(), enc = new TextEncoder();
  const put = (t) => w.write(enc.encode(t));
  (async () => {
    try {
      const counts = {};
      await put(`{"app":"トーク","version":${JSON.stringify(m.version)},"exportedAt":${m.at},"images":${withImages},"tables":{`);
      let cur = null, first = true;
      for (const p of parts) {
        const text = await bkReadPart(env, p);
        const head = `{"table":${JSON.stringify(p.table)},"rows":[`;
        if (!text.startsWith(head) || !text.endsWith(']}')) throw new Error('形式が違います');
        if (p.table !== cur) { await put(`${cur ? ']' : ''}${first ? '' : ','}${JSON.stringify(p.table)}:[`); cur = p.table; first = false; counts[cur] = 0; }
        else await put(',');
        await put(text.slice(head.length, -2));
        counts[cur] += p.rows;
      }
      if (cur) await put(']');
      await put(`},"counts":${JSON.stringify(counts)}}`);
      await w.close();
    } catch (e) { await w.abort(e).catch(() => {}); }
  })();
  return fileResponse(readable, `talk-backup-${label}-${jstDate(m.at)}${withImages ? '-photos' : ''}.json`);
}
async function bkView(env) { // 設定画面用
  const st = await bkStatus(env);
  const out = { r2: !!env.BACKUP, last: st.last || null, restoreResult: st.restore || null, slots: {}, job: null, restore: null, lock: !!(await kvGet(env, 'bk:lock', 0)), cycle: null };
  if (!env.BACKUP) return out;
  const slots = await bkSlots(env);
  for (const k of Object.keys(BK_SLOT_NAME)) if (slots[k]) { const { gen, ...rest } = slots[k]; out.slots[k] = { ...rest, name: BK_SLOT_NAME[k] }; }
  const job = await kvGet(env, 'bk:job', null);
  if (job) out.job = { kind: job.kind, slot: job.slot, phase: job.phase, table: job.ti, tables: BK_TABLES.length, parts: job.parts.length, bytes: job.bytes, started: job.started };
  const rs = await kvGet(env, 'bk:restore', null);
  if (rs) out.restore = { phase: rs.phase, label: rs.label, done: rs.phase === 'verify' ? rs.vi || 0 : rs.pi || 0, parts: rs.parts.length, started: rs.started };
  const c = bkCycle(Date.now()), cy = (st.cycles || {})[c.cycle] || {};
  out.cycle = { slot: c.slot, name: BK_SLOT_NAME[c.slot], ok: !!cy.ok, blocked: !!cy.blocked, attempts: cy.attempts || 0 };
  return out;
}
function needR2(env) { if (!env.BACKUP) throw new HttpError(400, '自動バックアップの置き場所（R2）がまだつながっていません'); }
const noteUserDelete = (env) => kvSet(env, 'bk:userdel', Date.now()).catch(() => {}); // ご自身で消した（急に減っても異常としない）

// ================================================================ タイムライン（表／裏）
// 表と裏は投稿・いいね・コメント・予定・記憶がすべて別。AIはその世界の設定（表のAI／裏のAI）を使う。
// 反応の決め方：
//   ① 性格（設定値「反応のしやすさ」＋AIがプロンプトから読んだ「反応したくなる度合い」）と仲の良さ
//   ② 投稿の中身への食いつき（AIが全キャラ分をまとめて0〜100で判定）
//   ③ 最後に少しだけサイコロで揺らぎ
//   点数が高いほど、いいね・コメントしやすく、反応も早い。
const ME = 'me';
const MIN = 60 * 1000;

const nz = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const cName = (c, world) => (world === 'ura' && c.uraName ? c.uraName : c.name);
function charPersona(c, world, max = 4000) {
  let p;
  if (world === 'ura') {
    const own = c.uraCharPrompt && c.uraCharPrompt.trim();
    p = (own ? c.uraCharPrompt : (c.prompt || '（設定なし）')) + (c.uraPrompt ? '\n（この世界での追加設定）\n' + c.uraPrompt : '');
  } else p = c.prompt || '（設定なし）';
  return (p.length > max ? p.slice(0, max) + '…' : p) + bdayLine(c);
}
function meName(st, world) { return (world === 'ura' ? st.meNameUra || st.meName : st.meName) || 'あなた'; }
function worldDesc(world) {
  return world === 'ura'
    ? '「裏」の世界のSNS。ユーザーと実際に会って過ごしている世界で、表（メッセージアプリでやり取りしている世界）とは時間の流れも記憶も別。表での出来事は知らない。'
    : '「表」の世界のSNS。ユーザーとはふだんスマホのメッセージアプリ（トーク）でやり取りしている。';
}
const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

async function getPost(env, id) {
  const p = await env.DB.prepare('SELECT * FROM tl_posts WHERE id=?').bind(num(id, 0)).first();
  if (!p) throw new HttpError(404, '投稿が見つかりません');
  return p;
}

async function loadTimeline(env, world, limit) {
  const { results: posts } = await env.DB.prepare('SELECT id,world,author,text,at,image,alt FROM tl_posts WHERE world=? ORDER BY id DESC LIMIT ?').bind(world, limit).all();
  if (!posts.length) return [];
  const ids = posts.map((p) => p.id);
  const qs = ids.map(() => '?').join(',');
  const { results: cs } = await env.DB.prepare(`SELECT id,post_id,author,text,reply_to,at FROM tl_comments WHERE post_id IN (${qs}) ORDER BY id`).bind(...ids).all();
  const { results: ls } = await env.DB.prepare(`SELECT post_id,author,at FROM tl_likes WHERE post_id IN (${qs}) ORDER BY at`).bind(...ids).all();
  return posts.map(({ image, alt, ...p }) => ({
    ...p, ...(image ? { image, alt: alt || '' } : {}),
    likes: ls.filter((l) => l.post_id === p.id).map((l) => ({ author: l.author, at: l.at })),
    comments: cs.filter((c) => c.post_id === p.id).map((c) => ({ id: c.id, author: c.author, text: c.text, replyTo: c.reply_to, at: c.at })),
  }));
}

async function deletePosts(env, where, args) {
  const sub = `SELECT id FROM tl_posts WHERE ${where}`;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM tl_jobs WHERE post_id IN (${sub})`).bind(...args),
    env.DB.prepare(`DELETE FROM tl_comments WHERE post_id IN (${sub})`).bind(...args),
    env.DB.prepare(`DELETE FROM tl_likes WHERE post_id IN (${sub})`).bind(...args),
    env.DB.prepare(`DELETE FROM tl_posts WHERE ${where}`).bind(...args),
  ]);
}

// ---- 静かな時間（表のみ）にかかる予定は、静かな時間が明けてから少しずつ
function deferQuiet(due, st, world, rnd = Math.random(), postAt = 0) {
  if (world !== 'omote' || !isQuiet(due, st)) return due;
  if (postAt && isQuiet(postAt, st)) return due; // 静かな時間に投稿されたものは、コメント欄も昼と同じように動く
  if (rnd < QUIET_RATE) return due; // 夜更かし・早起きしている子は、たまにそのまま反応する
  let t = due;
  for (let i = 0; i < 200 && isQuiet(t, st); i++) t += 15 * MIN;
  return t + Math.floor(Math.random() * 90) * MIN;
}
// 点数 x（0〜1）が高いほど早い。指数分布でばらつかせる
function reactDelay(x, isComment) {
  const mean = 4 + Math.pow(1 - x, 2) * 360; // 分
  let d = -mean * Math.log(1 - Math.random());
  if (isComment) d += 2 + Math.random() * 6; // 文章を打つ時間
  return clamp(d, 1, 20 * 60) * MIN;
}

// ---- トークの様子（TLとトークをつなげる）
async function talkContext(env, c, world) {
  const key = world === 'ura' ? c.id + URA : c.id;
  const hist = await recent(env, key, 8);
  if (!hist.length) return '（まだやり取りはありません）';
  const nm = cName(c, world);
  const lines = hist.map((m) => (m.sender === 'me' ? 'ユーザー' : m.sender === 'narr' ? '（描写）' : nm) + ': ' + trunc(m.text, 120));
  let state = '';
  if (world === 'omote') {
    const last = hist[hist.length - 1];
    const ago = fmtDur(Date.now() - last.at);
    if (last.sender === 'char') {
      const lastRead = await getRead(env, key);
      const unread = hist.filter((m) => m.sender === 'char' && m.at > lastRead).length;
      state = unread ? `あなたが送ったメッセージ${unread}件が、まだ読まれていない（最後に送ってから${ago}）`
        : `ユーザーはあなたのメッセージを読んだが、返信がない（既読スルー、${ago}）`;
    } else state = `ユーザーからの最後のメッセージは${ago}前`;
  }
  return lines.join('\n') + (state ? '\n今の状況: ' + state : '');
}

// トークのAIに渡す「同じ世界のTLでの最近の出来事」
async function tlContextForTalk(env, c, world) {
  const now = Date.now();
  const ura = world === 'ura';
  const { results: mine } = await env.DB.prepare("SELECT id,text,at,alt FROM tl_posts WHERE world=? AND author='me' AND at>? ORDER BY id DESC LIMIT 4").bind(world, now - 48 * 3600e3).all();
  const { results: own } = await env.DB.prepare('SELECT id,text,at FROM tl_posts WHERE world=? AND author=? ORDER BY id DESC LIMIT 2').bind(world, c.id).all();
  if (!mine.length && !own.length) return '';
  const lines = [];
  for (const p of mine) {
    const liked = await env.DB.prepare('SELECT 1 FROM tl_likes WHERE post_id=? AND author=?').bind(p.id, c.id).first();
    const cm = await env.DB.prepare('SELECT text FROM tl_comments WHERE post_id=? AND author=? ORDER BY id DESC LIMIT 1').bind(p.id, c.id).first();
    lines.push(`- ユーザーの投稿${ura ? '' : `（${fmtDur(now - p.at)}前）`}「${trunc(p.text, 100)}」${p.alt ? `（写真：${trunc(p.alt, 80)}）` : ''}→ あなたは${liked ? 'いいね済み' : 'いいねしていない'}${cm ? `・コメント「${trunc(cm.text, 60)}」` : ''}`);
  }
  for (const p of own) {
    const lk = await env.DB.prepare("SELECT 1 FROM tl_likes WHERE post_id=? AND author='me'").bind(p.id).first();
    const uc = await env.DB.prepare("SELECT text FROM tl_comments WHERE post_id=? AND author='me' ORDER BY id DESC LIMIT 1").bind(p.id).first();
    lines.push(`- あなたの投稿${ura ? '' : `（${fmtDur(now - p.at)}前）`}「${trunc(p.text, 100)}」→ ユーザーは${lk ? 'いいねした' : 'いいねしていない'}${uc ? `・コメント「${trunc(uc.text, 60)}」` : ''}`);
  }
  return `
# SNS（タイムライン）での最近の出来事${ura ? '（この世界のSNS）' : ''}
${lines.join('\n')}
（自然な流れなら話題にしてよい。毎回触れる必要はない）
`;
}

// ---- ② 投稿の中身への食いつき・① 性格からの反応したさ を、全キャラ分まとめて判定
const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, interest: { type: 'integer' }, eagerness: { type: 'integer' }, bond: { type: 'integer' }, note: { type: 'string' } },
        required: ['id', 'interest', 'eagerness', 'bond', 'note'], additionalProperties: false,
      },
    },
  },
  required: ['scores'], additionalProperties: false,
};
const TEXT_SCHEMA = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };

async function scoreReactions(env, post, author, cands, st) {
  const world = post.world;
  const authorName = post.author === ME ? meName(st, world) : cName(author, world);
  const system = 'あなたはSNS上で、各キャラクターがある投稿にどれくらい反応しそうかを判定する係です。キャラクター設定（性格・好きなもの・苦手なもの・人間関係・ユーザーへの気持ち）をよく読み、キャラクターごとに数値で答えてください。';
  const user = `# 世界
${worldDesc(world)}

# 投稿
投稿者: ${authorName}${post.author === ME ? '（ユーザー本人）' : ''}
本文: ${post.text || '（本文なし。写真だけの投稿）'}${post.alt ? `\n添付写真：${post.alt}` : ''}
${post.author !== ME ? `\n# 投稿者（${authorName}）のキャラクター設定\n${charPersona(author, world, 1500)}\n` : ''}
# 判定するキャラクター
${cands.map((c) => `## id: ${c.id} ／ 名前: ${cName(c, world)}
ユーザーとの仲の良さ（設定値）: ${nz(c.affinity, 60)}/100
SNSでの反応のしやすさ（設定値）: ${nz(c.snsActivity, 50)}/100
キャラクター設定:
${charPersona(c, world, 2000)}`).join('\n\n')}

# 答えること（各キャラクターについて0〜100の整数）
- interest: この投稿の話題にどれくらい食いつくか。好きなもの・趣味・気になる人・嫉妬しそうな話題なら高く、興味のない話題や苦手なものは低く。
- eagerness: 性格から見て、SNSで反応したくなる度合い。構いたがり・寂しがり・社交的なら高く、クール・さっぱり・SNSに興味が薄いなら低く。
- bond: 投稿者との親しさ。投稿者がユーザーなら、そのキャラクターのユーザーへの好意の強さ。
- note: 反応するとしたら、どんな気持ちで何に触れそうか（20字以内）。
すべてのキャラクターについて、idはそのまま返してください。`;
  const r = await aiJson(env, world, (await worldBlock(env, system + '\n' + user)) + system, user, SCORE_SCHEMA, 'tl_scores');
  const out = {};
  for (const s of (r && r.scores) || []) if (s && s.id) out[String(s.id)] = s;
  return out;
}

// 投稿に対して、誰が・いつ・いいね／コメントするかを決めて予定に入れる
async function planReactions(env, post) {
  const claim = await env.DB.prepare('UPDATE tl_posts SET planned=1 WHERE id=? AND planned=0').bind(post.id).run();
  if (claim.meta && claim.meta.changes === 0) return []; // ほかの処理がもう決めた
  const st = await getSettings(env);
  const world = post.world;
  if (world === 'ura' && st.uraPaused) return []; // 裏は止めている（この投稿には反応しない）
  const chars = await loadChars(env);
  const author = post.author === ME ? null : chars.find((c) => c.id === post.author);
  if (post.author !== ME && !author) return [];
  const cands = chars.filter((c) => c.id !== post.author && (post.world === 'ura' || inOmote(c)));
  if (!cands.length) return [];
  let scores = {};
  try { scores = await scoreReactions(env, post, author, cands, st); }
  catch (e) { await log(env, 'TL判定: ' + e.message); }
  const now = Date.now();
  const plan = [];
  for (const c of cands) {
    const s = scores[c.id] || { interest: 50, eagerness: 50, bond: 50, note: '' };
    const interest = clamp(nz(s.interest, 50), 0, 100) / 100;
    const eager = clamp(nz(s.eagerness, 50), 0, 100) / 100;
    const aiBond = clamp(nz(s.bond, 50), 0, 100) / 100;
    const base = 0.5 * (nz(c.snsActivity, 50) / 100) + 0.5 * eager;                                   // ① 性格
    const bond = post.author === ME ? 0.6 * (nz(c.affinity, 60) / 100) + 0.4 * aiBond : aiBond;     // ① 仲の良さ
    const x = clamp(0.35 * base + 0.30 * bond + 0.35 * interest + (Math.random() - 0.5) * 0.16, 0, 1); // ② 話題 ＋ ③ 揺らぎ
    const pLike = clamp(0.03 + 0.97 * Math.pow(x, 0.9), 0, 0.97);
    const pComment = clamp(0.92 * Math.pow(x, 1.7), 0, 0.9);
    const doComment = Math.random() < pComment;
    const doLike = Math.random() < (doComment ? Math.min(0.97, pLike + 0.25) : pLike);
    const note = String(s.note || '').slice(0, 60);
    if (doLike) plan.push({ c, kind: 'like', due: await schedDue(env, c.id, deferQuiet(now + reactDelay(x, false), st, world, undefined, post.at), post, st), x });
    if (doComment) plan.push({ c, kind: 'comment', due: await schedDue(env, c.id, deferQuiet(now + reactDelay(x, true), st, world, undefined, post.at), post, st), note, x });
  }
  if (plan.length) {
    await env.DB.batch(plan.map((j) => env.DB.prepare('INSERT INTO tl_jobs (world,char_id,kind,post_id,comment_id,due,note) VALUES (?,?,?,?,NULL,?,?)')
      .bind(world, j.c.id, j.kind, post.id, j.due, j.note || '')));
  }
  return plan.map((j) => ({ char: j.c.id, kind: j.kind, inMin: Math.round((j.due - now) / MIN), x: Math.round(j.x * 100) }));
}

// あなたのコメントに、キャラが返事をするか決める
function threadRoot(comments, id) {
  let cur = comments.find((c) => c.id === id);
  for (let i = 0; cur && cur.reply_to && i < 50; i++) cur = comments.find((c) => c.id === cur.reply_to) || cur;
  return cur ? cur.id : id;
}
async function planReplyToMe(env, post, comment, replyTo) {
  const st = await getSettings(env);
  let target = null; // 返事をするキャラ
  if (replyTo && replyTo.author !== ME) target = replyTo.author;
  else if (!replyTo && post.author !== ME) target = post.author;
  if (!target) return;
  const c = (await loadChars(env)).find((x) => x.id === target);
  if (!c || (post.world === 'omote' && !inOmote(c))) return;
  const { results: all } = await env.DB.prepare('SELECT id,author,reply_to FROM tl_comments WHERE post_id=?').bind(post.id).all();
  const root = threadRoot(all, comment.id);
  const charReplies = all.filter((x) => x.author === c.id && x.reply_to && threadRoot(all, x.id) === root).length;
  if (charReplies >= 3) return; // やり取りは3往復まで
  const aff = nz(c.affinity, 60) / 100, act = nz(c.snsActivity, 50) / 100;
  const p = clamp((replyTo ? 0.55 : 0.45) + 0.35 * aff + 0.15 * act, 0, 0.98);
  if (Math.random() >= p) return;
  const x = clamp(0.4 + 0.6 * aff + (Math.random() - 0.5) * 0.2, 0, 1);
  const due = await schedDue(env, c.id, deferQuiet(Date.now() + reactDelay(x, true), st, post.world, undefined, post.at), post, st);
  await env.DB.prepare('INSERT INTO tl_jobs (world,char_id,kind,post_id,comment_id,due,note) VALUES (?,?,?,?,?,?,?)')
    .bind(post.world, c.id, 'reply', post.id, comment.id, due, '').run();
}

// ---- 文章を作る
function snsRules(world, now) {
  return `- キャラクターの口調・性格・相手との関係をそのまま出す。
- 地の文・ト書き・（ ）での動作描写は書かない。
- 自分がAIであることには触れない。
- 公開のSNSなので、性的に露骨な内容や、相手との個人的なやり取りをそのまま書き写すことはしない（ほのめかす程度はよい）。
${world === 'ura' ? '- この世界は表（メッセージアプリの世界）とは別の時間軸。表での出来事は知らない。' : `- 現在日時: ${fmtTime(now)}${jstParts(now).h < 7 || jstParts(now).h >= 23 ? '（深夜・早朝。夜更かし・早起きしている感じなど、時間帯らしさをにじませてよい）' : ''}`}`;
}

async function genComment(env, c, post, replyTo, note) {
  const st = await getSettings(env);
  const world = post.world;
  const now = Date.now();
  const chars = await loadChars(env);
  const nameOf = (a) => (a === ME ? meName(st, world) + '（ユーザー）' : (chars.find((x) => x.id === a) ? cName(chars.find((x) => x.id === a), world) : '退会したユーザー'));
  const { results: cms } = await env.DB.prepare('SELECT id,author,text,reply_to FROM tl_comments WHERE post_id=? ORDER BY id').bind(post.id).all();
  const system = `あなたは次のキャラクターとして、SNS（タイムライン）にコメントを書きます。

# キャラクター: ${cName(c, world)}
${charPersona(c, world)}

# ルール（キャラクター設定に別の指示があればそちらを優先）
- SNSのコメントらしく、短く自然な話し言葉で。1〜3文、長くても100字程度。
- 好きな話題なら嬉しそうに、嫉妬する話題なら拗ねたり、興味が薄ければそっけなく。気持ちの温度をはっきり出す。
${snsRules(world, now)}

出力は {"text": "コメント本文"} の形のJSONのみ。`;
  const user = `# 世界
${worldDesc(world)}

# 投稿
投稿者: ${nameOf(post.author)}${world === 'omote' ? `（${fmtDur(now - post.at)}前）` : ''}
本文: ${post.text || '（本文なし。写真だけの投稿）'}${post.alt ? `\n添付写真：${post.alt}` : ''}

# これまでのコメント
${cms.length ? cms.map((x) => `${nameOf(x.author)}${x.reply_to ? '（返信）' : ''}: ${trunc(x.text, 150)}`).join('\n') : '（まだなし）'}
${replyTo ? `\n# あなたが返信するコメント\n${nameOf(replyTo.author)}: ${replyTo.text}\n` : ''}
# あなたとユーザーの${world === 'ura' ? '最近の様子（実際に会ったとき）' : 'トークでのやり取り'}
${await talkContext(env, c, world)}
${note ? `\n# 反応の方向性\n${note}\n` : ''}
${replyTo ? 'このコメントへの返信を書いてください。' : 'この投稿へのコメントを書いてください。'}`;
  const r = await aiJson(env, world, (await worldBlock(env, system + '\n' + user)) + system, user, TEXT_SCHEMA, 'tl_comment');
  const text = String((r && r.text) || '').trim();
  if (!text) throw new Error('コメントが空でした');
  return text.slice(0, 500);
}

async function genPost(env, c, world, opts = {}) {
  const now = Date.now();
  const st = await getSettings(env);
  const life = world === 'omote' ? await tlLifeTheme(env, c, st, now).catch(() => null) : null;
  if (life && opts.eventHint) { life.hint = opts.eventHint; life.photo = !!opts.eventPhoto && st.imagesEnabled; life.done = null; } // 災害などの出来事についての投稿
  const chars = await loadChars(env);
  const { results: own } = await env.DB.prepare('SELECT text FROM tl_posts WHERE world=? AND author=? ORDER BY id DESC LIMIT 6').bind(world, c.id).all();
  const { results: others } = await env.DB.prepare('SELECT author,text FROM tl_posts WHERE world=? AND author<>? ORDER BY id DESC LIMIT 5').bind(world, c.id).all();
  const nameOf = (a) => (a === ME ? meName(st, world) + '（ユーザー）' : (chars.find((x) => x.id === a) ? cName(chars.find((x) => x.id === a), world) : '誰か'));
  const system = `あなたは次のキャラクターとして、SNS（タイムライン）に自分の投稿（つぶやき）を書きます。

# キャラクター: ${cName(c, world)}
${charPersona(c, world)}

# ルール（キャラクター設定に別の指示があればそちらを優先）
- 1〜3文、140字以内のつぶやき。今していること、ふと思ったこと、好きなもの、日常の出来事など。
- 絵文字やハッシュタグは、キャラクターに合えば少しだけ。
- ユーザーとのトークの状況（既読スルーされている、楽しく話した、など）を踏まえたつぶやきをしてもよい。ただしやり取りの中身はそのまま書かず、ほのめかす程度に。毎回トークに触れる必要はない。
- 前の投稿と同じ内容・同じ言い回しにしない。
${snsRules(world, now)}
${life && life.photo ? `- 今回は写真付きの投稿にする。photo に写真の内容を具体的に1文で書く（${PHOTO_SUBJECTS}）。本文は写真に添える一言。

出力は {"text": "投稿本文", "photo": "写真の内容"} の形のJSONのみ。` : '\n出力は {"text": "投稿本文"} の形のJSONのみ。'}`;
  const user = `# 世界
${worldDesc(world)}

# あなたの最近の投稿（重ならないように）
${own.length ? own.map((p) => '- ' + trunc(p.text, 100)).join('\n') : '（まだなし）'}

# タイムラインに流れている最近の投稿
${others.length ? others.map((p) => `- ${nameOf(p.author)}: ${trunc(p.text, 100)}`).join('\n') : '（まだなし）'}

# あなたとユーザーの${world === 'ura' ? '最近の様子（実際に会ったとき）' : 'トークでのやり取り'}
${await talkContext(env, c, world)}
${life ? life.info + '\n\n# 今回の投稿のテーマ\n' + life.hint + '\n' : ''}${world === 'omote' && isQuiet(now, st) ? '\n# 時間帯\n' + nightNote(now).replace(/相手は[^。]*。/, '') + 'テーマより時間帯らしさを優先してよい。\n' : ''}
この世界のSNSに、新しい投稿を1つ書いてください。`;
  const schema = life && life.photo ? PHOTO_POST_SCHEMA : TEXT_SCHEMA;
  const r = await aiJson(env, world, (await worldBlock(env, system + '\n' + user)) + system, user, schema, 'tl_post');
  const text = String((r && r.text) || '').trim();
  if (!text) throw new Error('投稿が空でした');
  if (life && life.done) await life.done();
  return { text: text.slice(0, 500), photo: life && life.photo ? String((r && r.photo) || '').trim().slice(0, 300) : '' };
}

// ---- 表のTL：投稿のテーマ（気分・日記・続いている出来事・天気・記念日・写真）
const PHOTO_POST_SCHEMA = { type: 'object', properties: { text: { type: 'string' }, photo: { type: 'string' } }, required: ['text', 'photo'], additionalProperties: false };
async function tlLifeTheme(env, c, st, now) {
  if (!st.lifeEnabled) return null;
  const state = await getState(env, c.id);
  const today = jstDay(now);
  let w = null;
  try { w = await getWeather(env, st); } catch (_) {}
  const occ = state.tlOcc === today ? [] : occasionsToday(c, st, now, (await loadChars(env)).filter(inOmote));
  const ev = state.tlOcc === today ? null : (EVENTS.find(([d]) => d === today.slice(5)) || [])[1];
  const table = [
    ['free', 25],
    ['mood', state.day === today ? 22 : 0],
    ['story', state.story ? 15 : 0],
    ['project', state.project && !state.project.finished ? 10 : 0],
    ['weather', w ? (weatherNotable(w) ? 18 : 5) : 0],
    ['occasion', occ.length ? 45 : ev ? 18 : 0],
    ['photo', st.imagesEnabled ? 18 : 0],
  ];
  const total = table.reduce((a, x) => a + x[1], 0);
  let r = Math.random() * total, theme = 'free';
  for (const [k, wgt] of table) { if ((r -= wgt) < 0) { theme = k; break; } }
  const info = [];
  if (state.day === today) {
    info.push(`# あなた（${c.name}）の今日の様子
気分：${state.mood}${state.moodReason ? `（${state.moodReason}）` : ''}
今日：${state.today}
${(state.diary || []).slice(-2).map((x) => `${fmtDay(x.d)}の出来事：${x.t}`).join('\n')}${state.story ? `
続いている出来事「${state.story.title}」：${state.story.log.map((x) => `${fmtDay(x.d)} ${x.t}`).join(' → ')}${state.story.finished ? '（区切りがついた）' : ''}` : ''}`);
  }
  info.push(`# あなたが今していること\n${activityText(state, now, c.id)}\n（投稿は今していること・ひと段落したことに自然につながるように）`);
  const dc = await disasterContext(env, st, now).catch(() => '');
  if (dc) info.push(dc.trim());
  info.push(`# 天気・季節（ユーザーの住んでいる地域）
${w ? '天気：' + weatherText(w, st) + '\n' : ''}${seasonText(now)}／${weekdayText(now)}`);
  const hints = {
    free: '自由に。今日の気分や天気をさりげなくにじませてもよい。',
    mood: '今日の気分や、今日していること・最近の出来事（日記）をつぶやく。',
    story: `続いている出来事「${state.story ? state.story.title : ''}」の今日の進み具合をつぶやく。`,
    project: `何週間も続けていること「${state.project ? state.project.title : ''}」の最近の進み具合をつぶやく（最近の様子：${state.project ? state.project.log.slice(-2).map((x) => x.t).join(' → ') : ''}）。`,
    weather: '今日の天気や気温にちなんだつぶやき（雨、暑さ、寒さ、空の様子など）。',
    occasion: occ.length
      ? `今日は「${occ.map((o) => o.label).join('・')}」。それにちなんだ投稿をする（ユーザーの誕生日なら、名前はぼかしつつお祝いの気持ちがにじむように。記念日なら嬉しさを）。`
      : `今日は${ev}。それにちなんだ投稿をする。`,
    photo: '写真付きの投稿。今日の暮らしの一枚を載せる。',
  };
  return {
    info: info.join('\n\n'), hint: hints[theme], photo: theme === 'photo',
    done: theme === 'occasion' ? async () => { const s2 = await getState(env, c.id); s2.tlOcc = today; await setState(env, c.id, s2); } : null,
  };
}

// ---- キャラが自分からつぶやくか（15分ごと）
async function shouldCharPost(env, c, world, now, st) {
  if (world === 'omote' && c.uraOnly) return false;
  const perDay = nz(world === 'ura' ? c.uraTlPerDay : c.tlPerDay, world === 'ura' ? 1 : 2);
  if (perDay <= 0) return false;
  if (world === 'ura' && st.uraPaused) return false; // 裏は止めている
  const boost = world === 'omote' ? await activityBoost(env, c, st, now).catch(() => ({ f: 1 })) : { f: 1 };
  const last = await env.DB.prepare('SELECT at FROM tl_posts WHERE world=? AND author=? ORDER BY id DESC LIMIT 1').bind(world, c.id).first();
  if (last && now - last.at < 60 * MIN) return false; // 続けて投稿しすぎない
  const activeTicks = Math.max(1, ((24 - quietSpan(st)) * 60) / TICK_MIN);
  return Math.random() < (perDay / activeTicks) * (isQuiet(now, st) ? QUIET_RATE : 1) * boost.f; // 静かな時間は大幅に下げる・今していることで変わる
}

async function charPostNow(env, c, world, st, opts = {}) {
  const { text, photo } = await genPost(env, c, world, opts);
  let image = null;
  if (photo && world === 'omote' && st.imagesEnabled) {
    try { image = await saveImage(env, await makeCharPhoto(env, photo)); }
    catch (e) { await log(env, `TLの写真を作れませんでした（${c.name}）: ${e.message}`); }
  }
  const alt = image ? photo : null;
  const at = Date.now();
  const r = await env.DB.prepare('INSERT INTO tl_posts (world,author,text,at,planned,image,alt) VALUES (?,?,?,?,0,?,?)').bind(world, c.id, text, at, image, alt).run();
  const post = { id: r.meta.last_row_id, world, author: c.id, text, at, planned: 0, image, alt };
  await pushTL(env, st, world, 'tlCharPost', { title: cName(c, world), body: (image ? '📷 ' : '') + text, post, actor: c.id });
  const { image: im, alt: al, ...rest } = post;
  return { ...rest, ...(im ? { image: im, alt: al } : {}), likes: [], comments: [] };
}

// ---- 予定の実行
async function runTlJobs(env, limit) {
  await ensureSchema(env);
  let n = 0;
  // 1) まだ反応を決めていない投稿
  const { results: unplanned } = await env.DB.prepare('SELECT * FROM tl_posts WHERE planned=0 ORDER BY id LIMIT 2').all();
  for (const p of unplanned) {
    try { await planReactions(env, p); } catch (e) { await log(env, 'TL判定: ' + e.message); }
  }
  // 2) 時間が来た いいね・コメント・返信
  const paused = (await getSettings(env)).uraPaused;
  const { results: due } = await env.DB.prepare(`SELECT * FROM tl_jobs WHERE due<=? ${paused ? "AND world<>'ura'" : ''} ORDER BY due LIMIT ?`).bind(Date.now(), limit).all(); // 裏を止めているあいだ、裏の反応は待たせておく
  for (const j of due) {
    const claimed = await env.DB.prepare('DELETE FROM tl_jobs WHERE id=? RETURNING id').bind(j.id).first();
    if (!claimed) continue; // ほかの処理が先に実行した
    try { if (await execJob(env, j)) n++; } catch (e) { await log(env, `TL反応（${j.kind}）: ${e.message}`); }
  }
  return n;
}

async function execJob(env, j) {
  const post = await env.DB.prepare('SELECT * FROM tl_posts WHERE id=?').bind(j.post_id).first();
  if (!post) return false;
  const c = (await loadChars(env)).find((x) => x.id === j.char_id);
  if (!c) return false;
  const st = await getSettings(env);
  const world = post.world;
  const who = cName(c, world);

  if (j.kind === 'like') {
    const r = await env.DB.prepare('INSERT OR IGNORE INTO tl_likes (post_id,author,at) VALUES (?,?,?)').bind(post.id, c.id, Date.now()).run();
    if (r.meta && r.meta.changes === 0) return false;
    if (post.author === ME) await pushTL(env, st, world, 'tlLike', { title: `${who}さんがいいねしました`, body: trunc(post.text || '📷 写真', 80), post, tag: 'like-' + post.id, actor: c.id });
    return true;
  }

  let replyTo = null;
  if (j.kind === 'reply') {
    replyTo = await env.DB.prepare('SELECT * FROM tl_comments WHERE id=?').bind(j.comment_id).first();
    if (!replyTo) return false;
  } else {
    const dup = await env.DB.prepare('SELECT 1 FROM tl_comments WHERE post_id=? AND author=? AND reply_to IS NULL').bind(post.id, c.id).first();
    if (dup) return false; // 同じ投稿に2回コメントしない
  }
  const text = await genComment(env, c, post, replyTo, j.note);
  const at = Date.now();
  const r = await env.DB.prepare('INSERT INTO tl_comments (post_id,world,author,text,reply_to,at) VALUES (?,?,?,?,?,?)')
    .bind(post.id, world, c.id, text, replyTo ? replyTo.id : null, at).run();
  const commentId = r.meta.last_row_id;

  if (replyTo && replyTo.author === ME) {
    await pushTL(env, st, world, 'tlReply', { title: `${who}さんが返信しました`, body: text, post, actor: c.id });
  } else if (post.author === ME) {
    await pushTL(env, st, world, 'tlComment', { title: `${who}さんがコメントしました`, body: text, post, actor: c.id });
  }

  // キャラ同士：キャラの投稿にほかのキャラがコメントしたら、投稿したキャラが1回だけ返すことがある
  if (!replyTo && post.author !== ME && post.author !== c.id) {
    const author = (await loadChars(env)).find((x) => x.id === post.author);
    if (author && Math.random() < clamp(0.2 + 0.45 * (nz(author.snsActivity, 50) / 100), 0, 0.8)) {
      const due = await schedDue(env, author.id, deferQuiet(Date.now() + reactDelay(0.5, true), st, world, undefined, post.at), post, st);
      await env.DB.prepare('INSERT INTO tl_jobs (world,char_id,kind,post_id,comment_id,due,note) VALUES (?,?,?,?,?,?,?)')
        .bind(world, author.id, 'reply', post.id, commentId, due, '').run();
    }
  }
  return true;
}

// ---- 通知（表のTLだけ。4項目それぞれオン／オフ）
async function pushTL(env, st, world, flag, { title, body, post, tag, actor }) {
  if (world !== 'omote') return;              // 裏は通知しない
  if (!st.notify || !st.notify[flag]) return; // 設定でオフ
  if (st.notifyVia !== 'web') await sendBark(env, st, { title, body: truncBytes(body, 1500), cid: actor, group: 'タイムライン' }).catch((e) => log(env, 'Bark通知（TL）: ' + e.message));
  if (st.notifyVia === 'bark') return;
  try {
    await pushPayload(env, {
      title, body: truncBytes(body, 1500), tl: 'omote', postId: post.id,
      tag: 'tl-' + (tag || post.id + '-' + Date.now()), badge: await totalUnread(env),
    });
  } catch (e) { await log(env, 'TL通知: ' + e.message); }
}

// ================================================================ くらし（表のトークだけ）
// ・記憶：やり取りから、ユーザーの好み・予定・約束・出来事、キャラの相談・おすすめを覚え、あとで聞く
// ・キャラの毎日：1日1回、気分・今日していること・日記・何日も続く出来事を更新
// ・天気（ユーザーの地域）、季節・行事、曜日
// ・特別な日（誕生日・出会って◯日・行事）には長めの手紙
// ・しばらく来ないときの反応、嫉妬（嫉妬しやすいキャラだけ）、仲の良さの変化
// ・写真（ユーザーの写真に反応・加工して返す、料理や景色の写真。人物は写さない）
// ・本物っぽい振る舞い（打ち間違いの訂正、送信取り消し、忙しくて返信が遅れる）
const jstDay = (ts) => { const p = jstParts(ts); return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5); // b − a（日）
const addDays = (day, n) => jstDay(Date.parse(day + 'T00:00:00+09:00') + n * 864e5);
const fmtDay = (day) => { const [, m, d] = String(day).split('-'); return `${+m}/${+d}`; };

async function getState(env, id) {
  const r = await env.DB.prepare('SELECT data FROM char_state WHERE char_id=?').bind(id).first();
  try { return r ? JSON.parse(r.data) : {}; } catch (_) { return {}; }
}
async function setState(env, id, s) {
  await env.DB.prepare('INSERT INTO char_state (char_id,data) VALUES (?,?) ON CONFLICT(char_id) DO UPDATE SET data=excluded.data').bind(id, JSON.stringify(s)).run();
}

// ---- 天気（Open-Meteo・キー不要。1時間使い回す）
const WCODE = { 0: '快晴', 1: '晴れ', 2: '晴れ時々くもり', 3: 'くもり', 45: '霧', 48: '霧', 51: '弱い霧雨', 53: '霧雨', 55: '強い霧雨', 56: '冷たい霧雨', 57: '冷たい霧雨',
  61: '小雨', 63: '雨', 65: '大雨', 66: '冷たい雨', 67: '冷たい雨', 71: '小雪', 73: '雪', 75: '大雪', 77: '霧雪', 80: 'にわか雨', 81: 'にわか雨', 82: '激しいにわか雨',
  85: 'にわか雪', 86: '激しいにわか雪', 95: '雷雨', 96: 'ひょうを伴う雷雨', 99: 'ひょうを伴う雷雨' };
async function getWeather(env, st) {
  const c = await kvGet(env, 'weather', null);
  if (c && Date.now() - c.at < 3600e3 && c.lat === st.weatherLat && c.lon === st.weatherLon) return c.w;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${st.weatherLat}&longitude=${st.weatherLon}` +
    '&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTokyo&forecast_days=2';
  const r = await fetch(url);
  if (!r.ok) throw new Error('天気の取得に失敗しました（' + r.status + '）');
  const j = await r.json();
  const d = j.daily || {};
  const day = (i) => ({ w: WCODE[(d.weather_code || [])[i]] || '不明', max: (d.temperature_2m_max || [])[i], min: (d.temperature_2m_min || [])[i], rain: (d.precipitation_probability_max || [])[i] });
  const w = { now: { w: WCODE[(j.current || {}).weather_code] || '不明', t: (j.current || {}).temperature_2m }, today: day(0), tomorrow: day(1) };
  await kvSet(env, 'weather', { at: Date.now(), lat: st.weatherLat, lon: st.weatherLon, w });
  return w;
}
function weatherText(w, st) {
  return `${st.weatherPlace}　いま：${w.now.w}・${w.now.t}℃／今日：${w.today.w}（最高${w.today.max}℃・最低${w.today.min}℃・降水確率${w.today.rain}%）／明日：${w.tomorrow.w}（最高${w.tomorrow.max}℃・降水確率${w.tomorrow.rain}%）`;
}
function weatherNotable(w) {
  return !!w && (w.today.rain >= 60 || w.tomorrow.rain >= 70 || w.today.max >= 32 || w.today.min <= 3 || /雪|雷/.test(w.today.w + w.tomorrow.w));
}

// ---- 季節・行事・曜日
const EVENTS = [['01-01', 'お正月'], ['02-03', '節分'], ['02-14', 'バレンタインデー'], ['03-03', 'ひな祭り'], ['03-14', 'ホワイトデー'], ['04-01', 'エイプリルフール'],
  ['05-05', 'こどもの日'], ['07-07', '七夕'], ['08-13', 'お盆'], ['10-31', 'ハロウィン'], ['11-11', 'ポッキーの日'], ['12-24', 'クリスマスイブ'], ['12-25', 'クリスマス'], ['12-31', '大晦日']];
function seasonText(now) {
  const p = jstParts(now), m = p.mo, today = jstDay(now);
  const season = m === 12 || m <= 2 ? '冬' : m <= 5 ? '春' : m <= 8 ? '夏' : '秋';
  const near = EVENTS.map(([d, n]) => {
    let diff = dayDiff(today, `${p.y}-${d}`);
    if (diff < -180) diff = dayDiff(today, `${p.y + 1}-${d}`);
    return { n, diff };
  }).filter((x) => x.diff >= -1 && x.diff <= 5);
  return `季節：${season}` + (near.length ? '／近い行事：' + near.map((x) => (x.diff === 0 ? `今日は${x.n}` : x.diff > 0 ? `${x.diff}日後に${x.n}` : `昨日は${x.n}`)).join('、') : '');
}
function weekdayText(now) {
  return { 日: '日曜日（休日。明日から週明け）', 月: '月曜日（週の始まり）', 火: '火曜日', 水: '水曜日（週の真ん中）', 木: '木曜日（週末が近い）', 金: '金曜日（週末の前）', 土: '土曜日（休日）' }[jstParts(now).w];
}

// ---- 記憶
const MEM_KINDS = ['fact', 'plan', 'promise', 'consult', 'recommend', 'event', 'joke'];
const MEM_LABEL = { fact: 'ユーザーのこと', plan: 'ユーザーの予定', promise: '約束', consult: 'あなたがユーザーにした相談', recommend: 'あなたが勧めたもの', event: 'ユーザーに起きたこと', user_state: 'ユーザーの様子', joke: '二人の内輪ネタ' };
async function loadMemories(env, cid, limit = 200) {
  const { results } = await env.DB.prepare('SELECT * FROM memories WHERE char_id=? ORDER BY id DESC LIMIT ?').bind(cid, limit).all();
  return results;
}
function memoryText(mems, today, withJokes = false) {
  const open = mems.filter((m) => m.status === 'open' && m.kind !== 'fact' && m.kind !== 'user_state' && m.kind !== 'joke').slice(0, 15);
  const facts = mems.filter((m) => m.kind === 'fact').slice(0, 30);
  const states = mems.filter((m) => m.kind === 'user_state' && dayDiff(jstDay(m.created), today) <= 4).slice(0, 4);
  // 内輪ネタは毎回は見せない（ときどき、ふいに思い出す）
  const jokes = withJokes ? mems.filter((m) => m.kind === 'joke' && dayDiff(jstDay(m.created), today) >= 1).sort(() => Math.random() - 0.5).slice(0, 2) : [];
  if (!open.length && !facts.length && !states.length && !jokes.length) return '';
  const lines = [];
  if (facts.length) lines.push('## ユーザーについて覚えていること', ...facts.map((m) => '- ' + m.text));
  if (open.length) lines.push('## 予定・約束・まだ結果を聞いていないこと', ...open.map((m) => `- [${MEM_LABEL[m.kind] || m.kind}] ${m.text}${m.due ? `（${fmtDay(m.due)}）` : ''}`));
  if (states.length) lines.push('## 最近のユーザーの様子', ...states.map((m) => `- ${m.text}（${fmtDay(jstDay(m.created))}）`));
  if (jokes.length) lines.push('## 二人のあいだの内輪ネタ（話の流れにぴったり合うときだけ、ふいに持ち出してよい。説明はしない。無理に使わない）', ...jokes.map((m) => '- ' + m.text));
  return lines.join('\n');
}

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    new: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, text: { type: 'string' }, due: { type: 'string' } }, required: ['kind', 'text', 'due'], additionalProperties: false } },
    done: { type: 'array', items: { type: 'integer' } },
    user_state: { type: 'string' },
    affinity_delta: { type: 'integer' },
    birthday: { type: 'string' },
    jokes: { type: 'array', items: { type: 'string' } },
  },
  required: ['new', 'done', 'user_state', 'affinity_delta', 'birthday', 'jokes'], additionalProperties: false,
};

// やり取りがひと段落したら、覚えておくことを取り出す
async function extractMemories(env, c, st, now, force = false) {
  const state = await getState(env, c.id);
  const { results: msgs } = await env.DB.prepare('SELECT id,sender,text,at,alt FROM messages WHERE char_id=? AND id>? ORDER BY id LIMIT 60').bind(c.id, state.lastExtractId || 0).all();
  if (!msgs.length) return false;
  const last = msgs[msgs.length - 1];
  const hasMe = msgs.some((m) => m.sender === 'me');
  const settled = now - last.at > 20 * MIN;
  if (!force && !((hasMe && (msgs.length >= 10 || settled)) || (!hasMe && state.pendingMemo && settled))) return false;
  if (!hasMe && !state.pendingMemo) { state.lastExtractId = last.id; await setState(env, c.id, state); return false; }
  const today = jstDay(now);
  const mems = await loadMemories(env, c.id, 80);
  const open = mems.filter((m) => m.status === 'open' && m.kind !== 'fact' && m.kind !== 'user_state' && m.kind !== 'joke');
  const facts = mems.filter((m) => m.kind === 'fact').slice(0, 40);
  const jokes = mems.filter((m) => m.kind === 'joke').slice(0, 20);
  const system = 'あなたは、キャラクターとユーザーのメッセージのやり取りを読んで、キャラクターがあとで話題にするために覚えておくべきことを整理する係です。事実だけを、短く具体的に書きます。';
  const user = `# 今日の日付
${today}（${jstParts(now).w}曜日）

# キャラクター
${c.name}（${trunc(c.prompt || '', 300)}）

# すでに覚えていること（重ねて書かない）
${facts.map((m) => '- ' + m.text).join('\n') || '（なし）'}

# まだ結果を聞いていない予定・約束など（id付き）
${open.map((m) => `- id ${m.id}: [${m.kind}] ${m.text}${m.due ? `（${m.due}）` : ''}`).join('\n') || '（なし）'}

# 新しいやり取り
${msgs.map((m) => `[${fmtTime(m.at)}] ${m.sender === 'me' ? 'ユーザー' : c.name}: ${m.text || ''}${m.alt ? `（写真：${m.alt}）` : ''}`).join('\n')}

# 書き出すこと
new：新しく覚えること。kind は次のどれか。
- fact：ユーザーの好み・苦手・家族・仕事や学校・趣味など、長く役立つ事実（例「猫が好き」「数学が苦手」）。due は ""。
- plan：ユーザーの予定（例「土曜に友達と映画」）。due はその予定の日（YYYY-MM-DD）。日付が曖昧なら近い日を推測。
- promise：ユーザーとキャラクターの約束（例「今度一緒にブリヌイを作る」）。due は約束の日、決まっていなければ ""。
- consult：キャラクターがユーザーにした相談（例「友達とケンカした件」）。due は ${addDays(today, 2)} ごろ（結果を報告する日）。
- recommend：キャラクターがユーザーに勧めたもの（例「ボルシチのレシピ」）。due は ${addDays(today, 3)} ごろ（感想を聞く日）。
- event：ユーザーに起きた、あとで様子を聞くとよい出来事（例「風邪をひいた」「面接を受けた」）。due は ${addDays(today, 1)} ごろ。
done：上の「まだ結果を聞いていない」もののうち、今回のやり取りで結果がわかった・話し終えた id。
user_state：今回のやり取りから見えるユーザーの様子（疲れている・元気がない・忙しそう・機嫌がいい・夜更かし など）を1文。特になければ ""。
affinity_delta：今回のやり取りで、キャラクターから見たユーザーとの距離がどう変わったか。-3〜+3（ふつうは 0 か +1。冷たくされたら −）。
birthday：ユーザーが自分の誕生日を言っていれば "MM-DD"、なければ ""。
jokes：二人のあいだだけで通じる「内輪ネタ」になりそうなこと（一緒に笑った言い間違い・あだ名・二人だけの呼び方・繰り返し出てくる冗談・ちょっとした事件など）。あとでふいに持ち出したら二人で笑えるものだけ。どんな出来事だったかがわかるように短く（例「ユーザーがボルシチを"ボルチシ"と言い間違えた」）。すでにある内輪ネタ（${jokes.map((m) => m.text).join('／') || 'なし'}）と重ねない。なければ []（ほとんどの回は []）。`;
  const r = await aiJson(env, 'omote', (await worldBlock(env, user)) + system, user, EXTRACT_SCHEMA, 'memory_extract');
  const stmts = [];
  for (const m of (r && r.new) || []) {
    const kind = MEM_KINDS.includes(m.kind) ? m.kind : null;
    const text = String(m.text || '').trim().slice(0, 200);
    if (!kind || !text) continue;
    const due = /^\d{4}-\d{2}-\d{2}$/.test(m.due || '') ? m.due : '';
    stmts.push(env.DB.prepare("INSERT INTO memories (char_id,kind,text,due,status,created,followed) VALUES (?,?,?,?, 'open', ?, 0)").bind(c.id, kind, text, due, now));
  }
  for (const id of (r && r.done) || []) {
    if (open.some((m) => m.id === Number(id))) stmts.push(env.DB.prepare("UPDATE memories SET status='done' WHERE id=? AND char_id=?").bind(Number(id), c.id));
  }
  for (const j of ((r && r.jokes) || []).slice(0, 2)) {
    const t = String(j || '').trim().slice(0, 120);
    if (t) stmts.push(env.DB.prepare("INSERT INTO memories (char_id,kind,text,due,status,created,followed) VALUES (?, 'joke', ?, '', 'open', ?, 0)").bind(c.id, t, now));
  }
  const us = String((r && r.user_state) || '').trim();
  if (us) stmts.push(env.DB.prepare("INSERT INTO memories (char_id,kind,text,due,status,created,followed) VALUES (?, 'user_state', ?, '', 'done', ?, 0)").bind(c.id, us.slice(0, 120), now));
  if (stmts.length) await env.DB.batch(stmts);
  // 古いものを片付ける（1キャラ200件まで。予定・約束などの未完了は残す）
  await env.DB.prepare("DELETE FROM memories WHERE char_id=? AND id NOT IN (SELECT id FROM memories WHERE char_id=? ORDER BY (status='open') DESC, id DESC LIMIT 200)").bind(c.id, c.id).run();
  // 仲の良さが少しずつ変わる
  const delta = clamp(Math.round(nz(r && r.affinity_delta, 0)), -3, 3);
  if (delta) {
    const row = await env.DB.prepare('SELECT data FROM chars WHERE id=?').bind(c.id).first();
    if (row) {
      const data = JSON.parse(row.data);
      data.affinity = clamp(nz(data.affinity, 60) + delta, 0, 100);
      await env.DB.prepare('UPDATE chars SET data=? WHERE id=?').bind(JSON.stringify(data), c.id).run();
    }
  }
  const bd = String((r && r.birthday) || '');
  if (/^\d{2}-\d{2}$/.test(bd) && !st.birthday) { const v = await getSettings(env); v.birthday = bd; await kvSet(env, 'settings', v); }
  state.lastExtractId = last.id;
  state.pendingMemo = false;
  await setState(env, c.id, state);
  return true;
}

// ---- キャラの毎日（1日1回）：気分・今日していること・日記・何日も続く出来事
const PLAN_KINDS = ['sleep', 'nap', 'busy', 'meal', 'bath', 'chores', 'out', 'social', 'free'];
const PLAN_SCHEMA_ITEM = {
  type: 'object',
  properties: { start: { type: 'string' }, end: { type: 'string' }, act: { type: 'string' }, kind: { type: 'string' }, avail: { type: 'integer' } },
  required: ['start', 'end', 'act', 'kind', 'avail'], additionalProperties: false,
};
const DAILY_SCHEMA = {
  type: 'object',
  properties: {
    mood: { type: 'string' }, mood_reason: { type: 'string' }, today: { type: 'string' }, diary: { type: 'string' },
    story_title: { type: 'string' }, story_update: { type: 'string' }, story_finished: { type: 'boolean' }, busy: { type: 'integer' },
    fatigue: { type: 'integer' }, plan: { type: 'array', items: PLAN_SCHEMA_ITEM },
    project_title: { type: 'string' }, project_update: { type: 'string' }, project_finished: { type: 'boolean' },
    condition: { type: 'string' }, condition_days: { type: 'integer' }, condition_over: { type: 'boolean' },
    status_msg: { type: 'string' }, status_emoji: { type: 'string' },
    meet_with: { type: 'string' }, meet_act: { type: 'string' }, meet_time: { type: 'string' },
  },
  required: ['mood', 'mood_reason', 'today', 'diary', 'story_title', 'story_update', 'story_finished', 'busy', 'fatigue', 'plan',
    'project_title', 'project_update', 'project_finished', 'condition', 'condition_days', 'condition_over', 'status_msg', 'status_emoji', 'meet_with', 'meet_act', 'meet_time'], additionalProperties: false,
};
async function dailyUpdate(env, c, st, now, force = false) {
  const today = jstDay(now);
  const state = await getState(env, c.id);
  if (!force && (state.day === today || jstParts(now).h < 6)) return false;
  let weather = '';
  try { weather = weatherText(await getWeather(env, st), st); } catch (_) {}
  const story = state.story && !state.story.finished ? state.story : null;
  const mayStart = !story && Math.random() < 0.3;
  const mems = await loadMemories(env, c.id, 40);
  const rh = await getRhythm(env, c);
  const wd = jstParts(now).w, holiday = wd === '土' || wd === '日';
  const yPlan = state.plan && state.plan.blocks ? state.plan.blocks : [];
  const ySleep = yPlan.filter((b) => b.kind === 'sleep' && b.s > jstDayStart(state.plan.day) + 12 * 3600e3)[0];
  const dueToday = mems.filter((m) => m.status === 'open' && m.due === today && m.kind !== 'user_state' && m.kind !== 'joke');
  const project = state.project && !state.project.finished ? state.project : null;
  const mayProject = !project && Math.random() < 0.15;
  const cond = state.condition || null;
  const mayCond = !cond && Math.random() < 0.07;
  // ほかの子たち（同じユーザーと話している仲間）と、今日・昨日の約束
  const others = (await loadChars(env)).filter((x) => x.id !== c.id && inOmote(x));
  const meetsToday = (await kvGet(env, 'meet:' + today, [])).filter((m) => m.a === c.id || m.b === c.id);
  const meetsYday = (await kvGet(env, 'meet:' + addDays(today, -1), [])).filter((m) => m.a === c.id || m.b === c.id);
  const otherOf = (m) => (m.a === c.id ? m.bName : m.aName);
  const bdOthers = others.filter((o) => o.birthday && daysToMD(o.birthday, now) === 0);
  const myBday = c.birthday && daysToMD(c.birthday, now) === 0;
  const mayMeet = others.length && !meetsToday.length && Math.random() < (bdOthers.length || myBday ? 0.6 : 0.22); // 誕生日の子がいる日は、一緒に過ごしやすい
  const system = 'あなたは、キャラクターの日々の暮らしを考える係です。キャラクター設定と作品の世界観に合った、自然で小さな日常を考えます。大事件は起こしません。';
  const user = `# キャラクター: ${c.name}
${trunc(c.prompt || '（設定なし）', 2500)}

# 今日
${today}（${weekdayText(now)}）／${seasonText(now)}
${weather ? '天気：' + weather : ''}

# 昨日までの様子
気分：${state.mood || '（不明）'}${state.moodReason ? `（${state.moodReason}）` : ''}
昨日していたこと：${state.today || '（不明）'}
最近の日記：
${(state.diary || []).slice(-5).map((x) => `- ${fmtDay(x.d)} ${x.t}`).join('\n') || '（なし）'}

# ふだんの生活リズム
平日：${rh.weekday || '（キャラクター設定から考える）'}
休日：${rh.holiday || '（キャラクター設定から考える）'}
今日は${holiday ? '休日' : '平日'}（作品の世界観で別の決まりがあればそちらに従う）

# 昨日の過ごし方
${yPlan.length ? yPlan.filter((b) => !['sleep', 'free'].includes(b.kind)).map((b) => `${hmJ(b.s)} ${b.act}`).join('／').slice(0, 600) : '（記録なし）'}
${ySleep ? `昨夜寝た時刻：${hmJ(ySleep.s)}` : ''}
昨日の疲れ：${nz(state.fatigue, 30)}/100
${cond ? `数日続いている体調・状況：「${cond.label}」（${dayDiff(cond.start, today) + 1}日目／${cond.days}日ほどの見込み）` : ''}

${myBday ? '# 今日はあなたの誕生日\n（気分・今日の過ごし方・予定表に反映する。友達にお祝いされる、ちょっとしたごちそう、など）\n' : ''}${bdOthers.length ? `# 今日は ${bdOthers.map((o) => o.name + 'さん').join('・')} の誕生日\n（お祝いのメッセージを送る・プレゼントを渡す・一緒に過ごす、など、関係に合わせて予定や日記に反映してよい）\n` : ''}${c.birthday && !myBday && daysToMD(c.birthday, now) <= 3 ? `（あと${daysToMD(c.birthday, now)}日であなたの誕生日）\n` : ''}
# 毎週の習慣・季節の好み
${rh.habits || '（特になし）'}
${rh.seasonal ? '季節：' + rh.seasonal.replace(/\n/g, '／') : ''}
（今日の曜日や季節に当てはまる習慣があれば、予定表や今日の過ごし方に入れる）

# ほかの子たち（同じユーザーと話している仲間。あなたとも知り合い）
${others.map((o) => `- ${o.name}：${trunc(o.prompt || '', 120).replace(/\n/g, ' ')}`).join('\n') || '（いない）'}
${meetsToday.length ? '今日の約束（必ず予定表に入れる）：' + meetsToday.map((m) => `${m.time}ごろ ${otherOf(m)}さんと「${m.act}」`).join('／') : ''}
${meetsYday.length ? '昨日ほかの子と過ごしたこと：' + meetsYday.map((m) => `${otherOf(m)}さんと「${m.act}」`).join('／') + '（diary に書いてもよい）' : ''}

${await disasterContext(env, st, now).catch(() => '')}
# 今日のユーザーとの予定・約束（あれば）
${dueToday.map((m) => '- ' + m.text).join('\n') || '（なし）'}

# 続いている出来事
${story ? `「${story.title}」（${fmtDay(story.start)}から）\n${story.log.map((x) => `- ${fmtDay(x.d)} ${x.t}`).join('\n')}` : '（なし）'}

# ユーザーについて覚えていること（参考）
${mems.filter((m) => m.kind === 'fact').slice(0, 10).map((m) => '- ' + m.text).join('\n') || '（なし）'}

# 書き出すこと
- mood：今日の気分や体調をひとこと（例「少し眠い」「風邪気味」「ご機嫌」）。昨日の気分を少し引き継ぎ、急に変えすぎない。たまに体調をくずしたり、いいことがあったりしてよい。
- mood_reason：その理由をひとこと。
- today：今日していること・予定を1〜2文。曜日や季節、天気に合わせる。
- diary：昨日あった小さな出来事を1文（昨日していたことと矛盾しない）。
- story_title / story_update / story_finished：${story
    ? `続いている出来事「${story.title}」の今日の進み具合を story_update に1文。story_title は同じ題名。始まってから3〜7日たって区切りがよければ story_finished を true に。`
    : mayStart
      ? 'キャラクターの身の回りで、何日かかけて進む小さな出来事を新しく始める（例「猫を拾った」「料理の練習を始めた」「友達の誕生日プレゼントを選んでいる」）。story_title に題名、story_update に最初の様子。story_finished は false。'
      : '今日は新しい出来事を始めない。story_title と story_update は ""、story_finished は false。'}
- project_title / project_update / project_finished：${project
    ? `何週間もかけて続けていること「${project.title}」（${fmtDay(project.start)}から）。最近の進み具合：${project.log.slice(-3).map((x) => `${fmtDay(x.d)} ${x.t}`).join(' → ')}。今日少しでも進んだことがあれば project_update に1文（毎日でなくてよい。2〜3日に1回くらい。進んでいなければ ""）。project_title は同じ題名。始めて3〜6週間たって区切りがよければ project_finished を true に。`
    : mayProject
      ? '何週間もかけて少しずつ続ける、小さな趣味や取り組みを新しく始める（例「分厚い小説を1冊読み進める」「ベランダでハーブを育てる」「マフラーを編む」「お菓子作りの腕を上げる」。キャラクターらしいもの）。project_title に題名、project_update に始めたきっかけや最初の様子。project_finished は false。'
      : '今日は始めない。project_title と project_update は ""、project_finished は false。'}
- condition / condition_days / condition_over：${cond
    ? `数日続いている「${cond.label}」の今日の様子を condition に短く（例「熱は下がったが、まだ喉が痛い」）。condition_days は ${cond.days}。治った・終わったなら condition_over を true に。mood・busy・plan にも反映する（体調が悪ければ早く寝る・予定を減らす、など）。`
    : mayCond
      ? '数日続く体調や状況を新しく始めてよい（例「風邪をひいた」「試験週間」「家族が泊まりに来ている」「筋肉痛」「新しい靴で靴ずれ」。深刻すぎないもの）。始めるなら condition に短く、condition_days に続く見込みの日数（2〜5）、condition_over は false。mood・busy・plan にも反映する。始めないなら condition は ""、condition_days は 0。'
      : 'condition は ""、condition_days は 0、condition_over は false。'}
- status_msg：LINEのプロフィールの「ひとこと」（20文字以内）。今の気分・ハマっていること・季節のことなど、キャラクターらしく。昨日のひとこと「${state.statusMsg || ''}」のままがよければ同じ文でよい（毎日変えなくてよい。3日に1回くらい変える）。
- status_emoji：アイコンの横に付ける絵文字1つ（今日の気分や体調。例 🤒 😪 🎵 📚 🍰 ☔）。特になければ ""。
- meet_with / meet_act / meet_time：${meetsToday.length
    ? 'すでに今日の約束があるので、新しく決めない（すべて ""）。'
    : mayMeet
      ? `今日、ほかの子のうち誰かと一緒に過ごす予定を1つ入れてよい（お茶・買い物・勉強・料理など。キャラクター同士の関係に合うもの）。meet_with にその子の名前（上の一覧の名前どおり）、meet_act に内容を短く、meet_time に "HH:MM"。予定表（plan）にもその時間を social で入れる。合う相手がいなければすべて ""。`
      : 'すべて ""（今日はほかの子と会う予定を新しく作らない）。'}
- busy：今日の忙しさ 0〜100。
- fatigue：今日一日を終えたときの疲れ具合 0〜100（明日に引き継ぐ）。
- plan：今日の予定表。今朝起きる時刻から、明日の朝起きるまでを、時刻の順に隙間なく並べる。
  - start / end は "HH:MM"。日付をまたぐときは 24 を足して "25:30" のように書く（夜の就寝は "23:30"〜"31:00" など）。
  - act：していることを短く（例「紅茶を淹れて読書」「訓練」「お風呂」「夕ごはんを作る」）。
  - kind：sleep（夜の睡眠）／nap（昼寝・うたた寝）／busy（訓練・授業・仕事など手が離せない）／meal（食事）／bath（お風呂）／chores（料理・掃除・身支度）／out（外出・移動）／social（友達と過ごす）／free（自由時間）のどれか。
  - avail：そのあいだスマホを見て返事できる度合い 0〜100（自由時間やベッドでくつろぐ時間は高く、訓練・お風呂・睡眠は低く）。
  - ふだんの生活リズムを土台に、曜日・天気・気分・続いている出来事・ユーザーとの約束に合わせて今日らしく変える。毎日同じ時刻にしない（10〜30分ほどずれてよい）。
  - 昨日疲れていたり夜ふかししたりして、今日が休日なら、遅く起きる・昼寝をする（nap）など。昼寝や二度寝のしやすさ：${rh.napper}/100。
  - 夜ふかしの度合い：${rh.nightOwl}/100。寝る時刻に反映する。
  - 身の回りの天気・災害の様子があれば反映する（台風や大雪で休校・外出の中止・家で過ごす、停電、地震のあとの片付け、など）。`;
  const r = await aiJson(env, 'omote', (await worldBlock(env, user)) + system, user, DAILY_SCHEMA, 'daily_life');
  state.day = today;
  state.mood = String(r.mood || '').slice(0, 60);
  state.moodReason = String(r.mood_reason || '').slice(0, 80);
  state.today = String(r.today || '').slice(0, 200);
  state.busy = clamp(Math.round(nz(r.busy, 30)), 0, 100);
  state.fatigue = clamp(Math.round(nz(r.fatigue, 30)), 0, 100);
  const plan = parsePlan(r.plan, today);
  if (plan) { state.prevPlan = state.plan && state.plan.day !== today ? state.plan : state.prevPlan || null; state.plan = plan; }
  if (r.diary) state.diary = (state.diary || []).concat({ d: addDays(today, -1), t: String(r.diary).slice(0, 160) }).slice(-14);
  const title = String(r.story_title || '').trim();
  if (title && String(r.story_update || '').trim()) {
    if (!story || story.title !== title) state.story = { title: title.slice(0, 60), start: today, log: [] };
    state.story.log = state.story.log.concat({ d: today, t: String(r.story_update).slice(0, 160) }).slice(-10);
    state.story.finished = !!r.story_finished;
  } else if (state.story && state.story.finished) {
    state.story = null;
  }
  // 長く続けていること（何週間も）
  const pTitle = String(r.project_title || '').trim(), pUp = String(r.project_update || '').trim();
  if (project && (r.project_finished || dayDiff(project.start, today) > 60)) { state.project = { ...project, finished: true }; if (pUp) state.project.log = project.log.concat({ d: today, t: pUp.slice(0, 160) }).slice(-20); }
  else if (pTitle && pUp) {
    if (!project || project.title !== pTitle) state.project = { title: pTitle.slice(0, 60), start: today, log: [] };
    state.project.log = state.project.log.concat({ d: today, t: pUp.slice(0, 160) }).slice(-20);
  } else if (state.project && state.project.finished && dayDiff(state.project.log.length ? state.project.log[state.project.log.length - 1].d : today, today) > 3) state.project = null;
  // 数日続く体調・状況
  const cLabel = String(r.condition || '').trim();
  if (cond) {
    if (r.condition_over || dayDiff(cond.start, today) > cond.days + 2) state.condition = null;
    else state.condition = { ...cond, now: cLabel.slice(0, 80) || cond.now || '' };
  } else if (cLabel && nz(r.condition_days, 0) > 0) state.condition = { label: cLabel.slice(0, 60), start: today, days: clamp(Math.round(r.condition_days), 2, 6), now: '' };
  // ひとこと・アイコンの絵文字
  const sm = String(r.status_msg || '').trim().slice(0, 30);
  if (sm && sm !== state.statusMsg) { state.statusMsg = sm; state.statusAt = now; }
  state.statusEmoji = [...String(r.status_emoji || '').trim()].slice(0, 2).join('');
  await setState(env, c.id, state);
  // ほかの子との約束（相手の子にも伝わるように、日付ごとにまとめて覚える）
  const mw = String(r.meet_with || '').trim(), partner = mw && others.find((o) => o.name === mw || mw.includes(o.name) || o.name.includes(mw));
  if (partner && !meetsToday.length && String(r.meet_act || '').trim()) {
    const list = await kvGet(env, 'meet:' + today, []);
    if (!list.some((m) => [m.a, m.b].includes(partner.id))) { // 相手がすでに別の約束をしていたら作らない
      list.push({ a: c.id, aName: c.name, b: partner.id, bName: partner.name, act: String(r.meet_act).trim().slice(0, 60), time: /^\d{1,2}:\d{2}$/.test(String(r.meet_time || '').trim()) ? String(r.meet_time).trim() : '' });
      await kvSet(env, 'meet:' + today, list);
    }
  }
  await env.DB.prepare('DELETE FROM kv WHERE k=?').bind('meet:' + addDays(today, -3)).run();
  return true;
}


// ---------------------------------------------------------------- 1日の予定表（表のトークだけ。ユーザーには見せない）
// 毎朝「毎日の様子」と一緒にAIが作る。返事の早さ・既読のタイミング・話しかけ・TL投稿のタイミングをこれで決める
function seed01(str) { // 同じ文字列なら同じ値（0〜1）。予定の小さな変更を、何度見ても同じにするため
  let h = 2166136261;
  for (const ch of String(str)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}
const rndR = (a, b) => a + Math.random() * (b - a);
function jstDayStart(day) { return Date.parse(day + 'T00:00:00+09:00'); }
function hmJ(ts) { const p = jstParts(ts); return `${p.h}:${String(p.mi).padStart(2, '0')}`; }

// AIが書いた予定（"HH:MM"、日付をまたぐときは "25:30" など）を時刻に直す
function parsePlan(arr, today) {
  const base = jstDayStart(today);
  const toMin = (x) => { const m = String(x || '').match(/(\d{1,2})\s*[:：]\s*(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };
  const out = [];
  let off = 0, prevS = -Infinity;
  for (const b of Array.isArray(arr) ? arr.slice(0, 40) : []) {
    let s = toMin(b.start), e = toMin(b.end);
    if (s == null || e == null || s > 40 * 60) continue;
    s = s + off;
    if (s < prevS - 6 * 60) { off += 24 * 60; s += 24 * 60; } // 書き方が「01:00」に戻っていたら翌日
    e = e + off;
    while (e <= s) e += 24 * 60;
    prevS = s;
    const blk = { s: base + s * 60e3, e: base + Math.min(e, s + 16 * 60) * 60e3, act: String(b.act || '').trim().slice(0, 40) || '過ごしている', kind: PLAN_KINDS.includes(b.kind) ? b.kind : 'free', avail: clamp(Math.round(nz(b.avail, 60)), 0, 100) };
    const last = out[out.length - 1];
    if (last && blk.s < last.e) blk.s = last.e;
    if (blk.e - blk.s < 5 * 60e3) continue;
    if (last && blk.s > last.e) out.push({ s: last.e, e: blk.s, act: 'ひと息ついている', kind: 'free', avail: 65 });
    out.push(blk);
  }
  if (!out.length) return null;
  // 朝起きるまでは眠っている
  if (out[0].kind !== 'sleep' && out[0].s > base + 3 * 3600e3) out.unshift({ s: base, e: out[0].s, act: '眠っている', kind: 'sleep', avail: 0 });
  return { day: today, blocks: out };
}
// 予定がまだないときの、ざっくりした1日
function defaultActivity(t) {
  const h = jstParts(t).h, base = jstDayStart(jstDay(t));
  const B = (s, e, act, kind, avail) => ({ s: base + s * 3600e3, e: base + e * 3600e3, act, kind, avail });
  if (h < 7) return B(0, 7, '眠っている', 'sleep', 0);
  if (h < 8) return B(7, 8, '身支度', 'chores', 40);
  if (h < 12) return B(8, 12, '日中の用事', 'busy', 35);
  if (h < 13) return B(12, 13, 'お昼ごはん', 'meal', 50);
  if (h < 18) return B(13, 18, '午後の用事', 'busy', 45);
  if (h < 19) return B(18, 19, '自由時間', 'free', 75);
  if (h < 20) return B(19, 20, '夕ごはん', 'meal', 45);
  if (h < 21) return B(20, 21, '自由時間', 'free', 80);
  if (h < 22) return B(21, 22, 'お風呂', 'bath', 5);
  return h < 24 ? B(22, 24, '部屋でのんびり', 'free', 85) : B(0, 7, '眠っている', 'sleep', 0);
}
// 予定どおりにいかないこと（長引く・急な用事）を足した予定
function withChanges(blocks, key) {
  const bs = blocks.map((b) => ({ ...b }));
  const out = [];
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    const last = out[out.length - 1];
    if (last && b.s < last.e) b.s = last.e;
    if (b.e <= b.s) continue;
    if (['busy', 'out', 'chores', 'social'].includes(b.kind) && seed01(key + b.s + 'o') < 0.15) {
      b.e += Math.round(10 + seed01(key + b.s + 'O') * 30) * 60e3; b.act += '（長引いている）'; // 思ったより長引いた
    }
    if (b.kind === 'free' && b.e - b.s >= 60 * 60e3 && seed01(key + b.s + 'q') < 0.06) { // 急な用事
      const at = b.s + Math.round(seed01(key + b.s + 'Q') * (b.e - b.s - 30 * 60e3) / 60e3) * 60e3;
      const len = Math.round(30 + seed01(key + b.s + 'L') * 30) * 60e3;
      out.push({ ...b, e: at });
      out.push({ s: at, e: Math.min(b.e, at + len), act: '急な用事', kind: 'busy', avail: 15 });
      if (at + len < b.e) out.push({ ...b, s: at + len });
      continue;
    }
    out.push(b);
  }
  return out.filter((b) => b.e > b.s);
}
// ある時刻にしていること（{act, kind, avail, s, e, prev, next}）
function activityAt(state, t, key = '') {
  for (const p of [state.plan, state.prevPlan]) {
    if (!p || !p.blocks || !p.blocks.length) continue;
    const bs = withChanges(p.blocks, key + p.day);
    const i = bs.findIndex((b) => b.s <= t && t < b.e);
    if (i >= 0) return { ...bs[i], prev: bs[i - 1] || null, next: bs[i + 1] || null };
  }
  return { ...defaultActivity(t), prev: null, next: null };
}
const isSleepKind = (k) => k === 'sleep' || k === 'nap';

// 生活リズム（キャラ設定と世界観から1回だけ作る。設定を変えたら作り直す）
const RHYTHM_SCHEMA = {
  type: 'object',
  properties: { weekday: { type: 'string' }, holiday: { type: 'string' }, reply_speed: { type: 'string' }, night_owl: { type: 'integer' }, napper: { type: 'integer' }, calm: { type: 'integer' }, habits: { type: 'string' }, seasonal: { type: 'string' } },
  required: ['weekday', 'holiday', 'reply_speed', 'night_owl', 'napper', 'calm', 'habits', 'seasonal'], additionalProperties: false,
};
const DEFAULT_RHYTHM = { weekday: '', holiday: '', speed: 'normal', nightOwl: 30, napper: 30, calm: 50, habits: '', seasonal: '' };
async function getRhythm(env, c, allowAI = true) {
  const w = await loadWorld(env).catch(() => ({}));
  const h = strHash(c.name + '\n' + (c.prompt || '') + '\n' + (w.stage || ''));
  const cached = await kvGet(env, 'rhythm:' + c.id, null);
  if (cached && ((cached.h === h && cached.r.habits != null) || !allowAI)) return cached.r; // 習慣（第29版）が無い古いものは1回だけ作り直す
  if (!allowAI) return DEFAULT_RHYTHM;
  const user = `# キャラクター: ${c.name}
${trunc(c.prompt || '（設定なし）', 3000)}

このキャラクターのふだんの生活リズムを考えてください。
- weekday：平日の典型的な1日（起きる時刻・食事・日中にしていること・お風呂・寝る時刻など）を時刻つきで短く。
- holiday：休日の典型的な1日を同じように。
- reply_speed：メッセージへの返事の早さ。"fast"（すぐ返す）／"normal"／"slow"（マイペース・気づくのが遅い）のどれか。
- night_owl：夜ふかしの度合い 0〜100。
- napper：昼寝や二度寝をしやすい度合い 0〜100。
- calm：地震などとっさのときの落ち着き 0〜100（低いほど慌てて、しばらくスマホも触れない）。
- habits：毎週の決まりごと・小さな習慣を3〜5個、1行に1つ「曜日や時間：内容」の形で（例「日曜の朝：ブリヌイを焼く」「月曜：少し気だるい」「毎晩寝る前：紅茶と日記」）。キャラクターらしく具体的に。
- seasonal：季節ごとの好みや習慣を、春・夏・秋・冬それぞれ短く（例「冬：ホットココアが手放せない、厚手のマフラー」）。`;
  try {
    const r = await aiJson(env, 'omote', (await worldBlock(env, user)) + 'あなたは、キャラクターの暮らしぶりを考える係です。キャラクター設定と作品の世界観に合った、自然な生活リズムを考えます。', user, RHYTHM_SCHEMA, 'rhythm');
    const v = {
      weekday: String(r.weekday || '').slice(0, 400), holiday: String(r.holiday || '').slice(0, 400),
      speed: ['fast', 'normal', 'slow'].includes(r.reply_speed) ? r.reply_speed : 'normal',
      nightOwl: clamp(Math.round(nz(r.night_owl, 30)), 0, 100), napper: clamp(Math.round(nz(r.napper, 30)), 0, 100), calm: clamp(Math.round(nz(r.calm, 50)), 0, 100),
      habits: String(r.habits || '').slice(0, 400), seasonal: String(r.seasonal || '').slice(0, 400),
    };
    await kvSet(env, 'rhythm:' + c.id, { h, r: v });
    return v;
  } catch (e) {
    await log(env, `生活リズム（${c.name}）: ${e.message}`);
    return cached ? cached.r : DEFAULT_RHYTHM;
  }
}

// ---- 返事をいつするか（すぐ／あとで）。AIは使わずに決める
function replyTiming(c, rh, state, hist, now, slow = 1) {
  const speed = ['fast', 'normal', 'slow'].includes(c.replySpeed) ? c.replySpeed : rh.speed || 'normal';
  const sf = { fast: 0.6, normal: 1, slow: 1.6 }[speed] * slow;
  const a = activityAt(state, now, c.id);
  const endMin = Math.max(0, (a.e - now) / MIN);
  const res = (readMin, replyMin, extra = {}) => {
    readMin = Math.max(0, readMin); replyMin = Math.min(Math.max(readMin, replyMin), 14 * 60);
    if (replyMin < 1) return { now: true, act: a };
    return { now: false, readAt: now + readMin * MIN, replyAt: now + replyMin * MIN, act: a.act, kind: a.kind, ...extra };
  };
  // 会話が続いているときは、だいたいそのまま返す
  const lastChar = [...hist].reverse().find((m) => m.sender === 'char');
  if (lastChar && now - lastChar.at < 6 * MIN && !isSleepKind(a.kind) && a.avail >= 25 && Math.random() < { fast: 0.95, normal: 0.85, slow: 0.7 }[speed]) return { now: true, act: a };
  if (isSleepKind(a.kind)) {
    let pAwake = a.kind === 'nap' ? 0.3 : 0.04 + (rh.nightOwl || 30) / 100 * 0.3;
    if (a.kind === 'sleep' && now - a.s < 60 * MIN) pAwake += 0.35; // まだ寝付いていない
    if (Math.random() < pAwake) return res(rndR(0, 2) * sf, rndR(0.5, 6) * sf, { awake: true });
    if (endMin < 120 && Math.random() < 0.2 + (rh.napper || 30) / 100 * 0.25) { // 一度目が覚めて読んだのに、二度寝
      return res(rndR(1, 6), endMin + rndR(20, 70), { glanced: true, twice: true });
    }
    const r = endMin + rndR(2, 25) * sf;
    return res(r, r + rndR(0, 8));
  }
  if (a.avail >= 70) { const d = Math.random() < 0.45 ? 0 : rndR(0.5, 6) * sf; return res(d * 0.5, d); }
  if (a.avail >= 30) {
    if (Math.random() < 0.2 / sf) return { now: true, act: a };
    if (Math.random() < 0.6) { const r = rndR(1, 10); return res(r, Math.min(r + rndR(5, 25) * sf, endMin + rndR(1, 10)), { glanced: true }); } // 作業の合間に見た
    const r = Math.min(rndR(5, 30) * sf, endMin + rndR(1, 10));
    return res(r, r + rndR(0, 3));
  }
  if (endMin > 120 && Math.random() < 0.5) { const r = rndR(5, 40); return res(r, r + rndR(15, 60), { glanced: true }); } // 長い作業の休憩中に
  if (Math.random() < 0.25) return res(rndR(1, 6), endMin + rndR(1, 12) * sf, { glanced: true });
  const r = endMin + rndR(0, 10) * sf; // 終わるまで既読も付かない
  return res(r, r + rndR(0, 4));
}
const delayOn = (st) => st.lifeEnabled && st.delayEnabled !== false; // 予定に合わせて返事が遅れる（設定で切れる）
async function getPending(env, cid) { return kvGet(env, 'reply:' + cid, null); }
// 返事を後回しにするか決めて、後回しなら予約する。{ now: true } ならすぐ返してよい
async function decideReply(env, c, hist, now) {
  const go = await kvGet(env, 'replygo:' + c.id, 0);
  if (go && now - go < 3 * MIN) return { now: true };
  const pend = await getPending(env, c.id);
  if (pend) return pend.replyAt <= now ? { now: true, pend } : { now: false, pend };
  const state = await getState(env, c.id);
  const rh = await getRhythm(env, c, false);
  const dis = await kvGet(env, 'dis:state', null).catch(() => null);
  const t = replyTiming(c, rh, state, hist, now, dis && dis.outage && dis.outage.on ? 1.6 : 1); // 停電中は充電を節約して、返事が少し遅れがち
  if (t.now) { await kvSet(env, 'replygo:' + c.id, now); return t; } // 「すぐ返す」と決めたことを覚えておく（続く /reply で使う）
  const lastMe = [...hist].reverse().find((m) => m.sender === 'me');
  const pend2 = { key: c.id, readAt: t.readAt, replyAt: t.replyAt, act: t.act, kind: t.kind, glanced: !!t.glanced, twice: !!t.twice, awake: !!t.awake, from: lastMe ? lastMe.at : now };
  // 作業の合間に読んだときは「🏃（あとで返します）」、二度寝するときは「😴」を、既読と一緒に付けることがある
  if (t.glanced && lastMe && !lastMe.reaction && Math.random() < 0.5) pend2.stamp = { id: lastMe.id, r: t.twice ? '😴' : '🏃' };
  await kvSet(env, 'reply:' + c.id, pend2);
  return { now: false, pend: pend2 };
}
// ---- スタンプによる話しかけの調整
async function stampGate(env, c, d, hist, now) {
  if (now < (await kvGet(env, 'usleep:' + c.id, 0))) return null; // 😴：朝までは話しかけない
  const lastChar = [...hist].reverse().find((m) => m.sender === 'char');
  const lastIsChar = hist.length && hist[hist.length - 1].sender === 'char';
  const r = lastIsChar && lastChar && lastChar.reaction;
  if (r === '🏃' || (now < (await kvGet(env, 'ulater:' + c.id, 0)))) { // 🏃：3時間は催促しない。過ぎたら、そっと声をかける
    if (now < (await kvGet(env, 'ulater:' + c.id, 0))) return null;
    if (d.mode === 'nudge' || d.mode === 'unread') d.afterLater = true;
    return d;
  }
  if (r && STAMPS[r] && STAMPS[r].close && (d.mode === 'nudge' || d.mode === 'unread')) { // 👍❤️😴：一区切りなので、催促ではなく新しい話題で
    return { ...d, mode: 'topic', since: d.since || (hist.length ? hist[hist.length - 1].at : now), afterStamp: r };
  }
  return d;
}
async function sleepStamp(env, c, hist, now, st) {
  if (!st.lifeEnabled) return;
  const state = await getState(env, c.id);
  const a = activityAt(state, now, c.id);
  if (a.kind !== 'sleep' || now - a.s > TICK_MIN * MIN + 60e3) return; // 眠りに入ったところだけ
  const last = hist[hist.length - 1];
  if (!last || last.sender !== 'me' || last.reaction || now - last.at > 4 * 3600e3) return;
  if (Math.random() < 0.6) await setReaction(env, last.id, '😴');
}

// ---- 自分から話しかける時刻を、ほかの子とずらす
// 13分ごとの判定で当たった子は、その13分の中のばらばらの時刻に送る。直前に別の子が送るなら数分あける
async function nextProactiveSlot(env, now) {
  const last = await kvGet(env, 'projLast', 0);
  const due = Math.max(now + rndR(0, 11) * MIN, last + rndR(4, 9) * MIN);
  await kvSet(env, 'projLast', due);
  return due;
}
async function runDueProactive(env) {
  await ensureSchema(env);
  const now = Date.now();
  const { results } = await env.DB.prepare("SELECT k,v FROM kv WHERE k >= 'proj:' AND k < 'proj;'").all();
  const due = results.map((r) => { try { return { k: r.k, ...JSON.parse(r.v) }; } catch (_) { return null; } }).filter((p) => p && p.due <= now).sort((a, b) => a.due - b.due);
  if (!due.length) return 0;
  const chars = await loadChars(env);
  let n = 0;
  for (const p of due.slice(0, 2)) {
    const claimed = await env.DB.prepare('DELETE FROM kv WHERE k=? RETURNING k').bind(p.k).first();
    if (!claimed) continue;
    const c = chars.find((x) => 'proj:' + x.id === p.k);
    if (!c) continue;
    try {
      const hist = await recent(env, c.id, 60);
      // 予約したあとに、ユーザーやこの子が話していたら、この話しかけはやめる（状況が変わったため）
      if (hist.some((m) => m.at > p.at || (m.reactedAt || 0) > p.at)) continue; // スタンプが付いた・外れた場合も、状況が変わったのでやめる
      const msgs = await generateAndStore(env, c, p.d, hist, await getRead(env, c.id));
      if (msgs.length) await pushToAll(env, c, msgs);
      await lifeAfterSend(env, c, p.d, now);
      n++;
    } catch (e) { await log(env, `自動送信（${c.name}）: ${e.message}`); }
  }
  return n;
}

// 予約していた返事（毎分確認する）
async function runDueReplies(env) {
  await ensureSchema(env);
  const now = Date.now();
  const { results } = await env.DB.prepare("SELECT k,v FROM kv WHERE k >= 'reply:' AND k < 'reply;'").all();
  let n = 0;
  for (const row of results) {
    let p; try { p = JSON.parse(row.v); } catch (_) { p = null; }
    if (p && p.stamp && !p.stamped && p.readAt <= now) { // 読んだ瞬間にスタンプだけ付ける
      await setReaction(env, p.stamp.id, p.stamp.r);
      p.stamped = 1;
      if (p.replyAt > now) { await kvSet(env, row.k, p); continue; }
    }
    if (p && p.replyAt > now) continue;
    const claimed = await env.DB.prepare('DELETE FROM kv WHERE k=? RETURNING k').bind(row.k).first();
    if (!claimed || !p) continue;
    try {
      const c = (await loadChars(env)).find((x) => x.id === p.key);
      if (!c) continue;
      const hist = await recent(env, c.id, 60);
      const last = hist[hist.length - 1];
      if (!last || last.sender !== 'me') continue; // もう返事済み
      const msgs = await generateAndStore(env, c, { mode: 'reply', late: p }, hist, await getRead(env, c.id), 'omote');
      if (msgs.length) await pushToAll(env, c, msgs);
      n++;
    } catch (e) { await log(env, `あとで返す返事: ${e.message}`); }
  }
  return n;
}
// 返事が遅れたことを、AIにどう伝えるか
function lateNote(late, hist, now) {
  if (!late) return '';
  const firstWait = (() => { let i = hist.length - 1; while (i > 0 && hist[i - 1].sender === 'me') i--; return hist[i]; })();
  const waited = firstWait ? now - firstWait.at : 0;
  const n = (() => { let k = 0; for (let i = hist.length - 1; i >= 0 && hist[i].sender === 'me'; i--) k++; return k; })();
  const out = [];
  if (waited >= 3 * MIN) {
    const what = late.awake ? `本来は眠っている時間（${late.act}）だったが、たまたま起きていた`
      : late.kind === 'sleep' || late.kind === 'nap' ? `${late.act}（眠っていた）` : `「${late.act}」の最中だった`;
    const mention = late.twice ? 0.9 : waited >= 60 * MIN ? 0.7 : waited >= 20 * MIN ? 0.5 : 0.2;
    out.push(`（実はあなたは${what}ため、メッセージが届いてから返すまで${fmtDur(waited)}ほどかかった。${late.twice ? '一度目が覚めてメッセージを読んだのに、そのまま二度寝してしまった。' : late.glanced ? '途中で一度メッセージは読んだ（既読は付いた）が、すぐには返せなかった。' : ''}${Math.random() < mention ? '遅れた理由に一言だけ自然に触れてよい（例「お風呂に入っていました」）。言い訳を長くしない。' : '遅れた理由には特に触れず、自然に返す。'}）`);
  }
  if (n >= 2) out.push(`（ユーザーから${n}通のメッセージが溜まっている。それぞれに順番に答え、いつもより少し長めにまとめて返してよい）`);
  return out.join('\n');
}
// 今していることで、話しかけ・投稿のしやすさを変える（1日の合計がほぼ変わらないよう平均で割る）
function actFactor(a, now) {
  if (isSleepKind(a.kind)) return 0.04;
  let f = 0.15 + a.avail / 100 * 1.4;
  if (a.prev && a.prev.avail < 40 && a.avail >= 40 && now - a.s < 25 * MIN) f *= 2.2; // ひと段落した直後
  return f;
}
const normMemo = {};
function actNorm(state, st, key, now) {
  const day = jstDay(now), mk = key + day + (state.plan ? state.plan.day : '');
  if (normMemo[mk]) return normMemo[mk];
  const base = jstDayStart(day);
  let sum = 0, n = 0;
  for (let t = base; t < base + 864e5; t += 15 * MIN) {
    if (isQuiet(t, st)) continue;
    sum += actFactor(activityAt(state, t, key), t); n++;
  }
  return (normMemo[mk] = n ? Math.max(0.2, sum / n) : 1);
}
async function activityBoost(env, c, st, now) {
  if (!st.lifeEnabled) return { f: 1 };
  const state = await getState(env, c.id);
  const a = activityAt(state, now, c.id);
  const f = actFactor(a, now) / actNorm(state, st, c.id, now);
  const justDone = a.prev && a.prev.avail < 40 && a.avail >= 40 && now - a.s < 25 * MIN ? a.prev.act : '';
  return { f, a, justDone };
}
// TLの反応（いいね・コメント）も、その子の予定に合わせて遅らせる
async function schedDue(env, cid, due, post, st) {
  if (post.world !== 'omote' || !st.lifeEnabled || isQuiet(post.at, st)) return due;
  const state = await getState(env, cid);
  const a = activityAt(state, due, cid);
  if (isSleepKind(a.kind)) return Math.random() < (a.kind === 'nap' ? 0.3 : 0.1) ? due : a.e + rndR(5, 40) * MIN;
  if (a.avail < 30 && Math.random() < 0.65) return a.e + rndR(1, 15) * MIN;
  return due;
}
function activityText(state, now, key) {
  const a = activityAt(state, now, key);
  return `いま：${a.act}（${hmJ(a.s)}〜${hmJ(a.e)}ごろ）${isSleepKind(a.kind) ? '…本来は眠っている時間だが、今はたまたま起きている' : ''}${a.prev && now - a.prev.e < 40 * MIN ? `／少し前まで：${a.prev.act}` : ''}${a.next ? `／このあと：${a.next.act}` : ''}`;
}


// ---------------------------------------------------------------- 災害・季節の出来事（表のトークとTLだけ）
// 本物の情報（地震・緊急地震速報・警報・台風・天気予報・大気・停電・ニュース）を見て、
// キャラたちも同じ地域で暮らしている子として反応する。どう反応するかは、その子の予定と性格で決める。
const SCALE_NAME = { 10: '1', 20: '2', 30: '3', 40: '4', 45: '5弱', 46: '5弱以上', 50: '5強', 55: '6弱', 60: '6強', 70: '7' };
const scaleName = (s) => SCALE_NAME[s] || String(s);
const QUAKE_MIN = { '3': 30, '4': 40, '5-': 45, '5+': 50, '6-': 55 };
const quakeMin = (st) => QUAKE_MIN[st.quakeMin] || 40;
const disOn = (st) => st.lifeEnabled && st.disasterEnabled !== false;
const WARN_NAME = { '02': '暴風雪警報', '03': '大雨警報', '04': '洪水警報', '05': '暴風警報', '06': '大雪警報', '10': '大雨注意報', '12': '大雪注意報', '14': '雷注意報', '15': '強風注意報', '18': '洪水注意報', '21': '乾燥注意報', '23': '低温注意報', '32': '暴風雪特別警報', '33': '大雨特別警報', '35': '暴風特別警報', '36': '大雪特別警報' };
function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
async function disLoad(env) {
  const s = await kvGet(env, 'dis:state', null);
  return s || { events: [], seen: {}, saga: null, outage: null, mon: {}, ctx: [], warn: [], far: [] };
}
async function disSave(env, s) {
  s.events = (s.events || []).filter((e) => Date.now() - e.at < 7 * 864e5).slice(-30);
  const seen = Object.entries(s.seen || {}).sort((a, b) => b[1] - a[1]).slice(0, 200);
  s.seen = Object.fromEntries(seen);
  await kvSet(env, 'dis:state', s);
}
async function getJSON(url, label) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (chara-chat)', Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${label}の取得に失敗しました（${r.status}）`);
  return r.json();
}
async function disLog(env, s, key, msg) { // 同じ失敗は半日に1回だけ診断に残す
  s.mon.logs = s.mon.logs || {};
  if (Date.now() - (s.mon.logs[key] || 0) < 12 * 3600e3) return;
  s.mon.logs[key] = Date.now();
  await log(env, '災害の確認：' + msg);
}

// ---- 地震・緊急地震速報（P2P地震情報。毎分）
async function checkQuakes(env, st, s, now) {
  const list = await getJSON('https://api.p2pquake.net/v2/history?codes=551&codes=556&limit=12', '地震情報');
  const first = !s.mon.quakeInit;
  s.mon.quakeInit = 1;
  const out = [];
  for (const x of Array.isArray(list) ? list.slice().reverse() : []) {
    const id = String(x.id || x._id || x.code + ':' + x.time);
    const t = Date.parse(String(x.time || '').replace(/\//g, '-').replace(' ', 'T') + '+09:00') || now;
    if (s.seen[id]) continue;
    s.seen[id] = now;
    if (first || now - t > 30 * MIN) continue; // 古い情報には反応しない
    if (x.code === 556) { // 緊急地震速報（警報）
      const eid = String((x.issue && x.issue.eventId) || id);
      const ev = (s.events || []).find((e) => e.type === 'eew' && e.eid === eid);
      if (x.cancelled) { if (ev && !ev.outcome) ev.outcome = 'false'; continue; }
      const sai = (x.areas || []).filter((a) => a.pref === '埼玉県' || /埼玉/.test(a.name || ''));
      if (!sai.length || ev) continue;
      out.push({ type: 'eew', eid, at: now, place: (x.earthquake && x.earthquake.hypocenter && x.earthquake.hypocenter.name) || '' });
    } else if (x.code === 551) { // 地震情報（震度）
      const q = x.earthquake || {};
      if (x.issue && x.issue.type === 'Foreign') continue;
      const qt = String(q.time || x.time);
      let local = 0, area = 0, pref = 0;
      for (const p of x.points || []) {
        if (p.pref !== '埼玉県') continue;
        const a = String(p.addr || '');
        pref = Math.max(pref, p.scale || 0);
        if (/さいたま/.test(a) && /北区/.test(a)) local = Math.max(local, p.scale || 0);
        else if (a === '埼玉県南部' || /さいたま/.test(a)) area = Math.max(area, p.scale || 0);
      }
      const sc = local || area || (pref >= 50 ? pref - 5 : 0); // 北区がなければ、さいたま市・県南部の震度で
      const hypo = (q.hypocenter && q.hypocenter.name) || '';
      // 直前の緊急地震速報の答え合わせ
      const eew = (s.events || []).filter((e) => e.type === 'eew' && !e.outcome && now - e.at < 15 * MIN).pop();
      const qev = (s.events || []).find((e) => e.type === 'quake' && e.qt === qt);
      if (sc >= quakeMin(st)) {
        if (qev) { if (sc > qev.scale) { qev.scale = sc; qev.level = scaleName(sc); } continue; }
        if (eew) eew.outcome = 'real';
        out.push({ type: 'quake', qt, at: now, scale: sc, level: scaleName(sc), place: hypo, mag: q.hypocenter && q.hypocenter.magnitude, eew: eew ? eew.id : null });
      } else {
        if (eew) eew.outcome = sc > 0 || pref > 0 ? 'small' : 'false';
        if ((q.maxScale || 0) >= 55 && !/埼玉/.test(hypo)) addFar(s, `${hypo}で最大震度${scaleName(q.maxScale)}の地震`, now);
      }
    }
  }
  // 速報から6分たっても揺れの情報がなければ、誤報だったことにする
  for (const e of s.events || []) if (e.type === 'eew' && !e.outcome && now - e.at > 6 * MIN) e.outcome = 'false';
  return out;
}
function addFar(s, title, now) {
  if ((s.far || []).some((f) => f.title === title)) return;
  s.far = (s.far || []).filter((f) => now - f.at < 2 * 864e5).concat({ title, at: now }).slice(-4);
  s.newFar = (s.newFar || []).concat(title); // 遠くの大きな災害：ニュースを見て話す
}

// ---- 天気予報（数日先まで）と大気
async function getForecast(env, st) {
  const c = await kvGet(env, 'forecast', null);
  if (c && Date.now() - c.at < 3600e3) return c.f;
  const f = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${st.weatherLat}&longitude=${st.weatherLon}` +
    '&hourly=precipitation,snowfall,wind_gusts_10m,weather_code,pressure_msl,temperature_2m,relative_humidity_2m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum,wind_gusts_10m_max' +
    '&timezone=Asia%2FTokyo&forecast_days=5&wind_speed_unit=ms', '天気予報');
  await kvSet(env, 'forecast', { at: Date.now(), f });
  return f;
}
async function getAir(env, st) {
  const c = await kvGet(env, 'air', null);
  if (c && Date.now() - c.at < 2 * 3600e3) return c.a;
  const a = await getJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${st.weatherLat}&longitude=${st.weatherLon}&hourly=ozone,dust,pm2_5&timezone=Asia%2FTokyo&forecast_days=2`, '大気の情報');
  await kvSet(env, 'air', { at: Date.now(), a });
  return a;
}
// 予報の時刻（"2026-10-16T13:00"、日本時間）→ ミリ秒
const fcT = (s) => Date.parse(s + ':00+09:00');
function hourlyNext(f, key, now, hours) {
  const h = f.hourly || {}, t = h.time || [], v = h[key] || [];
  const out = [];
  for (let i = 0; i < t.length; i++) { const ts = fcT(t[i]); if (ts >= now - 3600e3 && ts <= now + hours * 3600e3) out.push({ t: ts, v: v[i] }); }
  return out;
}

// ---- 気象庁の警報・注意報（埼玉県。形式が変わっていたら読めないので、読めた分だけ使う）
async function checkWarnings(env, s) {
  const j = await getJSON('https://www.jma.go.jp/bosai/warning/data/warning/110000.json', '警報・注意報');
  const found = new Set();
  const walk = (o, inCity) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach((x) => walk(x, inCity)); return; }
    const city = inCity || o.code === '1110000';
    if (city && typeof o.code === 'string' && WARN_NAME[o.code] && o.status && !/解除|なし/.test(o.status)) found.add(o.code);
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, city);
  };
  walk(j, false);
  const prev = new Set((s.warn || []).map((w) => w.code));
  s.warn = [...found].map((code) => ({ code, name: WARN_NAME[code] }));
  return [...found].filter((c) => !prev.has(c));
}

// ---- 台風（気象庁の台風情報）
async function checkTyphoon(env, st, s, now) {
  const list = await getJSON('https://www.jma.go.jp/bosai/typhoon/data/targetTc.json', '台風情報');
  let best = null;
  for (const tc of Array.isArray(list) ? list : []) {
    if (!tc.tropicalCyclone) continue;
    const num = String(tc.typhoonNumber || '');
    if (num.length <= 2) continue; // 台風になっていない熱帯低気圧
    let fc;
    try { fc = await getJSON(`https://www.jma.go.jp/bosai/typhoon/data/${tc.tropicalCyclone}/forecast.json`, '台風の予報'); } catch (_) { continue; }
    for (const p of Array.isArray(fc) ? fc : []) {
      if (!Array.isArray(p.center) || !p.validtime) continue;
      const t = Date.parse(p.validtime.JST || p.validtime);
      const d = distKm(st.weatherLat, st.weatherLon, p.center[0], p.center[1]);
      if (!best || d < best.dist) best = { tc: tc.tropicalCyclone, name: '台風' + (+num.slice(-2)) + '号', dist: d, at: t };
    }
  }
  return best;
}

// ---- 停電（東京電力の停電情報ページ。読めないときは手動の切り替えで）
async function checkTepco(env, s) {
  const r = await fetch('https://teideninfo.tepco.co.jp/', { headers: { 'User-Agent': 'Mozilla/5.0 (chara-chat)' } });
  if (!r.ok) throw new Error('停電情報の取得に失敗しました（' + r.status + '）');
  const text = await r.text();
  if (!/埼玉|東京都|神奈川/.test(text)) throw new Error('停電情報のページを読み取れませんでした（形式が違う）');
  return /さいたま市北区/.test(text) && /停電/.test(text);
}

// ---- ニュース（遠くの大災害・竜巻・降灰・線状降水帯・地域の停電）
async function checkNews(env, s, now, wantOutage) {
  const qs = ['大津波警報', '大雨特別警報', '噴火 噴火警戒レベル', '線状降水帯 埼玉', '竜巻 埼玉', '降灰 埼玉'];
  if (wantOutage) qs.push('停電 さいたま市北区');
  const found = {};
  for (const q of qs) {
    let items = [];
    try {
      const r = await fetch('https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:1d') + '&hl=ja&gl=JP&ceid=JP:ja', { headers: { 'User-Agent': 'Mozilla/5.0 (chara-chat)' } });
      if (r.ok) items = parseRss(await r.text());
    } catch (_) {}
    found[q] = items.filter((x) => x.at && now - x.at < 24 * 3600e3);
  }
  // 訓練・想定・特集・振り返りなど、いま起きていない出来事の記事は除く
  const notReal = /訓練|想定|特集|解説|年前|周年|過去|教訓|シミュレーション|備え|啓発|講演|展示|ハザードマップ|もしも|仮に|検証|振り返|記念|追悼|研修|会議|計画|予測|可能性|とは[?？]?$|なぜ/;
  const recent = (q, h, re) => (found[q] || []).find((x) => now - x.at < h * 3600e3 && re.test(x.title) && !notReal.test(x.title));
  // 遠くの大きな災害：実際に警報が出た・噴火したという見出しだけ
  const far = [
    recent('大津波警報', 24, /大津波警報(が|を)?(発表|発令|出)|大津波警報([、　 ]|$)/),
    recent('大雨特別警報', 24, /特別警報(が|を)?(発表|発令|出)/),
    recent('噴火 噴火警戒レベル', 24, /噴火警報(が|を)?(発表|発令|出)|噴火警戒レベル.{0,6}[3-5３-５].{0,4}(に引き上げ|へ引き上げ|引き上げ)|噴火速報|(が|で)噴火(した|しました|が発生|[、　 ]|$)|入山規制/),
  ];
  for (const x of far) if (x && !/埼玉/.test(x.title)) addFar(s, x.title, now);
  return {
    senjo: recent('線状降水帯 埼玉', 6, /線状降水帯/),
    tornado: recent('竜巻 埼玉', 3, /竜巻|突風/),
    ash: recent('降灰 埼玉', 12, /降灰|火山灰/),
    outage: wantOutage ? recent('停電 さいたま市北区', 2, /停電/) : null,
  };
}

// ---- 毎分：確認して、出来事を作り、予定していた反応を届ける
async function runDisasters(env, minute) {
  await ensureSchema(env);
  const st = await getSettings(env);
  if (!disOn(st)) return;
  const now = Date.now();
  const s = await disLoad(env);
  s.mon = s.mon || {};
  let heavy = 0; // 1分に1つだけ重い確認をする（Cloudflareの1回あたりの通信回数の上限に収めるため）
  const due = (k, mins) => { if (!heavy && now - (s.mon[k] || 0) >= mins * MIN) { s.mon[k] = now; heavy = 1; return true; } return false; };
  const newEvents = [];
  // 1) 地震・緊急地震速報：毎分
  try { newEvents.push(...(await checkQuakes(env, st, s, now))); s.mon.quakeOk = now; } catch (e) { await disLog(env, s, 'quake', e.message); }
  const stormy = s.saga && s.saga.phase === 'hit' || (s.events || []).some((e) => ['quake', 'rain', 'gust', 'wind', 'tornado'].includes(e.type) && now - e.at < 6 * 3600e3);
  // 2) 天気予報・警報・台風：1時間ごと（荒れているときは20分ごと）
  if (due('fc', stormy ? 20 : 60)) {
    try { newEvents.push(...(await evalWeather(env, st, s, now))); s.mon.fcOk = now; } catch (e) { await disLog(env, s, 'fc', e.message); }
  }
  // 3) ニュース：3時間ごと（荒れているときは30分ごと）
  if (due('news', stormy ? 30 : 180)) {
    try {
      const n = await checkNews(env, s, now, stormy);
      if (!s.mon.newsInit) { s.mon.newsInit = 1; s.newFar = []; } // 最初の1回は、すでに流れていたニュースに反応しない
      if (n.senjo && !recentEv(s, 'rain', now, 12)) newEvents.push({ type: 'rain', at: now, detail: '線状降水帯が発生していて、記録的な大雨' });
      if (n.tornado && !recentEv(s, 'tornado', now, 12)) newEvents.push({ type: 'tornado', at: now, detail: n.tornado.title });
      if (n.ash && !recentEv(s, 'ash', now, 48)) newEvents.push({ type: 'ash', at: now, detail: n.ash.title });
      if (n.outage) setOutage(s, true, 'news', null, now, newEvents);
      s.mon.newsOk = now;
    } catch (e) { await disLog(env, s, 'news', e.message); }
  }
  // 4) 停電：荒れているときは15分ごと、ふだんは3時間ごと（読めないページなら半日ごと）
  if (due('tepco', s.mon.tepcoBad ? 720 : stormy ? 15 : 180)) {
    try {
      const out = await checkTepco(env, s);
      s.mon.tepcoBad = 0;
      if (out) setOutage(s, true, 'tepco', null, now, newEvents);
      else if (s.outage && s.outage.source === 'tepco') setOutage(s, false, 'tepco', null, now, newEvents);
    } catch (e) { s.mon.tepcoBad = now; await disLog(env, s, 'tepco', e.message + '（停電は、設定の「停電中」で手動で切り替えられます）'); }
  }
  // ニュースで知った停電は3時間で終わりにする
  if (s.outage && s.outage.source === 'news' && now - s.outage.since > 3 * 3600e3) setOutage(s, false, 'news', null, now, newEvents);
  // 遠くの大きな災害のニュース（半日に1回まで）
  if ((s.newFar || []).length) {
    if (!recentEv(s, 'far', now, 12)) newEvents.push({ type: 'far', at: now, detail: s.newFar[s.newFar.length - 1] });
    s.newFar = [];
  }
  // 5) 新しい出来事 → キャラごとに反応を予定する
  for (const ev of newEvents) await addEvent(env, st, s, ev, now);
  for (const e of s.events || []) if (e.testResolveAt && !e.outcome && now >= e.testResolveAt) e.outcome = e.simOutcome; // テストの速報は90秒で「誤報」
  // 6) 速報の答え合わせ（誤報だった・小さな揺れだった）
  for (const e of s.events || []) {
    if (e.type === 'eew' && e.outcome && e.outcome !== 'real' && !e.outcomeDone) { e.outcomeDone = 1; await scheduleOutcome(env, s, e, now); }
  }
  await disSave(env, s);
  // 7) 時間が来た反応を届ける
  await runDisJobs(env, st, now, heavy ? 2 : 4);
}
function recentEv(s, type, now, hours) { return (s.events || []).some((e) => e.type === type && now - e.at < hours * 3600e3); }
function setOutage(s, on, source, cause, now, newEvents) {
  if (on && !(s.outage && s.outage.on)) {
    const c = cause || (s.saga && s.saga.phase === 'hit' ? s.saga.name : recentEv(s, 'quake', now, 2) ? '地震' : recentEv(s, 'gust', now, 3) ? '雷' : recentEv(s, 'wind', now, 6) ? '強風' : '');
    s.outage = { on: true, since: now, source, cause: c };
    newEvents.push({ type: 'outage_on', at: now, cause: c, sim: source === 'test' });
  } else if (!on && s.outage && s.outage.on) {
    if (s.outage.source === 'manual' && source !== 'manual') return; // 手動で付けた停電は、手動でだけ戻す
    newEvents.push({ type: 'outage_off', at: now, since: s.outage.since, cause: s.outage.cause, sim: s.outage.source === 'test' });
    s.outage = null;
  }
}

// ---- 天気予報から、大雨・雷雨・強風・雪・台風・季節のことを判断する
async function evalWeather(env, st, s, now) {
  const evs = [];
  const f = await getForecast(env, st);
  const d = f.daily || {};
  const today = jstDay(now), m = jstParts(now).mo;
  const ctx = [];
  // 季節・日常
  const tmax = (d.temperature_2m_max || [])[0], tmin = (d.temperature_2m_min || [])[0];
  if (tmax >= 35) ctx.push(`今日は最高${tmax}℃の猛暑日。熱中症警戒アラートが出るような危険な暑さ`);
  else if (tmax >= 30) ctx.push(`今日は最高${tmax}℃の真夏日`);
  if (tmin <= 0) ctx.push(`今朝は${tmin}℃まで冷え込む寒さ`);
  const hum = hourlyNext(f, 'relative_humidity_2m', now, 24).map((x) => x.v).filter((x) => x != null);
  if ((m >= 11 || m <= 3) && hum.length && Math.min(...hum) <= 35) ctx.push('空気がとても乾燥している');
  const codes = hourlyNext(f, 'weather_code', now, 18);
  if (codes.some((x) => x.v >= 95)) ctx.push('雷雨の予報が出ている');
  if (m >= 2 && m <= 4) ctx.push(m === 4 ? 'ヒノキ花粉の季節' : 'スギ花粉の季節' + ((d.wind_gusts_10m_max || [])[0] >= 10 && (d.weather_code || [])[0] <= 3 ? '（晴れて風が強く、花粉が多そうな日）' : ''));
  try {
    const a = await getAir(env, st);
    const oz = hourlyNext({ hourly: a.hourly }, 'ozone', now, 12).map((x) => x.v).filter((x) => x != null);
    const du = hourlyNext({ hourly: a.hourly }, 'dust', now, 12).map((x) => x.v).filter((x) => x != null);
    if (m >= 4 && m <= 9 && oz.length && Math.max(...oz) >= 200) ctx.push('オゾンの濃度が高く、光化学スモッグ注意報が出そうな日');
    if (du.length && Math.max(...du) >= 60) ctx.push('黄砂が飛んでいて、空がかすんでいる');
  } catch (e) { await disLog(env, s, 'air', e.message); }
  // 警報・注意報（読めたら）
  try {
    const newly = await checkWarnings(env, s);
    s.mon.warnOk = now;
    if (newly.some((c) => ['03', '04', '33'].includes(c)) && !recentEv(s, 'rain', now, 12)) evs.push({ type: 'rain', at: now, detail: newly.filter((c) => ['03', '04', '33'].includes(c)).map((c) => WARN_NAME[c]).join('・') + 'が出た' });
    if (newly.some((c) => ['05', '35', '02', '32'].includes(c)) && !(s.saga && s.saga.type === 'typhoon') && !recentEv(s, 'wind', now, 12)) evs.push({ type: 'wind', at: now, detail: '暴風の警報が出た' });
  } catch (e) { await disLog(env, s, 'warn', e.message); }
  // 大雨・雷雨・強風（予報から）
  const pr = hourlyNext(f, 'precipitation', now, 3);
  if (pr.some((x) => x.v >= 30) && !recentEv(s, 'rain', now, 12)) evs.push({ type: 'rain', at: now, detail: `1時間に${Math.max(...pr.map((x) => x.v))}ミリほどの激しい雨（ゲリラ豪雨）` });
  if (codes.filter((x) => x.t <= now + 2 * 3600e3).some((x) => x.v >= 96) && !recentEv(s, 'gust', now, 12)) evs.push({ type: 'gust', at: now, detail: '雷雨で、突風やひょうの恐れ' });
  const gust = (d.wind_gusts_10m_max || [])[0];
  if (gust >= 20 && !(s.saga && s.saga.type === 'typhoon') && !recentEv(s, 'wind', now, 20)) evs.push({ type: 'wind', at: now, detail: `最大瞬間風速${Math.round(gust)}メートルほどの強い風（春の嵐・発達した低気圧）` });
  // 台風・雪（何日かかけて進む出来事）
  let tc = null;
  try { tc = await checkTyphoon(env, st, s, now); s.mon.tcOk = now; } catch (e) { await disLog(env, s, 'typhoon', e.message); }
  const snowDays = (d.snowfall_sum || []).map((v, i) => ({ v, day: (d.time || [])[i] })).filter((x) => x.v >= 1);
  const snowNow = hourlyNext(f, 'snowfall', now, 2).some((x) => x.v > 0.2);
  evs.push(...sagaStep(s, now, today, tc, snowDays, snowNow, f));
  s.ctx = ctx;
  return evs;
}
// 台風・雪の段階：接近 → 前日 → 直撃 → 通過（または逸れた）
function sagaStep(s, now, today, tc, snowDays, snowNow, f) {
  const evs = [];
  const go = (saga, phase, extra = {}) => {
    if (saga.phase === phase) return;
    saga.phase = phase; saga.phaseAt = now;
    evs.push({ type: saga.type, phase, at: now, name: saga.name, ...extra });
  };
  let sg = s.saga;
  if (sg && sg.type === 'typhoon') {
    const near = tc && tc.tc === sg.tc && tc.dist <= 400;
    const h = tc ? (tc.at - now) / 3600e3 : -99;
    if (['approach', 'eve'].includes(sg.phase) && (!tc || tc.tc !== sg.tc || tc.dist > 550)) { go(sg, 'missed'); sg.endAt = now + 864e5; }
    else if (sg.phase !== 'after' && sg.phase !== 'missed') {
      const gusts = hourlyNext(f, 'wind_gusts_10m', now, 3).map((x) => x.v);
      if ((near && Math.abs(h) <= 10 && (tc.dist <= 200 || Math.max(0, ...gusts) >= 15)) && sg.phase !== 'hit') go(sg, 'hit');
      else if (sg.phase === 'hit' && (!near || h < -6)) { go(sg, 'after'); sg.endAt = now + 30 * 3600e3; }
      else if (near && h > 0 && h <= 36 && sg.phase === 'approach') go(sg, 'eve');
    }
    if (sg.endAt && now > sg.endAt) s.saga = sg = null;
  } else if (sg && sg.type === 'snow') {
    if (snowNow && sg.phase !== 'hit') go(sg, 'hit');
    else if (sg.phase === 'hit' && !snowNow && !snowDays.some((x) => x.day === today)) { go(sg, 'after'); sg.endAt = now + 30 * 3600e3; }
    else if (sg.phase === 'approach' && !snowDays.length) { go(sg, 'missed'); sg.endAt = now + 864e5; }
    if (sg && sg.endAt && now > sg.endAt) s.saga = sg = null;
  }
  if (!s.saga) {
    if (tc && tc.dist <= 400 && tc.at > now - 6 * 3600e3 && tc.at - now <= 120 * 3600e3) {
      s.saga = { type: 'typhoon', tc: tc.tc, name: tc.name, phase: '', since: now };
      const h = (tc.at - now) / 3600e3;
      go(s.saga, h <= 36 ? 'eve' : 'approach', { days: Math.max(1, Math.round(h / 24)) });
    } else if (snowDays.length) {
      s.saga = { type: 'snow', name: '雪', phase: '', since: now };
      go(s.saga, snowNow ? 'hit' : 'approach', { detail: snowDays.map((x) => `${x.day.slice(5).replace('-', '/')} 約${Math.round(x.v)}cm`).join('、') });
    }
  }
  return evs;
}

// ---- 出来事ごとの「必ず」「急ぎ」
const EV_URGENT = { quake: 1, eew: 1, outage_on: 1, tornado: 1 };
const EV_QUICK = { outage_off: 0, rain: 0.2, gust: 0.4, wind: 0.15 };
const EV_STYLES = ['まず自分の身の回りの様子から話す', 'まずユーザーのことを気づかう一言から入る', '短く、要点だけ', '少し長めに、気持ちを素直に', '質問を交えて、ユーザーの様子を聞く', '自分らしい冗談や軽さを少し混ぜる（深刻な場合は控える）']; // その場で体験すること（起きていればすぐ。値は寝ていて気づく確率）
const EV_TL = { quake: 1, eew: 1, outage_on: 1, outage_off: 0.6, rain: 1, gust: 0.8, wind: 0.7, tornado: 1, typhoon: 1, snow: 1, far: 0.4, ash: 1 };

// その子が、いつ・どんな状態で気づいて連絡するか
function eventReaction(c, rh, state, ev, now) {
  const a = activityAt(state, now, c.id);
  const calm = nz(rh.calm, 50);
  const speed = ['fast', 'normal', 'slow'].includes(c.replySpeed) ? c.replySpeed : rh.speed || 'normal';
  const sf = { fast: 0.7, normal: 1, slow: 1.4 }[speed];
  const info = { act: a.act, kind: a.kind };
  const sleeping = isSleepKind(a.kind);
  let d;
  if (EV_URGENT[ev.type] || ev.type in EV_QUICK) {
    const s = ev.type === 'quake' ? ev.scale : 0;
    let wakeP = ev.type === 'quake' ? (s >= 55 ? 1 : s >= 50 ? 0.97 : s >= 45 ? 0.9 : s >= 40 ? 0.55 : 0.3) : ev.type === 'eew' ? 0.85 : ev.type === 'outage_on' ? 0.1 : ev.type in EV_QUICK ? EV_QUICK[ev.type] : 0.5;
    if (a.kind === 'nap') wakeP = Math.min(1, wakeP + 0.25);
    if (sleeping && Math.random() >= wakeP) { info.slept = true; d = Math.max(5, (a.e - now) / MIN) + rndR(3, 30); }
    else {
      if (sleeping) info.woke = true;
      d = info.woke ? rndR(1, 6) : ({ bath: rndR(5, 15), meal: rndR(2, 8), chores: rndR(2, 8), busy: rndR(5, 25), out: rndR(3, 15), social: rndR(2, 10) }[a.kind] ?? rndR(0.5, 4));
      if (EV_URGENT[ev.type] && ev.type !== 'outage_on' && calm < 35 && Math.random() < 0.7) { info.panic = true; d += rndR(5, 30); }
      if (ev.type === 'quake' && s >= 50 && Math.random() < 0.5) { info.evac = true; d += rndR(20, 60); }
      d *= sf;
    }
  } else if (sleeping) { info.slept = true; d = Math.max(5, (a.e - now) / MIN) + rndR(10, 60); }
  else d = a.avail >= 60 ? rndR(3, 40) * sf : Math.max(3, (a.e - now) / MIN) + rndR(3, 30);
  if (ev.sim) d = Math.min(d / 10, 8);
  d = Math.max(0.5, d);
  const tlGap = rndR(-2, 25) * (ev.sim ? 0.1 : 1);
  return { talkDue: now + d * MIN, tlDue: now + Math.max(0.5, d + tlGap) * MIN, info };
}
async function addEvent(env, st, s, ev, now) {
  ev.id = ev.id || 'ev' + now.toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  ev.sent = {};
  s.events = (s.events || []).concat(ev);
  // 本物の揺れが来たら、まだ届けていない速報の反応はやめて、地震の反応にまとめる
  if (ev.type === 'quake' && ev.eew) {
    const e = s.events.find((x) => x.id === ev.eew);
    if (e) ev.eewSent = Object.keys(e.sent || {});
    await env.DB.prepare("DELETE FROM kv WHERE k LIKE ?").bind('disjob:' + ev.eew + ':%').run();
  }
  let chars = (await loadChars(env)).filter(inOmote);
  if (ev.type === 'far') { // 遠くのニュースは、1〜2人だけ（心配性な子ほど選ばれやすい）
    const scored = [];
    for (const c of chars) { const rh = await getRhythm(env, c, false); scored.push({ c, w: (100 - nz(rh.calm, 50)) / 100 + Math.random() }); }
    chars = scored.sort((a, b) => b.w - a.w).slice(0, Math.random() < 0.6 ? 1 : 2).map((x) => x.c);
  }
  for (const c of chars) {
    const state = await getState(env, c.id);
    const rh = await getRhythm(env, c, false);
    const r = eventReaction(c, rh, state, ev, now);
    r.info.style = EV_STYLES[Math.floor(Math.random() * EV_STYLES.length)]; // 子によって話し方を変える
    const jobs = [['talk', r.talkDue]];
    if (Math.random() < (EV_TL[ev.type] ?? 0.5)) jobs.push(['tl', r.tlDue]);
    if (ev.type === 'quake') jobs.push(['follow', r.talkDue + (ev.sim ? 3 : rndR(40, 90)) * MIN]);
    for (const [kind, due] of jobs) await kvSet(env, `disjob:${ev.id}:${c.id}:${kind}`, { ev: ev.id, cid: c.id, kind, due, info: r.info });
  }
}
// 誤報・小さな揺れだったと分かったとき：もう速報の連絡をした子は、ひとこと続ける
async function scheduleOutcome(env, s, e, now) {
  for (const cid of Object.keys(e.sent || {})) {
    const at = now + (e.sim ? rndR(0.5, 2) : rndR(1, 8)) * MIN;
    await kvSet(env, `disjob:${e.id}:${cid}:outcome`, { ev: e.id, cid, kind: 'outcome', due: at, info: {} });
    if (Math.random() < 0.6) await kvSet(env, `disjob:${e.id}:${cid}:tl2`, { ev: e.id, cid, kind: 'tl2', due: at + rndR(1, 15) * MIN, info: {} });
  }
}
async function runDisJobs(env, st, now, limit = 6) {
  const { results } = await env.DB.prepare("SELECT k,v FROM kv WHERE k >= 'disjob:' AND k < 'disjob;'").all();
  const dueJobs = results.map((r) => { try { return { k: r.k, ...JSON.parse(r.v) }; } catch (_) { return null; } })
    .filter((j) => j && j.due <= now).sort((a, b) => a.due - b.due).slice(0, limit);
  if (!dueJobs.length) return 0;
  const chars = await loadChars(env);
  let n = 0;
  for (const j of dueJobs) {
    const claimed = await env.DB.prepare('DELETE FROM kv WHERE k=? RETURNING k').bind(j.k).first();
    if (!claimed) continue;
    const s = await disLoad(env);
    const ev = (s.events || []).find((x) => x.id === j.ev);
    const c = chars.find((x) => x.id === j.cid);
    if (!ev || !c) continue;
    try {
      if (j.kind === 'tl' || j.kind === 'tl2') {
        await charPostNow(env, c, 'omote', st, { eventHint: eventTL(ev, j, s, now), eventPhoto: ['snow', 'typhoon'].includes(ev.type) && ['hit', 'after'].includes(ev.phase) && Math.random() < 0.4 });
      } else {
        const hist = await recent(env, c.id, 60);
        if (j.kind === 'follow') { // 地震のあと、あなたから返事がなければ心配してもう一度
          if (hist.some((m) => m.sender === 'me' && m.at > ev.at)) continue;
        }
        const msgs = await generateAndStore(env, c, { mode: 'event', ev, job: j, outage: s.outage }, hist, await getRead(env, c.id), 'omote');
        if (msgs.length) await pushToAll(env, c, msgs);
        if (j.kind === 'talk') { const s2 = await disLoad(env); const e2 = (s2.events || []).find((x) => x.id === ev.id); if (e2) { e2.sent = { ...(e2.sent || {}), [c.id]: now }; await disSave(env, s2); } }
      }
      n++;
    } catch (e) { await log(env, `災害の反応（${c.name}）: ${e.message}`); }
  }
  return n;
}

// ---- AIへの説明
function reactText(info, ev, now) {
  if (!info) return '';
  const late = fmtDur(Math.max(60e3, now - ev.at));
  if (info.slept) return `そのときあなたは眠っていて気づかず、起きてから知った（${late}たっている）。`;
  const parts = [];
  if (info.woke) parts.push('眠っていたが、飛び起きた。');
  else if (info.act) parts.push(`そのときあなたは「${info.act}」の最中だった。`);
  if (info.panic) parts.push('動揺して、しばらくスマホを触れなかった。');
  if (info.evac) parts.push('念のため近くの安全な場所に出て、落ち着いてから連絡している。');
  parts.push(`それから${late}たっている。`);
  return parts.join('');
}
function eventCore(ev, j, s, now) {
  const info = j && j.info;
  switch (ev.type) {
    case 'quake':
      return `さっき地震があった（${ev.place ? ev.place + 'を震源とする地震で、' : ''}あなたたちの住む地域は震度${ev.level}）。${ev.eew ? 'その直前にスマホの緊急地震速報が鳴った。' : ''}${reactText(info, ev, now)}` +
        ((ev.eewSent || []).includes(j && j.cid) ? '速報が鳴ったときに、もう一度連絡している。' : '') +
        (ev.scale >= 55 ? 'かなり強い揺れで、本当に怖かった。ふざけたり、はしゃいだりしない。' : '') +
        '揺れの様子や、身の回りの小さな出来事（物が落ちた、棚が揺れた、など）をリアルに。大きな被害やけが人は勝手に作らない。';
    case 'eew': {
      const o = ev.outcome;
      return 'さっきスマホの緊急地震速報（強い揺れに警戒）が急に鳴った。' + reactText(info, ev, now) +
        (!o ? '揺れが来るかもしれない緊張の中で、急いで連絡している。' : o === 'false' ? '…でも結局ほとんど揺れなかった（誤報だった）。気が抜けた、ほっとした、慌てて今していたことを中断してしまって恥ずかしい、など、キャラクターらしく。' : o === 'small' ? '…でも少し揺れただけで済んだ。ほっとした気持ちを。' : '');
    }
    case 'outage_on':
      return `急に停電した${ev.cause ? `（${ev.cause}の影響らしい）` : ''}。` + reactText(info, ev, now) +
        (info && info.slept ? (s.outage && s.outage.on ? '起きたら電気がつかない。' : '夜中に停電していたらしい（もう復旧している）。') : '真っ暗で、今していたことが中断された。') +
        'スマホの充電を節約したいので、短めに。';
    case 'outage_off':
      return `停電が復旧して、電気がついた（${fmtDur(now - (ev.since || ev.at))}ほど停電していた）。ほっとした気持ちや、停電中どう過ごしていたかを。`;
    case 'rain':
      return `外はものすごい雨（${ev.detail}）。窓の外の様子や、今していることへの影響、出かける予定がどうなるかを。ユーザーのことも気づかう。`;
    case 'gust':
      return `空が急に荒れてきた（${ev.detail}）。雷の音やひょう、突風など、身の回りの様子を。怖がりなら怖さも。`;
    case 'tornado':
      return `この辺りで竜巻や突風が起きたというニュースが流れている（「${ev.detail}」）。驚きや心配、身の回りの様子を。`;
    case 'wind':
      return `風がとても強い（${ev.detail}）。洗濯物や傘、窓の音など、身近なことを。`;
    case 'ash':
      return `遠くの火山の噴火の影響で、この辺りにも少し灰が降っているらしい（「${ev.detail}」）。`;
    case 'far':
      return `ニュースで「${ev.detail}」と流れているのを見た。遠くの出来事。自分なりの受け止め方で（その土地に縁があれば心配する、詳しくは知らないなら軽く触れる程度、など）。見出しにないことは足さない。ふざけない。`;
    case 'typhoon':
      return {
        approach: `${ev.name}が近づいている（最接近まであと${ev.days || 2}日ほど）。日に日に天気や気圧が悪くなっていく様子、頭痛やだるさ、予定がどうなるかの心配や期待を。`,
        eve: `明日にかけて${ev.name}が最接近する予報。休校や予定の中止が決まったかもしれない（あなたの予定表やキャラクター設定から自然に判断する。嫌な予定がなくなって喜ぶ、楽しみな予定がなくなって落ち込む、など）。買い出しや充電など準備の様子も。`,
        hit: `いま${ev.name}が直撃していて、外は暴風雨。窓を叩く風の音、停電の心配、家の中での過ごし方を。ユーザーの家の様子も心配する。`,
        after: `${ev.name}が過ぎ去った。台風一過の清々しい空、片付け、地域で出た被害の話（詳しくはわからないので、身の回りで見た程度に）。いつもの日々に戻っていく感覚を。`,
        missed: `${ev.name}は予報より逸れて、この辺りにはほとんど影響がなかった。予定通り授業や用事があることに、がっかりしたり喜んだり、キャラクターらしく。`,
      }[ev.phase] || '';
    case 'snow':
      return {
        approach: `数日のうちに雪が降る予報（${ev.detail || ''}）。関東は雪に弱いので、電車や予定の心配、雪が楽しみな気持ちなどを。`,
        hit: 'いま雪が降っている。窓の外の景色、寒さ、電車が止まったり予定がなくなったり、雪で遊びたい気持ちなどを。',
        after: '雪がやんだ。雪かき、凍った道、溶けかけの雪景色などを。',
        missed: '雪の予報だったのに、結局ほとんど降らなかった。がっかりしたりほっとしたり、キャラクターらしく。',
      }[ev.phase] || '';
    default: return '';
  }
}
function eventSituation(d, now) {
  const { ev, job } = d;
  const head = job.kind === 'follow'
    ? `${eventCore(ev, null, {}, now)}\nさっき連絡したのに、ユーザーからまだ返事がない（地震から${fmtDur(now - ev.at)}）。無事かどうか心配で、もう一度連絡する。短く、気持ちが伝わるように。`
    : job.kind === 'outcome'
      ? `さっきの緊急地震速報は、結局${ev.outcome === 'false' ? '誤報だった（ほとんど揺れなかった）' : '小さな揺れで済んだ'}。さっき慌てて連絡したことを受けて、気が抜けた・ほっとした・恥ずかしい、などをキャラクターらしく短く。`
      : eventCore(ev, job, { outage: d.outage }, now);
  return head + `\n話し方：${(job.info && job.info.style) || '自分らしく'}。` +
    '\n（「胸がざわざわ」のようなありきたりな決まり文句は避けて、このキャラクターらしい言葉で。防災の呼びかけや、公式の情報を確認するよう促すような言い方はしない。あくまでこの地域で暮らしている一人として、自分の気持ちと様子を話す）';
}
function eventTL(ev, j, s, now) {
  if (j.kind === 'tl2') return `さっきの緊急地震速報は${ev.outcome === 'false' ? '誤報だった' : '小さな揺れで済んだ'}。そのことをつぶやく（例「速報が鳴って慌てて外に出たのに…」）。`;
  return `${eventCore(ev, j, s, now)}\nこのことをSNSにつぶやく。直前にしていたことから自然に書き出す（例「紅茶を淹れていたら急に揺れて…」）。ユーザーの名前は出さない。`;
}

// ---- ふだんの会話・TL・予定表に渡す「身の回りの様子」
async function disasterContext(env, st, now) {
  if (!disOn(st)) return '';
  const s = await disLoad(env).catch(() => null);
  if (!s) return '';
  const lines = [];
  if (s.outage && s.outage.on) lines.push(`いま停電中（${fmtDur(now - s.outage.since)}前から${s.outage.cause ? '・' + s.outage.cause + 'の影響' : ''}）。スマホの充電を節約したいので、メッセージは短めに。`);
  if (s.saga) {
    const sg = s.saga;
    const ph = { approach: '接近中', eve: '明日にかけて最接近', hit: 'いま直撃中', after: '通過した（片付けや被害の話が出る頃）', missed: '予報より逸れて、ほとんど影響なし' }[sg.phase];
    if (ph) lines.push(sg.type === 'typhoon' ? `${sg.name}：${ph}` : `雪：${{ approach: '数日のうちに降る予報', hit: 'いま降っている', after: 'やんだあと', missed: '予報が外れた' }[sg.phase]}`);
  }
  for (const e of (s.events || []).filter((x) => now - x.at < 2 * 864e5 && !['typhoon', 'snow'].includes(x.type)).slice(-4)) {
    const what = { quake: `震度${e.level}の地震`, eew: `緊急地震速報${e.outcome === 'false' ? '（誤報だった）' : ''}`, outage_on: '停電', outage_off: '停電からの復旧', rain: '激しい雨', gust: '雷雨', tornado: '竜巻のニュース', wind: '強風', ash: '降灰', far: '遠くの災害のニュース' }[e.type];
    if (what) lines.push(`${fmtDur(now - e.at)}前：${what}${e.sim ? '' : ''}`);
  }
  if ((s.warn || []).length) lines.push('出ている警報・注意報：' + s.warn.map((w) => w.name).join('・'));
  for (const t of s.ctx || []) lines.push(t);
  for (const f of (s.far || []).filter((x) => now - x.at < 2 * 864e5)) lines.push(`遠くのニュース：${f.title}`);
  if (!lines.length) return '';
  return `\n# 身の回りの天気・災害・季節の様子（実際の情報）\n${lines.map((l) => '- ' + l).join('\n')}\n（毎回触れなくてよい。今の話題や気分、予定に自然ににじませる。防災の呼びかけのような言い方はしない）\n`;
}

// 話しかけるときにAIへ渡す「くらし」の情報
async function lifeContext(env, c, st, now) {
  if (!st.lifeEnabled) return '';
  const state = await getState(env, c.id);
  const today = jstDay(now);
  const out = [];
  if (state.day) {
    out.push(`# あなた（${c.name}）の今日の様子
気分：${state.mood}${state.moodReason ? `（${state.moodReason}）` : ''}
今日：${state.today}
${(state.diary || []).slice(-2).map((x) => `${fmtDay(x.d)}の出来事：${x.t}`).join('\n')}${state.story ? `
続いている出来事「${state.story.title}」：${state.story.log.map((x) => `${fmtDay(x.d)} ${x.t}`).join(' → ')}${state.story.finished ? '（区切りがついた）' : ''}` : ''}${state.project ? `
何週間も続けていること「${state.project.title}」（${fmtDay(state.project.start)}から）：${state.project.log.slice(-4).map((x) => `${fmtDay(x.d)} ${x.t}`).join(' → ')}${state.project.finished ? '（最近、区切りがついた）' : ''}` : ''}${state.condition ? `
数日続いている体調・状況：「${state.condition.label}」（${dayDiff(state.condition.start, today) + 1}日目${state.condition.now ? '・今日は' + state.condition.now : ''}）` : ''}${state.statusMsg ? `
プロフィールのひとこと：「${state.statusMsg}」` : ''}
（気分や体調は話し方に自然ににじませる。毎回説明しなくてよい）`);
  }
  const meets = (await kvGet(env, 'meet:' + today, [])).filter((m) => m.a === c.id || m.b === c.id);
  const meetsY = (await kvGet(env, 'meet:' + addDays(today, -1), [])).filter((m) => m.a === c.id || m.b === c.id);
  if (meets.length || meetsY.length) {
    const who = (m) => (m.a === c.id ? m.bName : m.aName);
    out.push(`# ほかの子との予定（ユーザーもその子を知っている。同じアプリで話している仲間）
${meets.map((m) => `- 今日${m.time ? ' ' + m.time + 'ごろ' : ''}：${who(m)}さんと「${m.act}」${m.time && jstParts(now).h * 60 + jstParts(now).mi >= m.time.split(':')[0] * 60 + +m.time.split(':')[1] ? '（もう過ごした／過ごしている）' : '（これから）'}`).join('\n')}${meetsY.map((m) => `\n- 昨日：${who(m)}さんと「${m.act}」`).join('')}
（聞かれたり話の流れが合えば話してよい。相手の子の言っていることと食い違わないように。相手の子の秘密は話さない）`);
  }
  const bd = [];
  if (c.birthday) {
    const n = daysToMD(c.birthday, now);
    if (n === 0) bd.push(`今日はあなた（${c.name}）の誕生日。ユーザーにお祝いされたら、キャラクターらしく喜ぶ。`);
    else if (n <= 3) bd.push(`あと${n}日であなたの誕生日（${mdText(c.birthday)}）。自分から言うかどうかはキャラクターしだい（期待してそわそわする、さりげなくほのめかす、など）。`);
    else if (n >= 362) bd.push(`昨日はあなたの誕生日だった（${mdText(c.birthday)}）。`);
  }
  for (const o of (await loadChars(env)).filter((x) => x.id !== c.id && x.birthday && inOmote(x))) {
    const n = daysToMD(o.birthday, now);
    if (n === 0) bd.push(`今日は${o.name}さんの誕生日（ユーザーもその子を知っている）。`);
    else if (n === 1) bd.push(`明日は${o.name}さんの誕生日。`);
  }
  if (bd.length) out.push('# 誕生日\n' + bd.join('\n'));
  const rh = await getRhythm(env, c, false).catch(() => null);
  if (rh && rh.habits) out.push(`# あなたの毎週の習慣\n${rh.habits}\n（今日の曜日に当てはまるものがあれば、自然ににじませてよい）`);
  out.push(`# あなたが今していること（だいたいの予定）
${activityText(state, now, c.id)}
（今していることと矛盾しない内容にする。毎回説明しなくてよい）`);
  let w = '';
  try { w = weatherText(await getWeather(env, st), st); } catch (_) {}
  out.push(`# 天気・季節・曜日（ユーザーの住んでいる地域）
${w ? '天気：' + w + '\n' : ''}${seasonText(now)}／${weekdayText(now)}`);
  const dc = await disasterContext(env, st, now).catch(() => '');
  if (dc) out.push(dc.trim());
  const mt = memoryText(await loadMemories(env, c.id, 120), today, Math.random() < 0.3);
  if (mt) out.push(`# あなたが覚えているユーザーとのこと
${mt}
（会話に自然に活かす。予定や約束の日付を意識する。毎回すべてに触れなくてよい）`);
  return '\n' + out.join('\n\n') + '\n';
}

// ---- 嫉妬（嫉妬しやすいキャラだけ）
async function isJealous(env, c) {
  if (c.jealous === 'yes') return true;
  if (c.jealous === 'no') return false;
  const h = strHash(c.name + '\n' + (c.prompt || ''));
  const cached = await kvGet(env, 'jealous:' + c.id, null);
  if (cached && cached.h === h) return cached.score >= 60;
  const r = await aiJson(env, 'omote', 'キャラクター設定を読んで、そのキャラクターがどれくらい嫉妬しやすいかを判定する係です。',
    `# キャラクター: ${c.name}\n${trunc(c.prompt || '（設定なし）', 3000)}\n\nユーザーがほかの人と仲良くしているとき、このキャラクターが嫉妬したり拗ねたりする度合いを0〜100で。ヤンデレ・独占欲が強い・構ってほしがりなら高く、さっぱり・クール・大人の余裕があるなら低く。`,
    { type: 'object', properties: { score: { type: 'integer' } }, required: ['score'], additionalProperties: false }, 'jealousy');
  const score = clamp(nz(r && r.score, 0), 0, 100);
  await kvSet(env, 'jealous:' + c.id, { h, score });
  return score >= 60;
}
async function jealousySignal(env, c, chars, now) {
  const since = now - 6 * 3600e3;
  const others = chars.filter((x) => x.id !== c.id);
  if (!others.length) return null;
  const counts = [];
  for (const o of others) {
    const t = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE char_id=? AND sender='me' AND at>?").bind(o.id, since).first();
    const tl = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM tl_likes l JOIN tl_posts p ON p.id=l.post_id WHERE l.author='me' AND p.author=? AND p.world='omote' AND l.at>?) + (SELECT COUNT(*) FROM tl_comments cm JOIN tl_posts p ON p.id=cm.post_id WHERE cm.author='me' AND p.author=? AND p.world='omote' AND cm.at>?) AS n").bind(o.id, since, o.id, since).first();
    const score = (t ? t.n : 0) + 2 * (tl ? tl.n : 0);
    if (score) counts.push({ name: o.name, talk: t ? t.n : 0, tl: tl ? tl.n : 0, score });
  }
  const mine = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE char_id=? AND sender='me' AND at>?").bind(c.id, since).first();
  const total = counts.reduce((s, x) => s + x.score, 0);
  if (total < 4 || total <= 2 * (mine ? mine.n : 0) + 1) return null;
  counts.sort((a, b) => b.score - a.score);
  return { names: counts.slice(0, 2).map((x) => x.name), detail: counts.slice(0, 2).map((x) => `${x.name}さんとトーク${x.talk}回${x.tl ? `・タイムラインで${x.tl}回反応` : ''}`).join('、'), mine: mine ? mine.n : 0 };
}

// ---- 特別な日（誕生日・出会って◯日・行事）
function occasionsToday(c, st, now, others = []) {
  const today = jstDay(now), md = today.slice(5);
  const out = [];
  if (c.birthday && daysToMD(c.birthday, now) === 0) out.push({ key: 'charbday', label: 'あなた自身の誕生日' });
  for (const o of others) if (o.id !== c.id && o.birthday && daysToMD(o.birthday, now) === 0) out.push({ key: 'obday:' + o.id, label: `${o.name}さんの誕生日`, other: true });
  if (st.birthday && st.birthday === md) out.push({ key: 'birthday', label: 'ユーザーの誕生日' });
  const days = dayDiff(jstDay(c.created || now), today);
  if ([30, 100, 200, 300, 500, 1000].includes(days) || (days > 0 && days % 365 === 0)) {
    out.push({ key: 'meet' + days, label: days % 365 === 0 ? `初めて話してから${days / 365}年の記念日` : `初めて話してから${days}日目の記念日` });
  }
  for (const [d, n] of [['12-24', 'クリスマスイブ'], ['01-01', 'お正月'], ['02-14', 'バレンタインデー']]) if (md === d) out.push({ key: 'ev' + d, label: n });
  return out;
}

// ---- 15分ごと（13分ごと）の判定に加える「くらし」の話しかけ
async function lifeDecide(env, c, hist, lastRead, now, st, ctxAll) {
  if (!st.lifeEnabled || isQuiet(now, st)) return null;
  const last = hist[hist.length - 1];
  if (!last || last.sender === 'me') return null;
  if (now - last.at < 20 * MIN) return null;
  const today = jstDay(now), h = jstParts(now).h;
  const state = await getState(env, c.id);
  const unread = hist.filter((m) => m.sender === 'char' && m.at > lastRead).length;
  // 特別な日：1日1回、朝のうちに届くことが多い
  for (const occ of occasionsToday(c, st, now).filter((o) => !o.other)) {
    const k = occ.key + ':' + today;
    if ((state.specials || {})[k]) continue;
    if (Math.random() < 0.3) return { mode: 'special', occ, stateKey: k };
  }
  // しばらく来ない（2日以上）：1日1回まで
  const away = now - ctxAll.lastUserActive;
  if (ctxAll.lastUserActive && away > 48 * 3600e3 && state.lastAbsentDay !== today && Math.random() < 0.15) {
    return { mode: 'absent', days: Math.floor(away / 864e5) };
  }
  if (unread >= 3) return null;
  // 予定・約束・相談・おすすめのフォロー（1日2回まで）
  if ((state.followDay === today ? state.followCount || 0 : 0) < 2) {
    const mems = (await loadMemories(env, c.id, 120)).filter((m) => m.status === 'open' && m.kind !== 'fact' && m.kind !== 'user_state' && m.kind !== 'joke' && m.due);
    for (const m of mems) {
      const tomorrow = addDays(today, 1);
      if (m.kind === 'promise' && m.due === tomorrow && m.followed < 1 && Math.random() < 0.25) return { mode: 'followup', mem: m, phase: 'remind' };
      const ripe = today > m.due || (today === m.due && h >= 19);
      if (ripe && m.followed < 2 && Math.random() < 0.2) return { mode: 'followup', mem: m, phase: 'after' };
    }
  }
  // 不在着信：声が聞きたくなって電話をかける（ユーザーは出られない）。36時間に1回まで・手が空いているときだけ
  if (now - (state.lastCallAt || 0) > 36 * 3600e3 && h >= 8 && h < 23) {
    const a = activityAt(state, now, c.id);
    const quietFor = now - last.at;
    const p = quietFor > 60 * MIN && quietFor < 10 * 3600e3 ? 0.02 : 0.006;
    if (a.avail >= 50 && !isSleepKind(a.kind) && Math.random() < p * ((await isJealous(env, c).catch(() => false)) ? 1.8 : 1)) return { mode: 'call', since: last.at };
  }
  // 嫉妬（嫉妬しやすいキャラだけ。12時間に1回まで）
  if (now - (state.lastJealousAt || 0) > 12 * 3600e3 && Math.random() < 0.3) {
    const sig = await jealousySignal(env, c, ctxAll.chars, now);
    if (sig && (await isJealous(env, c))) return { mode: 'jealous', sig };
  }
  return null;
}

// 話しかけたあとの記録
async function lifeAfterSend(env, c, d, now) {
  const today = jstDay(now);
  const state = await getState(env, c.id);
  if (d.mode === 'special') state.specials = { ...(state.specials || {}), [d.stateKey]: true };
  if (d.mode === 'absent') state.lastAbsentDay = today;
  if (d.mode === 'jealous') state.lastJealousAt = now;
  if (d.mode === 'call') state.lastCallAt = now;
  if (d.mode === 'followup') {
    state.followCount = (state.followDay === today ? state.followCount || 0 : 0) + 1;
    state.followDay = today;
    await env.DB.prepare('UPDATE memories SET followed=? WHERE id=?').bind(d.phase === 'remind' ? 1 : 2, d.mem.id).run();
  }
  if (d.flavor === 'consult' || d.flavor === 'recommend') state.pendingMemo = true;
  // specials は直近のものだけ残す
  if (state.specials) state.specials = Object.fromEntries(Object.entries(state.specials).slice(-30));
  await setState(env, c.id, state);
}

// 話題を切り替えるとき（topic）の「何を話すか」
async function chooseFlavor(env, c, d, st, now) {
  if (d.news && d.news.length) { d.flavor = 'news'; return; }
  const state = await getState(env, c.id);
  let w = null;
  try { w = await getWeather(env, st); } catch (_) {}
  const facts = (await loadMemories(env, c.id, 60)).filter((m) => m.kind === 'fact');
  const wd = jstParts(now).w;
  const table = [
    ['free', 28],
    ['weather', w ? (weatherNotable(w) || (await disasterContext(env, st, now).catch(() => '')) ? 22 : 8) : 0],
    ['story', state.story ? 16 : 0],
    ['project', state.project && !state.project.finished ? 10 : 0],
    ['question', 12],
    ['weekday', ['月', '金', '土', '日'].includes(wd) ? 9 : 0],
    ['consult', 7],
    ['recommend', 7],
    ['memory', facts.length ? 10 : 0],
    ['photo', st.imagesEnabled ? 8 : 0],
  ];
  const total = table.reduce((s, x) => s + x[1], 0);
  let r = Math.random() * total;
  for (const [k, wgt] of table) { if ((r -= wgt) < 0) { d.flavor = k; break; } }
  if (d.flavor === 'memory' && facts.length) d.memFact = facts[Math.floor(Math.random() * Math.min(facts.length, 20))].text;
  if (state.project) d.projTitle = state.project.title;
}
function flavorText(d) {
  switch (d.flavor) {
    case 'weather': return '今回は、天気や気温の話題で話しかけてください（「傘、持ちましたか？」「今日は冷えますね」のように、ユーザーを気づかう形で）。';
    case 'story': return '今回は、あなたの「続いている出来事」の今日の進み具合を話題にしてください。ユーザーの意見を聞くのもよい。';
    case 'project': return `今回は、あなたが何週間も続けていること「${d.projTitle || ''}」の最近の進み具合を話題にしてください（うまくいったこと・つまずいたこと・ユーザーに見てほしいこと、など）。`;
    case 'question': return '今回は、ユーザーのことをもっと知るための質問を、キャラクターらしい聞き方で1つしてください（好きなもの、子どもの頃のこと、最近ハマっていること、など。覚えていることと重ならないもの）。';
    case 'weekday': return '今回は、曜日に合った話題にしてください（月曜なら週の始まりの気づかい、金曜なら週末の予定を聞く、休日なら何をしているか聞く、など）。';
    case 'consult': return '今回は、あなた自身の小さな悩みごとをユーザーに相談してください（キャラクターの暮らしや続いている出来事に合ったもの。深刻すぎない）。';
    case 'recommend': return '今回は、あなたが好きなもの（料理・本・音楽・場所など、キャラクター設定に合うもの）をユーザーに具体的に勧めてください。';
    case 'memory': return `今回は、あなたが覚えているユーザーのこと「${d.memFact}」につながる話題で話しかけてください。`;
    case 'photo': return `今回は、写真を送る流れで話しかけてください。写真の内容は photo に書く（${PHOTO_SUBJECTS}）。${d.projTitle ? `続けていること「${d.projTitle}」の様子を写してもよい。` : ''}`;
    default: return '';
  }
}

function lifeSituation(d, now) {
  switch (d.mode) {
    case 'special':
      if (d.occ.key === 'charbday') return '今日はあなた自身の誕生日です。キャラクターらしく、うれしさ・ちょっとした期待（ユーザーに覚えていてほしい、お祝いしてほしい）・照れなどをにじませて話しかけてください（吹き出し1〜3つ。自分から誕生日だと言うか、遠回しにほのめかすかは性格しだい。もうユーザーにお祝いされていたら、そのお礼を）。';
      return d.occ.key === 'birthday'
        ? '今日はユーザーの誕生日です。キャラクターらしく心をこめて、いつもより長い手紙のようなメッセージを送ってください（1つの吹き出しに200〜450字。最後に短い吹き出しを1つ添えてもよい）。'
        : `今日は「${d.occ.label}」です。キャラクターらしく、その日にちなんだ、いつもより長めの手紙のようなメッセージを送ってください（1つの吹き出しに150〜400字）。`;
    case 'absent':
      return `ユーザーが約${d.days}日間、アプリを開いていません。キャラクターらしく、心配・寂しさ・拗ね・怒りなどを伝えてください。日数が長いほど気持ちを強く。ただし責めすぎず、最後はユーザーを気づかう。`;
    case 'followup': {
      const m = d.mem;
      if (d.phase === 'remind') return `明日は、ユーザーと約束した「${m.text}」の日です。楽しみにしている気持ちや確認を、キャラクターらしく伝えてください。`;
      return {
        plan: `ユーザーの予定「${m.text}」（${fmtDay(m.due)}）について、どうだったかを自然に聞いてください。`,
        event: `ユーザーに起きた「${m.text}」について、その後どうなったか・大丈夫かを自然に聞いてください。`,
        promise: `約束した「${m.text}」（${fmtDay(m.due)}）の日が過ぎました。会話から果たされたとわかればその話を、わからなければどうだったかを聞いてください。果たされていなさそうなら、キャラクターらしく拗ねてもよい。`,
        consult: `あなたが前にユーザーに相談した「${m.text}」について、その後どうなったかを報告してください（うまくいった／いかなかった、アドバイスへのお礼など）。`,
        recommend: `あなたが前にユーザーに勧めた「${m.text}」を、試してみたか・どうだったかを聞いてください。`,
      }[m.kind] || `「${m.text}」について、その後どうなったか話題にしてください。`;
    }
    case 'jealous':
      return `ユーザーは最近、あなた以外（${d.sig.names.join('、')}）とよくやり取りしています（${d.sig.detail}。あなたとのトークは${d.sig.mine}回）。キャラクターらしく嫉妬して、拗ねたり、気を引こうとしたりしてください。相手を傷つけたり脅したりはしない。`;
    default: return '';
  }
}

// ---- 写真の保存（D1に分けて保存）
const IMG_CHUNK = 700000;
async function saveImage(env, dataUrl) {
  const m = String(dataUrl).match(/^data:(image\/[\w+.-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new HttpError(400, '画像の形式が正しくありません');
  const id = crypto.randomUUID();
  const stmts = [];
  for (let i = 0, n = 0; i < m[2].length; i += IMG_CHUNK, n++) {
    stmts.push(env.DB.prepare('INSERT INTO images (id,part,mime,data) VALUES (?,?,?,?)').bind(id, n, m[1], m[2].slice(i, i + IMG_CHUNK)));
  }
  await env.DB.batch(stmts);
  return id;
}
async function loadImage(env, id) {
  const { results } = await env.DB.prepare('SELECT mime,data FROM images WHERE id=? ORDER BY part').bind(String(id || '')).all();
  if (!results.length) return null;
  return { mime: results[0].mime, b64: results.map((r) => r.data).join('') };
}

// Gemini の画像モデルで作る／加工する
const IMAGE_MODELS = ['gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview'];
async function geminiImage(env, prompt, src) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY がありません');
  const models = env.GEMINI_IMAGE_MODEL ? [env.GEMINI_IMAGE_MODEL] : IMAGE_MODELS;
  let lastErr = '';
  for (const model of models) {
    const parts = [{ text: prompt }];
    if (src) parts.unshift({ inlineData: { mimeType: src.mime, data: src.b64 } });
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) { lastErr = `画像 ${model} ${r.status}: ${(data && data.error && data.error.message) || ''}`; await aiAlertFail(env, 'gemini', r.status, lastErr); if ([400, 403, 404].includes(r.status)) continue; throw new Error(lastErr); }
    const ps = (((data || {}).candidates || [])[0] || {}).content;
    const img = ((ps && ps.parts) || []).find((p) => p.inlineData && p.inlineData.data);
    if (img) { await recordCost(env, 'omote', 'gemini', model, 0, 0, 0, 1).catch(() => {}); return `data:${img.inlineData.mimeType || 'image/png'};base64,${img.inlineData.data}`; }
    lastErr = '画像が返ってきませんでした';
  }
  throw new Error(lastErr);
}
const NO_PEOPLE = '人物・キャラクター・人の顔や手足・イラストの人物は一切写さない。文字やロゴは入れない。';
// キャラが送る・載せる写真の題材（キャラ本人や人物は写さない）
const PHOTO_SUBJECTS = '作った料理、見かけた景色のほか、あなたにまつわる物（愛用品、趣味の道具、好きな物、部屋の一角、よく行く場所、飼っている動物など、キャラクター設定に合うもの）でもよい。あなた自身や人物は写っていないもの';
async function makeCharPhoto(env, desc) {
  return geminiImage(env, `スマートフォンで撮った自然な実写の写真を1枚作ってください。イラストやアニメ調にはしない。内容：${desc}。${NO_PEOPLE}`);
}
async function editUserPhoto(env, src, how) {
  return geminiImage(env, `この写真を次のように加工した画像を1枚作ってください：${how}。写っているものは保ったまま。${NO_PEOPLE.replace('写さない', '新しく描き足さない')}`, src);
}

// ---- 返事を作る（表）：ニュース・写真・打ち間違い・送信取り消しの指示を必要に応じて加える
async function callOmoteRich(env, c, d, system, contents, opt) {
  const props = { messages: { type: 'array', items: { type: 'string' } } };
  let extra = '';
  if (opt.news) { props.used_news = { type: 'integer' }; }
  if (opt.photo) { props.photo = { type: 'string' }; extra += `\n- photo：送る写真の内容を具体的に1文（例「焼きたてのブリヌイ、ジャムを添えて」）。${PHOTO_SUBJECTS}。写真を送らないなら ""。`; }
  if (opt.edit) { props.photo_edit = { type: 'string' }; extra += '\n- photo_edit：ユーザーが送ってくれた写真を、遊び心で加工して送り返したくなったら、加工の内容を1文（例「花の冠を描き足す」「レトロなフィルムカメラ風にする」）。人物やキャラクターは描き足さない。ほとんどの場合は加工しない（""）。'; }
  if (opt.retract) { props.retract = { type: 'integer' }; extra += '\n- retract：書いた吹き出しのうち、照れくさかったり言い過ぎたりして「やっぱり送信取り消し」したくなるものがあれば、その番号（0から）。なければ -1。'; }
  if (opt.quote && opt.quote.length) {
    props.quote = { type: 'integer' };
    extra += `\n- quote：ユーザーの少し前のメッセージに「引用して」返すとき（LINEの引用返信。続けて送られたうちの特定の1つに答える・少し前の話に戻る、など、どれへの返事かを示したほうが自然なとき）、その番号。ふだんは -1。
${opt.quote.map((m, i) => `  ${i}：「${trunc(m.text, 60)}」`).join('\n')}`;
  }
  if (opt.ps) { props.postscript = { type: 'string' }; extra += '\n- postscript：送り終えて数分たってから、ふと思い出したように付け足す短い一言（「あ、そういえば…」「さっき言い忘れましたが」「＊追伸」など、キャラクターらしく）。付け足したいことが自然にあるときだけ。ふだんは ""。'; }
  if (opt.typo) extra += '\n- 今回は、吹き出しのどれか1か所で、スマホらしい自然な打ち間違い（変換ミスなど）をして、次の吹き出しで「＊正しい言葉」と短く訂正する。キャラクターに合わなければしなくてよい。';
  if (opt.react) {
    props.stamp = { type: 'string' };
    extra += `\n- stamp：ユーザーの最後のメッセージに付けるスタンプ（LINEのリアクションのようなもの）。付けるなら次のどれか1つ、付けないなら ""。
${Object.keys(STAMPS).filter((k) => k !== '🏃').map((k) => `  ${k}：${STAMPS[k].char}`).join('\n')}
  ふだんは付けない（目安は5回に1回以下）。どのスタンプをどれくらい使うかは、キャラクターの性格に合わせる（照れ屋は👍で済ませがち、さみしがりは🥺や❤️が多め、など）。
  👍・❤️・😴 は「この話はここで一区切り」の意味。ユーザーのメッセージが話の締めくくり（「おやすみ」「了解」「ありがとう」など）で、スタンプだけで返すのが自然なときは、messages を空 [] にしてスタンプだけにしてよい。それ以外は、スタンプと一緒に短い言葉を添える。`;
  }
  const keys = Object.keys(props);
  const sys = system.replace(/出力は \{"messages"[\s\S]*$/, '') + (extra ? `\n# 追加の出力${extra}\n` : '') +
    `\n出力は ${JSON.stringify(Object.fromEntries(keys.map((k) => [k, k === 'messages' ? ['吹き出し1'] : props[k].type === 'integer' ? -1 : ''])))} の形のJSONのみ。`;
  const schema = { type: 'object', properties: props, required: keys, additionalProperties: false };
  const r = await callAIObj(env, 'omote', sys, contents, schema, 'chat_reply_rich');
  const maxSplit = c.maxSplit + (opt.typo ? 1 : 0);
  const stamp = opt.react && r && STAMPS[String(r.stamp || '').trim()] && String(r.stamp).trim() !== '🏃' ? String(r.stamp).trim() : '';
  const raw = ((r && r.messages) || []).map((x) => String(x).trim()).filter(Boolean);
  const texts = stamp && !raw.length ? [] : parseMessages(JSON.stringify({ messages: raw }), maxSplit, 'AI'); // スタンプだけで返すこともある
  return {
    texts, stamp,
    usedNews: opt.news ? Number(r && r.used_news) : -1,
    photo: opt.photo ? String((r && r.photo) || '').trim() : '',
    edit: opt.edit ? String((r && r.photo_edit) || '').trim() : '',
    retract: opt.retract ? Number(r && r.retract) : -1,
    quoteId: opt.quote && Number.isInteger(Number(r && r.quote)) && opt.quote[Number(r.quote)] ? opt.quote[Number(r.quote)].id : 0,
    postscript: opt.ps ? String((r && r.postscript) || '').trim().slice(0, 200) : '',
  };
}

// ================================================================ 最近のニュース（表で話題を切り替えるとき）
// キャラが興味を持ちそうなキーワードで Google ニュースを検索し、見出しの候補をAIに渡す。
// AIは「このキャラが本当に食いつきそうなもの」だけを選んで話題にし、どれも合わなければ使わない。
const NEWS_RATE = 0.4;          // 話題を切り替えるとき、ニュースを候補に入れる確率
const NEWS_MAX_AGE = 3 * 24 * 3600e3;
const NEWS_CACHE = 2 * 3600e3;  // 同じキーワードの検索は2時間使い回す

function strHash(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) | 0; return String(h); }
function decodeXml(s) {
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&').trim();
}
function parseRss(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const get = (tag) => { const r = m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return r ? decodeXml(r[1]) : ''; };
    const source = get('source');
    let title = get('title');
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    const at = Date.parse(get('pubDate')) || 0;
    if (title) items.push({ title, source, at });
  }
  return items;
}

// キャラが興味を持ちそうなキーワード（自分で書いたもの優先。なければキャラ設定からAIが考えて、設定が変わるまで覚えておく）
async function newsKeywords(env, c) {
  const own = String(c.newsKeywords || '').split(/[、,，\s\n]+/).map((x) => x.trim()).filter(Boolean);
  if (own.length) return own.slice(0, 15); // 自分で書いたキーワードは15個まで
  const key = 'newsKw:' + c.id, h = strHash(c.name + '\n' + (c.prompt || ''));
  const cached = await kvGet(env, key, null);
  if (cached && cached.h === h && Array.isArray(cached.kw) && cached.kw.length) return cached.kw;
  const r = await aiJson(env, 'omote',
    'あなたは、キャラクター設定を読んで、そのキャラクターが興味を持ちそうなニュースを探すための検索キーワードを考える係です。',
    `# キャラクター: ${c.name}\n${trunc(c.prompt || '（設定なし）', 3000)}\n\n` +
    'このキャラクターが思わず話題にしたくなりそうなニュースを、Googleニュースで探すための日本語の検索キーワードを4〜6個。' +
    '好きなもの・趣味・出身地や縁のある場所・仕事や立場・関心ごとから、具体的な名詞で（例：「ロシア料理」「猫」「天体観測」）。1つのキーワードは短く。',
    { type: 'object', properties: { keywords: { type: 'array', items: { type: 'string' } } }, required: ['keywords'], additionalProperties: false }, 'news_keywords');
  const kw = ((r && r.keywords) || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 6);
  if (kw.length) await kvSet(env, key, { h, kw });
  return kw;
}

async function searchNews(env, kw) {
  const ck = 'news:' + kw;
  const cached = await kvGet(env, ck, null);
  if (cached && Date.now() - cached.at < NEWS_CACHE) return cached.items;
  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(kw + ' when:3d') + '&hl=ja&gl=JP&ceid=JP:ja';
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (chara-chat)', Accept: 'application/rss+xml, application/xml' } });
  if (!r.ok) throw new Error('ニュースの取得に失敗しました（' + r.status + '）');
  const items = parseRss(await r.text()).slice(0, 8).map((x) => ({ ...x, kw }));
  await kvSet(env, ck, { at: Date.now(), items });
  return items;
}

// 話題の切り替え（topic）のとき、ときどきニュースの候補を d.news に入れる
async function attachNews(env, c, d, st) {
  if (!st.newsEnabled && !d.forceNews) return;
  if (!d.forceNews && Math.random() >= NEWS_RATE) return;
  try {
    const kws = await newsKeywords(env, c);
    if (!kws.length) return;
    const pick = kws.slice().sort(() => Math.random() - 0.5).slice(0, 3); // 毎回すこし違うキーワードで
    const used = new Set(await kvGet(env, 'newsUsed:' + c.id, []));
    const now = Date.now();
    const seen = new Set();
    let all = [];
    for (const kw of pick) {
      try { all = all.concat(await searchNews(env, kw)); } catch (e) { await log(env, `ニュース（${kw}）: ${e.message}`); }
    }
    all = all.filter((x) => x.at && now - x.at < NEWS_MAX_AGE && !used.has(x.title) && !seen.has(x.title) && seen.add(x.title))
      .sort((a, b) => b.at - a.at).slice(0, 10);
    if (all.length) d.news = all;
  } catch (e) {
    await log(env, 'ニュース: ' + e.message);
  }
}

function newsBlock(news, now) {
  return `

# 話題の候補：ここ数日の実際のニュース（見出し）
${news.map((x, i) => `${i}. ${x.title}（${x.source || '不明'}・${fmtDur(now - x.at)}前・検索語「${x.kw}」）`).join('\n')}

- このキャラクターが本当に興味を持ちそうなもの・自分に関係のありそうなものが1つあれば、それをキャラクターらしい感想や質問と一緒に話題にしてよい（「ねえ、ニュースで見たんですけど…」のように自然に）。
- どれもこのキャラクターらしくなければ、ニュースは使わず、キャラクターらしい別の話題や質問にする。無理にニュースを使わない。
- 見出しに書かれていないことを事実として付け足さない。詳しくわからない部分は「詳しくは知らないけど」くらいにとどめる。
- 使ったニュースの番号を used_news に入れる（使わなかったら -1）。`;
}

const NEWS_MSG_SCHEMA = {
  type: 'object',
  properties: { messages: { type: 'array', items: { type: 'string' } }, used_news: { type: 'integer' } },
  required: ['messages', 'used_news'], additionalProperties: false,
};
async function callWithNews(env, c, d, system, contents) {
  const r = await callAIObj(env, 'omote', system, contents, NEWS_MSG_SCHEMA, 'chat_reply_news');
  const texts = parseMessages(JSON.stringify({ messages: (r && r.messages) || [] }), c.maxSplit, 'AI');
  const i = Number(r && r.used_news);
  if (Number.isInteger(i) && i >= 0 && d.news[i]) {
    d.newsUsed = d.news[i].title;
    const used = await kvGet(env, 'newsUsed:' + c.id, []);
    used.push(d.newsUsed);
    await kvSet(env, 'newsUsed:' + c.id, used.slice(-40)); // 同じニュースを何度も話さない
  }
  return texts;
}

// ---------------------------------------------------------------- Web Push（RFC 8291 / RFC 8292）
const enc = (s) => new TextEncoder().encode(s);
function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  return Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
}
function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

async function getVapid(env) {
  let v = await kvGet(env, 'vapid', null);
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const pub = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
    await env.DB.prepare('INSERT OR IGNORE INTO kv (k,v) VALUES (?,?)').bind('vapid', JSON.stringify({ jwk, pub })).run();
    v = await kvGet(env, 'vapid', null);
  }
  const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return { pub: v.pub, key };
}

async function vapidJwt(aud, subject, key) {
  const h = b64u(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64u(enc(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc(h + '.' + p)));
  return `${h}.${p}.${b64u(sig)}`;
}

async function encryptPayload(sub, payload) {
  const uaPub = unb64u(sub.keys.p256dh);
  const auth = unb64u(sub.keys.auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, secret, concat(enc('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc(payload), new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPub.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPub.length;
  header.set(asPub, 21);
  return concat(header, ct);
}

async function sendPush(env, sub, payload, vapid) {
  const aud = new URL(sub.endpoint).origin;
  const jwt = await vapidJwt(aud, env.VAPID_SUBJECT || 'https://koara1012.github.io', vapid.key);
  const body = await encryptPayload(sub, payload);
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${vapid.pub}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
    },
    body,
  });
}

function truncBytes(s, max) {
  const e = enc(s);
  if (e.length <= max) return s;
  let out = '';
  for (const ch of s) { if (enc(out + ch + '…').length > max) break; out += ch; }
  return out + '…';
}

// ================================================================ Bark（好きな通知音・キャラのアイコンで届く。中身は暗号化）
// シークレット：BARK_DEVICE_KEY（送り先）、BARK_ENC_KEY（暗号の鍵：16・24・32文字）。IVは通知ごとにランダムに作って一緒に送る
const BARK_SERVER = 'https://api.day.app';
async function iconSig(env, cid) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.APP_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode('icon:' + cid)));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function publicIcon(env, cid, sig) {
  if (sig !== await iconSig(env, cid)) return new Response('not found', { status: 404 });
  await ensureSchema(env);
  const r = await env.DB.prepare('SELECT icon FROM chars WHERE id=?').bind(cid).first();
  const m = r && r.icon && String(r.icon).match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (!m) return new Response('not found', { status: 404 });
  const bin = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
  return new Response(bin, { headers: { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=86400' } });
}
async function rememberOrigin(env, origin) {
  if (!/^https:\/\//.test(origin)) return;
  if ((await kvGet(env, 'origin', '')) !== origin) await kvSet(env, 'origin', origin);
}
async function barkIconUrl(env, cid) {
  if (!cid || cid === ME) return '';
  const origin = await kvGet(env, 'origin', '');
  if (!origin) return '';
  const r = await env.DB.prepare('SELECT icon IS NOT NULL AS has, icon_ver FROM chars WHERE id=?').bind(cid).first();
  if (!r || !r.has) return '';
  return `${origin}/icon/${cid}/${await iconSig(env, cid)}.png?v=${r.icon_ver || 0}`;
}
function randomAlnum(n) {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => a[x % a.length]).join('');
}
async function barkEncrypt(keyStr, ivStr, plain) {
  const key = new TextEncoder().encode(keyStr), iv = new TextEncoder().encode(ivStr);
  if (![16, 24, 32].includes(key.length)) throw new Error('BARK_ENC_KEY は16・24・32文字（半角英数字）にしてください');
  if (iv.length !== 16) throw new Error('IV は16文字にしてください');
  const k = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, new TextEncoder().encode(plain))); // PKCS7で詰める
  let bin = ''; for (const b of ct) bin += String.fromCharCode(b);
  return btoa(bin);
}
async function sendBark(env, st, { title, body, cid, group }) {
  if (!env.BARK_DEVICE_KEY) throw new Error('シークレット BARK_DEVICE_KEY が設定されていません');
  const p = { title: String(title || ''), body: String(body || ''), group: group || 'トーク', level: 'active' };
  if (st.barkSound) p.sound = st.barkSound;
  const icon = await barkIconUrl(env, cid).catch(() => '');
  if (icon) p.icon = icon;
  const server = (env.BARK_SERVER || BARK_SERVER).replace(/\/+$/, '');
  let r;
  if (env.BARK_ENC_KEY) { // 暗号化して送る（途中のサーバーには中身が読めない）。IVは毎回ランダム
    const iv = randomAlnum(16);
    const ciphertext = await barkEncrypt(env.BARK_ENC_KEY, iv, JSON.stringify(p));
    r = await fetch(`${server}/${encodeURIComponent(env.BARK_DEVICE_KEY)}`, { method: 'POST', body: new URLSearchParams({ ciphertext, iv }) });
  } else {
    r = await fetch(`${server}/push`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ ...p, device_key: env.BARK_DEVICE_KEY }) });
  }
  const t = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`Barkへの送信に失敗しました（${r.status}）${t.slice(0, 120)}`);
  return { status: r.status, encrypted: !!env.BARK_ENC_KEY, icon: !!icon, sound: p.sound || '（Barkの既定の音）' };
}

async function pushPayload(env, obj) {
  const { results } = await env.DB.prepare('SELECT endpoint,data FROM subs').all();
  if (!results.length) return [{ error: '通知の登録がありません（アプリの設定で「通知をオンにする」を押してください）' }];
  const vapid = await getVapid(env);
  const payload = JSON.stringify(obj);
  const out = [];
  for (const r of results) {
    try {
      const res = await sendPush(env, JSON.parse(r.data), payload, vapid);
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare('DELETE FROM subs WHERE endpoint=?').bind(r.endpoint).run();
        out.push({ status: res.status, note: '期限切れの登録を削除しました' });
      } else if (!res.ok) {
        const t = await res.text().catch(() => '');
        out.push({ status: res.status, error: t.slice(0, 200) });
        await log(env, `通知送信 ${res.status}: ${t.slice(0, 200)}`);
      } else out.push({ status: res.status });
    } catch (e) {
      out.push({ error: e.message });
      await log(env, '通知送信: ' + e.message);
    }
  }
  return out;
}

async function pushToAll(env, c, msgs) {
  if (!msgs.length) return;
  const st = await getSettings(env);
  const body = truncBytes(msgs.map((m) => (m.kind === 'call' ? '📞 不在着信' : m.image && !m.text ? '📷 写真' : m.text)).filter(Boolean).join('\n'), 1800);
  if (st.notifyVia !== 'bark') await pushPayload(env, { title: c.name, body, charId: c.id, badge: await totalUnread(env) });
  if (st.notifyVia !== 'web') await sendBark(env, st, { title: c.name, body, cid: c.id, group: c.name }).catch((e) => log(env, 'Bark通知: ' + e.message));
}
