// =====================================================================
//  キャラチャット サーバー（Cloudflare Workers）
//  必要な設定（Cloudflareの画面で設定）:
//    ・D1データベース を「DB」という名前で結び付ける
//    ・シークレット GEMINI_API_KEY … GeminiのAPIキー
//    ・シークレット APP_TOKEN      … アプリとサーバーの合言葉（自分で決めた文字列）
//    ・（任意）変数 GEMINI_MODEL   … 使うモデル名。未設定なら gemini-flash-latest
//    ・（Grokを使うとき）シークレット XAI_API_KEY … xAI（Grok）のAPIキー
//    ・（任意）変数 XAI_MODEL      … Grokのモデル名。アプリの設定画面で指定したものが優先
//    ※ Gemini / Grok の切り替えはアプリの設定画面から（会話履歴はどちらでもそのまま使われる）
//    ・Cron トリガー  */15 * * * *  （15分おき）
// =====================================================================

const VERSION = '第3版（2026-10-14 17:05:00 更新・Gemini/Grok切り替え）';
const DEFAULT_MODEL = 'gemini-flash-latest';
const DEFAULT_GROK_MODEL = 'grok-4-fast-non-reasoning';
const JST = 9 * 3600 * 1000;
const TICK_MIN = 15;              // Cronの間隔（分）
const MAX_UNREAD = 8;             // 未読がこれ以上たまったら送らない
const REPLY_WAIT = 90 * 1000;     // ユーザーの送信後、アプリが返信を取りに来なかった場合にサーバーが代わりに返すまでの時間

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

const DEFAULT_SETTINGS = { quietEnabled: true, quietStart: 1, quietEnd: 7, provider: 'gemini', grokModel: '' };
async function getSettings(env) {
  return { ...DEFAULT_SETTINGS, ...(await kvGet(env, 'settings', {})) };
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
  };
}

async function loadChars(env) {
  const { results } = await env.DB.prepare('SELECT id,data,icon_ver,created FROM chars ORDER BY created').all();
  return results.map((r) => ({ ...JSON.parse(r.data), id: r.id, iconVer: r.icon_ver || 0, created: r.created }));
}
async function getChar(env, id) {
  const r = await env.DB.prepare('SELECT id,data,icon_ver,created FROM chars WHERE id=?').bind(String(id || '')).first();
  if (!r) throw new HttpError(404, 'キャラが見つかりません');
  return { ...JSON.parse(r.data), id: r.id, iconVer: r.icon_ver || 0, created: r.created };
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
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages m LEFT JOIN reads r ON r.char_id=m.char_id WHERE m.sender='char' AND m.at > COALESCE(r.at,0)").first();
  return r ? r.n : 0;
}

