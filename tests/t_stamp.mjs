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
  else { out = { messages: answer.msgs || ['返事'] }; if (sch.includes('"stamp"')) out.stamp = answer.stamp ?? ''; for (const k of ['used_news', 'retract']) if (sch.includes(k)) out[k] = answer[k] ?? -1; for (const k of ['photo', 'photo_edit']) if (sch.includes(k)) out[k] = answer[k] ?? ''; }
  const t = JSON.stringify(out);
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: t } }] } : { candidates: [{ content: { parts: [{ text: t }] } }] }));
};
const lastAI = () => calls.filter(c => !c.image && c.sch && c.sch.includes('messages')).pop();
await call('POST', '/settings', { settings: { delayEnabled: false, quietEnabled: false } });
const c = (await call('POST', '/char', { char: { name: 'シャロ', prompt: 'p' } })).char;
const R = Math.random; const withR = async (v, fn) => { Math.random = () => v; try { return await fn(); } finally { Math.random = R; } };
await call('POST', '/send', { charId: c.id, text: 'こんにちは' });
const r1 = await withR(0.99, () => call('POST', '/reply', { charId: c.id }));
const cm = r1.messages[r1.messages.length - 1];
// user 👍 → no reply, history note, sync map
let rr = await call('POST', '/react', { charId: c.id, id: cm.id, reaction: '👍' });
ok(rr.ok && rr.reply === false, '👍 → no reply needed');
let sy = await call('GET', '/sync?since=0');
ok(sy.reactions[cm.id] === '👍' && sy.messages.find(m => m.id === cm.id).reaction === '👍', 'sync carries reaction');
ok((await call('POST', '/reply', { charId: c.id })).messages.length === 0, '/reply does nothing after 👍');
// 😂 → reply about the stamp
calls.length = 0;
rr = await call('POST', '/react', { charId: c.id, id: cm.id, reaction: '😂' });
ok(rr.reply === true, '😂 → reply');
const d1 = await call('POST', '/reply/decide', { charId: c.id });
const r2 = await withR(0.99, () => call('POST', '/reply', { charId: c.id }));
const ai = calls.filter(x => x.sch && x.sch.includes('messages')).pop();
ok(d1.now && r2.messages.length > 0 && ai.sys.includes('😂') && ai.user.includes('スタンプ 😂'), 'reply mentions 😂 meaning + history note');
// remove
await call('POST', '/react', { charId: c.id, id: r2.messages[0].id, reaction: '❤️' });
await call('POST', '/react', { charId: c.id, id: r2.messages[0].id, reaction: null });
sy = await call('GET', '/sync?since=0');
ok(sy.reactions[r2.messages[0].id] === '' && !sy.messages.find(m => m.id === r2.messages[0].id).reaction, 'removing a stamp syncs as empty');
// ura not allowed
let err = ''; try { await call('POST', '/react', { charId: c.id + '#ura', id: cm.id, reaction: '👍' }); } catch (e) { err = e.message; }
ok(/表のトーク/.test(err), 'ura rejected');
// char stamp-only reply to おやすみ
await call('POST', '/send', { charId: c.id, text: 'おやすみ' });
answer.msgs = []; answer.stamp = '❤️';
calls.length = 0;
const r3 = await withR(0.99, () => call('POST', '/reply', { charId: c.id }));
const lastMe = (await call('GET', '/sync?since=0')).messages.filter(m => m.charId === c.id && m.sender === 'me').pop();
ok(r3.messages.length === 0 && lastMe.reaction === '❤️', 'char can answer with ❤️ only');
ok(calls.some(x => x.sch && x.sch.includes('"stamp"')), 'AI offered stamp option');
answer.msgs = null; answer.stamp = '';
// char 🏃 when glancing (delays on)
await call('POST', '/settings', { settings: { delayEnabled: true } });
await call('POST', '/send', { charId: c.id, text: '今なにしてる？' });
const hist = (await call('GET', '/sync?since=0')).messages.filter(m => m.charId === c.id);
const st = JSON.parse(DB.raw.prepare('SELECT data FROM char_state WHERE char_id=?').get(c.id)?.data || '{}');
const J = Date.now();
DB.raw.prepare("INSERT OR REPLACE INTO char_state (char_id,data) VALUES (?,?)").run(c.id, JSON.stringify({ ...st, plan: { day: 'x', blocks: [{ s: J - 600e3, e: J + 3600e3, act: '料理', kind: 'meal', avail: 50 }] } }));
let got = false;
for (let i = 0; i < 30 && !got; i++) {
  DB.raw.prepare("DELETE FROM kv WHERE k IN (?,?)").run('reply:' + c.id, 'replygo:' + c.id);
  const t = await X.decideReply(env, (await call('GET', '/sync?since=0')).chars[0], hist.map(m => m.sender === 'char' ? { ...m, at: m.at - 3600e3 } : m), Date.now());
  if (!t.now && t.pend.stamp) got = t.pend;
}
ok(got && got.stamp.r === '🏃', 'glancing sometimes schedules 🏃');
const RN = Date.now; Date.now = () => got.readAt + 1000;
await X.runDueReplies(env);
Date.now = RN;
const lm = (await call('GET', '/sync?since=0')).messages.filter(m => m.charId === c.id && m.sender === 'me').pop();
ok(lm.reaction === '🏃', '🏃 appears at read time, reply still pending');
ok(!!DB.raw.prepare("SELECT v FROM kv WHERE k=?").get('reply:' + c.id), 'reply still scheduled');
// 😴 from user blocks proactive until morning
DB.raw.prepare("DELETE FROM kv WHERE k LIKE 'reply:%'").run();
await call('POST', '/settings', { settings: { delayEnabled: false } });
await withR(0.99, () => call('POST', '/reply', { charId: c.id }));
const lastChar = (await call('GET', '/sync?since=0')).messages.filter(m => m.charId === c.id && m.sender === 'char').pop();
await withR(0.9, () => call('POST', '/react', { charId: c.id, id: lastChar.id, reaction: '😴' }));
const until = JSON.parse(DB.raw.prepare("SELECT v FROM kv WHERE k=?").get('usleep:' + c.id).v);
ok(until > Date.now() + 2 * 3600e3, '😴 blocks proactive until morning');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
