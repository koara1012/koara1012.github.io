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
const sharo = (await call('POST', '/char', { char: { name: 'シャロ', prompt: '一途' } })).char;
const yoru = (await call('POST', '/char', { char: { name: '夜鈴', prompt: '夜の街の子', uraOnly: true, birthday: '10-23' } })).char;
ok(yoru.uraOnly === true && sharo.uraOnly === false, 'uraOnly saved');
let e = ''; try { await call('POST', '/send', { charId: yoru.id, text: 'やあ' }); } catch (x) { e = x.message; }
ok(/裏だけ/.test(e), 'cannot talk to ura-only char in omote');
e = ''; try { await call('POST', '/poke', { charId: yoru.id }); } catch (x) { e = x.message; }
ok(/裏だけ/.test(e), 'no omote test poke');
await call('POST', '/send', { charId: yoru.id + '#ura', text: '（目が合う）' });
const r = await call('POST', '/reply', { charId: yoru.id + '#ura' });
ok(r.messages.length > 0, 'ura talk works');
const st = (await call('GET', '/sync?since=0')).settings;
ok(!(await X.shouldCharPost(env, yoru, 'omote', Date.now(), st)), 'no omote TL posts');
// 表のTLの反応候補にも入らない／裏では入る
const pid = (await call('POST', '/tl/post', { world: 'omote', text: 'おはよう' })).post.id;
await Promise.allSettled(waits);
const scoreO = calls.filter((x) => x.user && x.user.includes('おはよう') && x.sch && x.sch.includes('scores')).pop();
ok(scoreO && !scoreO.user.includes(yoru.id) && scoreO.user.includes(sharo.id), 'omote TL reactions exclude ura-only');
const pid2 = (await call('POST', '/tl/post', { world: 'ura', text: '夜の散歩' })).post.id;
await Promise.allSettled(waits);
const scoreU = calls.filter((x) => x.user && x.user.includes('夜の散歩') && x.sch && x.sch.includes('scores')).pop();
ok(scoreU && scoreU.user.includes(yoru.id), 'ura TL reactions include ura-only');
// くらし：毎日の様子・ほかの子・誕生日に出てこない
calls.length = 0;
const now = Date.parse('2026-10-23T12:00:00+09:00');
const R = Math.random; Math.random = () => 0.0001;
const w = []; await W.scheduled({ scheduledTime: Math.floor(now / 780000) * 780000 }, env, { waitUntil: (p) => w.push(p) }); await Promise.allSettled(w);
Math.random = R;
const daily = calls.filter((x) => x.sch && x.sch.includes('story_finished'));
ok(daily.length >= 1 && daily.every((x) => !x.user.includes('# キャラクター: 夜鈴') && !x.user.includes('夜鈴')), 'daily life only for omote chars, ura-only not listed as friend');
ok(!DB.raw.prepare("SELECT 1 FROM messages WHERE char_id=?").get(yoru.id), 'no omote messages for ura-only char');
const lc = await X.lifeContext(env, sharo, st, now);
ok(!lc.includes('夜鈴'), 'birthday of ura-only char not in omote context');
// 裏のグループには入れる
const g = (await call('POST', '/group', { group: { name: '夜', members: [sharo.id, yoru.id] } })).group;
ok(g.members.includes(yoru.id), 'ura-only char can join groups');
// 表と裏に戻すこともできる
const back = (await call('POST', '/char', { char: { ...yoru, uraOnly: false } })).char;
ok(back.uraOnly === false && (await call('POST', '/send', { charId: yoru.id, text: 'こんにちは' })).message, 'switch back to both worlds');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
