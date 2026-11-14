import W from './worker.mjs';
import { makeDB } from './fake.mjs';
// 寝落ち通話（第66版・表だけ）：1対1と表のグループ通話。確認（ask）とおやすみ（bye）・キャラから切らない・引き継がないなら何も残さない・裏は不可
const DB = makeDB();
const env = { DB, APP_TOKEN: 'pw', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' };
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
const call = async (m, p, b) => { const r = await W.fetch(new Request('https://w' + p, { method: m, headers: { 'X-App-Token': 'pw' }, body: b ? JSON.stringify(b) : undefined }), env, ctx); const d = await r.json(); if (!r.ok) { const e = new Error(p + ' ' + JSON.stringify(d)); e.status = r.status; throw e; } return d; };
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
const ai = [];
const answer = { one: { messages: ['もしもし……', '眠れないんですか？'], hangup: true }, grp: { lines: [{ speaker: '朱里', text: 'まだ聞いてますか……？' }, { speaker: 'マリ', text: 'しーっ' }], wait_user: false } };
globalThis.fetch = async (u, i) => {
  u = String(u);
  if (u.startsWith('https://api.open-meteo.com/')) return new Response('{}');
  const body = JSON.parse(i.body); const grok = u.includes('x.ai');
  const sys = grok ? body.messages[0].content : body.systemInstruction.parts[0].text, sch = JSON.stringify(grok ? body.response_format : body.generationConfig.responseSchema);
  const user = grok ? '' : body.contents.map((c) => c.parts.map((p) => p.text || '').join('|')).join('\n');
  ai.push({ sys, sch, user });
  let out;
  if (sch.includes('wait_user')) out = answer.grp;
  else if (sch.includes('"hangup"')) out = answer.one;
  else if (sch.includes('"after"')) out = { answer: true, reason: '', after: 'none', line: '' };
  else if (sch.includes('"summary"')) out = { summary: '夜にゆっくり話した。' };
  else out = { messages: ['返事'] };
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: JSON.stringify(out) } }] } : { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
};
const flush = async () => { while (waits.length) await waits.shift(); };
const mems = (id) => DB.raw.prepare('SELECT text FROM memories WHERE char_id=?').all(id).map((r) => r.text);
await call('POST', '/settings', { settings: { delayEnabled: false, lifeEnabled: false, quietEnabled: false } });
const a = (await call('POST', '/char', { char: { name: '朱里', prompt: '朱里の設定', voice: 'akari' } })).char;
const m = (await call('POST', '/char', { char: { name: 'マリ', prompt: 'マリの設定', voice: 'mari' } })).char;

// ---- 1対1・記憶を引き継ぐ
let r = await call('POST', '/call/start', { charId: a.id, sleep: true, keep: true });
r = await call('POST', '/call/connect', { id: r.call.id });
let q = ai.pop();
ok(r.answered && q.sys.includes('寝落ち通話') && q.sys.includes('キャラから電話を切ろうとしない'), '1:1 sleep: prompt has sleep rules');
ok(r.hangup === false, '1:1 sleep: char never hangs up (AI said hangup:true)');
const id1 = r.call.id;
await call('POST', '/call/say', { id: id1, text: 'ねむい……' });
answer.one = { messages: ['……まだ聞いてますか？', 'おーい'], hangup: false };
r = await call('POST', '/call/say', { id: id1, text: '', check: 'ask' });
q = ai.pop();
ok(q.sys.includes('まだ聞いてますか') && q.sys.includes('最優先') && r.lines.length === 1, '1:1 ask: check prompt, one line');
answer.one = { messages: ['……寝ちゃったみたいですね。', 'おやすみなさい。'], hangup: false };
r = await call('POST', '/call/say', { id: id1, text: '', check: 'bye' });
ok(ai.pop().sys.includes('おやすみなさい') && r.lines.length === 2, '1:1 bye: goodnight prompt');
let msg = (await call('POST', '/call/end', { id: id1, by: 'sleep' })).message;
await flush();
ok(msg.meta.sleep && !msg.meta.nokeep && msg.meta.by === 'sleep' && msg.meta.sum, '1:1 keep: record with summary, by sleep');
ok(mems(a.id).some((t) => t.includes('電話で話した')), '1:1 keep: summary in memories');

