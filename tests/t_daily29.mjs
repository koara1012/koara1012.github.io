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
  if (sch.includes('night_owl')) out = { weekday: '7時起床', holiday: '9時起床', reply_speed: 'normal', night_owl: 30, napper: 30, calm: 50, habits: '日曜の朝：ブリヌイを焼く', seasonal: '秋：紅茶' };
  else if (sch.includes('affinity_delta')) out = answer.extract || { new: [], done: [], user_state: '', affinity_delta: 0, birthday: '' };
  else if (sch.includes('story_finished')) out = answer.daily || { mood: 'ご機嫌', mood_reason: '晴れたから', today: 'ブリヌイを焼く', diary: '本を読んだ', story_title: '', story_update: '', story_finished: false, busy: 20 };
  else if (sch.includes('"score"')) out = { score: answer.jealous ?? 90 };
  else if (sch.includes('keywords')) out = { keywords: ['料理'] };
  else if (sch.includes('scores')) out = { scores: [] };
  else if (sch.includes('"text"')) out = { text: 'つぶやき' };
  else { out = { messages: answer.msgs || ['返事'] }; for (const k of ['used_news', 'retract', 'quote']) if (sch.includes('"' + k + '"')) out[k] = answer[k] ?? -1; for (const k of ['photo', 'photo_edit', 'postscript', 'stamp']) if (sch.includes('"' + k + '"')) out[k] = answer[k] ?? ''; }
  const t = JSON.stringify(out);
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: t } }] } : { candidates: [{ content: { parts: [{ text: t }] } }] }));
};
await call('POST', '/settings', { settings: { quietEnabled: false, delayEnabled: false } });
const sharo = (await call('POST', '/char', { char: { name: 'シャロ', prompt: '一途で嫉妬深いロシアの子' } })).char;
const iroha = (await call('POST', '/char', { char: { name: '色葉', prompt: 'のんびり屋' } })).char;
const R = Math.random; const withR = async (v, fn) => { Math.random = () => v; try { return await fn(); } finally { Math.random = R; } };
const getState = (id) => JSON.parse(DB.raw.prepare('SELECT data FROM char_state WHERE char_id=?').get(id)?.data || '{}');
const st = (await call('GET', '/sync?since=0')).settings;
const now0 = Date.now();

// ---- 1. 長く続けていること・5. 数日続く体調・4. ひとこと・6. ほかの子との約束・8. 習慣
const daily = (extra) => ({ mood: 'ご機嫌', mood_reason: '晴れ', today: '読書', diary: '本を読んだ', story_title: '', story_update: '', story_finished: false, busy: 20, fatigue: 30, plan: [],
  project_title: '', project_update: '', project_finished: false, condition: '', condition_days: 0, condition_over: false, status_msg: '', status_emoji: '', meet_with: '', meet_act: '', meet_time: '', ...extra });
