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
  else if (sch.includes('night_owl')) out = { weekday: '7時起床・23時半就寝', holiday: '9時起床', reply_speed: 'normal', night_owl: 20, napper: 40 };
  else if (sch.includes('"score"')) out = { score: answer.jealous ?? 90 };
  else if (sch.includes('keywords')) out = { keywords: ['料理'] };
  else if (sch.includes('scores')) out = { scores: [] };
  else if (sch.includes('"text"')) out = { text: 'つぶやき' };
  else { out = { messages: answer.msgs || ['返事'] }; for (const k of ['used_news', 'retract']) if (sch.includes(k)) out[k] = answer[k] ?? -1; for (const k of ['photo', 'photo_edit']) if (sch.includes(k)) out[k] = answer[k] ?? ''; }
  const t = JSON.stringify(out);
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: t } }] } : { candidates: [{ content: { parts: [{ text: t }] } }] }));
};
const lastAI = () => calls.filter(c => !c.image && c.sch && c.sch.includes('messages')).pop();
const RN = Date.now; let NOW = 0; Date.now = () => NOW || RN();
const day = '2026-10-16';
const J = (h, m = 0) => Date.parse(`${day}T00:00:00+09:00`) + (h * 60 + m) * 60e3;
const R = Math.random; const withR = async (v, fn) => { Math.random = () => v; try { return await fn(); } finally { Math.random = R; } };
const planRaw = [
  { start: '07:30', end: '08:10', act: '身支度', kind: 'chores', avail: 40 },
  { start: '08:30', end: '12:00', act: '訓練', kind: 'busy', avail: 10 },
  { start: '12:00', end: '13:00', act: 'お昼ごはん', kind: 'meal', avail: 50 },
  { start: '13:00', end: '18:00', act: '自由時間', kind: 'free', avail: 85 },
  { start: '21:00', end: '21:40', act: 'お風呂', kind: 'bath', avail: 5 },
  { start: '21:40', end: '23:50', act: 'ベッドで紅茶', kind: 'free', avail: 90 },
  { start: '23:50', end: '31:20', act: '眠っている', kind: 'sleep', avail: 0 },
];
answer.daily = { mood: 'ご機嫌', mood_reason: '晴れ', today: '訓練の日', diary: '本を読んだ', story_title: '', story_update: '', story_finished: false, busy: 40, fatigue: 70, plan: planRaw };
NOW = J(7, 40);
await call('POST', '/settings', { settings: { quietEnabled: true, quietStart: 1, quietEnd: 7 } });
const c = (await call('POST', '/char', { char: { name: 'シャロ', prompt: '紅茶好き' } })).char;
const cc = () => call('GET', '/sync?since=0').then(d => d.chars.find(x => x.id === c.id));
const st = (await call('GET', '/sync?since=0')).settings;
calls.length = 0;
await X.dailyUpdate(env, await cc(), st, NOW, true);
const dcall = calls.find(x => x.sch && x.sch.includes('story_finished'));
ok(calls.some(x => x.sch && x.sch.includes('night_owl')), 'rhythm generated once');
ok(dcall.user.includes('7時起床・23時半就寝') && dcall.user.includes('平日') && dcall.sch.includes('"plan"'), 'daily prompt has rhythm + asks for plan');
const stt = JSON.parse(DB.raw.prepare('SELECT data FROM char_state WHERE char_id=?').get(c.id).data);
ok(stt.plan && stt.plan.blocks.length >= 7 && stt.fatigue === 70, 'plan stored');
const life = await call('GET', '/life?charId=' + c.id);
ok(!JSON.stringify(life).includes('お風呂') && !('plan' in (life.today || {})), 'plan hidden from /life');
calls.length = 0;
await X.dailyUpdate(env, await cc(), st, NOW, true);
ok(!calls.some(x => x.sch && x.sch.includes('night_owl')), 'rhythm cached');

