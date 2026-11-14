// 第70版：裏の1対1の電話（発信・着信・不在・留守電・折り返し）と裏の寝落ち通話（1対1・グループ）。裏の設定・裏の名前・裏の物語で、記憶は裏の中だけ
import W from './worker.mjs';
import { makeDB } from './fake.mjs';
const DB = makeDB();
const env = { DB, APP_TOKEN: 'pw', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' };
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
const flush = async () => { while (waits.length) await waits.shift(); };
const call = async (m, p, b) => { const r = await W.fetch(new Request('https://w' + p, { method: m, headers: { 'X-App-Token': 'pw' }, body: b ? JSON.stringify(b) : undefined }), env, ctx); const d = await r.json(); await flush(); if (!r.ok) throw Object.assign(new Error(p + ' ' + JSON.stringify(d)), { status: r.status }); return d; };
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
const ai = []; const A = { answer: true, after: 'none', vm: true };
globalThis.fetch = async (u, i) => {
  u = String(u);
  if (!u.includes('googleapis') && !u.includes('x.ai')) return new Response('{}');
  const body = JSON.parse(i.body); const grok = u.includes('x.ai');
  const sys = grok ? body.messages[0].content : body.systemInstruction.parts[0].text, sch = JSON.stringify(grok ? body.response_format : body.generationConfig.responseSchema);
  const user = grok ? body.messages.slice(1).map((x) => typeof x.content === 'string' ? x.content : '').join('\n') : body.contents.map((c) => c.parts.map((p) => p.text || '').join('|')).join('\n');
  ai.push({ sys, sch, user, grok });
  let out;
  if (sch.includes('wait_user')) out = { lines: [{ speaker: 'ウラ', text: 'しーっ……' }], wait_user: false };
  else if (sch.includes('"members"')) out = { members: [{ name: 'ウラ', answer: true, reason: '' }] };
  else if (sch.includes('leave_voicemail')) out = { leave_voicemail: A.vm, voicemail: 'あとでまた会いに行くから。', send_line: true, line: 'なんで出ないの' };
  else if (sch.includes('"after"')) out = { answer: A.answer, reason: '物語で手が離せない', after: A.after, line: '' };
  else if (sch.includes('"hangup"')) out = { messages: ['……もしもし、私だよ。'], hangup: false };
  else if (sch.includes('"summary"')) out = { summary: '夜の屋上の話をした。' };
  else out = { messages: ['うん'] };
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: JSON.stringify(out) } }] } : { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
};
await call('POST', '/settings', { settings: { delayEnabled: false, lifeEnabled: false, quietEnabled: false } });
const a = (await call('POST', '/char', { char: { name: '朱里', uraName: 'アカリ', prompt: '表の設定', uraCharPrompt: '裏の設定ABC', uraScene: '夜の屋上', voice: 'akari' } })).char;
const u = (await call('POST', '/char', { char: { name: 'ウラ', prompt: 'p', uraOnly: true, voice: 'ura' } })).char;
ok(a.uraCallFreq === 'rare', 'ura incoming default: たまに');
await call('POST', '/send', { charId: a.id + '#ura', text: '屋上で待ってる' });
await call('POST', '/reply', { charId: a.id + '#ura' });
const memBefore = DB.raw.prepare('SELECT COUNT(*) n FROM memories').get().n;

// ---- 発信（裏）
ai.length = 0;
let r = await call('POST', '/call/start', { charId: a.id, ura: true });
let q = ai.pop();
ok(q.grok && q.sys.includes('アカリ') && q.sys.includes('裏の設定ABC') && q.sys.includes('屋上で待ってる') && !q.sys.includes('今の様子・時刻'), 'answer decided by the ura AI from the ura story');
ok(r.call.ura, 'call is ura');
r = await call('POST', '/call/connect', { id: r.call.id });
q = ai.pop();
ok(r.answered && q.grok && q.sys.includes('# キャラクター: アカリ') && q.sys.includes('夜の屋上') && q.sys.includes('これまでの物語'), 'ura call prompt: ura persona, scene, story');
const id1 = r.call.id;
await call('POST', '/call/say', { id: id1, text: '今どこ？' });
ok(ai.pop().grok, 'replies by the ura AI');
let m = (await call('POST', '/call/end', { id: id1 })).message;
ok(m.charId === a.id + '#ura' && m.kind === 'callog' && m.meta.sum, 'record in the ura talk with summary');
ok(DB.raw.prepare('SELECT COUNT(*) n FROM memories').get().n === memBefore, 'not added to omote memories');
ok(!DB.raw.prepare("SELECT 1 FROM messages WHERE char_id=? AND kind='callog'").get(a.id), 'nothing in the omote talk');
await call('POST', '/send', { charId: a.id + '#ura', text: 'さっきの電話の続きだけど' });
ai.length = 0; await call('POST', '/reply', { charId: a.id + '#ura' });
ok(ai.some((x) => x.user.includes('電話で') && x.user.includes('夜の屋上の話')), 'ura talk remembers the call');
// 裏だけの子にも
r = await call('POST', '/call/start', { charId: u.id, ura: true, test: true });
ok(r.call.ura, 'ura-only character can be called');
await call('POST', '/call/decline', { id: r.call.id });
let e = 0; try { await call('POST', '/call/start', { charId: u.id }); } catch (x) { e = x.status; } ok(e >= 400, 'ura-only character: no omote phone (' + e + ')');

