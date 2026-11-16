// 第72版：予定のお知らせ（表だけ）。トーク・通話・寝落ち通話・モーニングコールで頼む／変える／取りやめる、設定画面から（記憶なし・ランダムも）、
// 時刻ちょうどに頼んだ子が電話（静かな時間・止めている子でも・Bark 重要な通知 音量3・通知に中身）、出なければ4分おきに計3回→中身入りの留守電かボイスメッセージ、
// ほかの電話中なら終わり次第（遅れても必ず）、同じ子の予定は1回で、60日まで
import W from './worker.mjs';
import { makeDB } from './fake.mjs';
const DB = makeDB();
const env = { DB, APP_TOKEN: 'pw', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x', BARK_DEVICE_KEY: 'dev' };
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
const flush = async () => { while (waits.length) await waits.shift(); };
const call = async (m, p, b) => { const r = await W.fetch(new Request('https://w' + p, { method: m, headers: { 'X-App-Token': 'pw' }, body: b ? JSON.stringify(b) : undefined }), env, ctx); const d = await r.json(); await flush(); if (!r.ok) throw Object.assign(new Error(p + ' ' + JSON.stringify(d)), { status: r.status }); return d; };
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
const ai = [], barks = [];
const A = { rem: [], wake: '', leave: { kind: 'voicemail', text: '15時の歯医者、忘れないでくださいね。' }, hang: false };
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
  else if (sch.includes('"hangup"')) out = { messages: ['もしもし'], hangup: A.hang, ...(sch.includes('"wake"') ? { wake: A.wake } : {}), ...(sch.includes('"reminders"') ? { reminders: A.rem } : {}) };
  else if (sch.includes('"summary"')) out = { summary: '話した。' };
  else if (sch.includes('"after"')) out = { answer: true, reason: '', after: 'none', line: '' };
  else if (sch.includes('"messages"')) { out = { messages: ['わかりました'] }; for (const [k, v] of Object.entries(schO.properties || {})) if (!(k in out)) out[k] = k === 'reminders' ? A.rem : k === 'wake' ? A.wake : /integer/i.test(JSON.stringify(v)) ? -1 : /array/i.test(JSON.stringify(v)) ? [] : ''; }
  else out = {};
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: JSON.stringify(out) } }] } : { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
};
const RN = Date.now; let clock = RN(); Date.now = () => clock;
const jst = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi);
const cron = async (n = 1, step = 60e3) => { for (let i = 0; i < n; i++) { clock += step; const w = []; await W.scheduled({ scheduledTime: clock }, env, { waitUntil: (p) => w.push(p) }); await Promise.allSettled(w); } };
const msgs = (id) => DB.raw.prepare('SELECT * FROM messages WHERE char_id=? ORDER BY id').all(id).map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }));
const calls = () => DB.raw.prepare("SELECT v FROM kv WHERE k LIKE 'call:%'").all().map((r) => JSON.parse(r.v));
const kv = (k) => { const r = DB.raw.prepare('SELECT v FROM kv WHERE k=?').get(k); return r ? JSON.parse(r.v) : null; };
const list = () => kv('rem:list') || [];
await call('POST', '/settings', { settings: { delayEnabled: false, lifeEnabled: false, quietEnabled: true, quietStart: 0, quietEnd: 23, notifyVia: 'bark', proactive: false } });
const a = (await call('POST', '/char', { char: { name: '朱里', prompt: 'p', voice: 'akari', perDay: 0 } })).char;
const m = (await call('POST', '/char', { char: { name: 'シャロ', prompt: 'p', voice: 'sharo', perDay: 0 } })).char;

