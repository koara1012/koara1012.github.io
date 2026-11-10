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

// 表のAIをキャラごとに止める（omotePausedIds・第48版）
await call('POST', '/settings', { settings: { delayEnabled: false, quietEnabled: false } });
const A = (await call('POST', '/char', { char: { name: 'アリスネコ', prompt: 'p', tlPerDay: 24, perDay: 24 } })).char;
const B = (await call('POST', '/char', { char: { name: 'ボブイヌ', prompt: 'p', tlPerDay: 24, perDay: 24 } })).char;
await call('POST', '/settings', { settings: { pauseChar: { id: A.id, on: true } } });
let st = (await call('GET', '/sync?since=0')).settings;
ok(st.omotePausedIds.length === 1 && st.omotePausedIds[0] === A.id && !st.omotePaused, 'per-char pause saved');
await call('POST', '/settings', { settings: { pauseChar: { id: B.id, on: true } } });
await call('POST', '/settings', { settings: { pauseChar: { id: B.id, on: false } } });
st = (await call('GET', '/sync?since=0')).settings;
ok(st.omotePausedIds.length === 1 && st.omotePausedIds[0] === A.id, 'toggling another char keeps the first');
ok(X.omoteStop(st, A.id) && X.omoteStop(st, A.id + '#ura') && !X.omoteStop(st, B.id) && X.omoteStop({ omotePaused: true }, B.id), 'omoteStop helper');
// 返事
await call('POST', '/send', { charId: A.id, text: 'こんにちは' });
let r = await call('POST', '/reply', { charId: A.id });
ok(r.paused && r.messages.length === 0, 'paused char does not reply');
ok((await call('POST', '/reply/decide', { charId: A.id })).now === false, 'decide says not now for paused char');
await call('POST', '/send', { charId: B.id, text: 'やあ' });
r = await call('POST', '/reply', { charId: B.id });
ok(r.messages.length > 0, 'other char still replies');
await call('POST', '/send', { charId: A.id + '#ura', text: '裏は？' });
r = await call('POST', '/reply', { charId: A.id + '#ura' });
ok(r.messages.length > 0, 'ura of paused char unaffected');
ok(!(await X.shouldCharPost(env, A, 'omote', Date.now(), st)), 'paused char does not post on TL');
// 予約していた話しかけ・追伸・返事・TLの反応は待たせておく（ほかの子の分は動く）
const ins = (k, v) => DB.raw.prepare('INSERT OR REPLACE INTO kv (k,v) VALUES (?,?)').run(k, JSON.stringify(v));
ins('proj:' + A.id, { d: { mode: 'topic' }, due: Date.now() - 1000, at: Date.now() });
ins('ps:' + A.id, { texts: ['あ、そういえば'], due: Date.now() - 1000, after: 0 });
ins('reply:' + A.id, { key: A.id, replyAt: Date.now() - 1000, readAt: Date.now() - 1000 });
const pid = DB.raw.prepare("INSERT INTO tl_posts (world, author, text, at) VALUES ('omote', ?, 'テスト投稿', ?)").run('@me', Date.now()).lastInsertRowid;
DB.raw.prepare("INSERT INTO tl_jobs (world, char_id, kind, post_id, due) VALUES ('omote', ?, 'like', ?, ?)").run(A.id, pid, Date.now() - 1000);
DB.raw.prepare("INSERT INTO tl_jobs (world, char_id, kind, post_id, due) VALUES ('omote', ?, 'like', ?, ?)").run(B.id, pid, Date.now() - 1000);
await X.runTlJobs(env, 10);
ok(DB.raw.prepare('SELECT char_id FROM tl_jobs').all().map((x) => x.char_id).join() === A.id, 'TL job of paused char waits, other runs');
ok(await X.runDueProactive(env) === 0 && await X.runDuePostscripts(env) === 0 && await X.runDueReplies(env) === 0, 'due jobs skipped for paused char');
const n0 = calls.length;
for (let m = 0; m < 14; m++) { const w = []; await W.scheduled({ scheduledTime: Date.now() + m * 60000 }, env, { waitUntil: (p) => w.push(p) }); await Promise.allSettled(w); }
ok(!calls.slice(n0).some((x) => (x.sys || '').includes('アリスネコ') && !(x.sys || '').includes('ボブイヌ')), 'no AI calls for paused char during cron');
ok(['proj:', 'ps:', 'reply:'].every((p) => !!DB.raw.prepare('SELECT 1 FROM kv WHERE k=?').get(p + A.id)), 'proactive/postscript/reply kept waiting');
ok(!(await X.maybeRing(env, { ...A, voice: 'v', callFreq: 'often' }, { ...st, phoneEnabled: true }, Date.now())), 'paused char does not call');
// 会う場面
const ms = await call('POST', '/meet/start', { charId: A.id });
ok(ms.paused && ms.lines.length === 0, 'meet start paused for paused char');
// 編集で保存しても止めたまま（設定は settings 側にある）
await call('POST', '/char', { char: { ...A, prompt: 'p2' } });
ok((await call('GET', '/sync?since=0')).settings.omotePausedIds.includes(A.id), 'char save keeps pause');
// 再開
await call('POST', '/settings', { settings: { pauseChar: { id: A.id, on: false } } });
r = await call('POST', '/reply', { charId: A.id });
ok(r.messages.length > 0, 'reply after resume');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
