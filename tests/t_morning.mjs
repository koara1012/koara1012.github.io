// 第70版：モーニングコール（表だけ）。約束（トーク・通話・寝落ち通話）と設定（1回だけ・決めた1人／ランダム）、
// 同じ朝は約束を優先、4分おきに計4回、出たら起こしてキャラから切る、最後は留守電かボイスメッセージ、記憶を引き継がない、テスト
import W from './worker.mjs';
import { makeDB } from './fake.mjs';
const DB = makeDB();
const env = { DB, APP_TOKEN: 'pw', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x', BARK_DEVICE_KEY: 'dev' };
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
const flush = async () => { while (waits.length) await waits.shift(); };
const call = async (m, p, b) => { const r = await W.fetch(new Request('https://w' + p, { method: m, headers: { 'X-App-Token': 'pw' }, body: b ? JSON.stringify(b) : undefined }), env, ctx); const d = await r.json(); await flush(); if (!r.ok) throw Object.assign(new Error(p + ' ' + JSON.stringify(d)), { status: r.status }); return d; };
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
const ai = [], barks = [];
const A = { wake: '', leave: { kind: 'voicemail', text: '起きてますか……？' }, hang: false };
globalThis.fetch = async (u, i) => {
  u = String(u);
  if (u.includes('day.app')) { barks.push(String(i.body)); return new Response('{"code":200}'); }
  if (!u.includes('googleapis') && !u.includes('x.ai')) return new Response('{}');
  const body = JSON.parse(i.body); const grok = u.includes('x.ai');
  const sys = grok ? body.messages[0].content : body.systemInstruction.parts[0].text, schO = grok ? body.response_format.json_schema.schema : body.generationConfig.responseSchema, sch = JSON.stringify(schO);
  const user = grok ? body.messages.slice(1).map((x) => typeof x.content === 'string' ? x.content : '').join('\n') : body.contents.map((c) => c.parts.map((p) => p.text || '').join('|')).join('\n');
  ai.push({ sys, sch, user });
  let out;
  if (sch.includes('voice_message')) out = A.leave;
  else if (sch.includes('"hangup"')) out = { messages: ['おはようございます。起きてください。'], hangup: A.hang, ...(sch.includes('"wake"') ? { wake: A.wake } : {}) };
  else if (sch.includes('"summary"')) out = { summary: '朝、起こしてもらった。' };
  else if (sch.includes('"after"')) out = { answer: true, reason: '', after: 'none', line: '' };
  else if (sch.includes('"messages"')) { out = { messages: ['わかりました、起こしますね'] }; for (const [k, v] of Object.entries(schO.properties || {})) if (!(k in out)) out[k] = k === 'wake' ? A.wake : /integer/i.test(JSON.stringify(v)) ? -1 : ''; }
  else out = {};
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: JSON.stringify(out) } }] } : { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
};
const RN = Date.now; let clock = RN(); Date.now = () => clock;
const jst = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi);
const cron = async (n = 1, step = 60e3) => { for (let i = 0; i < n; i++) { clock += step; const w = []; await W.scheduled({ scheduledTime: clock }, env, { waitUntil: (p) => w.push(p) }); await Promise.allSettled(w); } };
const msgs = (id) => DB.raw.prepare('SELECT * FROM messages WHERE char_id=? ORDER BY id').all(id).map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }));
const calls = () => DB.raw.prepare("SELECT v FROM kv WHERE k LIKE 'call:%'").all().map((r) => JSON.parse(r.v));
const kv = (k) => { const r = DB.raw.prepare('SELECT v FROM kv WHERE k=?').get(k); return r ? JSON.parse(r.v) : null; };
await call('POST', '/settings', { settings: { delayEnabled: false, lifeEnabled: false, quietEnabled: true, quietStart: 1, quietEnd: 9, notifyVia: 'bark', proactive: false } });
const a = (await call('POST', '/char', { char: { name: '朱里', prompt: '朱里の設定', voice: 'akari', perDay: 0 } })).char;
const m = (await call('POST', '/char', { char: { name: 'マリ', prompt: 'マリの設定', voice: 'mari', perDay: 0 } })).char;
const nv = (await call('POST', '/char', { char: { name: '声なし', prompt: 'p', perDay: 0 } })).char;