answer.daily = daily({ project_title: 'マフラーを編む', project_update: '毛糸を買った', condition: '風邪をひいた', condition_days: 3, status_msg: '毛糸の色で迷い中', status_emoji: '🧶', meet_with: '色葉', meet_act: '一緒にお茶', meet_time: '15:00' });
calls.length = 0;
await withR(0.01, () => X.dailyUpdate(env, sharo, st, now0, true));
let s1 = getState(sharo.id);
ok(s1.project && s1.project.title === 'マフラーを編む' && s1.project.log.length === 1, 'project started');
ok(s1.condition && s1.condition.label === '風邪をひいた' && s1.condition.days === 3, 'condition started');
ok(s1.statusMsg === '毛糸の色で迷い中' && s1.statusEmoji === '🧶', 'status message + emoji');
const dsys = calls.find((x) => x.sch && x.sch.includes('story_finished'));
ok(dsys.user.includes('日曜の朝：ブリヌイを焼く') && dsys.user.includes('色葉'), 'daily prompt has habits and other chars');
const today = new Date(now0 + 9 * 3600e3).toISOString().slice(0, 10);
const meets = JSON.parse(DB.raw.prepare('SELECT v FROM kv WHERE k=?').get('meet:' + today).v);
ok(meets.length === 1 && meets[0].b === iroha.id && meets[0].time === '15:00', 'meet saved for both');
// 色葉の側：約束を知っている
answer.daily = daily({ meet_with: 'シャロ', meet_act: '別の予定', meet_time: '10:00' });
calls.length = 0;
await withR(0.01, () => X.dailyUpdate(env, iroha, st, now0, true));
const isys = calls.find((x) => x.sch && x.sch.includes('story_finished'));
ok(isys.user.includes('シャロさんと「一緒にお茶」') && isys.user.includes('新しく決めない'), 'partner told about the meet, no second meet');
ok(JSON.parse(DB.raw.prepare('SELECT v FROM kv WHERE k=?').get('meet:' + today).v).length === 1, 'still one meet');
const lc = await X.lifeContext(env, iroha, st, now0);
ok(lc.includes('シャロさんと「一緒にお茶」') && lc.includes('日曜の朝'), 'partner reply context has the meet and habits');
// 翌日：続き・体調・昨日の約束
answer.daily = daily({ project_title: 'マフラーを編む', project_update: '10段編めた', condition: '熱は下がった', status_msg: '毛糸の色で迷い中' });
calls.length = 0;
await withR(0.99, () => X.dailyUpdate(env, sharo, st, now0 + 864e5, true));
s1 = getState(sharo.id);
const d2 = calls.find((x) => x.sch && x.sch.includes('story_finished'));
ok(s1.project.log.length === 2 && d2.user.includes('毛糸を買った'), 'project continues with history');
ok(s1.condition.now === '熱は下がった' && d2.user.includes('2日目'), 'condition day 2');
ok(d2.user.includes('昨日ほかの子と過ごしたこと：色葉さんと「一緒にお茶」'), 'yesterday meet remembered');
ok(s1.statusAt < now0 + 864e5 - 1000 || s1.statusMsg === '毛糸の色で迷い中', 'status kept when unchanged');
answer.daily = daily({ condition_over: true });
await withR(0.99, () => X.dailyUpdate(env, sharo, st, now0 + 2 * 864e5, true));
ok(!getState(sharo.id).condition && getState(sharo.id).project, 'condition ends, project stays');
const sy = await call('GET', '/sync?since=0');
ok(sy.status[sharo.id] && sy.status[sharo.id].msg === '毛糸の色で迷い中', 'sync carries status');
const life = await call('GET', '/life?charId=' + sharo.id);
ok(life.today.project.title === 'マフラーを編む' && life.today.statusMsg, '/life shows project + status');

// ---- 2. 内輪ネタ
await call('POST', '/send', { charId: sharo.id, text: 'ボルチシ食べたい' });
await withR(0.99, () => call('POST', '/reply', { charId: sharo.id }));
answer.extract = { new: [], done: [], user_state: '', affinity_delta: 0, birthday: '', jokes: ['ユーザーがボルシチを"ボルチシ"と言い間違えた'] };
await X.extractMemories(env, sharo, st, Date.now(), true);
const jk = DB.raw.prepare("SELECT * FROM memories WHERE kind='joke'").all();
ok(jk.length === 1, 'inside joke saved');
const lj = await withR(0.01, () => X.lifeContext(env, sharo, st, Date.now() + 2 * 864e5));
const ln = await withR(0.99, () => X.lifeContext(env, sharo, st, Date.now() + 2 * 864e5));
if (!lj.includes('ボルチシ')) console.log(lj.slice(-900));
ok(lj.includes('ボルチシ') && !ln.includes('ボルチシ'), 'joke appears only sometimes');
ok(!ln.includes('[二人の内輪ネタ]'), 'joke not listed as a to-do');
const lifeJ = await call('GET', '/life?charId=' + sharo.id);
ok(lifeJ.memories.some((m) => m.label === '二人の内輪ネタ'), 'joke visible in memory list');

