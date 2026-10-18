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
  else if (sch.includes('"text"')) { out = { text: 'つぶやき' }; if (sch.includes('"photo"')) out.photo = '窓辺のティーセット'; }
  else { out = { messages: answer.msgs || ['返事'] }; for (const k of ['used_news', 'retract']) if (sch.includes(k)) out[k] = answer[k] ?? -1; for (const k of ['photo', 'photo_edit']) if (sch.includes(k)) out[k] = answer[k] ?? ''; }
  const t = JSON.stringify(out);
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: t } }] } : { candidates: [{ content: { parts: [{ text: t }] } }] }));
};
const forceRandom = (v, fn) => async () => { const R = Math.random; Math.random = () => v; try { return await fn(); } finally { Math.random = R; } };
const md = new Date(Date.now() + 9 * 3600e3).toISOString().slice(5, 10);
await call('POST', '/settings', { settings: { quietEnabled: false, birthday: md } });
const c = (await call('POST', '/char', { char: { name: 'シャロ', prompt: 'ロシア出身。紅茶とバレエが好き' } })).char;
await call('POST', '/char', { char: { name: 'レイ', prompt: 'クール' } });
const st = (await call('GET', '/sync?since=0')).settings;
await X.dailyUpdate(env, (await call('GET', '/sync?since=0')).chars.find(x => x.name === 'シャロ'), st, Date.now(), true);
const postCall = () => calls.filter(x => !x.image && x.sch && x.sch.includes('"text"') && x.sys.includes('自分の投稿')).pop();

// photo theme
calls.length = 0;
const p1 = (await forceRandom(0.999, () => call('POST', '/tl/poke', { charId: c.id, world: 'omote' }))()).post;
ok(p1.image && p1.alt === '窓辺のティーセット', 'photo post has image: ' + JSON.stringify({ image: p1.image, alt: p1.alt }));
const ic = calls.find(x => x.image);
ok(ic && ic.prompt.includes('ティーセット') && ic.prompt.includes('人物'), 'image prompt keeps no-people rule');
ok(postCall().user.includes('今日の様子') && postCall().user.includes('天気'), 'TL post sees mood + weather');
const tl = await call('GET', '/tl?world=omote');
ok(tl.posts[0].image === p1.image && tl.posts[0].alt, 'GET /tl returns image');
const img = await call('GET', '/img?id=' + p1.image);
ok(img.ok, '/img serves TL photo');

// comments know the photo
await X.runTlJobs(env, 5); await Promise.all(waits);
const plan = calls.find(x => x.user && x.user.includes('判定するキャラクター'));
ok(!plan || plan.user.includes('添付写真：窓辺のティーセット'), 'reaction planning sees the photo' + (plan ? '' : ' (no other chars; skipped)'));

// occasion (images off so photo theme is out)
await call('POST', '/settings', { settings: { imagesEnabled: false } });
calls.length = 0;
const p2 = (await forceRandom(0.999, () => call('POST', '/tl/poke', { charId: c.id, world: 'omote' }))()).post;
ok(!p2.image && postCall().user.includes('ユーザーの誕生日'), 'occasion theme (birthday)');
calls.length = 0;
await forceRandom(0.999, () => call('POST', '/tl/poke', { charId: c.id, world: 'omote' }))();
ok(!postCall().user.includes('ユーザーの誕生日') && postCall().user.includes('今日の天気や気温'), 'occasion only once a day → weather next');
ok(calls.filter(x => x.image).length === 0, 'no image when images disabled');

// ura untouched
await call('POST', '/settings', { settings: { imagesEnabled: true } });
calls.length = 0;
const p4 = (await forceRandom(0.999, () => call('POST', '/tl/poke', { charId: c.id, world: 'ura' }))()).post;
ok(!p4.image && !postCall().user.includes('今日の様子') && !postCall().user.includes('天気'), 'ura TL has no life/photo');

// life off → plain
await call('POST', '/settings', { settings: { lifeEnabled: false } });
calls.length = 0;
const p5 = (await forceRandom(0.999, () => call('POST', '/tl/poke', { charId: c.id, world: 'omote' }))()).post;
ok(!p5.image && !postCall().user.includes('今日の様子'), 'life disabled → plain TL post');
await call('POST', '/settings', { settings: { lifeEnabled: true } });

// talk photo subjects broadened
calls.length = 0;
await call('POST', '/send', { charId: c.id, text: 'やあ' });
await forceRandom(0.99, () => call('POST', '/reply', { charId: c.id }))();
const r = await call('POST', '/poke', { charId: c.id, flavor: 'photo' });
const talk = calls.filter(x => !x.image && x.sch && x.sch.includes('messages')).pop();
ok(talk && (talk.sys + talk.sch + talk.user).includes('あなたにまつわる物'), 'talk photo allows character-related items');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
