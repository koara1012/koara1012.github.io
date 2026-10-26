// AIのクレジット切れの表示（第34版）
import W, * as X from './worker.mjs';
import { makeDB } from './fake.mjs';
const DB = makeDB();
const env = { DB, APP_TOKEN: 'pw', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x', BARK_DEVICE_KEY: 'DEV' };
const ctx = { waitUntil: () => {} };
const raw = (m, p, b) => W.fetch(new Request('https://w' + p, { method: m, headers: { 'X-App-Token': 'pw' }, body: b ? JSON.stringify(b) : undefined }), env, ctx);
const call = async (m, p, b) => { const r = await raw(m, p, b); const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; };
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
let mode = { gemini: 'ok', grok: 'ok' }; let barks = 0;
globalThis.fetch = async (u, i) => {
  u = String(u);
  if (u.includes('api.day.app')) { barks++; return new Response('{}'); }
  if (u.includes('generativelanguage')) {
    if (mode.gemini === '402') return new Response(JSON.stringify({ error: { message: 'Your prepayment credits are depleted. Please go to AI Studio' } }), { status: 402 });
    if (mode.gemini === '500') return new Response(JSON.stringify({ error: { message: 'internal' } }), { status: 500 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ messages: ['こんにちは'] }) }] } }] }));
  }
  if (u.includes('api.x.ai')) {
    if (mode.grok === 'limit') return new Response(JSON.stringify({ error: 'You have reached your spending limit' }), { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ messages: ['やあ'] }) } }] }));
  }
  return new Response('{}');
};
await call('POST', '/settings', { settings: { delayEnabled: false, quietEnabled: false, lifeEnabled: false, notifyVia: 'bark' } });
const c = (await call('POST', '/char', { char: { name: 'シャロ', prompt: 'p' } })).char;
// クレジット切れ
mode.gemini = '402';
await call('POST', '/send', { charId: c.id, text: 'おーい' });
let e = ''; try { await call('POST', '/reply', { charId: c.id }); } catch (x) { e = x.message; }
ok(/402/.test(e), 'reply fails with 402');
let sy = await call('GET', '/sync?since=0');
ok(sy.aiAlerts.gemini && sy.aiAlerts.gemini.status === 402 && /prepayment/.test(sy.aiAlerts.gemini.msg), 'sync carries gemini alert');
ok(barks === 1, 'notified once');
try { await call('POST', '/reply', { charId: c.id }); } catch (_) {}
ok(barks === 1 && (await call('GET', '/sync?since=0')).aiAlerts.gemini, 'no repeat notification within a day');
// ふつうのエラーは警告にしない
mode.gemini = 'ok';
await call('POST', '/reply', { charId: c.id });
sy = await call('GET', '/sync?since=0');
ok(!sy.aiAlerts.gemini, 'alert clears after a successful call');
mode.gemini = '500';
await call('POST', '/send', { charId: c.id, text: 'もう一回' });
try { await call('POST', '/reply', { charId: c.id }); } catch (_) {}
ok(!(await call('GET', '/sync?since=0')).aiAlerts.gemini, 'server errors are not credit alerts');
// Grok の利用上限
mode.gemini = 'ok'; mode.grok = 'limit';
await call('POST', '/send', { charId: c.id + '#ura', text: '（手を振る）' });
try { await call('POST', '/reply', { charId: c.id + '#ura' }); } catch (_) {}
sy = await call('GET', '/sync?since=0');
ok(sy.aiAlerts.grok && sy.aiAlerts.grok.status === 429 && barks === 2, 'grok spending limit alert');
mode.grok = 'ok';
await call('POST', '/reply', { charId: c.id + '#ura' });
ok(!(await call('GET', '/sync?since=0')).aiAlerts.grok, 'grok alert clears');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
