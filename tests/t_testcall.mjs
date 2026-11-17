// 第77版：テストの電話（今すぐかけてもらう・必ず出る）は記憶に残さない。その時刻の様子と「ふだんなら」を見せる
import W from './worker.mjs';
import { makeDB } from './fake.mjs';
const DB = makeDB();
const env = { DB, APP_TOKEN: 'pw', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' };
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
const flush = async () => { while (waits.length) await waits.shift(); };
const call = async (m, p, b) => { const r = await W.fetch(new Request('https://w' + p, { method: m, headers: { 'X-App-Token': 'pw' }, body: b ? JSON.stringify(b) : undefined }), env, ctx); const d = await r.json(); await flush(); if (!r.ok) throw Object.assign(new Error(p + ' ' + JSON.stringify(d)), { status: r.status }); return d; };
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
const ai = [];
globalThis.fetch = async (u, i) => {
  u = String(u);
  if (!u.includes('googleapis') && !u.includes('x.ai')) return new Response('{}');
  const body = JSON.parse(i.body); const grok = u.includes('x.ai');
  const sys = grok ? body.messages[0].content : body.systemInstruction.parts[0].text, sch = JSON.stringify(grok ? body.response_format : body.generationConfig.responseSchema);
  ai.push({ sys, sch });
  let out;
  if (sch.includes('leave_voicemail')) out = { leave_voicemail: true, voicemail: 'さびしいです', send_line: true, line: '切られちゃった' };
  else if (sch.includes('"after"')) out = { answer: false, reason: '授業中で出られない', after: 'callback', line: '' };
  else if (sch.includes('"hangup"')) out = { messages: ['もしもし'], hangup: false };
  else if (sch.includes('"summary"')) out = { summary: 'テストで話した。' };
  else out = { messages: ['うん'] };
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: JSON.stringify(out) } }] } : { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
};
await call('POST', '/settings', { settings: { delayEnabled: false, lifeEnabled: false, quietEnabled: false } });
const c = (await call('POST', '/char', { char: { name: 'シャロ', prompt: 'p', voice: 'sharo' } })).char;
const mems = () => DB.raw.prepare('SELECT COUNT(*) n FROM memories WHERE char_id=?').get(c.id).n;
const m0 = mems();
// ---- 今すぐ電話をかけてもらう（テスト）→ 拒否：記録だけ。留守電・トークの一言・折り返しなし
let r = await call('POST', '/call/test', { charId: c.id });
ok(r.call.test && r.call.nokeep && r.call.testInfo && r.call.testInfo.now.includes('いま'), 'incoming test: nokeep, shows what the character is doing');
ai.length = 0;
await call('POST', '/call/decline', { id: r.call.id });
let sy = await call('GET', '/sync?since=0');
const miss = sy.messages.find((x) => x.kind === 'call');
ok(miss && miss.meta.test && miss.meta.nokeep && miss.meta.declined && miss.meta.testInfo, 'declined test: record only (hidden from the character)');
ok(!sy.messages.some((x) => x.kind === 'vm') && !ai.some((x) => x.sch.includes('leave_voicemail')) && !DB.raw.prepare("SELECT 1 FROM kv WHERE k LIKE 'callback:%' OR k LIKE 'ps:%'").get(), 'no voicemail, no LINE, no callback');
// 出て話す → 記憶に残らない
r = await call('POST', '/call/test', { charId: c.id });
await call('POST', '/call/answer', { id: r.call.id });
await call('POST', '/call/say', { id: r.call.id, text: 'テストだよ' });
let msg = (await call('POST', '/call/end', { id: r.call.id })).message;
ok(msg.meta.test && msg.meta.nokeep && !msg.meta.sum && mems() === m0, 'answered test: no summary, no memory');
// ---- こちらからかける・必ず出る（テスト）
r = await call('POST', '/call/start', { charId: c.id, test: true });
ok(r.test && r.test.wouldAnswer === false && r.test.reason.includes('授業') && r.test.now, 'outgoing test: would not have answered (reason, what she was doing)');
ok(r.call.test && r.call.nokeep && r.call.testInfo.would === false, 'outgoing test: nokeep with info');
r = await call('POST', '/call/connect', { id: r.call.id });
ok(r.answered, 'still answers');
await call('POST', '/call/say', { id: r.call.id, text: 'こんにちは' });
msg = (await call('POST', '/call/end', { id: r.call.id })).message;
ok(msg.meta.test && msg.meta.nokeep && msg.meta.testInfo && msg.meta.testInfo.reason.includes('授業') && mems() === m0, 'outgoing test: record with info, no memory');
// キャラ（AI）には見えない
await call('POST', '/send', { charId: c.id, text: 'やっほー' }); ai.length = 0;
await call('POST', '/reply', { charId: c.id });
ok(!ai.some((x) => /電話で|不在|拒否/.test(x.sys + (x.user || ''))), 'test calls invisible to the character');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