// ---- 約束：トーク
clock = jst(2026, 12, 1, 22);
await call('POST', '/send', { charId: a.id, text: '明日の朝7時に電話で起こして' });
A.wake = '07:00'; ai.length = 0;
await call('POST', '/reply', { charId: a.id });
ok(ai.some((x) => x.sch.includes('"wake"') && x.sys.includes('モーニングコール')), 'talk: wake asked → wake option');
let p = kv('mc:promise');
ok(p && p.charId === a.id && p.at === jst(2026, 12, 2, 7) && p.keep && p.src === 'talk', 'talk promise → tomorrow 7:00, keep');
await call('POST', '/send', { charId: a.id, text: 'おやすみ' }); ai.length = 0; A.wake = '';
await call('POST', '/reply', { charId: a.id });
ok(kv('mc:promise').at === jst(2026, 12, 2, 7), 'next message with empty wake keeps the promise');
for (let i = 0; i < 4; i++) { await call('POST', '/send', { charId: a.id, text: '雑談' + i }); await call('POST', '/reply', { charId: a.id }); }
ai.length = 0; await call('POST', '/send', { charId: a.id, text: 'ねえ' }); await call('POST', '/reply', { charId: a.id });
ok(!ai.some((x) => x.sch.includes('"wake"')), 'long after the wake talk → no wake option');
// 第71版：時刻をあとから言っても取りこぼさない（トーク）
await call('POST', '/send', { charId: a.id, text: '明日モーニングコールお願いできる？' });
A.wake = ''; await call('POST', '/reply', { charId: a.id });
await call('POST', '/send', { charId: a.id, text: '7時半で' });
A.wake = '7時半'; ai.length = 0; await call('POST', '/reply', { charId: a.id });
ok(ai.some((x) => x.sch.includes('"wake"') && x.sys.includes('時刻がこの返事で決まった')) && kv('mc:promise').at === jst(2026, 12, 2, 7, 30), 'talk: time given in the next message → promise (7時半)');
A.wake = '';
// ---- 約束：ふつうの通話（上書き）
let r = await call('POST', '/call/start', { charId: m.id }); await call('POST', '/call/connect', { id: r.call.id });
A.wake = '06:30';
let s = await call('POST', '/call/say', { id: r.call.id, text: '明日6時半に起こしてくれる？' });
p = kv('mc:promise');
ok(s.promise && p.charId === m.id && p.at === jst(2026, 12, 2, 6, 30) && p.keep && p.src === 'call', 'call promise → 6:30, replaces');
A.wake = '';
await call('POST', '/call/end', { id: r.call.id });
// 第71版：通話で「お願い」→「何時？」→「6時で」
r = await call('POST', '/call/start', { charId: m.id }); await call('POST', '/call/connect', { id: r.call.id });
A.wake = ''; await call('POST', '/call/say', { id: r.call.id, text: 'あした もーにんぐ こーる おねがい できるかな' }); // 音声認識のひらがな・空白
ok(ai.some((x) => x.sch.includes('"wake"')), 'call: hiragana with spaces → wake asked');
A.wake = '06:00'; ai.length = 0;
s = await call('POST', '/call/say', { id: r.call.id, text: '6時で' });
ok(ai.some((x) => x.sch.includes('"wake"')) && s.promise && kv('mc:promise').at === jst(2026, 12, 2, 6) && kv('mc:promise').charId === m.id, 'call: time said later → promise');
s = await call('POST', '/call/say', { id: r.call.id, text: 'ありがとう' });
ok(!s.promise, 'same promise written again → no second notice');
A.wake = '+180'; s = await call('POST', '/call/say', { id: r.call.id, text: 'やっぱり3時間後に起こして' });
ok(s.promise && kv('mc:promise').at === clock + 180 * 60e3, '"+180" → exactly 3 hours later');
A.wake = '午後3時'; s = await call('POST', '/call/say', { id: r.call.id, text: 'やっぱり午後3時に起こして' });
ok(s.promise && kv('mc:promise').at === jst(2026, 12, 2, 15), '"午後3時" → 15:00');
A.wake = '6'; s = await call('POST', '/call/say', { id: r.call.id, text: 'じゃあ6で' });
ok(!s.promise && DB.raw.prepare("SELECT v FROM kv WHERE k='log'").get()?.v.includes('時刻が読めません') !== false, 'bare number refused (kept the old promise)');
ok(kv('mc:promise').at === jst(2026, 12, 2, 15), 'old promise kept');
A.wake = '';
await call('POST', '/call/end', { id: r.call.id });
// ---- 約束：寝落ち通話・引き継がない
r = await call('POST', '/call/start', { charId: a.id, sleep: true, keep: false }); await call('POST', '/call/connect', { id: r.call.id });
A.wake = '06:00';
await call('POST', '/call/say', { id: r.call.id, text: '6時に起こして……' });
p = kv('mc:promise');
ok(p.charId === a.id && p.at === jst(2026, 12, 2, 6) && p.keep === false && p.src === 'sleep', 'nokeep sleep call → promise without memory');
A.wake = '';
await call('POST', '/call/end', { id: r.call.id, by: 'sleep' });
// ---- 設定：同じ朝 → 約束を優先
let e = 0; try { await call('POST', '/mc/set', { time: '07:30', who: 'pick', charId: nv.id }); } catch (x) { e = x.status; } ok(e === 400, 'set: needs a voice');
let v = await call('POST', '/mc/set', { time: '07:30', who: 'pick', charId: m.id, keep: true });
ok(v.mc.set.at === jst(2026, 12, 2, 7, 30) && v.mc.skipSet, 'set 7:30 same morning as promise → will be skipped');
ok((await call('GET', '/sync?since=0')).mc.promise.charId === a.id, 'sync carries morning call');
// ---- 鳴る：静かな時間でも・GPU を1分前に起こす・Bark は重要な通知
clock = jst(2026, 12, 2, 5, 58);
const health = []; const f0 = globalThis.fetch; globalThis.fetch = async (u, i) => { if (String(u).includes('/health')) { health.push(clock); return new Response('{}'); } return f0(u, i); };
await call('POST', '/settings', { settings: { ttsUrl: 'https://tts.example' } });
barks.length = 0;
await cron(1); // 5:59
ok(health.length >= 1 && !kv('mc:run'), 'GPU woken a minute before');
await cron(1); // 6:00
let run = kv('mc:run'), cl = calls().find((x) => x.morning);
ok(run && run.charId === a.id && run.tries === 1 && cl && cl.status === 'ringing' && cl.nokeep, 'rings at 6:00 in quiet hours (promise, nokeep)');
ok(barks.some((b) => b.includes('⏰ モーニングコール') && b.includes('"level":"critical"') && b.includes('"call":"1"')), 'Bark: critical ringing alert');
ok(!kv('mc:promise'), 'promise used');
// ---- 出ない → 4分おきに計4回 → 最後は留守電
A.leave = { kind: 'voicemail', text: '……起きてますか？ 起きたら連絡ください。' };
for (let i = 0; i < 20; i++) await cron(1);
const am = msgs(a.id).filter((x) => x.at >= jst(2026, 12, 2, 5));
const missed = am.filter((x) => x.kind === 'call');
ok(missed.length === 4 && missed.every((x) => x.meta.morning && x.meta.nokeep), '4 missed calls, all hidden from the character');
ok(missed[1].at - missed[0].at >= 4 * 60e3 && missed[1].at - missed[0].at < 6 * 60e3, 'about 4 minutes apart');
const vmm = am.find((x) => x.kind === 'vm');
ok(vmm && vmm.meta.nokeep && vmm.meta.morning && !kv('mc:run') && !calls().length, 'final: voicemail left, run finished');
ok(ai.some((x) => x.sch.includes('voice_message') && x.sys.includes('4回')), 'AI chose voicemail or voice message by personality');
// キャラ（AI）からは見えない
await call('POST', '/send', { charId: a.id, text: 'おはよう' }); ai.length = 0;
await call('POST', '/reply', { charId: a.id });
const q = ai.find((x) => x.sch.includes('"messages"'));
ok(q && !q.user.includes('電話をかけたが') && !q.user.includes('留守番電話'), 'nokeep morning call invisible to the character');
// 設定の 7:30 はお休み
await cron(100);
ok(!kv('mc:set') && !msgs(m.id).some((x) => x.kind === 'call' && x.at > jst(2026, 12, 2, 7)), 'set skipped on the promised morning');

