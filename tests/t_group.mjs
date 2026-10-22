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
  if (sch.includes('"who"')) out = answer.group || { messages: [{ who: 'ナレーション', text: '雨音が響く' }] };
  else if (sch.includes('affinity_delta')) out = answer.extract || { new: [], done: [], user_state: '', affinity_delta: 0, birthday: '' };
  else if (sch.includes('story_finished')) out = answer.daily || { mood: 'ご機嫌', mood_reason: '晴れたから', today: 'ブリヌイを焼く', diary: '本を読んだ', story_title: '', story_update: '', story_finished: false, busy: 20 };
  else if (sch.includes('"score"')) out = { score: answer.jealous ?? 90 };
  else if (sch.includes('keywords')) out = { keywords: ['料理'] };
  else if (sch.includes('scores')) out = { scores: [] };
  else if (sch.includes('"text"')) out = { text: 'つぶやき' };
  else { out = { messages: answer.msgs || ['返事'] }; for (const k of ['used_news', 'retract']) if (sch.includes(k)) out[k] = answer[k] ?? -1; for (const k of ['photo', 'photo_edit']) if (sch.includes(k)) out[k] = answer[k] ?? ''; }
  const t = JSON.stringify(out);
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: t } }] } : { candidates: [{ content: { parts: [{ text: t }] } }] }));
};
await call('POST', '/me', { world: 'ura', name: '転校生' });
const sharo = (await call('POST', '/char', { char: { name: 'シャロ', prompt: 'ロシアの子。一人称は私', uraName: 'シャロ' } })).char;
const iroha = (await call('POST', '/char', { char: { name: '色葉', prompt: 'のんびり屋。一人称はうち' } })).char;
const mito = (await call('POST', '/char', { char: { name: '三郷', prompt: '囲碁好き' } })).char;
let e = ''; try { await call('POST', '/group', { group: { name: 'x', members: [] } }); } catch (x) { e = x.message; }
ok(/メンバー/.test(e), 'group needs members');
const g = (await call('POST', '/group', { group: { name: '雨の談話室', members: [sharo.id, iroha.id, 'nobody'], synopsis: '雨の放課後、寮の談話室に三人だけが残っていた。', length: 'normal' } })).group;
ok(g.id.startsWith('grp-') && g.members.length === 2, 'group created (unknown member dropped)');
let sy = await call('GET', '/sync?since=0');
ok(sy.groups.length === 1 && sy.groups[0].synopsis.includes('談話室'), 'sync returns groups');
const K = g.id + '#ura';
e = ''; try { await call('POST', '/send', { charId: g.id, text: 'hi' }); } catch (x) { e = x.message; }
ok(/裏/.test(e), 'groups are ura-only');
// 物語を始める（まだ何もないとき）
answer.group = { messages: [{ who: 'ナレーション', text: '窓を打つ雨。ランプの灯りが揺れる。' }, { who: 'シャロ', text: '……転校生さん、まだいたんですね' }, { who: '色葉', text: 'あ、ちょうどよかった〜' }] };
calls.length = 0;
let r = await call('POST', '/reply', { charId: K, start: true });
ok(r.messages.length === 3 && r.messages[0].sender === 'narr' && r.messages[1].speaker === sharo.id && r.messages[2].speaker === iroha.id, 'start: narration + two speakers');
const sys0 = calls.filter((x) => x.sch && x.sch.includes('"who"')).pop();
ok(sys0.sys.includes('雨の放課後') && sys0.sys.includes('## シャロ') && sys0.sys.includes('## 色葉') && !sys0.sys.includes('囲碁') && sys0.sys.includes('小説の書き出し') && sys0.sys.includes('転校生'), 'system has synopsis, members only, start instruction, user name');
ok((await call('POST', '/reply', { charId: K, start: true })).messages.length === 0, 'no second start once begun');
// ふつうのやり取り
await call('POST', '/send', { charId: K, text: '（タオルを差し出して）濡れてない？' });
answer.group = { messages: [{ who: 'シャロ', text: '「ありがとうございます」' }, { who: '謎の人', text: 'こんばんは' }, { who: '＊', text: '＊色葉が笑う' }] };
calls.length = 0;
r = await call('POST', '/reply', { charId: K });
ok(r.messages[0].text === 'ありがとうございます' && r.messages[1].sender === 'narr' && r.messages[1].text.includes('謎の人「こんばんは」') && r.messages[2].sender === 'narr' && r.messages[2].text === '色葉が笑う', 'quotes stripped, unknown speaker → narration, ＊ → narration');
const c1 = calls.filter((x) => x.sch && x.sch.includes('"who"')).pop();
ok(c1.user.includes('【シャロ】……転校生さん') && c1.user.includes('＊窓を打つ雨'), 'history shows who said what');
sy = await call('GET', '/sync?since=0');
const gm = sy.messages.filter((m) => m.charId === K);
ok(gm.length === 7 && gm.some((m) => m.speaker === iroha.id), 'sync carries group messages with speakers');
// 裏を止めているとき
await call('POST', '/settings', { settings: { uraPaused: true } });
await call('POST', '/send', { charId: K, text: 'おーい' });
ok((await call('POST', '/reply', { charId: K })).paused === true && (await call('POST', '/reply/decide', { charId: K })).now === false, 'ura pause applies to groups');
await call('POST', '/settings', { settings: { uraPaused: false } });
// リセット：会話だけ消えて、あらすじとメンバーは残る
await call('POST', '/clear', { charId: K });
sy = await call('GET', '/sync?since=0');
ok(!sy.messages.some((m) => m.charId === K) && sy.groups[0].synopsis.includes('談話室') && sy.groups[0].members.length === 2, 'reset keeps synopsis and members');
// 編集：名前・あらすじを変える
const g2 = (await call('POST', '/group', { group: { ...g, name: '夜の談話室', members: [sharo.id, iroha.id, mito.id] } })).group;
ok(g2.id === g.id && g2.name === '夜の談話室' && g2.members.length === 3 && g2.created === g.created, 'group updated in place');
// キャラを消すとメンバーから外れる
await call('DELETE', '/char?id=' + mito.id);
ok((await call('GET', '/sync?since=0')).groups[0].members.length === 2, 'deleted char leaves the group');
// バックアップ・中身の確認
await call('POST', '/send', { charId: K, text: 'ただいま' });
const ex = await (await W.fetch(new Request('https://w/export', { headers: { 'X-App-Token': 'pw' } }), env, ctx)).json();
ok(ex.tables.groups && ex.tables.groups.length === 1 && ex.counts.groups === 1, 'groups included in backup');
const ck = await call('GET', '/backup/check');
ok(!ck.warnings.some((w) => w.includes('持ち主')), 'group messages are not flagged as orphans');
// 削除
await call('DELETE', '/group?id=' + g.id);
sy = await call('GET', '/sync?since=0');
ok(!sy.groups.length && !sy.messages.some((m) => m.charId === K), 'group deleted with its messages');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
