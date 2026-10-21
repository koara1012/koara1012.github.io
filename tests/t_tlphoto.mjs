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
const sharo = (await call('POST', '/char', { char: { name: 'シャロ', prompt: '紅茶が好き' } })).char;
// 写真の説明は、AI（偽物）が写真を見て返す
const realFetch = globalThis.fetch;
let sawImage = false;
globalThis.fetch = async (u, i) => {
  if (i && i.body && String(i.body).includes('photo_alt') || (i && i.body && String(i.body).includes('写真の内容を短く正確に'))) {
    sawImage = String(i.body).includes('inlineData') || String(i.body).includes('image_url');
    const t = JSON.stringify({ alt: '窓辺に置かれた湯気の立つ紅茶のカップ' });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] }));
  }
  return realFetch(u, i);
};
const img = 'data:image/png;base64,' + PNG;
let e = ''; try { await call('POST', '/tl/post', { world: 'omote', text: '' }); } catch (x) { e = x.message; }
ok(/空/.test(e), 'empty post rejected');
const r = await call('POST', '/tl/post', { world: 'omote', text: '', image: img });
ok(r.post.image && r.post.text === '', 'photo-only post accepted');
const row0 = DB.raw.prepare('SELECT * FROM tl_posts WHERE id=?').get(r.post.id);
await Promise.allSettled(waits);
const row = DB.raw.prepare('SELECT * FROM tl_posts WHERE id=?').get(r.post.id);
ok(row0.planned === 1 && sawImage && row.alt.includes('紅茶のカップ'), 'AI looked at the photo before planning reactions');
const scoreCall = calls.filter((x) => x.user && x.user.includes('添付写真')).pop();
ok(scoreCall && scoreCall.user.includes('紅茶のカップ') && scoreCall.user.includes('写真だけの投稿'), 'reaction planning sees the photo description');
const tl = await call('GET', '/tl?world=omote');
ok(tl.posts[0].image === r.post.image && tl.posts[0].alt.includes('紅茶'), 'timeline returns the photo');
const ctxT = await X.tlContextForTalk(env, sharo, 'omote');
ok(ctxT.includes('（写真：窓辺'), 'talk knows about the photo post');
// 説明に失敗しても、反応は止まらない
globalThis.fetch = async (u, i) => { if (i && i.body && String(i.body).includes('写真の内容を短く正確に')) return new Response('err', { status: 500 }); return realFetch(u, i); };
waits.length = 0;
const r2 = await call('POST', '/tl/post', { world: 'ura', text: 'これ見て', image: img });
await Promise.allSettled(waits);
const row2 = DB.raw.prepare('SELECT * FROM tl_posts WHERE id=?').get(r2.post.id);
ok(row2.planned === 1 && row2.alt.includes('よくわからない'), 'description failure still lets reactions run (planned after fallback)');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
