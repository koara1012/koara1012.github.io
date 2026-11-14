// 第70版：ボイスメッセージ（表の個人トーク）。あなたから送る・キャラが声で返す・気まぐれに送る・声は R2・静かな時間は音なしの通知
import W from './worker.mjs';
import { makeDB } from './fake.mjs';
const DB = makeDB();
const store = new Map();
const R2 = {
  async put(k, b) { store.set(k, Buffer.from(typeof b === 'string' ? b : new Uint8Array(b))); },
  async get(k) { const b = store.get(k); return b ? { text: async () => b.toString(), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) } : null; },
  async head(k) { return store.has(k) ? {} : null; },
  async delete(ks) { for (const k of [].concat(ks)) store.delete(k); },
  async list() { return { objects: [...store.keys()].map((key) => ({ key, size: store.get(key).length })), truncated: false }; },
};
const env = { DB, APP_TOKEN: 'pw', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x', BACKUP: R2, BARK_DEVICE_KEY: 'dev' };
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
const flush = async () => { while (waits.length) await waits.shift(); };
const raw = (m, p, b, bin) => W.fetch(new Request('https://w' + p, { method: m, headers: { 'X-App-Token': 'pw' }, body: bin || (b ? JSON.stringify(b) : undefined) }), env, ctx);
const call = async (m, p, b, bin) => { const r = await raw(m, p, b, bin); const d = await r.json(); await flush(); if (!r.ok) throw Object.assign(new Error(p + ' ' + JSON.stringify(d)), { status: r.status }); return d; };
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
const ai = [], barks = []; let answer = { messages: ['ふつうの返事'], voice: -1 };
globalThis.fetch = async (u, i) => {
  u = String(u);
  if (u.includes('day.app')) { barks.push(String(i.body)); return new Response('{"code":200}'); }
  if (!u.includes('googleapis') && !u.includes('x.ai')) return new Response('{}');
  const body = JSON.parse(i.body); const grok = u.includes('x.ai');
  const sys = grok ? body.messages[0].content : body.systemInstruction.parts[0].text, sch = JSON.stringify(grok ? body.response_format : body.generationConfig.responseSchema);
  const user = grok ? body.messages.slice(1).map((x) => typeof x.content === 'string' ? x.content : '').join('\n') : body.contents.map((c) => c.parts.map((p) => p.text || '').join('|')).join('\n');
  ai.push({ sys, sch, user });
  let out = { messages: ['返事'] };
  if (/"(voice|stamp|quote|postscript|retract)"/i.test(sch)) { out = { ...answer }; for (const k of Object.keys(JSON.parse(sch).properties || {})) if (!(k in out)) out[k] = /INTEGER|integer/.test(JSON.stringify(JSON.parse(sch).properties[k])) ? -1 : ''; }
  else if (sch.includes('"messages"')) out = { messages: answer.messages };
  const txt = JSON.stringify(out);
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: txt } }] } : { candidates: [{ content: { parts: [{ text: txt }] } }] }));
};
await call('POST', '/settings', { settings: { delayEnabled: false, lifeEnabled: false, quietEnabled: false, notifyVia: 'bark' } });
const a = (await call('POST', '/char', { char: { name: '朱里', prompt: '朱里の設定', voice: 'akari' } })).char;
const n = (await call('POST', '/char', { char: { name: '声なし', prompt: 'p' } })).char;
ok(a.vmsgFreq === 'rare', 'default frequency: たまに');

