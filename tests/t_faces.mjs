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
  else if (sch.includes('"score"')) out = { score: answer.jealous ?? 90 };
  else if (sch.includes('keywords')) out = { keywords: ['料理'] };
  else if (sch.includes('scores')) out = { scores: [] };
  else if (sch.includes('"text"')) out = { text: 'つぶやき' };
  else { out = { messages: answer.msgs || ['返事'] }; for (const k of ['used_news', 'retract']) if (sch.includes(k)) out[k] = answer[k] ?? -1; for (const k of ['photo', 'photo_edit']) if (sch.includes(k)) out[k] = answer[k] ?? ''; }
  const t = JSON.stringify(out);
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: t } }] } : { candidates: [{ content: { parts: [{ text: t }] } }] }));
};

// 裏の返事に、立ち絵の表情（ノベル画面用）を付ける：POST /faces・《表情名》を外して face 列へ
const sys = () => { const b = calls.filter(c => c.sch && c.sch.includes('messages')).pop(); return b ? b.sys : ''; };
const usr = () => { const b = calls.filter(c => c.sch && c.sch.includes('messages')).pop(); return b ? b.user : ''; };
const a = (await call('POST', '/char', { char: { name: '朱里', prompt: 'p' } })).char;
const b = (await call('POST', '/char', { char: { name: 'るか', prompt: 'p' } })).char;
// 表情が無いときは今までどおり
answer.msgs = ['《照れ》こんにちは'];
await call('POST', '/send', { charId: a.id + '#ura', text: 'やあ' });
let r = await call('POST', '/reply', { charId: a.id + '#ura' });
ok(!sys().includes('《表情名》'), 'no faces → no face rule');
ok(r.messages[0].text === '《照れ》こんにちは' && !r.messages[0].face, 'no faces → text untouched');
// 1つだけなら登録しない
let f = await call('POST', '/faces', { charId: a.id, faces: [{ name: '通常' }] });
ok(f.faces.length === 0, 'single face is not stored');
let e = ''; try { await call('POST', '/faces', { charId: 'nobody', faces: [] }); } catch (x) { e = x.message; }
ok(e.includes('404') || e.includes('見つかりません'), 'unknown char rejected');
f = await call('POST', '/faces', { charId: a.id, faces: [{ name: '通常', desc: 'いつもの顔' }, { name: '照れ', desc: '頬を赤くして目をそらす' }, { name: '照れ' }, { name: '《泣き》\n', desc: '泣きそう' }, { name: '' }] });
ok(f.faces.map(x => x.name).join(',') === '通常,照れ,泣き', 'faces normalized: ' + f.faces.map(x => x.name).join(','));
answer.msgs = ['＊《照れ》彼女は目をそらした。', '《照れ》……あ、ありがとうございます', '《知らない顔》えっと', '「《泣き》すみません」'];
await call('POST', '/send', { charId: a.id + '#ura', text: 'かわいいね' });
r = await call('POST', '/reply', { charId: a.id + '#ura' });
ok(sys().includes('《表情名》') && sys().includes('照れ（頬を赤くして目をそらす）'), 'face rule with candidates in prompt');
ok(usr().includes('こんにちは'), 'history passed');
const [n1, m1, m2] = r.messages;
ok(n1.sender === 'narr' && n1.text === '彼女は目をそらした。' && !n1.face, 'narration: tag removed, no face');
ok(m1.text === '……あ、ありがとうございます' && m1.face === '照れ', 'char: face taken');
ok(m2.text === 'えっと' && !m2.face, 'unknown face: tag removed, no face');
ok(r.messages.length === 3 || (r.messages[3] && !r.messages[3].text.includes('《')), 'quoted tag not shown: ' + JSON.stringify(r.messages[3] || null));
// /sync でも face が返る・次の会話ではAIに《照れ》付きで渡す
const s = await call('GET', '/sync?since=0');
ok(s.messages.some(m => m.id === m1.id && m.face === '照れ'), 'sync returns face');
answer.msgs = ['うん'];
await call('POST', '/send', { charId: a.id + '#ura', text: 'ほんとだよ' });
await call('POST', '/reply', { charId: a.id + '#ura' });
ok(usr().includes('《照れ》……あ、ありがとうございます'), 'history includes face tag');
// グループ：表情のある人だけ
const g = (await call('POST', '/group', { group: { name: '部活', members: [a.id, b.id], synopsis: 'コート' } })).group;
answer.msgs = [{ who: 'ナレーション', text: '夕方のコート。' }, { who: '朱里', text: '《泣き》す、すみません' }, { who: 'るか', text: '《照れ》もう、朱里ったら' }];
await call('POST', '/send', { charId: g.id + '#ura', text: 'おつかれ' });
r = await call('POST', '/reply', { charId: g.id + '#ura' });
ok(sys().includes('朱里：通常') && !sys().includes('るか：'), 'group rule lists only members with faces');
const ga = r.messages.find(m => m.speaker === a.id), gb = r.messages.find(m => m.speaker === b.id);
ok(ga && ga.text === 'す、すみません' && ga.face === '泣き', 'group: face taken');
ok(gb && gb.text === 'もう、朱里ったら' && !gb.face, 'group: member without faces gets no face, tag removed');
// 消すと今までどおり
f = await call('POST', '/faces', { charId: a.id, faces: [] });
answer.msgs = ['ふつう'];
await call('POST', '/send', { charId: a.id + '#ura', text: 'ね' });
await call('POST', '/reply', { charId: a.id + '#ura' });
ok(!sys().includes('《表情名》'), 'cleared faces → no rule');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