// 第68版：引き継ぐ寝落ち通話のあとは、今までどおりトークの返事が来る
let rr = await call('POST', '/reply', { charId: a.id });
ok(rr.messages.length > 0, '1:1 keep: text reply after the call (unchanged)');
// ---- 1対1・引き継がない：これまでの記憶は使う・この通話のことは残さない
r = await call('POST', '/call/start', { charId: a.id, sleep: true, keep: false });
await call('POST', '/call/connect', { id: r.call.id });
const before = mems(a.id).length;
await call('POST', '/call/say', { id: r.call.id, text: '今日は内緒の話' });
msg = (await call('POST', '/call/end', { id: r.call.id })).message;
await flush();
ok(msg.meta.sleep && msg.meta.nokeep && !msg.meta.sum, '1:1 nokeep: record only, no summary');
ok(mems(a.id).length === before, '1:1 nokeep: nothing added to memories');
// 第68版：引き継がない寝落ち通話は、キャラ（AI）に見せない・トークの返事も来ない
ai.length = 0;
rr = await call('POST', '/reply', { charId: a.id });
ok(rr.messages.length === 0 && !ai.length, '1:1 nokeep: no text reply after the call');
await call('POST', '/send', { charId: a.id, text: 'おはよう' });
await call('POST', '/reply', { charId: a.id });
q = ai.filter((x) => x.sch.includes('"messages"') && !x.sch.includes('hangup')).pop();
ok(q && q.user.includes('おはよう') && (q.user.match(/（電話で/g) || []).length === 1 && q.user.includes('話した内容'), 'text reply history: keep call visible, nokeep call hidden');
answer.one = { messages: ['もしもし'], hangup: false };
r = await call('POST', '/call/start', { charId: a.id });
await call('POST', '/call/connect', { id: r.call.id });
q = ai.pop();
ok((q.sys.match(/（電話で/g) || []).length === 1, 'next call prompt: nokeep call hidden');
await call('POST', '/call/end', { id: r.call.id }); await flush();
const sy = await call('GET', '/sync?since=0');
ok(sy.messages.some((x) => x.charId === a.id && x.kind === 'callog' && x.meta && x.meta.nokeep), 'nokeep record still returned to the app');
// ふつうの通話には確認が効かない
answer.one = { messages: ['うん'], hangup: false };
r = await call('POST', '/call/start', { charId: a.id });
await call('POST', '/call/connect', { id: r.call.id });
await call('POST', '/call/say', { id: r.call.id, text: '', check: 'ask' });
ok(!ai.pop().sys.includes('寝落ち通話'), 'normal call: check ignored');
await call('POST', '/call/end', { id: r.call.id }); await flush();

// ---- 表のグループ・引き継ぐ／引き継がない
const g = (await call('POST', '/ogroup', { group: { name: '31A', members: [a.id, m.id], lateJoin: false } })).group;
r = await call('POST', '/gcall/start', { groupId: g.id, sleep: true, keep: true });
await call('POST', '/gcall/connect', { id: r.call.id });
ok(ai.pop().sys.includes('寝落ち通話'), 'group sleep: prompt has sleep rules');
await call('POST', '/gcall/say', { id: r.call.id, text: 'おやすみ前に話そ' });
const r2 = await call('POST', '/gcall/say', { id: r.call.id, text: '', check: 'ask' });
q = ai.pop();
ok(q.sys.includes('だれか1人が') && r2.lines.length === 1, 'group ask: one member, one line');
await call('POST', '/gcall/say', { id: r.call.id, text: '', check: 'bye' });
ok(ai.pop().sys.includes('1〜3人が'), 'group bye prompt');
msg = (await call('POST', '/gcall/end', { id: r.call.id, by: 'sleep' })).message;
await flush();
ok(msg.meta.sleep && msg.meta.log && msg.meta.by === 'sleep' && (await call('GET', '/ogroup/memory?id=' + g.id)).memory.length === 1, 'group keep: log and group memory');
r = await call('POST', '/gcall/start', { groupId: g.id, sleep: true, keep: false });
await call('POST', '/gcall/connect', { id: r.call.id });
await call('POST', '/gcall/say', { id: r.call.id, text: '内緒' });
msg = (await call('POST', '/gcall/end', { id: r.call.id })).message;
await flush();
ok(msg.meta.nokeep && !msg.meta.log && !msg.meta.sum && (await call('GET', '/ogroup/memory?id=' + g.id)).memory.length === 1, 'group nokeep: no log, no memory');
ok(!DB.raw.prepare('SELECT 1 FROM kv WHERE k=?').get(`gclog:${g.id}:${msg.id}`), 'group nokeep: no call text saved');

// ---- 裏は寝落ち通話なし
const ug = (await call('POST', '/group', { group: { name: '裏', members: [a.id] } })).group;
try { await call('POST', '/gcall/start', { groupId: ug.id, sleep: true }); ok(false, 'ura sleep refused'); } catch (e) { ok(e.status === 400, 'ura sleep refused'); }

console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
