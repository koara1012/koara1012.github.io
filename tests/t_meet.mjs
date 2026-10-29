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


// 会う約束（第39版・試作）：返事と一緒に約束を記録・二段の通知・モードのオン／オフ・延期・会う場面・まとめ
const barkHits = []; const F0 = globalThis.fetch;
globalThis.fetch = async (u, i) => { if (String(u).startsWith('https://api.day.app/')) { barkHits.push(JSON.parse(i.body)); return new Response('{"code":200}'); } return F0(u, i); };
env.BARK_DEVICE_KEY = 'dev';
const mainCall = () => calls.filter(c => c.sch && c.sch.includes('messages')).pop() || {};
const lastSch = () => mainCall().sch || '';
const lastSys = () => mainCall().sys || '';
const getAppt = async (id) => (await call('GET', '/sync?since=0')).appts[id] || null;
const setAppt = (id, a) => DB.raw.prepare('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run('appt:' + id, JSON.stringify(a));
await call('POST', '/settings', { settings: { delayEnabled: false, notifyVia: 'bark', lifeEnabled: false } });
const c = (await call('POST', '/char', { char: { name: '朱里', prompt: 'p' } })).char;
const say = async (t) => { await call('POST', '/send', { charId: c.id, text: t }); return call('POST', '/reply', { charId: c.id }); };
// 使わない（既定）：今までどおり
answer.meet = { status: 'set', date: '2099-01-01', time: '18:00', place: '駅' };
await say('こんにちは');
ok(!lastSch().includes('meet_status') && !lastSys().includes('実際に会うこと'), 'feature off: schema/prompt untouched');
ok(!(await getAppt(c.id)), 'feature off: no appointment');
// 使う：返事と一緒に約束を記録
await call('POST', '/settings', { settings: { meetFeature: true } });
const tmr = new Date(Date.now() + 864e5 + 9 * 3600e3).toISOString().slice(0, 10);
answer.meet = { status: 'set', date: tmr, time: '18:00', place: '駅前のカフェ' };
await say('明日18時に駅前のカフェで会おう');
ok(lastSch().includes('meet_status'), 'feature on: schema has meet fields');
let a = await getAppt(c.id);
ok(a && a.status === 'set' && a.place === '駅前のカフェ' && a.at === Date.parse(tmr + 'T18:00:00+09:00'), 'appointment stored: ' + JSON.stringify(a));
answer.meet = { status: '', date: '', time: '', place: '' };
await say('楽しみ');
ok(lastSys().includes('会う約束をしている') && lastSys().includes('駅前のカフェ'), 'prompt mentions appointment');
ok((await getAppt(c.id)).at === a.at, 'empty status keeps appointment');
answer.meet = { status: 'set', date: tmr, time: '19:30', place: '' };
await say('やっぱり19時半で');
a = await getAppt(c.id);
ok(a.time === '19:30' && a.place === '駅前のカフェ', 'changed time keeps place');
answer.meet = { status: 'set', date: '2001-01-01', time: '10:00', place: 'x' };
await say('昔の話');
ok((await getAppt(c.id)).time === '19:30', 'past date ignored');
// 二段の通知
answer.meet = { status: '', date: '', time: '', place: '' };
setAppt(c.id, { ...a, at: Date.now() + 10 * 60e3, n1: false, n2: false });
await X.runAppointments(env);
ok(barkHits.length === 1 && barkHits[0].title.includes('そろそろ') && String(barkHits[0].url).includes('meet=' + c.id), 'soon notification with url: ' + JSON.stringify(barkHits[0]));
await X.runAppointments(env);
ok(barkHits.length === 1, 'not repeated');
setAppt(c.id, { ...(await getAppt(c.id)), at: Date.now() - 60e3 });
await X.runAppointments(env);
ok(barkHits.length === 2 && barkHits[1].title.includes('待っています'), 'at-time notification');
setAppt(c.id, { ...(await getAppt(c.id)), at: Date.now() - 3 * 3600e3 });
await X.runAppointments(env);
ok((await getAppt(c.id)).status === 'missed', 'missed after 2h');
await say('ごめん');
ok(lastSys().includes('ユーザーは来なかった'), 'prompt: disappointed/worried');
// キャラごとにモードをオフ
setAppt(c.id, { date: tmr, time: '18:00', place: '公園', at: Date.now() - 60e3, status: 'set', n1: false, n2: false });
await call('POST', '/settings', { settings: { meetOffChars: [c.id] } });
const hits0 = barkHits.length;
await X.runAppointments(env);
ok((await getAppt(c.id)).status === 'postponed' && barkHits.length === hits0, 'mode off: postponed, no notification');
await say('ひま？');
ok(!lastSch().includes('meet_status') && lastSys().includes('とても忙しく') && lastSys().includes('催促しない'), 'mode off: no detection, busy note');
await call('POST', '/settings', { settings: { meetOffChars: [] } });
ok((await getAppt(c.id)).status === 'replan', 'turning on → replan');
await say('ただいま');
ok(lastSys().includes('今回の返事で、日時を決め直そう'), 'prompt: propose new date');
// 全員まとめてオフも同じ
await call('POST', '/settings', { settings: { meetOn: false } });
await say('いそがしい');
ok(lastSys().includes('とても忙しく') && !lastSch().includes('meet_status'), 'global mode off');
await call('POST', '/settings', { settings: { meetOn: true } });
// 取りやめ
answer.meet = { status: 'cancel', date: '', time: '', place: '' };
await say('やっぱりやめよう');
ok(!(await getAppt(c.id)), 'cancelled by conversation');
// 帯のボタン
setAppt(c.id, { date: tmr, time: '18:00', place: '公園', at: Date.now() + 864e5, status: 'set' });
ok((await call('POST', '/appt', { charId: c.id, action: 'replan' })).appt.status === 'replan', 'appt replan');
ok((await call('POST', '/appt', { charId: c.id, action: 'cancel' })).appt === null && !(await getAppt(c.id)), 'appt cancel');
let e = ''; try { await call('POST', '/appt', { charId: 'nobody', action: 'cancel' }); } catch (x) { e = x.message; }
ok(e.includes('見つかりません'), 'unknown char 404');
// 会う場面（表情は表用）
answer.meet = { status: '', date: '', time: '', place: '' };
setAppt(c.id, { date: tmr, time: '18:00', place: '駅前のカフェ', at: Date.now() - 60e3, status: 'set', n1: true, n2: true });
await call('POST', '/faces', { charId: c.id, kind: 'omote', faces: [{ name: '通常' }, { name: '照れ', desc: '頬を赤くする' }] });
answer.msgs = ['＊駅前のカフェの前で、朱里が小さく手を振った。', '《照れ》あ……来てくださったんですね'];
let m = await call('POST', '/meet/start', { charId: c.id });
ok(m.appt.status === 'meeting' && m.lines.length === 2 && m.lines[0].who === 'narr' && m.lines[1].face === '照れ' && m.lines[1].text === 'あ……来てくださったんですね', 'meet start: opening with face ' + JSON.stringify(m.lines));
ok(lastSys().includes('実際に会っている場面') && lastSys().includes('駅前のカフェ') && lastSys().includes('最近のトーク') && lastSys().includes('照れ（頬を赤くする）'), 'meet prompt: talk history, place, omote faces');
ok(!mainCall().grok, 'meet uses omote AI (Gemini)');
m = await call('POST', '/meet/start', { charId: c.id });
ok(m.lines.length === 0 && m.log.length === 2, 'second start: no new opening');
answer.msgs = ['ケーキ、おいしいですね……'];
m = await call('POST', '/meet/say', { charId: c.id, text: 'ケーキ食べよう' });
ok(m.lines[0].text === 'ケーキ、おいしいですね……', 'meet say');
const g = await call('GET', '/meet?charId=' + c.id);
ok(g.log.length === 4 && g.log[2].who === 'me' && g.on === true && g.feature === true, 'meet log');
answer.msgs = ['返事'];
await say('今会ってるね');
ok(lastSys().includes('今まさに「駅前のカフェ」でユーザーと実際に会っている最中'), 'LINE prompt: meeting now');
m = await call('POST', '/meet/end', { charId: c.id });
ok(m.appt.status === 'done' && m.appt.summary.includes('ケーキ'), 'meet end: summary');
ok(DB.raw.prepare("SELECT text FROM memories WHERE char_id=? AND kind='fact'").all(c.id).some(r => r.text.includes('実際に会った')), 'summary saved as memory');
ok(!(await call('GET', '/meet?charId=' + c.id)).log.length, 'meet log cleared');
await say('楽しかったね');
ok(lastSys().includes('ユーザーと実際に会った。そのときの様子'), 'LINE prompt: remembers meeting');
// 終え忘れは6時間で自動で終える
setAppt(c.id, { place: '公園', at: 0, status: 'meeting', metAt: Date.now() - 7 * 3600e3 });
DB.raw.prepare('INSERT INTO kv (k,v) VALUES (?,?)').run('meetlog:' + c.id, JSON.stringify([{ who: 'me', text: 'やあ' }, { who: 'char', text: 'こんにちは' }]));
await X.runAppointments(env);
ok((await getAppt(c.id)).status === 'done', 'meeting auto-ended after 6h');
await call('POST', '/settings', { settings: { meetFeature: false } });
setAppt(c.id, { place: '', at: 0, status: 'meeting', metAt: Date.now() - 7 * 3600e3 });
await X.runAppointments(env);
ok((await getAppt(c.id)).status === 'done', 'meeting auto-ended even when feature off');
await call('POST', '/settings', { settings: { meetFeature: true } });
// キャラを消すと片付く
await call('DELETE', '/char?id=' + c.id);
ok(!DB.raw.prepare('SELECT k FROM kv WHERE k IN (?,?,?)').all('appt:' + c.id, 'facesO:' + c.id, 'meetlog:' + c.id).length, 'char delete cleans kv');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