// bath → delayed
NOW = J(21, 10);
await call('POST', '/send', { charId: c.id, text: 'こんばんは' });
const dec = await withR(0.99, () => call('POST', '/reply/decide', { charId: c.id }));
ok(dec.now === false, 'in bath → not now');
const rp = await call('POST', '/reply', { charId: c.id });
ok(rp.delayed && !rp.messages.length, '/reply also delayed');
const pend = JSON.parse(DB.raw.prepare("SELECT v FROM kv WHERE k=?").get('reply:' + c.id).v);
console.log('  readAt', new Date(pend.readAt + 9 * 3600e3).toISOString().slice(11, 16), 'replyAt', new Date(pend.replyAt + 9 * 3600e3).toISOString().slice(11, 16));
ok(pend.readAt >= J(21, 40) && pend.replyAt >= pend.readAt, 'read only after bath');
ok(Object.keys((await call('GET', '/sync?since=0')).charRead).length === 0, 'no read mark yet');
await call('POST', '/send', { charId: c.id, text: 'お風呂かな？' });
NOW = pend.readAt + 1000;
ok((await call('GET', '/sync?since=0')).charRead[c.id] === pend.readAt, 'read mark appears at readAt');
ok((await X.runDueReplies(env)) === 0 || pend.replyAt <= NOW, 'not yet replied before replyAt');
NOW = pend.replyAt + 1000; calls.length = 0;
const n = await X.runDueReplies(env);
const rc = calls.filter(x => x.sch && x.sch.includes('messages')).pop();
ok(n === 1 && rc.sys.includes('「お風呂」の最中だった') && rc.sys.includes('2通のメッセージが溜まっている'), 'late reply mentions activity + 2 waiting msgs');
ok(!DB.raw.prepare("SELECT v FROM kv WHERE k=?").get('reply:' + c.id), 'pending cleared');
const msgs = (await call('GET', '/sync?since=0')).messages.filter(m => m.charId === c.id);
ok(msgs[msgs.length - 1].sender === 'char', 'reply stored');
ok(rc.sys.includes('いま：ベッドで紅茶'), 'current activity in prompt');
ok((await X.runDueReplies(env)) === 0, 'no double reply');

// ongoing conversation → immediate
await call('POST', '/send', { charId: c.id, text: 'おかえり' });
const d2 = await withR(0.5, () => call('POST', '/reply/decide', { charId: c.id }));
ok(d2.now === true, 'ongoing chat → immediate');
const r2 = await call('POST', '/reply', { charId: c.id });
ok(r2.messages.length > 0, 'immediate reply generated');

// cron fallback when app closed: last is me for > 90s, in training → pending instead of instant
NOW = J(10, 0) + 864e5; // next day 10:00 (plan of yesterday doesn't cover → default plan "日中の用事" avail 35)
await call('POST', '/send', { charId: c.id, text: 'おはよう' });
NOW += 120e3;
const w = []; await withR(0.99, () => W.scheduled({ scheduledTime: Math.floor(NOW / 60000 / 13) * 13 * 60000 }, env, { waitUntil: (x) => w.push(x) })); await Promise.all(w);
const lt = (await call('GET', '/ping')).lastTick;
console.log('  tick done:', lt.done);
ok(DB.raw.prepare("SELECT v FROM kv WHERE k=?").get('reply:' + c.id) && !lt.done.some(x => x.includes(':reply')), 'cron schedules pending reply instead of instant');

// TL reaction moved after bath; quiet-time post unaffected
const stx = { ...st, lifeEnabled: true };
const s2 = JSON.parse(DB.raw.prepare('SELECT data FROM char_state WHERE char_id=?').get(c.id).data);
s2.plan.day = day; // keep
const due1 = await withR(0.1, () => X.schedDue(env, c.id, J(21, 15), { world: 'omote', at: J(21, 5) }, stx));
ok(due1 >= J(21, 40), 'TL reaction during bath → after bath');
const due2 = await withR(0.1, () => X.schedDue(env, c.id, J(3, 0) + 864e5, { world: 'omote', at: J(2, 50) + 864e5 }, stx));
ok(due2 === J(3, 0) + 864e5, 'quiet-hour post reactions not moved');
const due3 = await withR(0.1, () => X.schedDue(env, c.id, J(21, 15), { world: 'ura', at: J(21, 5) }, stx));
ok(due3 === J(21, 15), 'ura untouched');
// ura reply never delayed
await call('POST', '/send', { charId: c.id + '#ura', text: 'やあ' });
ok((await call('POST', '/reply/decide', { charId: c.id + '#ura' })).now === true, 'ura always now');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
