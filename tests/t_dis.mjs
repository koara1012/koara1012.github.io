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
  else if (sch.includes('night_owl')) out = { weekday: '7時起床', holiday: '9時起床', reply_speed: 'normal', night_owl: 20, napper: 40, calm: 20 };
  else if (sch.includes('"score"')) out = { score: answer.jealous ?? 90 };
  else if (sch.includes('keywords')) out = { keywords: ['料理'] };
  else if (sch.includes('scores')) out = { scores: [] };
  else if (sch.includes('"text"')) out = { text: 'つぶやき' };
  else { out = { messages: answer.msgs || ['返事'] }; for (const k of ['used_news', 'retract']) if (sch.includes(k)) out[k] = answer[k] ?? -1; for (const k of ['photo', 'photo_edit']) if (sch.includes(k)) out[k] = answer[k] ?? ''; }
  const t = JSON.stringify(out);
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: t } }] } : { candidates: [{ content: { parts: [{ text: t }] } }] }));
};
const lastAI = () => calls.filter(c => !c.image && c.sch && c.sch.includes('messages')).pop();
// ---- fake external feeds
const RN = Date.now; let NOW = 0; Date.now = () => NOW || RN();
const day = '2026-10-16';
const J = (h, m = 0) => Date.parse(`${day}T00:00:00+09:00`) + (h * 60 + m) * 60e3;
const jst = (t) => new Date(t + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 19).replace(/-/g, '/');
let p2p = [], tcList = [], tcFc = [], fc = null, tepco = '<html>東京都 埼玉県 停電はありません</html>', news = {};
const F0 = globalThis.fetch;
globalThis.fetch = async (u, i) => {
  u = String(u);
  if (u.startsWith('https://api.p2pquake.net/')) return new Response(JSON.stringify(p2p));
  if (u.includes('/typhoon/data/targetTc.json')) return new Response(JSON.stringify(tcList));
  if (u.includes('/typhoon/data/')) return new Response(JSON.stringify(tcFc));
  if (u.includes('/bosai/warning/')) return new Response(JSON.stringify({ areaTypes: [{ areas: [{ code: '1110000', warnings: [{ code: '14', status: '発表' }] }] }] }));
  if (u.startsWith('https://air-quality-api.open-meteo.com/')) return new Response(JSON.stringify({ hourly: { time: [], ozone: [], dust: [] } }));
  if (u.startsWith('https://api.open-meteo.com/') && u.includes('hourly=')) return new Response(JSON.stringify(fc));
  if (u.startsWith('https://teideninfo.tepco.co.jp/')) return new Response(tepco);
  if (u.startsWith('https://news.google.com/')) { const q = decodeURIComponent(u.split('q=')[1].split('&')[0]).replace(' when:1d', ''); return new Response(news[q] || '<rss></rss>'); }
  return F0(u, i);
};
const mkFc = (opts = {}) => {
  const t = [], P = [], S = [], G = [], W = [], T = [], H = [];
  for (let k = -2; k < 48; k++) { const ts = NOW + k * 3600e3; t.push(new Date(ts + 9 * 3600e3).toISOString().slice(0, 13) + ':00'); P.push(opts.rain && k >= 0 && k < 2 ? 40 : 0); S.push(opts.snowNow && k < 3 ? 1 : 0); G.push(opts.gust || 5); W.push(opts.code || 1); T.push(20); H.push(60); }
  const days = Array.from({ length: 5 }, (_, i) => new Date(NOW + i * 864e5 + 9 * 3600e3).toISOString().slice(0, 10));
  return { hourly: { time: t, precipitation: P, snowfall: S, wind_gusts_10m: G, weather_code: W, pressure_msl: t.map(() => 1000), temperature_2m: T, relative_humidity_2m: H },
    daily: { time: days, weather_code: [1, 1, 1, 1, 1], temperature_2m_max: [opts.tmax || 24, 24, 24, 24, 24], temperature_2m_min: [15, 15, 15, 15, 15], precipitation_sum: [0, 0, 0, 0, 0], snowfall_sum: opts.snowDays || [0, 0, 0, 0, 0], wind_gusts_10m_max: [opts.gust || 8, 8, 8, 8, 8] } };
};
const run = async () => { await X.runDisasters(env, 0); };
const kvJobs = () => DB.raw.prepare("SELECT k,v FROM kv WHERE k LIKE 'disjob:%'").all().map(r => ({ k: r.k, ...JSON.parse(r.v) }));
const disState = () => JSON.parse(DB.raw.prepare("SELECT v FROM kv WHERE k='dis:state'").get().v);
const planRaw = (bathAt) => [
  { start: '07:00', end: '08:00', act: '身支度', kind: 'chores', avail: 40 },
  { start: '08:00', end: '21:00', act: '自由時間', kind: 'free', avail: 85 },
  { start: '21:00', end: '21:40', act: 'お風呂', kind: 'bath', avail: 5 },
  { start: '21:40', end: '23:30', act: 'ベッドで紅茶', kind: 'free', avail: 90 },
  { start: '23:30', end: '31:00', act: '眠っている', kind: 'sleep', avail: 0 },
];
NOW = J(9);
await call('POST', '/settings', { settings: { quietEnabled: true, quietStart: 1, quietEnd: 7, delayEnabled: false } });
const a = (await call('POST', '/char', { char: { name: 'シャロ', prompt: '紅茶好き' } })).char;
const b = (await call('POST', '/char', { char: { name: 'レイ', prompt: 'クール' } })).char;
const st = (await call('GET', '/sync?since=0')).settings;
for (const c of [a, b]) { answer.daily = { mood: '普通', mood_reason: '', today: '', diary: '', story_title: '', story_update: '', story_finished: false, busy: 30, fatigue: 30, plan: planRaw() }; await X.dailyUpdate(env, (await call('GET', '/sync?since=0')).chars.find(x => x.id === c.id), st, NOW, true); }
fc = mkFc();
p2p = [{ id: 'old1', code: 551, time: jst(NOW - 3600e3), earthquake: { time: jst(NOW - 3600e3), maxScale: 40, hypocenter: { name: '千葉県北西部' } }, points: [{ pref: '埼玉県', addr: 'さいたま北区', scale: 40, isArea: false }] }];
await run();
ok(kvJobs().length === 0, 'first run: old quake ignored');

