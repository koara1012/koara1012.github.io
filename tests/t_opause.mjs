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
await call('POST', '/settings', { settings: { delayEnabled: false, quietEnabled: false } });
// 表のAIを止める（omotePaused・第42版）
await call('POST', '/settings', { settings: { delayEnabled: false, quietEnabled: false } });
const c = (await call('POST', '/char', { char: { name: 'シャロ', prompt: 'p', tlPerDay: 24, perDay: 24 } })).char;
await call('POST', '/settings', { settings: { omotePaused: true } });
const st = (await call('GET', '/sync?since=0')).settings;
ok(st.omotePaused === true && !st.uraPaused, 'omote paused flag saved');
const n0 = calls.length;
await call('POST', '/send', { charId: c.id, text: 'こんにちは' });
let r = await call('POST', '/reply', { charId: c.id });
ok(r.paused && r.messages.length === 0, 'omote reply paused');
ok((await call('POST', '/reply/decide', { charId: c.id })).now === false, 'decide says not now');
await call('POST', '/send', { charId: c.id + '#ura', text: '裏はどう？' });
r = await call('POST', '/reply', { charId: c.id + '#ura' });
ok(r.messages.length > 0, 'ura unaffected');
const nAfterUra = calls.length;
ok(!(await X.shouldCharPost(env, c, 'omote', Date.now(), st)), 'omote TL posting stopped');
// 予約していた返事・話しかけ・追伸は待たせておく
DB.raw.prepare('INSERT INTO kv (k,v) VALUES (?,?)').run('proj:' + c.id, JSON.stringify({ d: { mode: 'topic' }, due: Date.now() - 1000, at: Date.now() }));
DB.raw.prepare('INSERT INTO kv (k,v) VALUES (?,?)').run('ps:' + c.id, JSON.stringify({ texts: ['あ、そういえば'], due: Date.now() - 1000, after: 0 }));
for (let m = 0; m < 14; m++) { const w = []; await W.scheduled({ scheduledTime: Date.now() + m * 60000 }, env, { waitUntil: (p) => w.push(p) }); await Promise.allSettled(w); }
ok(calls.length === nAfterUra, 'no AI calls during cron while paused (' + (calls.length - nAfterUra) + ')');
ok(!!DB.raw.prepare("SELECT 1 FROM kv WHERE k=?").get('proj:' + c.id) && !!DB.raw.prepare("SELECT 1 FROM kv WHERE k=?").get('ps:' + c.id), 'proactive and postscript kept waiting');
// 会う場面
const ms = await call('POST', '/meet/start', { charId: c.id });
ok(ms.paused && ms.lines.length === 0, 'meet start paused');
const say = await call('POST', '/meet/say', { charId: c.id, text: 'やあ' });
ok(say.paused && (await call('GET', '/meet?charId=' + c.id)).log.some(m => m.text === 'やあ'), 'meet say paused but kept');
ok(calls.length === nAfterUra, 'still no omote AI calls');
// 再開
await call('POST', '/settings', { settings: { omotePaused: false } });
r = await call('POST', '/reply', { charId: c.id });
ok(r.messages.length > 0, 'omote reply after resume');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
