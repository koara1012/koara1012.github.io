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
  else if (sch.includes('group_reply')) out = { messages: answer.msgs };
  else if (sch.includes('"summary"')) out = { summary: answer.summary || '駅前のカフェでケーキを食べて、テニスの話をした。' };
  else if (sch.includes('"score"')) out = { score: answer.jealous ?? 90 };
  else if (sch.includes('keywords')) out = { keywords: ['料理'] };
  else if (sch.includes('scores')) out = { scores: [] };
  else if (sch.includes('"text"')) out = { text: 'つぶやき' };
  else { out = { messages: answer.msgs || ['返事'] }; for (const k of ['used_news', 'retract']) if (sch.includes(k)) out[k] = answer[k] ?? -1; for (const k of ['photo', 'photo_edit']) if (sch.includes(k)) out[k] = answer[k] ?? ''; for (const k of ['meet_status', 'meet_date', 'meet_time', 'meet_place']) if (sch.includes(k)) out[k] = (answer.meet || {})[k.slice(5)] ?? ''; }
  const t = JSON.stringify(out);
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: t } }] } : { candidates: [{ content: { parts: [{ text: t }] } }] }));
};


// ノベル画面の会話・設定を預かる（統合後のバックアップ）
const mk = (n) => ({ chars: [{ id: 'n1', name: '朱里' }], rooms: [{ id: 'r1' }], hists: { r1: Array.from({ length: n }, (_, i) => ({ role: 'user', text: 'x' + i })) }, settings: { speed: 45 } });
let e = ''; try { await call('POST', '/novel/save', { data: { foo: 1 } }); } catch (x) { e = x.message; }
ok(e.includes('形が違います'), 'bad shape rejected');
let r = await call('GET', '/novel/data');
ok(r.data === null && !r.hasPrev, 'empty at first');
await call('POST', '/novel/save', { data: mk(40) });
r = await call('GET', '/novel/data');
ok(r.data.hists.r1.length === 40 && r.at > 0 && !r.hasPrev, 'saved');
await call('POST', '/novel/save', { data: mk(35) });
ok(!(await call('GET', '/novel/data')).hasPrev, 'small decrease: no prev');
await call('POST', '/novel/save', { data: mk(3) });
r = await call('GET', '/novel/data');
ok(r.data.hists.r1.length === 3 && r.hasPrev, 'big decrease keeps prev');
ok((await call('GET', '/novel/data?prev=1')).data.hists.r1.length === 35, 'prev readable');
e = ''; try { await call('POST', '/novel/save', { data: { ...mk(1), big: 'あ'.repeat(1900000) } }); } catch (x) { e = x.message; }
ok(e.includes('大きすぎます'), 'too large rejected');
await call('POST', '/backup/novel-manual', { assets: true, bytes: 12345 });
const st = await call('GET', '/backup/status');
ok(st.novelManual && st.novelManual.assets === true && st.novelManual.bytes === 12345, 'novel manual backup recorded');
// 書き出しに入る（kv）・手動の記録（bk:）は入らない
const ex = await (await W.fetch(new Request('https://w/export', { headers: { 'X-App-Token': 'pw' } }), env, ctx)).json();
ok(ex.tables.kv.some(r => r.k === 'novel:data') && !ex.tables.kv.some(r => r.k === 'bk:novelManual'), 'export includes novel data, not manual record');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