// ---- 設定：ランダム・止めている子も・出たら起こしてキャラから切る・記憶に残る
await call('POST', '/char', { char: { ...m, paused: true } });
await call('POST', '/settings', { settings: { omotePausedIds: [m.id] } }); // その子だけ止める（第48版のしくみ）
await call('POST', '/messages/delete', { charId: a.id, ids: msgs(a.id).map((x) => x.id) }); // 朱里はトークが空 → 候補外
v = await call('POST', '/mc/set', { time: '08:00', who: 'random', keep: true });
ok(v.mc.set.who === 'random', 'set random');
const cand = (await call('GET', '/mc')).chars;
ok(cand.length === 1 && cand[0] === m.id, 'random candidates: voice + talked in omote 1:1 (' + cand + ')');
clock = jst(2026, 12, 3, 7, 58); await cron(2);
cl = calls().find((x) => x.morning);
ok(cl && cl.charId === m.id && !cl.nokeep, 'random picked マリ (even paused)');
let ans = await call('POST', '/call/answer', { id: cl.id });
ok(ans.lines.length && !kv('mc:run'), 'answered → no more retries');
ok(ai.some((x) => x.sys.includes('モーニングコール（最優先）') && x.sys.includes('hangup を true')), 'prompt: wake up then hang up yourself');
A.hang = true;
s = await call('POST', '/call/say', { id: cl.id, text: 'おはよう……起きたよ' });
ok(s.hangup === true && s.lines.length, 'character hangs up after waking you');
A.hang = false;
const end = await call('POST', '/call/end', { id: cl.id, by: 'char' });
ok(end.message.meta.morning && !end.message.meta.nokeep && end.message.meta.sum, 'call log kept with summary');
ok(DB.raw.prepare('SELECT text FROM memories WHERE char_id=?').all(m.id).some((x) => x.text.includes('電話で話した')), 'memory kept');
await cron(10);
ok(!calls().length && !kv('mc:run'), 'no retries after answering');