// ---- 3. 引用返信・追伸
await call('POST', '/send', { charId: sharo.id, text: '今日は寒いね' });
await call('POST', '/send', { charId: sharo.id, text: 'あとマフラー楽しみ' });
answer.quote = 0; answer.postscript = 'あ、そういえば毛糸は水色にしました';
calls.length = 0;
const r1 = await withR(0.05, () => call('POST', '/reply', { charId: sharo.id }));
const aiq = calls.filter((x) => x.sch && x.sch.includes('"quote"')).pop();
ok(aiq && aiq.sys.includes('今日は寒いね') && aiq.sys.includes('postscript'), 'AI offered quote candidates + postscript');
const firstChar = r1.messages.find((m) => m.sender === 'char');
const quoted = (await call('GET', '/sync?since=0')).messages.find((m) => m.id === firstChar.id);
ok(quoted.replyTo && (await call('GET', '/sync?since=0')).messages.find((m) => m.id === quoted.replyTo).text.includes('マフラー楽しみ') === false, 'reply quotes the chosen message');
ok(!!DB.raw.prepare("SELECT v FROM kv WHERE k='ps:' || ?").get(sharo.id), 'postscript scheduled');
answer.quote = -1; answer.postscript = '';
const RN = Date.now; Date.now = () => RN() + 8 * 60e3;
let n = await X.runDuePostscripts(env);
Date.now = RN;
const lastM = (await call('GET', '/sync?since=0')).messages.filter((m) => m.charId === sharo.id).pop();
ok(n === 1 && lastM.text.includes('水色'), 'postscript delivered later');
// 間にユーザーが話したら送らない
DB.raw.prepare("INSERT OR REPLACE INTO kv (k,v) VALUES ('ps:' || ?, ?)").run(sharo.id, JSON.stringify({ texts: ['追伸'], due: 0, after: lastM.id }));
await call('POST', '/send', { charId: sharo.id, text: 'おーい' });
ok((await X.runDuePostscripts(env)) === 0, 'postscript dropped when conversation moved on');

// ---- 7. 不在着信
await withR(0.99, () => call('POST', '/reply', { charId: sharo.id }));
const hist = (await call('GET', '/sync?since=0')).messages.filter((m) => m.charId === sharo.id);
const T = Date.now() + 2 * 3600e3; // 2時間返事がない
const ss = getState(sharo.id); ss.plan = { day: 'x', blocks: [{ s: T - 3600e3, e: T + 3600e3, act: '自由時間', kind: 'free', avail: 90 }] }; ss.lastCallAt = 0;
DB.raw.prepare('UPDATE char_state SET data=? WHERE char_id=?').run(JSON.stringify(ss), sharo.id);
const dCall = await withR(0.001, () => X.lifeDecide(env, sharo, hist, Date.now(), T, { ...st, lifeEnabled: true }, { chars: [sharo, iroha], lastUserActive: Date.now() }));
const jst = new Date(T + 9 * 3600e3).getUTCHours();
ok(jst < 8 || jst >= 23 ? true : dCall && dCall.mode === 'call', 'lifeDecide can choose a missed call (hour ' + jst + ')');
answer.msgs = ['……出てくれないんですね', '声が聞きたかっただけです'];
const out = await X.generateAndStore(env, sharo, { mode: 'call', since: Date.now() - 2 * 3600e3 }, hist, Date.now());
const callRow = DB.raw.prepare("SELECT * FROM messages WHERE kind='call'").get();
ok(out.length === 1 && out[0].kind === 'call' && callRow, 'call message stored first');
const callAI = calls.filter((x) => x.sch && x.sch.includes('messages')).pop();
ok(callAI.sys.includes('電話をかけた') , 'call situation prompt');
Date.now = () => RN() + 3 * 60e3;
await X.runDuePostscripts(env);
Date.now = RN;
const after = (await call('GET', '/sync?since=0')).messages.filter((m) => m.charId === sharo.id).slice(-3);
ok(after[0].kind === 'call' && after[1].text.includes('出てくれない') && after[2].text.includes('声が'), 'words arrive after the missed call');
const ctxT = X.buildContents(after.map((m) => ({ ...m })), 'omote').map((t) => t.parts.map((p) => p.text).join('')).join('\n');
ok(ctxT.includes('電話をかけたが、ユーザーは出なかった'), 'AI history shows the missed call');
answer.msgs = null;
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