// ---- 震度5弱 at 21:10 (A in bath, B too) ; calm 20 → many panic
NOW = J(21, 10);
p2p = [{ id: 'q1', code: 551, time: jst(NOW - 60e3), issue: { type: 'DetailScale' }, earthquake: { time: jst(NOW - 90e3), maxScale: 45, hypocenter: { name: '埼玉県南部', magnitude: 5.1 } }, points: [{ pref: '埼玉県', addr: 'さいたま北区', scale: 45, isArea: false }] }, ...p2p];
await run();
let jobs = kvJobs();
console.log('  jobs:', jobs.map(j => `${j.cid === a.id ? 'A' : 'B'}:${j.kind}@+${Math.round((j.due - NOW) / 60e3)}m ${JSON.stringify(j.info)}`).join('\n        '));
ok(jobs.filter(j => j.kind === 'talk').length === 2 && jobs.some(j => j.kind === 'follow'), 'quake → talk (+TL, follow) jobs for every char');
ok(disState().events.some(e => e.type === 'quake' && e.level === '5弱'), 'quake event 5弱');
// advance until all talk/tl jobs done
calls.length = 0;
for (let i = 0; i < 120; i++) { NOW += 60e3; await run(); if (!kvJobs().some(j => j.kind !== 'follow')) break; }
const talks = calls.filter(x => x.sch && x.sch.includes('messages'));
ok(talks.length >= 2 && talks.every(t => t.sys.includes('震度5弱')) && talks.some(t => t.sys.includes('お風呂')), 'quake talk mentions 震度 + what they were doing');
ok(talks.every(t => t.sys.includes('公式の情報を確認するよう促すような言い方はしない')), 'no official-info nagging');
const tlPosts = (await call('GET', '/tl?world=omote')).posts;
ok(tlPosts.length >= 1, 'quake TL posts: ' + tlPosts.length);
const tlCall = calls.find(x => x.sys && x.sys.includes('自分の投稿'));
ok(!tlCall || tlCall.user.includes('震度5弱'), 'TL prompt about quake');
// follow-up: nobody replied
calls.length = 0;
for (let i = 0; i < 120; i++) { NOW += 60e3; await run(); if (!kvJobs().length) break; }
const follows = calls.filter(x => x.sch && x.sch.includes('messages') && x.sys.includes('まだ返事がない'));
ok(follows.length === 2, 'follow-up worry when user silent');
// context
let lc = await X.lifeContext(env, (await call('GET', '/sync?since=0')).chars[0], st, NOW);
ok(lc.includes('震度5弱の地震') && lc.includes('雷注意報'), 'context: recent quake + warnings');

// ---- EEW false alarm at 12:00 next day (both awake free)
NOW = J(12) + 864e5;
p2p = [{ id: 'e1', code: 556, time: jst(NOW - 20e3), cancelled: false, issue: { eventId: 'E1' }, earthquake: { hypocenter: { name: '茨城県南部' } }, areas: [{ pref: '埼玉県', name: '埼玉県南部', scaleFrom: 45 }] }, ...p2p];
calls.length = 0;
await run();
ok(disState().events.some(e => e.type === 'eew'), 'EEW event');
for (let i = 0; i < 6; i++) { NOW += 60e3; await run(); }
const eewTalk = calls.filter(x => x.sch && x.sch.includes('messages'));
console.log('  eew talks before outcome:', eewTalk.length);
for (let i = 0; i < 40; i++) { NOW += 60e3; await run(); if (!kvJobs().length) break; }
const allEew = calls.filter(x => x.sch && x.sch.includes('messages'));
ok(disState().events.find(e => e.type === 'eew').outcome === 'false', 'no shaking → 誤報');
ok(allEew.some(t => t.sys.includes('誤報')), 'false alarm reaction mentions 誤報');

