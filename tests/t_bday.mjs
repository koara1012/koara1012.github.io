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
await call('POST', '/settings', { settings: { quietEnabled: false, delayEnabled: false } });
const jstNow = (md, h = 12) => { const y = 2026; return Date.parse(`${y}-${md}T${String(h).padStart(2, '0')}:00:00+09:00`); };
const sharo = (await call('POST', '/char', { char: { name: 'シャロ', prompt: '一途', birthday: '10-24' } })).char;
const iroha = (await call('POST', '/char', { char: { name: '色葉', prompt: 'のんびり', birthday: '10-21' } })).char;
ok(sharo.birthday === '10-24', 'birthday saved');
ok(X.normChar({ birthday: '02-30' }).birthday === '' && X.normChar({ birthday: '13-01' }).birthday === '' && X.normChar({ birthday: '02-29' }).birthday === '02-29', 'invalid dates rejected');
ok(X.daysToMD('10-24', jstNow('10-21')) === 3 && X.daysToMD('10-21', jstNow('10-21')) === 0 && X.daysToMD('10-20', jstNow('10-21')) === 364, 'days until birthday');
ok(X.daysToMD('02-29', Date.parse('2027-02-28T12:00:00+09:00')) === 0, 'Feb 29 celebrated on Feb 28 in non-leap years');
const st = (await call('GET', '/sync?since=0')).settings;
// 返事のとき：あと3日・ほかの子が今日
const lc = await X.lifeContext(env, sharo, st, jstNow('10-21'));
ok(lc.includes('あと3日であなたの誕生日（10月24日）') && lc.includes('今日は色葉さんの誕生日'), 'reply context: own soon + other today');
const lc2 = await X.lifeContext(env, iroha, st, jstNow('10-21'));
ok(lc2.includes('今日はあなた（色葉）の誕生日'), 'reply context: own birthday today');
// 自分の誕生日は知っている（いつでも）
await call('POST', '/send', { charId: sharo.id, text: '誕生日いつ？' });
calls.length = 0;
const R = Math.random; Math.random = () => 0.99; await call('POST', '/reply', { charId: sharo.id }); Math.random = R;
ok(calls.filter((x) => x.sch && x.sch.includes('messages')).pop().sys.includes('あなたの誕生日：10月24日'), 'char knows own birthday');
// 特別な日：自分の誕生日に話しかける
const occ = X.occasionsToday(iroha, st, jstNow('10-21'), [sharo, iroha]);
ok(occ.some((o) => o.key === 'charbday') && !occ.some((o) => o.other), 'own birthday is an occasion');
const occS = X.occasionsToday(sharo, st, jstNow('10-21'), [sharo, iroha]);
ok(occS.some((o) => o.label === '色葉さんの誕生日' && o.other), 'other char birthday is a TL occasion');
const histI = [{ id: 1, sender: 'char', text: 'やあ', at: jstNow('10-21', 9) }];
const d = await (async () => { Math.random = () => 0.1; try { return await X.lifeDecide(env, iroha, histI, jstNow('10-21', 9), jstNow('10-21', 12), st, { chars: [sharo, iroha], lastUserActive: jstNow('10-21', 9) }); } finally { Math.random = R; } })();
ok(d && d.mode === 'special' && d.occ.key === 'charbday', 'birthday char reaches out on the day');
const dS = await (async () => { Math.random = () => 0.1; try { return await X.lifeDecide(env, sharo, histI, jstNow('10-21', 9), jstNow('10-21', 12), st, { chars: [sharo, iroha], lastUserActive: jstNow('10-21', 9) }); } finally { Math.random = R; } })();
ok(!dS || dS.occ?.key !== 'obday:' + iroha.id, 'others do not send a birthday letter about someone else');
// 毎日の様子：誕生日の子がいると一緒に過ごしやすい・自分の誕生日は予定に
answer.daily = null; calls.length = 0;
Math.random = () => 0.5; await X.dailyUpdate(env, sharo, st, jstNow('10-21', 7), true); Math.random = R;
const du = calls.find((x) => x.sch && x.sch.includes('story_finished')).user;
ok(du.includes('今日は 色葉さん の誕生日') && du.includes('ほかの子のうち誰かと一緒に過ごす'), 'daily: birthday raises chance to meet');
calls.length = 0;
await X.dailyUpdate(env, iroha, st, jstNow('10-21', 7), true);
ok(calls.find((x) => x.sch && x.sch.includes('story_finished')).user.includes('今日はあなたの誕生日'), 'daily: own birthday');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
