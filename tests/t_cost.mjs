import W, * as X from './worker.mjs';
import { makeDB } from './fake.mjs';
const DB = makeDB();
const env = { DB, APP_TOKEN: 'pw', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' };
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
const call = async (m, p, b) => { const r = await W.fetch(new Request('https://w' + p, { method: m, headers: { 'X-App-Token': 'pw' }, body: b ? JSON.stringify(b) : undefined }), env, ctx); if (p.startsWith('/img')) return r; const d = await r.json(); if (!r.ok) throw new Error(p + ' ' + JSON.stringify(d)); return d; };
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
const calls = []; let answer = {}; let imgCalls = 0;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
globalThis.fetch = async (u, i) => {
  u = String(u);
  if (u.startsWith('https://api.open-meteo.com/')) return new Response(JSON.stringify({ current: { temperature_2m: 18.2, weather_code: 61 }, daily: { weather_code: [63, 3], temperature_2m_max: [20, 22], temperature_2m_min: [14, 15], precipitation_probability_max: [80, 20] } }));
  if (u.startsWith('https://news.google.com/')) return new Response('<rss></rss>');
  if (u.includes('-image')) { imgCalls++; const b = JSON.parse(i.body); calls.push({ image: true, prompt: b.contents[0].parts.map(p => p.text || '[img]').join('|') }); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }] } }] })); }
  const body = JSON.parse(i.body); const grok = u.includes('x.ai');
  const sys = grok ? body.messages[0].content : body.systemInstruction.parts[0].text;
  const parts = grok ? body.messages.slice(1) : body.contents;
  const user = grok ? parts.map(m => typeof m.content === 'string' ? m.content : m.content.map(c => c.text || '[IMG]').join('|')).join('\n') : parts.map(c => c.parts.map(p => p.text || '[IMG]').join('|')).join('\n');
  const sch = JSON.stringify(grok ? body.response_format : body.generationConfig.responseSchema);
  calls.push({ sys, user, sch });
  let out;
  if (sch.includes('affinity_delta')) out = answer.extract || { new: [], done: [], user_state: '', affinity_delta: 0, birthday: '' };
  else if (sch.includes('story_finished')) out = answer.daily || { mood: 'ご機嫌', mood_reason: '晴れたから', today: 'ブリヌイを焼く', diary: '本を読んだ', story_title: '', story_update: '', story_finished: false, busy: 20 };
  else if (sch.includes('"score"')) out = { score: answer.jealous ?? 90 };
  else if (sch.includes('keywords')) out = { keywords: ['料理'] };
  else if (sch.includes('scores')) out = { scores: [] };
  else if (sch.includes('"text"')) out = { text: 'つぶやき' };
  else { out = { messages: answer.msgs || ['返事'] }; for (const k of ['used_news', 'retract']) if (sch.includes(k)) out[k] = answer[k] ?? -1; for (const k of ['photo', 'photo_edit']) if (sch.includes(k)) out[k] = answer[k] ?? ''; }
  const t = JSON.stringify(out);
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: t } }] } : { candidates: [{ content: { parts: [{ text: t }] } }] }));
};
const lastAI = () => calls.filter(c => !c.image && c.sch && c.sch.includes('messages')).pop();
// wrap fake AI to add usage numbers
const F1 = globalThis.fetch;
globalThis.fetch = async (u, i) => {
  const r = await F1(u, i); u = String(u);
  if (u.includes('generativelanguage') && !u.includes('-image')) { const j = await r.json(); j.usageMetadata = { promptTokenCount: 10000, candidatesTokenCount: 500, thoughtsTokenCount: 500, cachedContentTokenCount: 0 }; j.modelVersion = 'gemini-2.5-flash'; return new Response(JSON.stringify(j)); }
  if (u.includes('x.ai')) { const j = await r.json(); j.usage = { prompt_tokens: 20000, completion_tokens: 1000, total_tokens: 21500, completion_tokens_details: { reasoning_tokens: 500 } }; j.model = 'grok-4.7'; return new Response(JSON.stringify(j)); }
  return r;
};
await call('POST', '/settings', { settings: { delayEnabled: false, quietEnabled: false } });
const c = (await call('POST', '/char', { char: { name: 'シャロ', prompt: 'p' } })).char;
DB.raw.prepare('DELETE FROM ai_cost').run();
await call('POST', '/send', { charId: c.id, text: 'やあ' });
const R = Math.random; Math.random = () => 0.99; await call('POST', '/reply', { charId: c.id }); Math.random = R;
let s = (await call('GET', '/sync?since=0')).cost;
const gem = (10000 * 0.30 + 1000 * 2.50) / 1e6;
console.log('  表:', s.omote, 'expected per call', gem);
ok(s.omote.calls >= 1 && Math.abs(s.omote.month - gem * s.omote.calls) < 1e-9, '表 uses Gemini 2.5 Flash price incl. thinking');
await call('POST', '/send', { charId: c.id + '#ura', text: 'やあ' }); await call('POST', '/reply', { charId: c.id + '#ura' });
s = (await call('GET', '/sync?since=0')).cost;
const grk = (20000 * 2.0 + 1500 * 6.0) / 1e6;
console.log('  裏:', s.ura, 'expected', grk);
ok(s.ura.calls === 1 && Math.abs(s.ura.month - grk) < 1e-9, '裏 uses Grok 4.7 price incl. reasoning');
await X.recordCost(env, 'omote', 'gemini', 'gemini-2.5-flash-image', 0, 0, 0, 1);
s = (await call('GET', '/sync?since=0')).cost;
ok(s.omote.images === 1, 'image counted');
await call('POST', '/settings', { settings: { cost: { grokIn: 1, grokOut: 2, image: '' }, yen: 140 } });
const st = (await call('GET', '/sync?since=0')).settings;
ok(st.yen === 140 && st.cost.grokIn === 1 && !('image' in st.cost), 'price overrides saved');
ok(X.priceFor('grok', 'grok-4.7', st).pOut === 2 && X.priceFor('gemini', 'gemini-3-flash', st).pIn === 0.5, 'priceFor respects overrides/auto');