// ---- 寝落ち通話（裏・引き継がない）
r = await call('POST', '/call/start', { charId: a.id, ura: true, sleep: true, keep: false });
r = await call('POST', '/call/connect', { id: r.call.id });
ok(ai.pop().sys.includes('寝落ち通話'), 'ura sleep call rules');
await call('POST', '/call/say', { id: r.call.id, text: 'ないしょ' });
const ask = await call('POST', '/call/say', { id: r.call.id, text: '', check: 'ask' });
ok(ai.pop().sys.includes('まだ聞いてますか') && ask.lines.length === 1, 'ura sleep: ask');
m = (await call('POST', '/call/end', { id: r.call.id, by: 'sleep' })).message;
ok(m.meta.sleep && m.meta.nokeep && !m.meta.sum, 'ura nokeep: record only');
ai.length = 0; await call('POST', '/send', { charId: a.id + '#ura', text: 'おはよう' }); await call('POST', '/reply', { charId: a.id + '#ura' });
ok(ai.some((x) => x.user.includes('おはよう')) && !ai.some((x) => x.user.includes('ないしょ') || (x.user.match(/（電話で/g) || []).length > 1), 'ura nokeep sleep call hidden from the character');

// ---- 着信（裏）：拒否 → 留守電は裏のトークに
r = await call('POST', '/call/test', { charId: a.id, ura: true });
ok(r.call.ura && r.call.status === 'ringing', 'ura incoming rings');
ai.length = 0;
await call('POST', '/call/decline', { id: r.call.id });
ok(ai.some((x) => x.grok && x.sch.includes('leave_voicemail') && x.sys.includes('アカリ')), 'voicemail decided by the ura AI');
const sy = await call('GET', '/sync?since=0');
const vm = sy.messages.find((x) => x.kind === 'vm');
ok(vm && vm.charId === a.id + '#ura' && sy.vms[a.id + '#ura'] && sy.vms[a.id + '#ura'][0].text.includes('会いに行く'), 'voicemail in the ura talk');
ok(!DB.raw.prepare("SELECT 1 FROM kv WHERE k LIKE 'ps:%'").get(), 'no omote LINE after an ura call');
await call('POST', '/vm/heard', { charId: a.id + '#ura', id: vm.id });
ok((await call('GET', '/sync?since=0')).vms[a.id + '#ura'][0].heard, 'heard (ura)');
// 出なかった → 折り返し（裏）
DB.raw.prepare('INSERT INTO kv (k,v) VALUES (?,?)').run('callback:' + a.id + '#ura', JSON.stringify({ due: 0 }));
await W.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: (p) => waits.push(p) }); await flush();
const cl = DB.raw.prepare("SELECT v FROM kv WHERE k LIKE 'call:%'").all().map((x) => JSON.parse(x.v)).find((x) => x.charId === a.id);
ok(cl && cl.ura && cl.why === 'callback', 'ura callback rings as ura');
await call('POST', '/call/decline', { id: cl.id });
// 裏を止めていたらかけられない
await call('POST', '/settings', { settings: { uraPaused: true } });
e = 0; try { await call('POST', '/call/start', { charId: a.id, ura: true }); } catch (x) { e = x.status; } ok(e === 409, 'ura paused → no ura calls');
await call('POST', '/settings', { settings: { uraPaused: false } });

// ---- 裏のグループの寝落ち通話
const g = (await call('POST', '/group', { group: { name: '屋上組', members: [a.id, u.id] } })).group;
r = await call('POST', '/gcall/start', { groupId: g.id, sleep: true, keep: true, all: true });
await call('POST', '/gcall/connect', { id: r.call.id });
ok(ai.pop().sys.includes('寝落ち通話'), 'ura group sleep call allowed');
const r2 = await call('POST', '/gcall/say', { id: r.call.id, text: '', check: 'ask' });
ok(ai.pop().sys.includes('だれか1人が') && r2.lines.length === 1, 'ura group: ask');
m = (await call('POST', '/gcall/end', { id: r.call.id, by: 'sleep' })).message;
ok(m.meta.sleep && m.meta.by === 'sleep', 'ura group sleep record');
// 表の電話はいつもどおり
r = await call('POST', '/call/start', { charId: a.id });
ok(!r.call.ura && !ai.pop().grok, 'omote call unchanged (Gemini, omote)');
// 裏の着信（見回り）：頻度の設定でかけてくる
for (const x of DB.raw.prepare("SELECT k FROM kv WHERE k LIKE 'call:%'").all()) DB.raw.prepare('DELETE FROM kv WHERE k=?').run(x.k);
await call('POST', '/char', { char: { ...a, uraCallFreq: 'often', callFreq: 'none' } });
const R0 = Math.random; Math.random = () => 0.0001;
let rang = null;
for (let i = 0; i < 14 && !rang; i++) {
  await W.scheduled({ scheduledTime: Date.now() + i * 60e3 }, env, { waitUntil: (p) => waits.push(p) }); await flush();
  rang = DB.raw.prepare("SELECT v FROM kv WHERE k LIKE 'call:%'").all().map((x) => JSON.parse(x.v)).find((x) => x.charId === a.id && x.ura);
}
Math.random = R0;
ok(rang && rang.dir === 'in' && rang.why === 'ring', 'ura incoming call from the regular check');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
