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
const c = (await call('POST', '/char', { char: { name: 'シャロ', prompt: 'p', uraTlPerDay: 12, tlPerDay: 12 } })).char;
const c2 = (await call('POST', '/char', { char: { name: 'レイ', prompt: 'q' } })).char;
// user posts on ura TL before pausing → jobs planned
const up = await call('POST', '/tl/post', { world: 'ura', text: '裏のテスト投稿' });
await X.runTlJobs(env, 5); await Promise.all(waits);
await call('POST', '/settings', { settings: { uraPaused: true } });
const st = (await call('GET', '/sync?since=0')).settings;
ok(st.uraPaused === true, 'paused flag saved');
// ura reply paused
await call('POST', '/send', { charId: c.id + '#ura', text: 'やあ' });
const r = await call('POST', '/reply', { charId: c.id + '#ura' });
ok(r.paused && r.messages.length === 0, 'ura reply paused');
// omote still works
await call('POST', '/send', { charId: c.id, text: 'やあ' });
const r2 = await call('POST', '/reply', { charId: c.id });
ok(r2.messages.length > 0, 'omote reply unaffected');
// ura TL posting stopped
const R = Math.random; Math.random = () => 0.0001;
ok(!(await X.shouldCharPost(env, c, 'ura', Date.now(), st)) && (await X.shouldCharPost(env, c, 'omote', Date.now(), st)), 'ura TL posting stopped, omote still posts');
Math.random = R;
// ura TL jobs held
DB.raw.prepare("UPDATE tl_jobs SET due=0").run();
const heldBefore = DB.raw.prepare("SELECT count(*) n FROM tl_jobs WHERE world='ura'").get().n;
await X.runTlJobs(env, 20);
const heldAfter = DB.raw.prepare("SELECT count(*) n FROM tl_jobs WHERE world='ura'").get().n;
console.log('  ura jobs held:', heldBefore, '→', heldAfter);
ok(heldAfter === heldBefore, 'ura TL reactions wait while paused');
// new ura post while paused → no reactions planned
const up2 = await call('POST', '/tl/post', { world: 'ura', text: '止めている間の投稿' });
await X.runTlJobs(env, 5);
ok(DB.raw.prepare("SELECT count(*) n FROM tl_jobs WHERE post_id=?").get(up2.post.id).n === 0, 'no reactions planned for posts during pause');
// resume → held jobs run, reply works
await call('POST', '/settings', { settings: { uraPaused: false } });
await X.runTlJobs(env, 20);
ok(DB.raw.prepare("SELECT count(*) n FROM tl_jobs WHERE world='ura' AND due<=?").get(Date.now()).n === 0, 'held reactions delivered after resume');
const r3 = await call('POST', '/reply', { charId: c.id + '#ura' });
ok(r3.messages.length > 0, 'ura reply after resume');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
