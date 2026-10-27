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
// 第36版：見回りをキャラごとにずらす・TLの反応は毎分
await call('POST', '/settings', { settings: { quietEnabled: false, delayEnabled: false, lifeEnabled: false } });
const cs = [];
for (const n of ['シャロ', '色葉', '三郷', '朱里', '夜鈴']) cs.push((await call('POST', '/char', { char: { name: n, prompt: 'p', tlPerDay: 12, uraTlPerDay: 0, perDay: 0 } })).char);
const R = Math.random; Math.random = () => 0.0001;
const T0 = Math.floor(Date.now() / 60000 / 13) * 13 * 60000;
const RN = Date.now;
const byMin = [];
for (let m = 0; m < 13; m++) {
  Date.now = () => T0 + m * 60000 + 5000;
  const before = DB.raw.prepare("SELECT id FROM tl_posts").all().map((r) => r.id);
  const w = []; await W.scheduled({ scheduledTime: T0 + m * 60000 }, env, { waitUntil: (x) => w.push(x) }); await Promise.all(w);
  const now = DB.raw.prepare("SELECT author FROM tl_posts WHERE world='omote'").all().map((r) => r.author);
  byMin.push(new Set(DB.raw.prepare(`SELECT author FROM tl_posts WHERE world='omote' AND id NOT IN (${before.join(',') || 0})`).all().map((r) => r.author)).size);
}
Math.random = R;
ok(byMin.reduce((a, b) => a + b, 0) === 5, 'all five characters posted once in 13 minutes');
ok(byMin.every((n) => n <= 1), 'never two characters posting in the same minute: ' + byMin.join(''));
// TLの反応：予定の時刻が来た分から、毎分実行される（13分ごとにまとめない）
const pid = DB.raw.prepare("INSERT INTO tl_posts (world,author,text,at,planned) VALUES ('omote','me','おはよう',?,1)").run(T0).lastInsertRowid;
DB.raw.prepare('DELETE FROM tl_jobs').run();
const ins = DB.raw.prepare("INSERT INTO tl_jobs (world,char_id,kind,post_id,due) VALUES ('omote',?,'like',?,?)");
ins.run(cs[0].id, pid, T0 + 20 * 60000 + 2 * 60000); // 22分目
ins.run(cs[1].id, pid, T0 + 20 * 60000 + 7 * 60000); // 27分目
const doneAt = {};
for (let m = 20; m < 30; m++) {
  Date.now = () => T0 + m * 60000 + 30000;
  const w = []; await W.scheduled({ scheduledTime: T0 + m * 60000 }, env, { waitUntil: (x) => w.push(x) }); await Promise.all(w);
  for (const r of DB.raw.prepare('SELECT author FROM tl_likes WHERE post_id=?').all(pid)) if (!(r.author in doneAt)) doneAt[r.author] = m;
}
Date.now = RN;
ok(doneAt[cs[0].id] === 22 && doneAt[cs[1].id] === 27, 'likes arrive at their own minutes (22, 27), not batched: ' + JSON.stringify(Object.values(doneAt)));
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