// ---------------------------------------------------------------- ルート
async function route(key, url, body, env, ctx) {
  switch (key) {
    case 'GET /ping': {
      const subs = await env.DB.prepare('SELECT COUNT(*) AS n FROM subs').first();
      const st = await getSettings(env);
      return json({
        ok: true, version: VERSION, provider: st.provider, model: modelFor(env, st),
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
        for (const c of chars) messages.push(...(await recent(env, c.id, 200)));
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
      const { results } = await env.DB.prepare(`SELECT id,icon,icon_ver FROM chars WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
      return json({ icons: Object.fromEntries(results.map((r) => [r.id, { ver: r.icon_ver || 0, data: r.icon || null }])) });
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
      return json({ char: await getChar(env, c.id) });
    }

    case 'DELETE /char': {
      const id = url.searchParams.get('id') || '';
      await env.DB.batch([
        env.DB.prepare('DELETE FROM chars WHERE id=?').bind(id),
        env.DB.prepare('DELETE FROM messages WHERE char_id=?').bind(id),
        env.DB.prepare('DELETE FROM reads WHERE char_id=?').bind(id),
      ]);
      return json({ ok: true });
    }

    case 'POST /clear': {
      const c = await getChar(env, body.charId);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM messages WHERE char_id=?').bind(c.id),
        env.DB.prepare('DELETE FROM reads WHERE char_id=?').bind(c.id),
      ]);
      return json({ ok: true });
    }

    case 'POST /send': {
      const c = await getChar(env, body.charId);
      const text = String(body.text || '').trim().slice(0, 4000);
      if (!text) throw new HttpError(400, 'メッセージが空です');
      const at = Date.now();
      const r = await env.DB.prepare('INSERT INTO messages (char_id,sender,text,at) VALUES (?,?,?,?)').bind(c.id, 'me', text, at).run();
      await setRead(env, c.id, at); // 返信する＝それまでの相手のメッセージは読んだ
      return json({ message: { id: r.meta.last_row_id, charId: c.id, sender: 'me', text, at } });
    }

    case 'POST /reply': {
      const c = await getChar(env, body.charId);
      const hist = await recent(env, c.id, 60);
      const last = hist[hist.length - 1];
      if (!last || last.sender !== 'me') return json({ messages: [] });
      const msgs = await generateAndStore(env, c, { mode: 'reply' }, hist, await getRead(env, c.id));
      return json({ messages: msgs });
    }

    case 'POST /read': {
      const c = await getChar(env, body.charId);
      await setRead(env, c.id, Date.now());
      return json({ ok: true, badge: await totalUnread(env) });
    }

    case 'POST /poke': { // テスト用：今すぐ自分から話しかけさせる
      const c = await getChar(env, body.charId);
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
      if ('provider' in s) v.provider = s.provider === 'grok' ? 'grok' : 'gemini';
      if ('grokModel' in s) v.grokModel = String(s.grokModel || '').trim().slice(0, 80);
      await kvSet(env, 'settings', v);
      return json({ settings: v });
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

function buildSystem(c, d, hist, now) {
  return `あなたは次のキャラクターになりきって、ユーザーとスマホのメッセージアプリ（LINEのようなチャット）でやり取りしています。

# キャラクター: ${c.name}
${c.prompt || '（設定なし）'}

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

function buildContents(hist) {
  const turns = [];
  for (const m of hist) {
    const role = m.sender === 'me' ? 'user' : 'model';
    const line = `[${fmtTime(m.at)}] ${m.text}`;
    const t = turns[turns.length - 1];
    if (t && t.role === role) t.parts[0].text += '\n' + line;
    else turns.push({ role, parts: [{ text: line }] });
  }
  if (turns.length && turns[0].role === 'model') turns.unshift({ role: 'user', parts: [{ text: '（会話の始まり）' }] });
  if (!turns.length || turns[turns.length - 1].role === 'model') {
    turns.push({ role: 'user', parts: [{ text: '（ユーザーからの新しいメッセージはありません。「今の状況」に沿って、あなたから送るメッセージを作ってください）' }] });
  }
  return turns;
}

function modelFor(env, st) {
  return st.provider === 'grok' ? grokModelFor(env, st) : (env.GEMINI_MODEL || DEFAULT_MODEL);
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
async function callGrok(env, model, system, contents, maxSplit) {
  if (!env.XAI_API_KEY) throw new Error('シークレット XAI_API_KEY が設定されていません');
  const messages = [{ role: 'system', content: system }].concat(
    contents.map((t) => ({ role: t.role === 'model' ? 'assistant' : 'user', content: t.parts.map((p) => p.text).join('\n') })));
  const schemaFormat = {
    type: 'json_schema',
    json_schema: {
      name: 'chat_reply', strict: true,
      schema: { type: 'object', properties: { messages: { type: 'array', items: { type: 'string' } } }, required: ['messages'], additionalProperties: false },
    },
  };
  let format = schemaFormat, data, lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.XAI_API_KEY },
      body: JSON.stringify({ model, messages, temperature: 1.0, response_format: format }),
    });
    data = await r.json().catch(() => null);
    if (r.ok) break;
    const msg = (data && ((data.error && (data.error.message || data.error)) || data.message)) || '不明なエラー';
    lastErr = `Grok ${r.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
    // 構造化出力に対応していないモデルなら、JSON指定をゆるめて再試行
    if (r.status === 400 && format === schemaFormat && /response_format|json_schema|schema/i.test(lastErr)) { format = { type: 'json_object' }; data = null; continue; }
    if (![429, 500, 502, 503, 504].includes(r.status)) throw new Error(lastErr);
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    data = null;
  }
  if (!data) throw new Error(lastErr);
  const ch = data.choices && data.choices[0];
  const text = ch && ch.message && typeof ch.message.content === 'string' ? ch.message.content : '';
  if (!text) throw new Error('Grokの返答が空でした（' + ((ch && ch.finish_reason) || '理由不明') + '）');
  return parseMessages(text, maxSplit, 'Grok');
}

// ---------------------------------------------------------------- 使うAIを選んで呼ぶ
async function callAI(env, system, contents, maxSplit) {
  const st = await getSettings(env);
  if (st.provider === 'grok') return callGrok(env, grokModelFor(env, st), system, contents, maxSplit);
  return callGemini(env, system, contents, maxSplit);
}

async function callGemini(env, system, contents, maxSplit) {
  if (!env.GEMINI_API_KEY) throw new Error('シークレット GEMINI_API_KEY が設定されていません');
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const req = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      temperature: 1.0,
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { messages: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['messages'] },
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
  return parseMessages(text, maxSplit, 'Gemini');
}

async function generateAndStore(env, c, d, hist, lastRead) {
  const now = Date.now();
  const texts = await callAI(env, buildSystem(c, d, hist, now), buildContents(hist), c.maxSplit);
  const t0 = Date.now();
  const res = await env.DB.batch(texts.map((t, i) =>
    env.DB.prepare('INSERT INTO messages (char_id,sender,text,at) VALUES (?,?,?,?)').bind(c.id, 'char', t, t0 + i)));
  return texts.map((t, i) => ({ id: res[i].meta.last_row_id, charId: c.id, sender: 'char', text: t, at: t0 + i }));
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
