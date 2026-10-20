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
const st0 = (await call('POST', '/settings', { settings: { quietEnabled: false, birthday: '10-14', delayEnabled: false } })).settings;
ok(st0.birthday === '10-14' && st0.lifeEnabled && st0.imagesEnabled && st0.weatherPlace.includes('日進町'), 'settings: birthday/life/images/weather place');
const c = (await call('POST', '/char', { char: { name: 'シャロ', prompt: '一途で嫉妬深い' } })).char;
const rei = (await call('POST', '/char', { char: { name: 'レイ', prompt: 'クール', jealous: 'no' } })).char;
ok(c.jealous === 'auto' && rei.jealous === 'no', 'jealous field');

// talk + photo from user
const forceRandom = (v, fn) => async () => { const R = Math.random; Math.random = () => v; try { return await fn(); } finally { Math.random = R; } };
await call('POST', '/send', { charId: c.id, text: 'こんにちは' }); await forceRandom(0.99, () => call('POST', '/reply', { charId: c.id }))();
const sent = await call('POST', '/send', { charId: c.id, text: '見て', image: 'data:image/png;base64,' + PNG });
ok(sent.message.image, 'photo stored');
const imgRes = await call('GET', '/img?id=' + sent.message.image);
ok(imgRes.headers.get('content-type') === 'image/png' && (await imgRes.arrayBuffer()).byteLength > 50, 'GET /img returns binary');
answer = { photo_edit: '花の冠を描き足す', msgs: ['かわいい写真ですね', 'ちょっと加工しました'] };
const rp = await call('POST', '/reply', { charId: c.id });
const ai = lastAI();
ok(ai.user.includes('[IMG]') && ai.sch.includes('photo_edit'), 'AI sees the new photo and may edit it');
ok(rp.messages.some(m => m.image && m.alt.includes('花の冠')) && calls.some(x => x.image && x.prompt.startsWith('[img]') && x.prompt.includes('描き足さない')), 'edited photo sent back, no people added');
answer = {};
await call('POST', '/send', { charId: c.id, text: '次の話' }); await forceRandom(0.99, () => call('POST', '/reply', { charId: c.id }))();
ok(!lastAI().user.includes('[IMG]') && lastAI().user.includes('（写真を送りました）'), 'old photo not re-sent to AI');

// life context in prompt: weather/season/weekday
ok(lastAI().sys.includes('日進町') && lastAI().sys.includes('雨') && lastAI().sys.includes('季節：秋'), 'weather + season in prompt');

// photo flavor (char sends food photo)
answer = { photo: '焼きたてのブリヌイ', msgs: ['見てください', '焼けました'] };
const pk = await call('POST', '/poke', { charId: c.id, flavor: 'photo' });
ok(pk.messages[1] && pk.messages[1].image && pk.messages[1].alt === '焼きたてのブリヌイ', 'char sends food photo after first bubble');
ok(calls.filter(x => x.image).pop().prompt.includes('人物・キャラクター') , 'char photo prompt forbids people/characters');
answer = {};

// retract
answer = { retract: 0, msgs: ['すき', 'なんでもないです'] };
await call('POST', '/send', { charId: c.id, text: 'ねえ' }); await call('POST', '/send', { charId: c.id, text: 'ねえってば' });
const rr = await forceRandom(0.01, () => call('POST', '/reply', { charId: c.id }))();
ok(lastAI().sch.includes('retract') && lastAI().sys.includes('打ち間違い'), 'retract + typo instructions appear (forced)');
DB.raw.prepare('UPDATE messages SET retract_at=0 WHERE retract_at IS NOT NULL').run();
const sy = await call('GET', '/sync?since=0');
const rmsg = sy.messages.find(m => m.id === rr.messages[0].id);
ok(sy.retracted.includes(rr.messages[0].id) && rmsg.retracted && rmsg.text === '' && !('origText' in rmsg), 'message retracted; original text hidden from app');
answer = {};
await call('POST', '/send', { charId: c.id, text: 'あれ？' }); await forceRandom(0.99, () => call('POST', '/reply', { charId: c.id }))();
ok(lastAI().user.includes('送信を取り消したメッセージ：すき'), 'character remembers what it retracted');

// app closed before reply → cron replies (delays off in this test)
await call('POST', '/send', { charId: c.id, text: '今ひま？' });
DB.raw.prepare("UPDATE messages SET at=at-200000 WHERE char_id=? AND text='今ひま？'").run(c.id);
const t1 = []; await W.scheduled({}, env, { waitUntil: (x) => t1.push(x) }); await Promise.all(t1);
const lt = (await call('GET', '/ping')).lastTick;
ok(lt.done.some(x => x.startsWith('シャロ:reply')), 'cron replies after busy period: ' + JSON.stringify(lt.done));
ok(lt.done.some(x => x.includes('今日の様子')), 'daily life generated');

