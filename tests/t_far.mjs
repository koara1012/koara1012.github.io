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
const c3 = (await call('POST', '/char', { char: { name: '朱里', prompt: '心配性' } })).char;
const c4 = (await call('POST', '/char', { char: { name: '三郷', prompt: '堅物' } })).char;
await run();
const item = (t, ago = 3600e3) => `<item><title>${t} - NHK</title><source>NHK</source><pubDate>${new Date(NOW - ago).toUTCString()}</pubDate></item>`;
const runNews = async () => { const s = disState(); s.mon.news = 0; s.mon.fc = NOW; s.mon.tepco = NOW; DB.raw.prepare("UPDATE kv SET v=? WHERE k='dis:state'").run(JSON.stringify(s)); DB.raw.prepare("DELETE FROM kv WHERE k LIKE 'disjob:%'").run(); await run(); };
await runNews(); // first run marks init
NOW += 3600e3;
news['噴火 噴火警戒レベル'] = `<rss>${item('北海道駒ヶ岳で噴火を想定した避難訓練')}${item('噴火警戒レベルとは？ 備えを解説')}</rss>`;
news['大津波警報'] = `<rss>${item('東日本大震災15年 大津波警報の教訓')}</rss>`;
await runNews();
ok(!disState().events.some(e => e.type === 'far'), 'drills / features / anniversaries are ignored');
NOW += 13 * 3600e3;
news['噴火 噴火警戒レベル'] = `<rss>${item('浅間山 噴火警戒レベル3に引き上げ 入山規制')}</rss>`;
await runNews();
const far = disState().events.filter(e => e.type === 'far');
ok(far.length === 1 && /浅間山/.test(far[0].detail), 'real alert → far event');
const talkJobs = DB.raw.prepare("SELECT v FROM kv WHERE k LIKE 'disjob:%'").all().map(r => JSON.parse(r.v)).filter(j => j.kind === 'talk');
console.log('  far talkers:', talkJobs.length);
ok(talkJobs.length >= 1 && talkJobs.length <= 2, 'only 1-2 characters mention it');
ok(talkJobs.every(j => j.info.style), 'each has a speaking style');
for (const t of ['北海道に大津波警報', '桜島が噴火', '大雨特別警報を発表 熊本']) { /* pattern sanity */ }
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