// ---- 拒否したら、かけ直さずに最後の一言（ボイスメッセージ）
await call('POST', '/mc/set', { time: '09:00', who: 'pick', charId: m.id, keep: true });
A.leave = { kind: 'voice_message', text: 'もう、起きてるなら出てくださいよ。' };
clock = jst(2026, 12, 3, 8, 59); await cron(1);
cl = calls().find((x) => x.morning);
await call('POST', '/call/decline', { id: cl.id });
await cron(10);
const mm = msgs(m.id).filter((x) => x.at >= jst(2026, 12, 3, 8, 59));
ok(mm.filter((x) => x.kind === 'call').length === 1 && mm.some((x) => x.kind === 'voice' && x.meta.morning && x.meta.est > 0), 'declined → no retries, left a voice message');

// ---- テスト：今すぐ1回だけ・かけ直しなし・記憶なし
r = await call('POST', '/mc/test', { who: 'pick', charId: m.id });
cl = calls().find((x) => x.morning);
ok(cl && cl.test && cl.nokeep && cl.status === 'ringing', 'test rings now');
await cron(8);
const tm = msgs(m.id).filter((x) => x.meta && x.meta.test);
ok(tm.length === 1 && tm[0].kind === 'call' && !calls().length && !kv('mc:run'), 'test: one missed call only');
// 取り消し
await call('POST', '/mc/set', { time: '10:00', who: 'pick', charId: m.id });
await call('POST', '/mc/cancel', { which: 'set' });
ok(!(await call('GET', '/mc')).mc, 'cancel set');
// ---- 止めている子を「決めた1人」に：出なければ最後まで4回かけて、留守電かボイスメッセージを残す
ok((await call('GET', '/sync?since=0')).settings.omotePausedIds.includes(m.id), 'マリ is stopped');
await call('POST', '/mc/set', { time: '06:00', who: 'pick', charId: m.id, keep: true });
A.leave = { kind: 'voice_message', text: 'おはようございます……起きてくださいね。' };
const t0 = jst(2026, 12, 4, 5, 58); clock = t0; ai.length = 0;
for (let i = 0; i < 22; i++) await cron(1);
const sm = msgs(m.id).filter((x) => x.at >= t0);
ok(sm.filter((x) => x.kind === 'call' && x.meta.morning).length === 4, 'stopped character: rang 4 times');
ok(sm.some((x) => x.kind === 'voice' && x.meta.morning && x.text.includes('起きて')), 'stopped character: left a voice message');
A.leave = { kind: 'voicemail', text: '留守電です。起きたら連絡を。' };
await call('POST', '/mc/set', { time: '06:00', who: 'pick', charId: m.id, keep: true });
clock = jst(2026, 12, 5, 5, 58); for (let i = 0; i < 22; i++) await cron(1);
ok(msgs(m.id).some((x) => x.kind === 'vm' && x.text.includes('留守電です')) && (await call('GET', '/sync?since=0')).vms[m.id].some((v) => v.text.includes('留守電です')), 'stopped character: left a voicemail');
// 出たときも話す
await call('POST', '/mc/set', { time: '06:00', who: 'pick', charId: m.id, keep: true });
clock = jst(2026, 12, 6, 5, 58); await cron(2);
const scl = calls().find((x) => x.morning);
const sa = await call('POST', '/call/answer', { id: scl.id });
const ss = await call('POST', '/call/say', { id: scl.id, text: 'おはよう' });
ok(sa.lines.length && ss.lines.length && !ss.paused, 'stopped character: talks in the morning call');
await call('POST', '/call/end', { id: scl.id });
// ふだんのトークは止まったまま
await call('POST', '/send', { charId: m.id, text: 'ありがとう' });
const rp = await call('POST', '/reply', { charId: m.id });
ok(rp.paused && !rp.messages.length, 'stopped character: normal talk stays stopped');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
