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
//    ・Cron トリガー  * * * * *  （毎分。実際に動くのは13分おき）
// =====================================================================

const VERSION = '第8版（2026-10-14 22:10:00 更新・13分おきに起きる）';
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
      if (req.headers.get('X-App-Token') !== env.APP_TOKEN) throw new HttpError(401, '合言葉が違います');
      await ensureSchema(env);
      const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
      return await route(req.method + ' ' + url.pathname, url, body, env, ctx);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.status || 500);
    }
  },

  async scheduled(event, env, ctx) {
    // Cronの書き方では「13分ごと」をぴったり指定できないので、毎分呼ばれて13分おきのときだけ動く
    const minute = Math.floor(Number(event && event.scheduledTime) / 60000);
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
    uraMaxSplit: clamp(Math.round(num(c.uraMaxSplit, 5)), 1, 8),
    // タイムライン用
    affinity: clamp(Math.round(num(c.affinity, 60)), 0, 100),     // あなたとの仲の良さ
    snsActivity: clamp(Math.round(num(c.snsActivity, 50)), 0, 100), // SNSでの反応のしやすさ
    tlPerDay: clamp(num(c.tlPerDay, 2), 0, 12),                   // 表のTLに自分から投稿する回数（1日の目安）
    uraTlPerDay: clamp(num(c.uraTlPerDay, 1), 0, 12),             // 裏のTLに投稿する回数
  };
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
async function getChar(env, id) {
  const r = await env.DB.prepare(`SELECT ${CHAR_COLS} WHERE c.id=?`).bind(String(id || '')).first();
  if (!r) throw new HttpError(404, 'キャラが見つかりません');
  return rowToChar(r);
}
const rowToMsg = (r) => ({ id: r.id, charId: r.char_id, sender: r.sender, text: r.text, at: r.at });