// ---- あなたから
let r = await call('POST', '/send', { charId: a.id, text: 'おはよう、声で送るね', voice: true, dur: 4200 });
ok(r.message.kind === 'voice' && r.message.meta.dur === 4200 && r.message.text === 'おはよう、声で送るね', 'send voice message');
r = await call('POST', '/send', { charId: a.id, text: 'x', voice: true, dur: 999999 });
ok(r.message.meta.dur === 60000, 'your voice: up to 1 minute');
await call('POST', '/messages/delete', { charId: a.id, ids: [r.message.id] });
let e = 0; try { await call('POST', '/send', { charId: a.id + '#ura', text: 'x', voice: true }); } catch (x) { e = x.status; }
ok(e === 400, 'ura: voice message refused');
// ---- 声で返す
answer = { messages: ['ふふ……', '声、聞こえましたよ。私も声で返しますね。'], voice: 1 };
ai.length = 0;
r = await call('POST', '/reply', { charId: a.id });
let q = ai.find((x) => x.sch.includes('"voice"'));
ok(q && q.sys.includes('ボイスメッセージ（声）を送ってきた') && q.user.includes('（ボイスメッセージ：「おはよう、声で送るね」）'), 'AI sees your voice message and may answer by voice');
ok(r.messages.length === 2 && !r.messages[0].kind && r.messages[1].kind === 'voice' && r.messages[1].meta.est > 0, 'second bubble stored as voice message');
const vm = r.messages[1];
// 次の返事では、キャラ自身の声のメッセージも分かる
answer = { messages: ['うん'], voice: -1 };
await call('POST', '/send', { charId: a.id, text: 'ありがとう' });
ai.length = 0; await call('POST', '/reply', { charId: a.id });
ok(ai.some((x) => x.user.includes('（ボイスメッセージで）声、聞こえましたよ')), 'history shows the character\'s own voice message');
// 声を聞きたがったら選べる
await call('POST', '/send', { charId: a.id, text: '声が聞きたいな' });
ai.length = 0; await call('POST', '/reply', { charId: a.id });
ok(ai.some((x) => x.sch.includes('"voice"') && x.sys.includes('声を聞きたがって')), 'asked for voice → voice option offered');
// 声のない子には出さない
await call('POST', '/send', { charId: n.id, text: '声が聞きたい' });
ai.length = 0; await call('POST', '/reply', { charId: n.id });
ok(!ai.some((x) => x.sch.includes('"voice"')), 'no voice name → no voice messages');
// 頻度：なし → 気まぐれでは出ない／多め → ときどき出る
await call('POST', '/char', { char: { ...a, vmsgFreq: 'none' } });
let offered = 0;
for (let i = 0; i < 25; i++) { await call('POST', '/send', { charId: a.id, text: 'ねえ' + i }); ai.length = 0; await call('POST', '/reply', { charId: a.id }); if (ai.some((x) => x.sch.includes('"voice"'))) offered++; }
ok(offered === 0, 'frequency none: never offered on its own');
await call('POST', '/char', { char: { ...a, vmsgFreq: 'often' } });
offered = 0;
for (let i = 0; i < 25; i++) { ai.length = 0; await call('POST', '/poke', { charId: a.id }); if (ai.some((x) => x.sch.includes('"voice"'))) offered++; }
ok(offered >= 4 && offered <= 22, 'frequency often: offered sometimes when talking first (' + offered + '/25)');

// ---- 声を R2 に
let rr = await raw('GET', '/vmsg/audio?id=' + vm.id); await flush();
ok(rr.status === 404, 'no audio yet');
const audio = new Uint8Array(5000).fill(3);
r = await call('POST', `/vmsg/audio?id=${vm.id}&dur=6400`, null, audio);
ok(r.meta.au === 1 && r.meta.dur === 6400 && store.has('voice/' + vm.id), 'audio stored in R2, duration saved');
rr = await raw('GET', '/vmsg/audio?id=' + vm.id); await flush();
ok(rr.status === 200 && (await rr.arrayBuffer()).byteLength === 5000, 'audio returned');
const sy = await call('GET', '/sync?since=0');
ok(sy.messages.find((x) => x.id === vm.id).meta.au === 1, 'sync carries audio flag');
e = 0; try { await call('POST', `/vmsg/audio?id=${sy.messages.find((x) => x.sender === 'me').id}`, null, audio); } catch (x) { e = x.status; }
ok(e === 404, 'only character voice messages take audio');
await call('POST', '/messages/delete', { charId: a.id, ids: [vm.id] });
ok(!store.has('voice/' + vm.id), 'deleting the message deletes its audio');

// ---- 通知：ボイスメッセージ・静かな時間は音なし
await call('POST', '/char', { char: { ...a, vmsgFreq: 'often' } });
answer = { messages: ['……起きてますか', 'なんだか眠れなくて'], voice: 1 };
const h = (new Date(Date.now() + 9 * 3600e3).getUTCHours());
await call('POST', '/settings', { settings: { quietEnabled: true, quietStart: h, quietEnd: (h + 2) % 24 } });
barks.length = 0;
for (let i = 0; i < 30 && !barks.some((b) => b.includes('🎤')); i++) await call('POST', '/poke', { charId: a.id });
const bk = barks.find((b) => b.includes('🎤'));
ok(bk && bk.includes('"level":"passive"') && !bk.includes('"sound"'), 'quiet hours: voice message notification is silent');
await call('POST', '/settings', { settings: { quietEnabled: false } });
barks.length = 0;
for (let i = 0; i < 30 && !barks.some((b) => b.includes('🎤')); i++) await call('POST', '/poke', { charId: a.id });
ok(barks.some((b) => b.includes('🎤 ボイスメッセージ') && !b.includes('passive')), 'daytime: normal notification');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