// memory extraction
answer = { extract: { new: [{ kind: 'plan', text: '土曜に友達と映画', due: '2026-10-17' }, { kind: 'promise', text: '一緒にブリヌイを作る', due: '2026-10-16' }, { kind: 'fact', text: '猫が好き', due: '' }, { kind: 'bogus', text: 'x', due: '' }], done: [], user_state: '少し疲れている', affinity_delta: 2, birthday: '' } };
await call('POST', '/send', { charId: c.id, text: '土曜に友達と映画行くんだ。今度一緒にブリヌイ作ろうね' }); await forceRandom(0.99, () => call('POST', '/reply', { charId: c.id }))();
const ex = await X.extractMemories(env, (await call('GET', '/sync?since=0')).chars.find(x => x.id === c.id), await (async()=> (await call('GET','/sync?since=0')).settings)(), Date.now(), true);
const life = await call('GET', '/life?charId=' + c.id);
ok(ex && life.memories.length === 4 && life.memories.some(m => m.kind === 'user_state') && !life.memories.some(m => m.kind === 'bogus'), 'memories extracted (invalid kind dropped)');
ok(life.affinity === 62, 'affinity drifted +2');
ok(life.today && life.today.mood === 'ご機嫌', 'today state visible');
answer = {};
await call('POST', '/send', { charId: c.id, text: 'ただいま' }); await forceRandom(0.99, () => call('POST', '/reply', { charId: c.id }))();
ok(lastAI().sys.includes('猫が好き') && lastAI().sys.includes('土曜に友達と映画（10/17）') && lastAI().sys.includes('少し疲れている') && lastAI().sys.includes('ご機嫌'), 'memories + mood in prompt');

// followup decisions
const chars = (await call('GET', '/sync?since=0')).chars; const C = chars.find(x => x.id === c.id);
const settings = (await call('GET', '/sync?since=0')).settings;
DB.raw.prepare("UPDATE messages SET at=at-3600000 WHERE char_id=?").run(c.id);
const hist = await (async () => (await call('GET', '/sync?since=0')).messages.filter(m => m.charId === c.id))();
const day = (s) => Date.parse(s + 'T12:00:00+09:00');
const R = Math.random; Math.random = () => 0.01;
let d = await X.lifeDecide(env, C, hist.map(m => ({ ...m, at: day('2026-10-15') - 7200e3 })), day('2026-10-15') - 3600e3, day('2026-10-15'), { ...settings, birthday: '' }, { chars, lastUserActive: day('2026-10-15') - 3600e3 });
ok(d && d.mode === 'followup' && d.phase === 'remind' && d.mem.kind === 'promise', 'promise reminder the day before');
d = await X.lifeDecide(env, C, hist.map(m => ({ ...m, at: day('2026-10-18') - 7200e3 })), day('2026-10-18') - 3600e3, day('2026-10-18'), { ...settings, birthday: '' }, { chars, lastUserActive: day('2026-10-18') - 3600e3 });
ok(d && d.mode === 'followup' && d.phase === 'after', 'follow-up after the date');
// special: birthday
d = await X.lifeDecide(env, C, hist.map(m => ({ ...m, at: day('2026-10-14') - 7200e3 })), day('2026-10-14') - 3600e3, day('2026-10-14'), settings, { chars, lastUserActive: day('2026-10-14') - 3600e3 });
ok(d && d.mode === 'special' && d.occ.key === 'birthday', 'birthday letter');
// absent
d = await X.lifeDecide(env, C, hist.map(m => ({ ...m, at: day('2026-10-16') })), day('2026-10-16'), day('2026-10-20'), { ...settings, birthday: '' }, { chars, lastUserActive: day('2026-10-16') });
ok(d && d.mode === 'absent' && d.days === 4, 'absent 4 days');
// jealousy: user talks a lot with rei
DB.raw.prepare("UPDATE messages SET at=at-8*3600000 WHERE char_id=? AND sender='me'").run(c.id);
for (let i = 0; i < 5; i++) DB.raw.prepare("INSERT INTO messages (char_id,sender,text,at) VALUES (?,?,?,?)").run(rei.id, 'me', 'hi', Date.now());
DB.raw.prepare("UPDATE memories SET status='done'").run();
d = await X.lifeDecide(env, C, hist, Date.now(), Date.now(), { ...settings, birthday: '' }, { chars, lastUserActive: Date.now() });
ok(d && d.mode === 'jealous' && d.sig.names.includes('レイ'), 'jealous char reacts to user talking with others');
const Rei = chars.find(x => x.id === rei.id);
for (let i = 0; i < 6; i++) DB.raw.prepare("INSERT INTO messages (char_id,sender,text,at) VALUES (?,?,?,?)").run(c.id, 'me', 'hi', Date.now());
const reiHist = [{ sender: 'char', at: Date.now() - 3600e3, text: 'x' }];
d = await X.lifeDecide(env, Rei, reiHist, Date.now(), Date.now(), { ...settings, birthday: '' }, { chars, lastUserActive: Date.now() });
ok(!d || d.mode !== 'jealous', 'non-jealous char never gets jealous');
Math.random = R;
// special letter prompt
answer = { msgs: ['お誕生日おめでとうございます。' + 'あ'.repeat(300)] };
const gen = await call('POST', '/poke', { charId: c.id });
console.log('  poke mode:', gen.mode, gen.flavor);
ok(X.occasionsToday({ created: day('2026-07-06') }, { birthday: '' }, day('2026-10-14')).some(o => o.key === 'meet100'), 'meeting 100 days detected');
// ura untouched
await call('POST', '/send', { charId: c.id + '#ura', text: '（手を振る）' }); calls.length = 0; await call('POST', '/reply', { charId: c.id + '#ura' });
ok(!calls[0].sys.includes('日進町') && !calls[0].sys.includes('覚えているユーザー'), 'ura has no weather/memory');
// memory delete
const mid = (await call('GET', '/life?charId=' + c.id)).memories[0].id; await call('POST', '/memory/delete', { id: mid });
ok(!(await call('GET', '/life?charId=' + c.id)).memories.some(m => m.id === mid), 'memory delete');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
