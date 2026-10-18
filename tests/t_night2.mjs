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
const c = (await call('POST', '/char', { char: { name: 'シャロ', prompt: '一途', perDay: 12, tlPerDay: 12 } })).char;
await call('POST', '/settings', { settings: { delayEnabled: false } });
await call('POST', '/send', { charId: c.id, text: 'おやすみ' });
const R = Math.random; Math.random = () => 0.99; await call('POST', '/reply', { charId: c.id }); Math.random = R;
// move clock to 3:20 JST, 5h later
const realNow = Date.now; const t = Date.UTC(2026, 9, 15, 18, 20); Date.now = () => t;
DB.raw.prepare('UPDATE messages SET at=?').run(t - 5 * 3600e3);
DB.raw.prepare("UPDATE messages SET reaction='❤️', reacted_at=? WHERE sender='me'").run(t - 5 * 3600e3); // 🥺だけ付ける話しかけ（第26版）ではなく、文章の話しかけを確かめる
await call('POST', '/settings', { settings: { quietEnabled: true, quietStart: 1, quietEnd: 7, delayEnabled: false } });
Math.random = () => 0.0001;
const w = []; await W.scheduled({}, env, { waitUntil: (x) => w.push(x) }); await Promise.all(w);
Math.random = R;
Date.now = () => t + 15 * 60e3; await X.runDueProactive(env); Date.now = () => t;
const talk = calls.filter(x => !x.image && x.sch && x.sch.includes('messages')).pop();
ok(talk && talk.sys.includes('深夜（3時台）'), 'cron talk at 3am gets night note');
const posts = calls.filter(x => x.sys && x.sys.includes('自分の投稿')); const post = posts.find(x => x.user.includes('「表」')); const ura = posts.find(x => x.user.includes('「裏」'));
ok(ura && !ura.user.includes('深夜'), 'ura TL post has no night theme');
ok(post && post.user.includes('深夜'), 'TL post at 3am gets night theme');
console.log((await call('GET', '/ping')).lastTick.done);
Date.now = realNow;
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
