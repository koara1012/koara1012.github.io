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
import nodeCrypto from 'node:crypto';
// 1) known vector from Bark issue #186
const ct = await X.barkEncrypt('hgffbiytrc4686gj', 'gggvjkoptdaz5806', '{"body": "test", "sound": "birdsong"}');
ok(ct === 'du82KA6U/qfw+j1fPcQwUI6PKWB/sPYhJ07m6WePG9MADxFg34Q39ECAEOzNG6zx', 'ciphertext matches Bark\'s published example');
// 2) end to end with fake Bark server
const barkHits = []; const F = globalThis.fetch;
globalThis.fetch = async (u, i) => { if (String(u).startsWith('https://api.day.app/')) { barkHits.push({ u: String(u), body: i.body.toString() }); return new Response('{"code":200}'); } return F(u, i); };
env.BARK_DEVICE_KEY = 'DEVKEY123'; env.BARK_ENC_KEY = 'abcdefghijklmnop';
const PNGB64 = PNG;
const c = (await call('POST', '/char', { char: { name: 'シャロ', prompt: 'p', icon: 'data:image/png;base64,' + PNGB64 } })).char;
await call('GET', '/sync?since=0'); // remembers origin
await new Promise(r => setTimeout(r, 50)); await Promise.all(waits);
await call('POST', '/settings', { settings: { notifyVia: 'bark', barkSound: 'mysound.caf', delayEnabled: false } });
const st = (await call('GET', '/sync?since=0')).settings;
ok(st.barkSound === 'mysound', 'sound name normalized');
const t = await call('POST', '/test-bark', { charId: c.id });
ok(t.encrypted && t.icon && t.sound === 'mysound', 'test-bark: encrypted, icon, sound');
const hit = barkHits.pop();
const form = new URLSearchParams(hit.body);
ok(hit.u === 'https://api.day.app/DEVKEY123' && /^[A-Za-z0-9]{16}$/.test(form.get('iv')), 'posted to device URL with random 16-char iv');
const dec = nodeCrypto.createDecipheriv('aes-128-cbc', Buffer.from('abcdefghijklmnop'), Buffer.from(form.get('iv')));
const plain = JSON.parse(dec.update(form.get('ciphertext'), 'base64', 'utf8') + dec.final('utf8'));
console.log('  decrypted:', plain);
ok(plain.title === 'シャロ' && plain.sound === 'mysound' && plain.group === 'シャロ' && /\/icon\/.+\/[0-9a-f]{32}\.png\?v=/.test(plain.icon), 'payload has title/sound/group/icon');
// 3) public icon endpoint
const path = new URL(plain.icon).pathname;
const r1 = await W.fetch(new Request('https://w' + path), env, ctx);
ok(r1.status === 200 && r1.headers.get('Content-Type') === 'image/png' && (await r1.arrayBuffer()).byteLength > 50, 'icon served without token');
const r2 = await W.fetch(new Request('https://w' + path.replace(/[0-9a-f]{32}/, '0'.repeat(32))), env, ctx);
ok(r2.status === 404, 'wrong signature → 404');
const r3 = await W.fetch(new Request('https://w/sync'), env, ctx);
ok(r3.status === 401, 'other routes still need token');
// 4) chat message → Bark only (no web push), TL comment → Bark with actor icon
barkHits.length = 0;
await call('POST', '/send', { charId: c.id, text: 'やあ' });
const rp = await call('POST', '/poke', { charId: c.id }); await Promise.all(waits);
ok(barkHits.length === 1, 'proactive message → Bark');
// 5) via=web → no Bark
await call('POST', '/settings', { settings: { notifyVia: 'web' } });
barkHits.length = 0; await call('POST', '/poke', { charId: c.id }); await Promise.all(waits);
ok(barkHits.length === 0, 'web mode → no Bark');
// 6) no encryption key → plain JSON to /push
await call('POST', '/settings', { settings: { notifyVia: 'both' } });
delete env.BARK_ENC_KEY; barkHits.length = 0;
await call('POST', '/test-bark', { charId: c.id });
const h2 = barkHits.pop(); const j2 = JSON.parse(h2.body);
ok(h2.u === 'https://api.day.app/push' && j2.device_key === 'DEVKEY123' && j2.title === 'シャロ', 'unencrypted fallback');
const bs = await call('GET', '/bark/status');
ok(bs.deviceKey && !bs.encrypted, 'status endpoint');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