// ---- manual outage
NOW += 3600e3;
calls.length = 0;
await call('POST', '/outage', { on: true });
ok((await call('GET', '/sync?since=0')).outage.on, 'sync shows outage');
for (let i = 0; i < 40; i++) { NOW += 60e3; await run(); if (!kvJobs().length) break; }
const out1 = calls.filter(x => x.sch && x.sch.includes('messages'));
ok(out1.length >= 2 && out1.every(t => t.sys.includes('停電')) && out1.every(t => /1〜2個/.test(t.sys)), 'outage talk: short (≤2 bubbles) + 停電');
await call('POST', '/send', { charId: a.id, text: '大丈夫？' });
await call('POST', '/reply', { charId: a.id });
ok(calls.filter(x => x.sch && x.sch.includes('messages')).pop().sys.includes('いま停電中'), 'normal reply knows outage');
calls.length = 0;
await call('POST', '/outage', { on: false });
for (let i = 0; i < 90; i++) { NOW += 60e3; await run(); if (!kvJobs().length) break; }
ok(calls.some(x => x.sch && x.sch.includes('messages') && x.sys.includes('復旧')), 'outage end → 復旧 message');
ok(!(await call('GET', '/sync?since=0')).outage, 'outage cleared');

// ---- typhoon saga
NOW = J(12) + 3 * 864e5;
const center = (dLat, h) => ({ validtime: { JST: new Date(NOW + h * 3600e3 + 9 * 3600e3).toISOString().slice(0, 19) + '+09:00' }, center: [35.9 + dLat, 139.6] });
tcList = [{ tropicalCyclone: 'TC2619', typhoonNumber: '2619' }];
tcFc = [center(-3, 60), center(-1, 66)];
fc = mkFc();
const s0 = disState(); s0.mon.fc = 0; DB.raw.prepare("UPDATE kv SET v=? WHERE k='dis:state'").run(JSON.stringify(s0));
DB.raw.prepare("DELETE FROM kv WHERE k='forecast'").run();
await run();
const sg = () => disState().saga;
ok(sg() && sg().type === 'typhoon' && sg().phase === 'approach' && sg().name === '台風19号', 'typhoon approach');
const advance = async (h, fcOpts = {}) => { NOW += h * 3600e3; tcFc = tcFc.map(p => p); fc = mkFc(fcOpts); DB.raw.prepare("DELETE FROM kv WHERE k='forecast'").run(); const s1 = disState(); s1.mon.fc = 0; DB.raw.prepare("UPDATE kv SET v=? WHERE k='dis:state'").run(JSON.stringify(s1)); await run(); };
await advance(40); ok(sg().phase === 'eve', 'typhoon eve');
await advance(24, { gust: 25 }); ok(sg().phase === 'hit', 'typhoon hit');
tcList = []; await advance(12); ok(sg() && sg().phase === 'after', 'typhoon after');
const tyEvents = disState().events.filter(e => e.type === 'typhoon').map(e => e.phase);
ok(tyEvents.join() === 'approach,eve,hit,after', 'typhoon phases → events: ' + tyEvents.join());
calls.length = 0;
for (let i = 0; i < 400; i++) { NOW += 5 * 60e3; await X.runDisasters(env, 0); if (!kvJobs().length) break; }
const tyTalk = calls.filter(x => x.sch && x.sch.includes('messages') && x.sys.includes('台風19号'));
ok(tyTalk.length >= 2, 'typhoon talk messages: ' + tyTalk.length);
// missed typhoon
NOW += 3 * 864e5; const s3 = disState(); s3.saga = null; DB.raw.prepare("UPDATE kv SET v=? WHERE k='dis:state'").run(JSON.stringify(s3));
tcList = [{ tropicalCyclone: 'TC2620', typhoonNumber: '2620' }]; tcFc = [center(-3, 70)];
await advance(0); ok(sg().phase === 'approach', 'typhoon20 approach');
tcFc = [center(-8, 50)]; await advance(10); ok(sg().phase === 'missed', 'typhoon veered → missed');

// ---- test endpoint + disabled
NOW += 864e5;
DB.raw.prepare("DELETE FROM kv WHERE k LIKE 'disjob:%'").run();
await call('POST', '/disaster/test', { type: 'quake' });
const tj = kvJobs().filter(j => j.kind === 'talk');
ok(tj.length === 2 && tj.every(j => j.due - NOW <= 8 * 60e3 + 1000), 'test quake: reactions within minutes');
await call('POST', '/settings', { settings: { disasterEnabled: false } });
DB.raw.prepare("DELETE FROM kv WHERE k LIKE 'disjob:%'").run();
p2p = [{ id: 'q9', code: 551, time: jst(NOW), earthquake: { time: jst(NOW), maxScale: 50, hypocenter: { name: 'x' } }, points: [{ pref: '埼玉県', addr: 'さいたま北区', scale: 50 }] }];
await run();
ok(kvJobs().length === 0, 'disabled → no reactions');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