async function recent(env, charId, n) {
  const { results } = await env.DB.prepare('SELECT id,char_id,sender,text,at FROM messages WHERE char_id=? ORDER BY id DESC LIMIT ?').bind(charId, n).all();
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
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages m LEFT JOIN reads r ON r.char_id=m.char_id WHERE m.sender='char' AND m.char_id NOT LIKE '%#ura' AND m.at > COALESCE(r.at,0)").first();
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
      const since = num(url.searchParams.get('since'), 0);
      const chars = await loadChars(env);
      let messages = [], more = false;
      if (since <= 0) {
        for (const c of chars) {
          messages.push(...(await recent(env, c.id, 200)));
          messages.push(...(await recent(env, c.id + URA, 200)));
        }
      } else {
        const { results } = await env.DB.prepare('SELECT id,char_id,sender,text,at FROM messages WHERE id>? ORDER BY id LIMIT 501').bind(since).all();
        more = results.length > 500;
        messages = results.slice(0, 500).map(rowToMsg);
      }
      const { results: rr } = await env.DB.prepare('SELECT char_id,at FROM reads').all();
      const reads = Object.fromEntries(rr.map((r) => [r.char_id, r.at]));
      return json({ chars, messages, more, reads, settings: await getSettings(env), now: Date.now(), version: VERSION });
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
      await env.DB.batch([
        env.DB.prepare('DELETE FROM chars WHERE id=?').bind(id),
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
      return json({ ok: true });
    }

    case 'POST /clear': { // 表・裏それぞれ別に消す（charId に #ura が付いていれば裏）
      const { base, key } = splitCid(body.charId);
      await getChar(env, base);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM messages WHERE char_id=?').bind(key),
        env.DB.prepare('DELETE FROM reads WHERE char_id=?').bind(key),
      ]);
      return json({ ok: true });
    }

    case 'POST /send': {
      const { base, key } = splitCid(body.charId);
      await getChar(env, base);
      const text = String(body.text || '').trim().slice(0, 4000);
      if (!text) throw new HttpError(400, 'メッセージが空です');
      const at = Date.now();
      const r = await env.DB.prepare('INSERT INTO messages (char_id,sender,text,at) VALUES (?,?,?,?)').bind(key, 'me', text, at).run();
      await setRead(env, key, at); // 返信する＝それまでの相手のメッセージは読んだ
      return json({ message: { id: r.meta.last_row_id, charId: key, sender: 'me', text, at } });
    }

    case 'POST /reply': {
      const { base, world, key } = splitCid(body.charId);
      const c = await getChar(env, base);
      const hist = await recent(env, key, 60);
      const last = hist[hist.length - 1];
      if (!last || last.sender !== 'me') return json({ messages: [] });
      const msgs = await generateAndStore(env, c, { mode: 'reply' }, hist, await getRead(env, key), world);
      return json({ messages: msgs });
    }

    case 'POST /read': {
      const { base, key } = splitCid(body.charId);
      await getChar(env, base);
      await setRead(env, key, Date.now());
      return json({ ok: true, badge: await totalUnread(env) });
    }

    case 'POST /poke': { // テスト用：今すぐ自分から話しかけさせる（表のみ）
      const c = await getChar(env, splitCid(body.charId).base);
      const hist = await recent(env, c.id, 60);
      const lastRead = await getRead(env, c.id);
      const d = decide(c, hist, lastRead, Date.now(), await getSettings(env), true) || { mode: 'topic' };
      const msgs = await generateAndStore(env, c, d, hist, lastRead);
      ctx.waitUntil(pushToAll(env, c, msgs).catch((e) => log(env, 'push: ' + e.message)));
      return json({ messages: msgs, mode: d.mode });
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
      if (!text) throw new HttpError(400, '投稿が空です');
      const at = Date.now();
      const r = await env.DB.prepare('INSERT INTO tl_posts (world,author,text,at,planned) VALUES (?,?,?,?,0)').bind(world, ME, text, at).run();
      const post = { id: r.meta.last_row_id, world, author: ME, text, at, planned: 0 };
      ctx.waitUntil(runTlJobs(env, 2).catch((e) => log(env, 'TL: ' + e.message))); // 誰がどう反応するかをすぐに決める
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
      const world = body.world === 'ura' ? 'ura' : 'omote';
      await deletePosts(env, 'world=?', [world]);
      return json({ ok: true });
    }

    case 'POST /tl/poke': { // テスト用：今すぐTLに投稿してもらう
      const world = body.world === 'ura' ? 'ura' : 'omote';
      const c = await getChar(env, splitCid(body.charId).base);
      const post = await charPostNow(env, c, world, await getSettings(env));
      ctx.waitUntil(runTlJobs(env, 2).catch((e) => log(env, 'TL: ' + e.message)));
      return json({ post });
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
function isQuiet(ts, s) {
  if (!quietSpan(s)) return false;
  const h = jstParts(ts).h;
  return s.quietStart < s.quietEnd ? h >= s.quietStart && h < s.quietEnd : h >= s.quietStart || h < s.quietEnd;
}

// 戻り値: null（送らない）または { mode, ... }
function decide(c, hist, lastRead, now, settings, force = false) {
  const last = hist[hist.length - 1];
  if (!force && last && last.sender === 'me') {
    return now - last.at > REPLY_WAIT ? { mode: 'reply' } : null; // アプリが閉じられて返信しそびれた分
  }
  if (!force) {
    if (c.perDay <= 0 || isQuiet(now, settings)) return null;
    if (last && now - last.at < 20 * 60 * 1000) return null; // 会話の直後は割り込まない
  }
  const activeTicks = Math.max(1, ((24 - quietSpan(settings)) * 60) / TICK_MIN);
  const p = c.perDay / activeTicks; // 1回のCronで話しかける確率
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
  const chars = await loadChars(env);
  const done = [];
  for (const c of chars) {
    try {
      const hist = await recent(env, c.id, 60);
      const lastRead = await getRead(env, c.id);
      const d = decide(c, hist, lastRead, now, settings);
      if (!d) continue;
      const msgs = await generateAndStore(env, c, d, hist, lastRead);
      if (msgs.length) await pushToAll(env, c, msgs);
      done.push(c.name + ':' + d.mode);
    } catch (e) {
      await log(env, `自動送信（${c.name}）: ${e.message}`);
    }
  }
  // タイムライン：キャラが自分からつぶやく（表・裏それぞれ）
  for (const c of chars) {
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
      return `ユーザーはあなたの最後のメッセージを読みましたが、返信がありません（既読スルー、${fmtDur(now - d.since)}経過）。` +
        'キャラクターらしく返信を催促してください。ただし直前の会話が自然に終わっていた場合（おやすみ・またね等）は、催促ではなく新しい話題で話しかけてください。';
    case 'topic':
    default:
      return `最後のやり取りから${fmtDur(now - (hist.length ? hist[hist.length - 1].at : now))}たっています。` +
        '直前の話題の催促はせず、キャラクターらしい別の新しい話題で話しかけてください（今していること、ふと思ったこと、時間帯や季節に合った話など）。' +
        (lastMe ? '' : '');
  }
}

function buildSystem(c, d, hist, now, tlInfo = '') {
  return `あなたは次のキャラクターになりきって、ユーザーとスマホのメッセージアプリ（LINEのようなチャット）でやり取りしています。

# キャラクター: ${c.name}
${c.prompt || '（設定なし）'}
${tlInfo}
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
${situation(d, hist, now)}

出力は {"messages": ["吹き出し1", "吹き出し2"]} の形のJSONのみ。`;
}

function buildContents(hist, world = 'omote') {
  const turns = [];
  for (const m of hist) {
    const role = m.sender === 'me' ? 'user' : 'model';
    // 裏は現実の時刻とは別の時間軸なので時刻は付けない。ナレーションは「＊」付きで渡す
    const line = world === 'ura' ? (m.sender === 'narr' ? '＊' + m.text : m.text) : `[${fmtTime(m.at)}] ${m.text}`;
    const t = turns[turns.length - 1];
    if (t && t.role === role) t.parts[0].text += '\n' + line;
    else turns.push({ role, parts: [{ text: line }] });
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
  const narr = c.uraNarration
    ? `- 情景・キャラクターの動作・表情・しぐさなどの描写（ナレーション）は、先頭に「＊」を付けた別の吹き出しとして書く。三人称・現在形で、1〜3文程度の短さにする。
- セリフの吹き出しには描写や（ ）書きを混ぜず、キャラクターが口にする言葉だけを書く。
- ナレーションは場面が伝わるときに挟む程度でよい。毎回入れなくてよい。`
    : '- ナレーションや地の文、（ ）での動作描写は書かず、キャラクターのセリフだけで表現する。';
  return `あなたは次のキャラクターになりきって、ユーザーと「実際に同じ場所で会っている場面」のロールプレイをしています。
これはスマホのメッセージアプリ（SNS）でのやり取りとは完全に別の時間軸・別の世界線の出来事です。SNSでの会話の内容は知らないものとして振る舞ってください。

# キャラクター: ${c.uraName || c.name}${alias}
${own ? c.uraCharPrompt : (c.prompt || '（設定なし）')}
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

async function callGrok(env, model, system, contents, maxSplit) {
  return parseMessages(await grokText(env, model, system, contents, MSG_SCHEMA, 'chat_reply'), maxSplit, 'Grok');
}

// Grok に送って、返答の文字列（JSON）をそのまま返す
async function grokText(env, model, system, contents, schema, schemaName) {
  if (!env.XAI_API_KEY) throw new Error('シークレット XAI_API_KEY が設定されていません');
  const messages = [{ role: 'system', content: system }].concat(
    contents.map((t) => ({ role: t.role === 'model' ? 'assistant' : 'user', content: t.parts.map((p) => p.text).join('\n') })));
  const schemaFormat = { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } };
  let format = schemaFormat, data, lastErr;
  // 考えるモデル（grok-4.7 など）は、チャットの返事が遅くならないよう思考を軽めにする
  let effort = /^grok-4\.[5-9]|^grok-[5-9]/.test(model) ? 'low' : null;
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
    if (![429, 500, 502, 503, 504].includes(r.status)) throw new Error(lastErr);
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    data = null;
  }
  if (!data) throw new Error(lastErr);
  const ch = data.choices && data.choices[0];
  const text = ch && ch.message && typeof ch.message.content === 'string' ? ch.message.content : '';
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
  const st = await getSettings(env);
  const contents = [{ role: 'user', parts: [{ text: userText }] }];
  if (providerFor(st, world) === 'grok') {
    return parseJsonLoose(await grokText(env, grokModelFor(env, st), system, contents, schema, schemaName), 'Grok');
  }
  return parseJsonLoose(await geminiText(env, system, contents, toGeminiSchema(schema)), 'Gemini');
}

// ---------------------------------------------------------------- 使うAIを選んで呼ぶ
async function callAI(env, world, system, contents, maxSplit) {
  const st = await getSettings(env);
  if (providerFor(st, world) === 'grok') return callGrok(env, grokModelFor(env, st), system, contents, maxSplit);
  return callGemini(env, system, contents, maxSplit);
}

async function callGemini(env, system, contents, maxSplit) {
  return parseMessages(await geminiText(env, system, contents, toGeminiSchema(MSG_SCHEMA)), maxSplit, 'Gemini');
}

// Gemini に送って、返答の文字列（JSON）をそのまま返す
async function geminiText(env, system, contents, responseSchema) {
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
  let data, lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(req),
    });
    data = await r.json().catch(() => null);
    if (r.ok) break;
    lastErr = `Gemini ${r.status}: ${(data && data.error && data.error.message) || '不明なエラー'}`;
    if (![429, 500, 502, 503, 504].includes(r.status)) throw new Error(lastErr);
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    data = null;
  }
  if (!data) throw new Error(lastErr);
  const cand = data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const text = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  if (!text) throw new Error('Geminiの返答が空でした（' + ((cand && cand.finishReason) || (data.promptFeedback && data.promptFeedback.blockReason) || '理由不明') + '）');
  return text;
}

async function generateAndStore(env, c, d, hist, lastRead, world = 'omote') {
  const now = Date.now();
  const ura = world === 'ura';
  const key = ura ? c.id + URA : c.id;
  // 同じ世界のタイムラインでの出来事も伝える（トークとTLはつながっている）
  const tlInfo = await tlContextForTalk(env, c, world).catch(() => '');
  const texts = ura
    ? (await callAI(env, 'ura', buildUraSystem(c, tlInfo), buildContents(hist, 'ura'), c.uraMaxSplit + 4))
        .flatMap((t) => t.split(/\n(?=\s*[＊*])/)) // ナレーションとセリフが1つにまとまっていたら分ける
    : await callAI(env, 'omote', buildSystem(c, d, hist, now, tlInfo), buildContents(hist), c.maxSplit);
  // 裏では「＊」で始まる吹き出しをナレーションとして保存する
  const items = texts.map((t) => {
    const m = ura && t.match(/^\s*[＊*]+\s*([\s\S]*)$/);
    return m ? { sender: 'narr', text: m[1].trim() } : { sender: 'char', text: ura ? t.replace(/^「([\s\S]*)」$/, '$1') : t };
  }).filter((x) => x.text);
  if (!items.length) throw new Error('返答が空でした');
  const t0 = Date.now();
  const res = await env.DB.batch(items.map((x, i) =>
    env.DB.prepare('INSERT INTO messages (char_id,sender,text,at) VALUES (?,?,?,?)').bind(key, x.sender, x.text, t0 + i)));
  return items.map((x, i) => ({ id: res[i].meta.last_row_id, charId: key, sender: x.sender, text: x.text, at: t0 + i }));
}

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
  return p.length > max ? p.slice(0, max) + '…' : p;
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
  const { results: posts } = await env.DB.prepare('SELECT id,world,author,text,at FROM tl_posts WHERE world=? ORDER BY id DESC LIMIT ?').bind(world, limit).all();
  if (!posts.length) return [];
  const ids = posts.map((p) => p.id);
  const qs = ids.map(() => '?').join(',');
  const { results: cs } = await env.DB.prepare(`SELECT id,post_id,author,text,reply_to,at FROM tl_comments WHERE post_id IN (${qs}) ORDER BY id`).bind(...ids).all();
  const { results: ls } = await env.DB.prepare(`SELECT post_id,author,at FROM tl_likes WHERE post_id IN (${qs}) ORDER BY at`).bind(...ids).all();
  return posts.map((p) => ({
    ...p,
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
function deferQuiet(due, st, world) {
  if (world !== 'omote' || !isQuiet(due, st)) return due;
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
  const { results: mine } = await env.DB.prepare("SELECT id,text,at FROM tl_posts WHERE world=? AND author='me' AND at>? ORDER BY id DESC LIMIT 4").bind(world, now - 48 * 3600e3).all();
  const { results: own } = await env.DB.prepare('SELECT id,text,at FROM tl_posts WHERE world=? AND author=? ORDER BY id DESC LIMIT 2').bind(world, c.id).all();
  if (!mine.length && !own.length) return '';
  const lines = [];
  for (const p of mine) {
    const liked = await env.DB.prepare('SELECT 1 FROM tl_likes WHERE post_id=? AND author=?').bind(p.id, c.id).first();
    const cm = await env.DB.prepare('SELECT text FROM tl_comments WHERE post_id=? AND author=? ORDER BY id DESC LIMIT 1').bind(p.id, c.id).first();
    lines.push(`- ユーザーの投稿${ura ? '' : `（${fmtDur(now - p.at)}前）`}「${trunc(p.text, 100)}」→ あなたは${liked ? 'いいね済み' : 'いいねしていない'}${cm ? `・コメント「${trunc(cm.text, 60)}」` : ''}`);
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
本文: ${post.text}
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
  const r = await aiJson(env, world, system, user, SCORE_SCHEMA, 'tl_scores');
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
  const chars = await loadChars(env);
  const author = post.author === ME ? null : chars.find((c) => c.id === post.author);
  if (post.author !== ME && !author) return [];
  const cands = chars.filter((c) => c.id !== post.author);
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
    if (doLike) plan.push({ c, kind: 'like', due: deferQuiet(now + reactDelay(x, false), st, world), x });
    if (doComment) plan.push({ c, kind: 'comment', due: deferQuiet(now + reactDelay(x, true), st, world), note, x });
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
  if (!c) return;
  const { results: all } = await env.DB.prepare('SELECT id,author,reply_to FROM tl_comments WHERE post_id=?').bind(post.id).all();
  const root = threadRoot(all, comment.id);
  const charReplies = all.filter((x) => x.author === c.id && x.reply_to && threadRoot(all, x.id) === root).length;
  if (charReplies >= 3) return; // やり取りは3往復まで
  const aff = nz(c.affinity, 60) / 100, act = nz(c.snsActivity, 50) / 100;
  const p = clamp((replyTo ? 0.55 : 0.45) + 0.35 * aff + 0.15 * act, 0, 0.98);
  if (Math.random() >= p) return;
  const x = clamp(0.4 + 0.6 * aff + (Math.random() - 0.5) * 0.2, 0, 1);
  const due = deferQuiet(Date.now() + reactDelay(x, true), st, post.world);
  await env.DB.prepare('INSERT INTO tl_jobs (world,char_id,kind,post_id,comment_id,due,note) VALUES (?,?,?,?,?,?,?)')
    .bind(post.world, c.id, 'reply', post.id, comment.id, due, '').run();
}

// ---- 文章を作る
function snsRules(world, now) {
  return `- キャラクターの口調・性格・相手との関係をそのまま出す。
- 地の文・ト書き・（ ）での動作描写は書かない。
- 自分がAIであることには触れない。
- 公開のSNSなので、性的に露骨な内容や、相手との個人的なやり取りをそのまま書き写すことはしない（ほのめかす程度はよい）。
${world === 'ura' ? '- この世界は表（メッセージアプリの世界）とは別の時間軸。表での出来事は知らない。' : `- 現在日時: ${fmtTime(now)}`}`;
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
本文: ${post.text}

# これまでのコメント
${cms.length ? cms.map((x) => `${nameOf(x.author)}${x.reply_to ? '（返信）' : ''}: ${trunc(x.text, 150)}`).join('\n') : '（まだなし）'}
${replyTo ? `\n# あなたが返信するコメント\n${nameOf(replyTo.author)}: ${replyTo.text}\n` : ''}
# あなたとユーザーの${world === 'ura' ? '最近の様子（実際に会ったとき）' : 'トークでのやり取り'}
${await talkContext(env, c, world)}
${note ? `\n# 反応の方向性\n${note}\n` : ''}
${replyTo ? 'このコメントへの返信を書いてください。' : 'この投稿へのコメントを書いてください。'}`;
  const r = await aiJson(env, world, system, user, TEXT_SCHEMA, 'tl_comment');
  const text = String((r && r.text) || '').trim();
  if (!text) throw new Error('コメントが空でした');
  return text.slice(0, 500);
}

async function genPost(env, c, world) {
  const now = Date.now();
  const st = await getSettings(env);
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

出力は {"text": "投稿本文"} の形のJSONのみ。`;
  const user = `# 世界
${worldDesc(world)}

# あなたの最近の投稿（重ならないように）
${own.length ? own.map((p) => '- ' + trunc(p.text, 100)).join('\n') : '（まだなし）'}

# タイムラインに流れている最近の投稿
${others.length ? others.map((p) => `- ${nameOf(p.author)}: ${trunc(p.text, 100)}`).join('\n') : '（まだなし）'}

# あなたとユーザーの${world === 'ura' ? '最近の様子（実際に会ったとき）' : 'トークでのやり取り'}
${await talkContext(env, c, world)}

この世界のSNSに、新しい投稿を1つ書いてください。`;
  const r = await aiJson(env, world, system, user, TEXT_SCHEMA, 'tl_post');
  const text = String((r && r.text) || '').trim();
  if (!text) throw new Error('投稿が空でした');
  return text.slice(0, 500);
}

// ---- キャラが自分からつぶやくか（15分ごと）
async function shouldCharPost(env, c, world, now, st) {
  const perDay = nz(world === 'ura' ? c.uraTlPerDay : c.tlPerDay, world === 'ura' ? 1 : 2);
  if (perDay <= 0 || isQuiet(now, st)) return false;
  const last = await env.DB.prepare('SELECT at FROM tl_posts WHERE world=? AND author=? ORDER BY id DESC LIMIT 1').bind(world, c.id).first();
  if (last && now - last.at < 60 * MIN) return false; // 続けて投稿しすぎない
  const activeTicks = Math.max(1, ((24 - quietSpan(st)) * 60) / TICK_MIN);
  return Math.random() < perDay / activeTicks;
}

async function charPostNow(env, c, world, st) {
  const text = await genPost(env, c, world);
  const at = Date.now();
  const r = await env.DB.prepare('INSERT INTO tl_posts (world,author,text,at,planned) VALUES (?,?,?,?,0)').bind(world, c.id, text, at).run();
  const post = { id: r.meta.last_row_id, world, author: c.id, text, at, planned: 0 };
  await pushTL(env, st, world, 'tlCharPost', { title: cName(c, world), body: text, post });
  return { ...post, likes: [], comments: [] };
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
  const { results: due } = await env.DB.prepare('SELECT * FROM tl_jobs WHERE due<=? ORDER BY due LIMIT ?').bind(Date.now(), limit).all();
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
    if (post.author === ME) await pushTL(env, st, world, 'tlLike', { title: `${who}さんがいいねしました`, body: trunc(post.text, 80), post, tag: 'like-' + post.id });
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
    await pushTL(env, st, world, 'tlReply', { title: `${who}さんが返信しました`, body: text, post });
  } else if (post.author === ME) {
    await pushTL(env, st, world, 'tlComment', { title: `${who}さんがコメントしました`, body: text, post });
  }

  // キャラ同士：キャラの投稿にほかのキャラがコメントしたら、投稿したキャラが1回だけ返すことがある
  if (!replyTo && post.author !== ME && post.author !== c.id) {
    const author = (await loadChars(env)).find((x) => x.id === post.author);
    if (author && Math.random() < clamp(0.2 + 0.45 * (nz(author.snsActivity, 50) / 100), 0, 0.8)) {
      const due = deferQuiet(Date.now() + reactDelay(0.5, true), st, world);
      await env.DB.prepare('INSERT INTO tl_jobs (world,char_id,kind,post_id,comment_id,due,note) VALUES (?,?,?,?,?,?,?)')
        .bind(world, author.id, 'reply', post.id, commentId, due, '').run();
    }
  }
  return true;
}

// ---- 通知（表のTLだけ。4項目それぞれオン／オフ）
async function pushTL(env, st, world, flag, { title, body, post, tag }) {
  if (world !== 'omote') return;              // 裏は通知しない
  if (!st.notify || !st.notify[flag]) return; // 設定でオフ
  try {
    await pushPayload(env, {
      title, body: truncBytes(body, 1500), tl: 'omote', postId: post.id,
      tag: 'tl-' + (tag || post.id + '-' + Date.now()), badge: await totalUnread(env),
    });
  } catch (e) { await log(env, 'TL通知: ' + e.message); }
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
  await pushPayload(env, {
    title: c.name,
    body: truncBytes(msgs.map((m) => m.text).join('\n'), 1800),
    charId: c.id,
    badge: await totalUnread(env),
  });
}
