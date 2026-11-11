import W, * as X from './worker.mjs';
import { makeDB } from './fake.mjs';
// 電話・留守電（第47版）：発信（出る・出ない）・通話・終話の記録と記憶・着信（GPU を起こしてから鳴らす）・拒否と不在の留守電・設定
const DB = makeDB();
const env = { DB, APP_TOKEN: 'pw', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x', BARK_DEVICE_KEY: 'dev' };
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
const call = async (m, p, b) => { const r = await W.fetch(new Request('https://w' + p, { method: m, headers: { 'X-App-Token': 'pw' }, body: b ? JSON.stringify(b) : undefined }), env, ctx); const d = await r.json(); if (!r.ok) { const e = new Error(p + ' ' + JSON.stringify(d)); e.status = r.status; throw e; } return d; };
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
const ai = []; const answer = { ans: { answer: true, after: 'none', line: '' }, vm: { leave_voicemail: true, voicemail: 'もしもし、朱里です。また、かけますね。', send_line: false, line: '' }, reply: { messages: ['もしもし……', '朱里です。'], hangup: false } };
const bark = []; let health = 0, healthOk = true;
globalThis.fetch = async (u, i) => {
  u = String(u);
  if (u.startsWith('https://api.day.app/')) { bark.push(JSON.parse(i.body)); return new Response('{"code":200}'); }
  if (u.startsWith('https://tts.example.modal.run/health')) { health++; return new Response(healthOk ? '{"status":"ok"}' : 'x', { status: healthOk ? 200 : 503 }); }
  if (u.startsWith('https://api.open-meteo.com/')) return new Response('{}');
  const body = JSON.parse(i.body);
  const sys = body.systemInstruction.parts[0].text, sch = JSON.stringify(body.generationConfig.responseSchema);
  const user = body.contents.map((c) => c.parts.map((p) => p.text || '').join('|')).join('\n');
  ai.push({ sys, sch, user });
  let out;
  if (sch.includes('leave_voicemail')) out = answer.vm;
  else if (sch.includes('"after"')) out = answer.ans;
  else if (sch.includes('hangup')) out = answer.reply;
  else if (sch.includes('"summary"')) out = { summary: 'テニスの練習の話をして、笑い合った。' };
  else if (sch.includes('affinity_delta')) out = { new: [], done: [], user_state: '', affinity_delta: 0, birthday: '' };
  else out = { messages: ['返事'] };
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
};
const flush = async () => { while (waits.length) await waits.shift(); };
await call('POST', '/settings', { settings: { delayEnabled: false, notifyVia: 'bark', lifeEnabled: false, quietEnabled: false, ttsUrl: 'https://tts.example.modal.run' } });
const noVoice = (await call('POST', '/char', { char: { name: '声なし', prompt: 'p' } })).char;
const c = (await call('POST', '/char', { char: { name: '朱里', prompt: 'p', voice: 'akari', callFreq: 'often' } })).char;
ok(c.voice === 'akari' && c.callFreq === 'often', 'char keeps voice and frequency');
ok((await call('POST', '/char', { char: { ...c, voice: 'bad name!' } })).char.voice === '', 'invalid voice name dropped');
await call('POST', '/char', { char: { ...c, voice: 'akari' } });
let st = (await call('GET', '/sync?since=0')).settings;
ok(st.ttsUrl === 'https://tts.example.modal.run' && st.phoneEnabled === true && st.phoneQuietMode === 'same', 'phone settings defaults + ttsUrl');
// 声のないキャラには電話できない
try { await call('POST', '/call/start', { charId: noVoice.id }); ok(false, 'no voice → refused'); } catch (e) { ok(e.status === 400, 'no voice → refused'); }

// ---- 発信：出る
let r = await call('POST', '/call/start', { charId: c.id });
ok(r.call.status === 'dialing' && r.call.dir === 'out' && r.ringMs >= 4000 && r.ringMs <= 13000, 'start: dialing, short ring when answering');
ok(ai.pop().sys.includes('出るかどうか'), 'answer decision asked AI');
r = await call('POST', '/call/connect', { id: r.call.id });
ok(r.answered && r.lines.join('').includes('もしもし') && r.call.status === 'active', 'connect: answered with first words');
const first = ai.pop();
ok(first.sys.includes('電話で') && first.sys.includes('hangup') && first.sys.includes('ユーザーからかかってきた'), 'call prompt: phone rules, outgoing');
const cid = r.call.id;
ok((await call('GET', '/sync?since=0')).calls.some((x) => x.id === cid && x.status === 'active'), 'sync shows active call');
answer.reply = { messages: ['うん、聞いてるよ。'], hangup: false };
r = await call('POST', '/call/say', { id: cid, text: '今日はテニスの練習だったよ' });
ok(r.lines[0] === 'うん、聞いてるよ。' && !r.hangup, 'say → reply');
ok(ai.pop().user.includes('今日はテニスの練習だったよ'), 'transcript sent to AI');
answer.reply = { messages: ['そろそろ切るね。またね。'], hangup: true };
r = await call('POST', '/call/say', { id: cid, text: 'そっちは？' });
ok(r.hangup === true, 'character can hang up');
r = await call('POST', '/call/end', { id: cid, by: 'char', est: { usd: 0.0123, gpuMs: 95000 } });
await flush();
ok(r.message && r.message.kind === 'callog' && r.message.sender === 'me' && r.message.meta.sum.includes('テニス') && r.message.meta.usd === 0.0123, 'end: call log message with summary and cost');
let mems = DB.raw.prepare("SELECT text FROM memories WHERE char_id=?").all(c.id);
ok(mems.some((m) => m.text.includes('電話で話した')), 'summary saved to memories');
ok(!(await call('GET', '/sync?since=0')).calls.length, 'no call left');
// 通話の記録は次の返事のときにAIへ渡る
await call('POST', '/send', { charId: c.id, text: 'さっきは楽しかった' });
await call('POST', '/reply', { charId: c.id });
ok(ai.some((x) => x.user.includes('電話で') && x.user.includes('話した')), 'call log appears in talk history for AI');

// ---- 発信：出ない → 記録・折り返し
answer.ans = { answer: false, after: 'callback', line: '' };
r = await call('POST', '/call/start', { charId: c.id });
ok(r.ringMs === 25000, 'no answer → full ring');
const realRandom = Math.random; Math.random = () => 0.1;
r = await call('POST', '/call/connect', { id: r.call.id });
Math.random = realRandom;
ok(!r.answered && r.message.kind === 'callout', 'not answered → callout record');
const cb = DB.raw.prepare("SELECT v FROM kv WHERE k=?").get('callback:' + c.id);
ok(cb && JSON.parse(cb.v).due > Date.now(), 'callback scheduled');

// ---- テスト発信（第49版）：AI が出ないと決めても必ず出る。ふだんの判断と理由を返す
answer.ans = { answer: false, reason: '授業中', after: 'line', line: 'あとで' };
r = await call('POST', '/call/start', { charId: c.id, test: true });
ok(r.ringMs === 3000 && r.test && r.test.wouldAnswer === false && r.test.reason === '授業中' && typeof r.test.now === 'string', 'test call: short ring + would-answer info');
ok(ai.pop().sch.includes('reason'), 'answer schema asks for reason');
r = await call('POST', '/call/connect', { id: r.call.id });
ok(r.answered && r.call.status === 'active', 'test call always answered');
await call('POST', '/call/end', { id: r.call.id, by: 'me' }); await flush();
// ---- 残った通話（第54版）：force で片付けてからかけられる
answer.ans = { answer: true, reason: '手が空いている', after: 'none', line: '' };
r = await call('POST', '/call/start', { charId: c.id });
r = await call('POST', '/call/connect', { id: r.call.id });
const stale = r.call.id;
try { await call('POST', '/call/start', { charId: c.id }); ok(false, 'busy without force → 409'); } catch (e) { ok(e.status === 409, 'busy without force → 409'); }
r = await call('POST', '/call/start', { charId: c.id, force: true }); await flush();
ok(r.call && r.call.id !== stale && !(await call('GET', '/sync?since=0')).calls.some((x) => x.id === stale), 'force clears the stale active call');
await call('POST', '/call/decline', { id: r.call.id }).catch(() => {});
for (const x of (await call('GET', '/sync?since=0')).calls) DB.raw.prepare('DELETE FROM kv WHERE k=?').run('call:' + x.id);
answer.ans = { answer: false, after: 'callback', line: '' };

// ---- 着信（テスト）：GPU を起こしてから鳴らす・Bark は着信音を鳴らし続ける
DB.raw.prepare("DELETE FROM kv WHERE k LIKE 'callback:%'").run();
health = 0; bark.length = 0;
r = await call('POST', '/call/test', { charId: c.id });
await flush();
let s = await call('GET', '/sync?since=0');
let ring = s.calls.find((x) => x.status === 'ringing');
ok(health >= 1 && ring && ring.dir === 'in', 'incoming: warmed GPU then ringing');
ok(bark.length === 1 && bark[0].call === '1' && !bark[0].url && bark[0].body.includes('アプリを開く'), 'bark rings like a phone (open the app to answer)');
answer.reply = { messages: ['もしもし、朱里です。急にごめんね。'], hangup: false };
r = await call('POST', '/call/answer', { id: ring.id });
ok(r.lines[0].includes('もしもし') && ai.pop().sys.includes('あなたからかけた'), 'answer incoming → char speaks first');
r = await call('POST', '/call/end', { id: ring.id, by: 'me' });
ok(r.message && r.message.sender === 'char' && r.message.meta.dur >= 0, 'incoming call log');

// ---- 着信を拒否 → 留守電（残す）
r = await call('POST', '/call/test', { charId: c.id }); await flush();
ring = (await call('GET', '/sync?since=0')).calls.find((x) => x.status === 'ringing');
await call('POST', '/call/decline', { id: ring.id }); await flush();
s = await call('GET', '/sync?since=0');
const vm = (s.vms[c.id] || []).slice(-1)[0];
ok(vm && vm.text.includes('また、かけますね') && !vm.heard, 'declined → voicemail stored');
ok(s.messages.some((m) => m.kind === 'call' && m.meta && m.meta.declined) && s.messages.some((m) => m.kind === 'vm'), 'missed-call + voicemail messages');
await call('POST', '/vm/heard', { charId: c.id, id: vm.id });
ok((await call('GET', '/sync?since=0')).vms[c.id].slice(-1)[0].heard === true, 'voicemail marked heard');
// 不在（25秒＋猶予を過ぎた）→ 留守電を残さないことも
answer.vm = { leave_voicemail: false, voicemail: '', send_line: true, line: 'なんで出ないの？' };
r = await call('POST', '/call/test', { charId: c.id }); await flush();
ring = (await call('GET', '/sync?since=0')).calls.find((x) => x.status === 'ringing');
const k = 'call:' + ring.id; const raw = JSON.parse(DB.raw.prepare('SELECT v FROM kv WHERE k=?').get(k).v); raw.ringAt -= 60e3;
DB.raw.prepare('UPDATE kv SET v=? WHERE k=?').run(JSON.stringify(raw), k);
const vmBefore = ((await call('GET', '/sync?since=0')).vms[c.id] || []).length;
Math.random = () => 0.1; await X.runCalls(env); Math.random = realRandom;
s = await call('GET', '/sync?since=0');
ok(!s.calls.length && (s.vms[c.id] || []).length === vmBefore, 'missed → no voicemail this time');
ok(DB.raw.prepare("SELECT v FROM kv WHERE k=?").get('ps:' + c.id), 'missed → later LINE scheduled');
try { await call('POST', '/call/answer', { id: ring.id }); ok(false, 'late answer refused'); } catch (e) { ok(e.status === 404 || e.status === 410, 'late answer refused'); }

// ---- 起こせないときは鳴らさない
healthOk = false; bark.length = 0;
r = await call('POST', '/call/test', { charId: c.id }); await flush();
ok(!(await call('GET', '/sync?since=0')).calls.length && !bark.length, 'GPU not awake → not ringing yet');
const wk = DB.raw.prepare("SELECT k,v FROM kv WHERE k LIKE 'call:%'").get();
ok(wk && JSON.parse(wk.v).status === 'warming', 'call waits while warming');
const w2 = JSON.parse(wk.v); w2.created -= 5 * 60e3; DB.raw.prepare('UPDATE kv SET v=? WHERE k=?').run(JSON.stringify(w2), wk.k);
await X.runCalls(env);
ok(!DB.raw.prepare("SELECT k FROM kv WHERE k LIKE 'call:%'").get(), 'gave up after warming too long');
healthOk = true;

// ---- 自分からかけてくる頻度・すべて拒否・出られない時間
const ringOnce = async (stPatch) => { DB.raw.prepare("DELETE FROM kv WHERE k LIKE 'call:%'").run(); DB.raw.prepare('DELETE FROM char_state').run(); const s0 = { ...(await call('GET', '/sync?since=0')).settings, ...stPatch }; Math.random = () => 0; const got = await X.maybeRing(env, { ...c, voice: 'akari', callFreq: 'often' }, s0, Date.now()); Math.random = realRandom; await flush(); return got; };
ok(await ringOnce({}) === true, 'maybeRing rings when allowed');
ok(await ringOnce({ phoneAllOff: true }) === false, 'all calls rejected → no ring');
ok(await ringOnce({ phoneQuietMode: 'custom', phoneQuietStart: 0, phoneQuietEnd: 23 }) === false, 'phone quiet hours → no ring');
ok(await ringOnce({ phoneEnabled: false }) === false, 'phone off → no ring');
DB.raw.prepare("DELETE FROM kv WHERE k LIKE 'call:%'").run();
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