// ---- トークで頼む（日をまたぐ）
clock = jst(2026, 11, 16, 12, 30);
await call('POST', '/send', { charId: a.id, text: '明後日の15時に歯医者があるから、時間になったら教えて' });
A.rem = [{ op: 'add', id: '', when: '2026-11-18 15:00', what: '歯医者' }]; ai.length = 0;
await call('POST', '/reply', { charId: a.id });
ok(ai.some((x) => x.sch.includes('"reminders"') && x.sys.includes('予定の時刻に知らせてほしい')), 'talk: reminder option offered');
let l = list();
ok(l.length === 1 && l[0].at === jst(2026, 11, 18, 15) && l[0].what === '歯医者' && l[0].charId === a.id && l[0].keep && l[0].src === 'talk', 'talk reminder saved');
await call('POST', '/send', { charId: a.id, text: 'ありがとう' }); ai.length = 0;
await call('POST', '/reply', { charId: a.id });
ok(list().length === 1, 'same reminder written again → not doubled');
// あいまいなら入れない（AI が聞き返す）→ あとの返事で決まる
await call('POST', '/send', { charId: a.id, text: '来週の打ち合わせも教えてほしい' });
A.rem = []; await call('POST', '/reply', { charId: a.id });
await call('POST', '/send', { charId: a.id, text: '月曜の10時半で' });
A.rem = [{ op: 'add', id: '', when: '11月23日 10時半', what: '打ち合わせ' }];
await call('POST', '/reply', { charId: a.id });
ok(list().length === 2 && list()[1].at === jst(2026, 11, 23, 10, 30), 'time decided in a later message → saved (11月23日 10時半)');
// 60日より先は入れない
A.rem = [{ op: 'add', id: '', when: '2027-03-01 10:00', what: '旅行' }];
await call('POST', '/send', { charId: a.id, text: '3月1日の旅行も教えて' }); await call('POST', '/reply', { charId: a.id });
ok(list().length === 2, 'beyond 60 days refused');
ok(ai.some((x) => x.sys.includes('60日より先')), 'prompt says 60 days');
// ---- 通話で変える・取りやめる・足す
let r = await call('POST', '/call/start', { charId: a.id }); await call('POST', '/call/connect', { id: r.call.id });
const dent = list().find((x) => x.what === '歯医者');
A.rem = [{ op: 'change', id: dent.id, when: '2026-11-18 16:00', what: '' }];
let s = await call('POST', '/call/say', { id: r.call.id, text: '歯医者、16時に変わったんだ' });
ok(s.rems && s.rems[0].op === 'change' && list().find((x) => x.id === dent.id).at === jst(2026, 11, 18, 16), 'call: change');
ok(ai.some((x) => x.sys.includes(`[${dent.id}]`) && x.sys.includes('歯医者')), 'call prompt lists my reminders with ids');
const meet = list().find((x) => x.what === '打ち合わせ');
A.rem = [{ op: 'cancel', id: meet.id, when: '', what: '' }];
s = await call('POST', '/call/say', { id: r.call.id, text: '打ち合わせはなくなったよ' });
ok(!list().some((x) => x.id === meet.id), 'call: cancel');
A.rem = [{ op: 'cancel', id: 'nope', when: '', what: '' }];
await call('POST', '/call/say', { id: r.call.id, text: 'キャンセル' });
ok(list().length === 1, 'unknown id ignored');
A.rem = [];
await call('POST', '/call/end', { id: r.call.id });
// ---- 寝落ち通話（引き継がない）で頼む → keep:false
r = await call('POST', '/call/start', { charId: m.id, sleep: true, keep: false }); await call('POST', '/call/connect', { id: r.call.id });
A.rem = [{ op: 'add', id: '', when: '+180', what: '洗濯物' }];
s = await call('POST', '/call/say', { id: r.call.id, text: '3時間後に洗濯物のこと教えて' });
const wash = list().find((x) => x.what === '洗濯物');
ok(wash && wash.keep === false && wash.src === 'sleep' && wash.at === clock + 180 * 60e3 && s.rems, 'sleep nokeep: +180, keep false');
// 第73版：「12時に床屋に行くんだけれども、その時間になったら伝えて」（実際に取りこぼした言い方）
A.rem = [{ op: 'add', id: '', when: '2026-11-17 12:00', what: '床屋' }]; ai.length = 0;
s = await call('POST', '/call/say', { id: r.call.id, text: '12時に床屋に行くんだけれどもその時間になったら伝えてくれないかい' });
ok(ai.some((x) => x.sch.includes('"reminders"')) && s.rems && list().some((x) => x.what === '床屋' && x.keep === false), '「その時間になったら伝えて」 → reminder');
await call('POST', '/rem/del', { id: list().find((x) => x.what === '床屋').id });
A.rem = [];
await call('POST', '/call/end', { id: r.call.id, by: 'sleep' });
// ---- 設定画面から（記憶なし・ランダム）
let v = await call('POST', '/rem/add', { date: '2026-11-17', time: '09:00', what: 'ゴミ出し', who: 'pick', charId: m.id });
ok(v.rem.list.some((x) => x.what === 'ゴミ出し' && x.keep === false && x.src === 'set'), 'settings add (always nokeep)');
v = await call('POST', '/rem/add', { date: '2026-11-17', time: '09:00', what: '薬', who: 'random' });
ok(v.rem.list.some((x) => x.what === '薬' && x.who === 'random' && !x.charId), 'settings add random');
let e = 0; try { await call('POST', '/rem/add', { date: '2026-11-16', time: '01:00', what: 'x', who: 'pick', charId: m.id }); } catch (x) { e = x.status; } ok(e === 400, 'past refused');
const gomi = list().find((x) => x.what === 'ゴミ出し');
v = await call('POST', '/rem/edit', { id: gomi.id, date: '2026-11-17', time: '09:30', what: 'ゴミ出し（燃える）', who: 'pick', charId: m.id });
ok(list().find((x) => x.id === gomi.id).at === jst(2026, 11, 17, 9, 30), 'settings edit');
ok((await call('GET', '/sync?since=0')).rem.list.length === 4, 'sync carries reminders');

