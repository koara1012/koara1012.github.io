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
//    ・Cron トリガー  */15 * * * *  （15分おき）
// =====================================================================

const VERSION = '第6版（2026-10-14 18:10:00 更新・裏のプロンプトを別に設定）';
const DEFAULT_MODEL = 'gemini-flash-latest';
const DEFAULT_GROK_MODEL = 'grok-4-fast-non-reasoning';
const JST = 9 * 3600 * 1000;
const TICK_MIN = 15;              // Cronの間隔（分）
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

const DEFAULT_SETTINGS = { quietEnabled: true, quietStart: 1, quietEnd: 7, omoteProvider: 'gemini', uraProvider: 'grok', grokModel: '' };
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
    // 裏（実際に会う場面）用
    uraName: String(c.uraName || '').trim().slice(0, 40),       // 裏での名前（空なら表と同じ）
    uraCharPrompt: String(c.uraCharPrompt || '').slice(0, 20000), // 裏のキャラ設定（空なら表と同じ prompt を使う）
    uraPrompt: String(c.uraPrompt || '').slice(0, 20000),    // 裏だけの追加設定（関係性など）
    uraScene: String(c.uraScene || '').slice(0, 2000),       // いまの場面
    uraNarration: c.uraNarration !== false,                  // ナレーションを入れるか
    uraMaxSplit: clamp(Math.round(num(c.uraMaxSplit, 5)), 1, 8),
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
      const omote = ids.filter((i) => !i.endsWith(URA)), ura = ids.filter((i) => i.endsWith(URA)).map((i) => i.slice(0, -URA.length));
      const icons = {};
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
function buildUraSystem(c) {
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
async function callAI(env, world, system, contents, maxSplit) {
  const st = await getSettings(env);
  if (providerFor(st, world) === 'grok') return callGrok(env, grokModelFor(env, st), system, contents, maxSplit);
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

async function generateAndStore(env, c, d, hist, lastRead, world = 'omote') {
  const now = Date.now();
  const ura = world === 'ura';
  const key = ura ? c.id + URA : c.id;
  const texts = ura
    ? (await callAI(env, 'ura', buildUraSystem(c), buildContents(hist, 'ura'), c.uraMaxSplit + 4))
        .flatMap((t) => t.split(/\n(?=\s*[＊*])/)) // ナレーションとセリフが1つにまとまっていたら分ける
    : await callAI(env, 'omote', buildSystem(c, d, hist, now), buildContents(hist), c.maxSplit);
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