// ---- stagger: 3 chars all decide in one tick
const c2 = (await call('POST', '/char', { char: { name: 'レイ', prompt: 'q', perDay: 24 } })).char;
const c3 = (await call('POST', '/char', { char: { name: '朱里', prompt: 'r', perDay: 24 } })).char;
for (const cc of [c, c2, c3]) { await call('POST', '/char', { char: { ...cc, perDay: 24 } }); }
DB.raw.prepare('DELETE FROM messages').run();
const old = Date.now() - 3 * 3600e3;
for (const cc of [c, c2, c3]) { DB.raw.prepare("INSERT INTO messages (char_id,sender,text,at) VALUES (?,?,?,?)").run(cc.id, 'char', 'hi', old); DB.raw.prepare("INSERT INTO messages (char_id,sender,text,at) VALUES (?,?,?,?)").run(cc.id, 'me', 'yo', old + 1000); DB.raw.prepare("INSERT INTO messages (char_id,sender,text,at) VALUES (?,?,?,?)").run(cc.id, 'char', 'ok', old + 2000); await call('POST', '/read', { charId: cc.id }); }
await call('POST', '/settings', { settings: { lifeEnabled: false } });
Math.random = () => 0.001;
// 見回りはキャラごとに13分の中でずらしてある（第36版）：13分ぶん回すと全員1回ずつ、別々の分に判定される
const base = Math.floor(Date.now() / 60000 / 13) * 13 * 60000, perMin = [];
for (let m = 0; m < 13; m++) {
  const w = []; await W.scheduled({ scheduledTime: base + m * 60000 }, env, { waitUntil: (x) => w.push(x) }); await Promise.all(w);
  perMin.push(DB.raw.prepare("SELECT count(*) n FROM kv WHERE k LIKE 'proj:%'").get().n);
}
Math.random = R;
ok(perMin.every((n, i) => n - (i ? perMin[i - 1] : 0) <= 1), 'each character judged in its own minute: ' + perMin.join(','));
const proj = DB.raw.prepare("SELECT k,v FROM kv WHERE k LIKE 'proj:%'").all().map(r => JSON.parse(r.v)).sort((a, b) => a.due - b.due);
console.log('  scheduled offsets (min):', proj.map(p => ((p.due - Date.now()) / 60000).toFixed(1)));
ok(proj.length === 3, 'all three scheduled instead of sent at once');
ok(proj.every((p, i) => i === 0 || p.due - proj[i - 1].due >= 4 * 60e3 - 1000), 'at least 4 minutes apart');
const before = DB.raw.prepare("SELECT count(*) n FROM messages WHERE sender='char'").get().n;
// first slot due → exactly one char sends
const RN = Date.now; Date.now = () => proj[0].due + 1000;
await X.runDueProactive(env);
let after = DB.raw.prepare("SELECT count(*) n FROM messages WHERE sender='char'").get().n;
ok(after > before && DB.raw.prepare("SELECT count(*) n FROM kv WHERE k LIKE 'proj:%'").get().n === 2, 'first slot: one character sends');
// user writes to 3rd char before its slot → cancelled
const third = proj[2]; const cid3 = DB.raw.prepare("SELECT k FROM kv WHERE k LIKE 'proj:%'").all().map(r => r.k.slice(5)).find(id => JSON.parse(DB.raw.prepare('SELECT v FROM kv WHERE k=?').get('proj:' + id).v).due === third.due);
DB.raw.prepare("INSERT INTO messages (char_id,sender,text,at) VALUES (?,?,?,?)").run(cid3, 'me', 'さきに話しかける', proj[0].due + 2000);
Date.now = () => third.due + 1000;
const b2 = DB.raw.prepare("SELECT count(*) n FROM messages WHERE sender='char' AND char_id=?").get(cid3).n;
await X.runDueProactive(env);
ok(DB.raw.prepare("SELECT count(*) n FROM messages WHERE sender='char' AND char_id=?").get(cid3).n === b2, 'cancelled when user started talking first');
Date.now = RN;
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