// ---- 鳴る：3時間後の洗濯物（引き継がない・シャロ）。静かな時間でも、Bark 重要な通知 音量3、通知に中身
await call('POST', '/settings', { settings: { omotePausedIds: [m.id], ttsUrl: 'https://tts.example' } });
barks.length = 0;
clock = wash.at - 120e3; await cron(2);
let cl = calls().find((x) => x.remind);
ok(cl && cl.charId === m.id && cl.nokeep && cl.status === 'ringing', 'rings on time (stopped character, quiet hours)');
ok(barks.some((b) => b.includes('📅 洗濯物（') && b.includes('"level":"critical"') && b.includes('"volume":"3"') && b.includes('"call":"1"')), 'Bark: 📅 洗濯物（HH:MM）, critical, volume 3, ringing');
let ans = await call('POST', '/call/answer', { id: cl.id });
ok(ans.lines.length && !kv('rem:run'), 'answered → no retries');
const q = ai.filter((x) => x.sys.includes('予定のお知らせ（最優先）')).pop();
ok(q && q.sys.includes('洗濯物') && q.sys.includes('寝落ち通話で頼まれた') && q.sys.includes('hangup を true'), 'prompt: what, where it was asked, hang up yourself');
A.hang = true; s = await call('POST', '/call/say', { id: cl.id, text: '大丈夫、ありがとう' }); A.hang = false;
ok(s.hangup && !s.paused, 'stopped character talks and hangs up');
const lg = (await call('POST', '/call/end', { id: cl.id, by: 'char' })).message;
ok(lg.meta.remind === '洗濯物' && lg.meta.nokeep && !lg.meta.sum, 'record: remind, nokeep, no summary');
// ---- 早い順に。ほかの電話中 → 終わり次第（遅れても必ず）
clock = jst(2026, 11, 17, 9, 28); await cron(1); // 9:29（9:00 の分は過ぎている）
cl = calls().find((x) => x.remind);
ok(cl && cl.remind.length === 1 && cl.remind[0].what === '薬' && [a.id, m.id].includes(cl.charId), 'earliest first (random 薬 9:00)');
await call('POST', '/call/answer', { id: cl.id });
await cron(3);
ok(calls().filter((x) => x.remind).length === 1 && list().some((x) => x.what.includes('ゴミ')), 'busy → waits');
await call('POST', '/call/end', { id: cl.id });
await cron(1);
cl = calls().find((x) => x.remind);
ok(cl && cl.remind[0].what.includes('ゴミ') && cl.charId === m.id && !list().some((x) => x.what.includes('ゴミ')), 'after the call ends → next reminder (late but always)');
await call('POST', '/call/answer', { id: cl.id });
ok(ai.some((x) => x.sys.includes('分すぎてしまった')), 'late reminder: character knows it is late');
await call('POST', '/call/end', { id: cl.id });
// 同じ子・同じ時刻の予定は1回の電話で
await call('POST', '/rem/add', { date: '2026-11-17', time: '12:00', what: 'お昼の薬', who: 'pick', charId: m.id });
await call('POST', '/rem/add', { date: '2026-11-17', time: '12:00', what: '洗い物', who: 'pick', charId: m.id });
clock = jst(2026, 11, 17, 11, 59); await cron(1);
cl = calls().find((x) => x.remind);
ok(cl && cl.remind.length === 2 && barks.some((b) => b.includes('📅 お昼の薬（12:00）・洗い物（12:00）')), 'same character, same time → one call with both');
await call('POST', '/call/answer', { id: cl.id }); await call('POST', '/call/end', { id: cl.id });
// ---- 出ない → 4分おきに計3回 → 中身入りの留守電
clock = jst(2026, 11, 18, 15, 58); A.leave = { kind: 'voicemail', text: '16時の歯医者の時間ですよ、大丈夫ですか？' };
await call('POST', '/rem/add', { date: '2026-11-18', time: '16:00', what: '薬局', who: 'pick', charId: a.id }); // 同じ子・同じ時刻（記憶なし）→ 別の電話
await cron(2);
cl = calls().find((x) => x.remind);
ok(cl && cl.charId === a.id && cl.remind.length === 1 && cl.remind[0].what === '歯医者', 'keep and nokeep are not mixed in one call');
for (let i = 0; i < 14; i++) await cron(1);
const am = msgs(a.id).filter((x) => x.at >= jst(2026, 11, 18, 15, 58));
const miss = am.filter((x) => x.kind === 'call' && x.meta.remind === '歯医者');
ok(miss.length === 3, '3 calls (4 minutes apart)');
ok(miss[1].at - miss[0].at >= 4 * 60e3 && miss[1].at - miss[0].at < 6 * 60e3, '4 minutes apart');
const vm = am.find((x) => x.kind === 'vm' && x.meta.remind);
ok(vm && vm.text.includes('歯医者') && !vm.meta.nokeep, 'final voicemail with the plan');
ok(ai.some((x) => x.sch.includes('voice_message') && x.sys.includes('16:00') && x.sys.includes('歯医者') && x.sys.includes('必ず入れる')), 'leave prompt includes the plan');
// 次の電話（薬局・同じ子・記憶なし）は前のが終わってから
for (let i = 0; i < 8 && !calls().some((x) => x.remind && x.status === 'ringing'); i++) await cron(1);
cl = calls().find((x) => x.remind);
ok(cl && cl.remind[0].what === '薬局' && cl.nokeep, 'then the other reminder');
await call('POST', '/call/decline', { id: cl.id });
await cron(6);
const nDecl = msgs(a.id).filter((x) => x.kind === 'call' && x.meta.remind === '薬局').length;
await cron(6);
ok(!kv('rem:run') && msgs(a.id).filter((x) => x.kind === 'call' && x.meta.remind === '薬局').length === nDecl && msgs(a.id).some((x) => x.meta && x.meta.declined && x.meta.remind === '薬局'), 'declined → no more retries');
// 消す
v = await call('POST', '/rem/add', { date: '2026-11-20', time: '10:00', what: 'テスト', who: 'pick', charId: a.id });
await call('POST', '/rem/del', { id: v.rem.list[0].id });
ok(!list().length, 'delete from the screen');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
