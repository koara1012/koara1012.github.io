import W from './worker.mjs';
import { makeDB } from './fake.mjs';
// 表のグループ通話（第55版）：作る（声のある子だけ・7人まで）・設定・発信（出る子を決める／テストは全員）・掛け合い・さえぎり・終話のまとめはグループの記憶だけ
const DB = makeDB();
const env = { DB, APP_TOKEN: 'pw', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' };
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
const call = async (m, p, b) => { const r = await W.fetch(new Request('https://w' + p, { method: m, headers: { 'X-App-Token': 'pw' }, body: b ? JSON.stringify(b) : undefined }), env, ctx); const d = await r.json(); if (!r.ok) { const e = new Error(p + ' ' + JSON.stringify(d)); e.status = r.status; throw e; } return d; };
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
const ai = [];
const answer = { gans: null, reply: { lines: [{ speaker: '朱里', text: 'もしもし……' }, { speaker: 'マリさん', text: 'やっほー、聞こえる？' }], wait_user: false } };
globalThis.fetch = async (u, i) => {
  u = String(u);
  if (u.startsWith('https://tts.example.modal.run/health')) return new Response('{"status":"ok"}');
  if (u.startsWith('https://api.open-meteo.com/')) return new Response('{}');
  const body = JSON.parse(i.body);
  const sys = body.systemInstruction.parts[0].text, sch = JSON.stringify(body.generationConfig.responseSchema);
  const user = body.contents.map((c) => c.parts.map((p) => p.text || '').join('|')).join('\n');
  ai.push({ sys, sch, user });
  let out;
  if (sch.includes('wait_user')) out = answer.reply;
  else if (sch.includes('"members"')) out = answer.gans;
  else if (sch.includes('"summary"')) out = { summary: '3人で週末の予定を話して、笑い合った。' };
  else out = { messages: ['返事'] };
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
};
const flush = async () => { while (waits.length) await waits.shift(); };
await call('POST', '/settings', { settings: { delayEnabled: false, lifeEnabled: false, quietEnabled: false, ttsUrl: 'https://tts.example.modal.run' } });
const noVoice = (await call('POST', '/char', { char: { name: '声なし', prompt: 'p' } })).char;
const a = (await call('POST', '/char', { char: { name: '朱里', prompt: '朱里の設定', voice: 'akari' } })).char;
const m = (await call('POST', '/char', { char: { name: 'マリ', prompt: 'マリの設定', voice: 'mari' } })).char;
const s = (await call('POST', '/char', { char: { name: 'すもも', prompt: 'すももの設定', voice: 'sumomo' } })).char;
// 1対1のトーク（参照される）
await call('POST', '/send', { charId: a.id, text: '朱里さん、昨日はありがとう' });

// ---- 作る
try { await call('POST', '/ogroup', { group: { name: 'x', members: [a.id, noVoice.id] } }); ok(false, 'no-voice member refused'); } catch (e) { ok(e.status === 400 && e.message.includes('声の名前'), 'no-voice member refused'); }
const many = [];
for (let i = 0; i < 7; i++) many.push((await call('POST', '/char', { char: { name: '子' + i, prompt: 'p', voice: 'v' + i } })).char.id);
try { await call('POST', '/ogroup', { group: { name: 'x', members: [a.id, ...many] } }); ok(false, '8 members refused'); } catch (e) { ok(e.status === 400 && e.message.includes('7人'), '8 members refused'); }
let g = (await call('POST', '/ogroup', { group: { name: 'テニス部', members: [a.id, m.id, s.id], prompt: '3人は同じテニス部', roles: { [a.id]: '部長', [noVoice.id]: 'x' } } })).group;
ok(g.id.startsWith('ogp-') && g.members.length === 3 && g.roles[a.id] === '部長' && !g.roles[noVoice.id], 'group created with roles');
ok(g.ringIn === true && g.lateJoin === true && g.paused === false, 'group default settings');
let sy = await call('GET', '/sync?since=0');
ok(sy.ogroups.some((x) => x.id === g.id) && !sy.groups.some((x) => x.id === g.id), 'sync: ogroups separate from ura groups');
g = (await call('POST', '/ogroup', { group: { ...g, lateJoin: false } })).group;
ok(g.lateJoin === false && g.created, 'update keeps id');

// ---- 止めている
await call('POST', '/ogroup', { group: { ...g, paused: true } });
try { await call('POST', '/gcall/start', { groupId: g.id }); ok(false, 'paused group refused'); } catch (e) { ok(e.status === 409, 'paused group refused'); }
g = (await call('POST', '/ogroup', { group: { ...g, paused: false } })).group;
// キャラごとに止めている子でもグループでは話す
await call('POST', '/settings', { pauseChar: { id: m.id, on: true } });

// ---- 発信（遅れて入るがオフ → 全員すぐ出る）
let r = await call('POST', '/gcall/start', { groupId: g.id });
ok(r.call.group === g.id && r.call.members.length === 3 && r.ringMs <= 9000, 'start: lateJoin off → all join');
ok(!ai.some((x) => x.sch.includes('"members"')), 'no answer decision when lateJoin off');
r = await call('POST', '/gcall/connect', { id: r.call.id });
ok(r.answered && r.lines.length === 2 && r.lines[1].id === m.id && r.lines[0].id === a.id, 'connect: lines with speakers (name with さん matched)');
let q = ai.pop();
ok(q.sys.includes('グループ通話') && q.sys.includes('3人は同じテニス部') && q.sys.includes('部長') && q.sys.includes('朱里さん、昨日はありがとう'), 'prompt: group setting, member role, 1:1 talk');
ok(q.sys.includes('通話に入ったところ'), 'prompt: first words');
const cid = r.call.id;
// ほかの電話はかけられない（通話中）
try { await call('POST', '/call/start', { charId: s.id }); ok(false, 'busy'); } catch (e) { ok(e.status === 409, 'busy while group call'); }
// 黙って聞いている → 続ける
answer.reply = { lines: [{ speaker: 'すもも', text: 'ねえねえ、週末どうする？' }, { speaker: '朱里', text: '私は……空いてます。' }, { speaker: 'マリ', text: 'じゃあ決まり！' }], wait_user: true };
r = await call('POST', '/gcall/say', { id: cid, text: '' });
ok(r.lines.length === 3 && r.wait === true, 'continue without user → 3 lines, wait_user');
ok(ai.pop().sys.includes('ユーザーは黙って聞いている'), 'prompt: silent user');
// 2セリフ目でさえぎる → 3セリフ目は言わなかったことに
answer.reply = { lines: [{ speaker: '朱里', text: 'あ、ごめんなさい……どうぞ。' }], wait_user: true };
r = await call('POST', '/gcall/say', { id: cid, text: '待って、私も行きたい！', heard: 2 });
q = ai.pop();
ok(q.user.includes('私は……空いてます。（ここで、ユーザーにさえぎられた）') && !q.user.includes('じゃあ決まり'), 'interrupted: unheard line dropped, cut mark');
ok(q.user.includes('待って、私も行きたい！'), 'user line in transcript');
let kvc = JSON.parse(DB.raw.prepare('SELECT v FROM kv WHERE k=?').get('call:' + cid).v);
ok(!kvc.transcript.some((x) => x.text === 'じゃあ決まり！'), 'transcript stored without unheard line');
// ［勝手に話す］（第56版）：auto のときは、どんどん話し続ける・ときどき話を振る
answer.reply = { lines: [{ speaker: 'マリ', text: 'そういえば新しいカフェできたよね。' }], wait_user: false };
r = await call('POST', '/gcall/say', { id: cid, text: '', auto: true });
q = ai.pop();
ok(q.sys.includes('聞き役にまわっている') && q.sys.includes('ユーザーの返事を待たない'), 'auto: keep talking prompt');
// 終わる
r = await call('POST', '/gcall/end', { id: cid, est: { usd: 0.02, gpuMs: 80000 } });
await flush();
ok(r.message && r.message.kind === 'callog' && r.message.charId === g.id && r.message.meta.group && r.message.meta.sum.includes('週末'), 'end: callog in group talk with summary');
const gm = (await call('GET', '/ogroup/memory?id=' + g.id)).memory;
ok(gm.length === 1 && gm[0].text.includes('グループ通話'), 'summary saved to group memory');
ok(!DB.raw.prepare("SELECT 1 FROM memories WHERE text LIKE '%グループ通話%'").get(), 'not saved to 1:1 memories');
ok(!DB.raw.prepare("SELECT 1 FROM messages WHERE char_id=? AND kind='callog'").get(a.id), 'no record in 1:1 talk');
ok((await call('GET', '/sync?since=0')).messages.some((x) => x.charId === g.id && x.kind === 'callog'), 'sync returns group call log');
// 次の通話ではグループの記憶が入る
r = await call('POST', '/gcall/start', { groupId: g.id, test: true });
await call('POST', '/gcall/connect', { id: r.call.id });
ok(ai.pop().sys.includes('週末の予定'), 'group memory in next call prompt');
await call('POST', '/gcall/end', { id: r.call.id });
await flush();

// ---- 通話ごとの会話の文字・続きから話す（第57版）
const logMsgId = (await call('GET', '/sync?since=0')).messages.filter((x) => x.charId === g.id && x.kind === 'callog')[0].id;
let lg = (await call('GET', `/gcall/log?group=${g.id}&id=${logMsgId}`)).log;
ok(lg.transcript.some((x) => x.text === '待って、私も行きたい！' && x.who === 'me') && lg.transcript.some((x) => x.who === a.id) && !lg.transcript.some((x) => x.text === 'じゃあ決まり！'), 'log keeps what was said (not the unheard line)');
answer.reply = { lines: [{ speaker: 'マリ', text: 'さっきの続きだけどさ。' }], wait_user: false };
r = await call('POST', '/gcall/start', { groupId: g.id, test: true, from: logMsgId });
await call('POST', '/gcall/connect', { id: r.call.id });
q = ai.pop();
ok(q.sys.includes('前回') && q.sys.includes('続き') && q.user.includes('待って、私も行きたい！') && q.user.includes('続きで'), 'continue: previous lines and continue prompt');
ok(!q.sys.includes('「もしもし」など、通話に入ったときの言葉から'), 'continue: not a fresh hello');
await call('POST', '/gcall/say', { id: r.call.id, text: '続きだね' });
const m2 = (await call('POST', '/gcall/end', { id: r.call.id })).message;
await flush();
ok(m2.meta.log && m2.meta.from === logMsgId, 'continued call record links to previous');
const lg2 = (await call('GET', `/gcall/log?group=${g.id}&id=${m2.id}`)).log;
ok(lg2.transcript.some((x) => x.old && x.text === '待って、私も行きたい！') && lg2.transcript.some((x) => !x.old && x.text === '続きだね'), 'continued log: old lines marked, new lines kept');
// 選んで消す：記録と会話の文字が一緒に消える
await call('POST', '/messages/delete', { charId: g.id, ids: [logMsgId] });
ok(!DB.raw.prepare('SELECT 1 FROM messages WHERE id=?').get(logMsgId), 'record deleted');
try { await call('GET', `/gcall/log?group=${g.id}&id=${logMsgId}`); ok(false, 'log deleted with record'); } catch (e) { ok(e.status === 404, 'log deleted with record'); }
try { await call('POST', '/gcall/start', { groupId: g.id, from: logMsgId }); ok(false, 'continue from deleted refused'); } catch (e) { ok(e.status === 404, 'continue from deleted refused'); }

// ---- 遅れて入るがオン：AI が出る子を決める・テストは全員
g = (await call('POST', '/ogroup', { group: { ...g, lateJoin: true } })).group;
answer.gans = { members: [{ name: '朱里', answer: true, reason: '空いている' }, { name: 'マリ', answer: false, reason: '授業中' }, { name: 'すもも', answer: true, reason: '' }] };
r = await call('POST', '/gcall/start', { groupId: g.id });
ok(r.call.members.length === 2 && !r.call.members.includes(m.id) && r.absent.some((x) => x.id === m.id && x.reason === '授業中'), 'lateJoin on: AI decides who joins');
await call('POST', '/gcall/end', { id: r.call.id }); // 呼び出し中にやめた
ok(!DB.raw.prepare("SELECT 1 FROM kv WHERE k=?").get('call:' + r.call.id), 'cancel while dialing removes call');
r = await call('POST', '/gcall/start', { groupId: g.id, test: true });
ok(r.call.members.length === 3 && r.ringMs === 3000, 'test: everyone joins');
await call('POST', '/gcall/end', { id: r.call.id });
// だれも出ない → 記録だけ
answer.gans = { members: [{ name: '朱里', answer: false, reason: '寝ている' }, { name: 'マリ', answer: false, reason: '' }, { name: 'すもも', answer: false, reason: '' }] };
r = await call('POST', '/gcall/start', { groupId: g.id });
ok(r.ringMs === 25000 && !r.call.members.length, 'nobody → long ring');
r = await call('POST', '/gcall/connect', { id: r.call.id });
ok(!r.answered && r.message.kind === 'callout' && r.message.charId === g.id, 'nobody answered → callout record');

// ---- 第58版：GPU を長く待っている呼び出しは消さない（ping が来ていれば）・つなぐときの失敗は記録に残す
r = await call('POST', '/gcall/start', { groupId: g.id, test: true });
kvc = JSON.parse(DB.raw.prepare('SELECT v FROM kv WHERE k=?').get('call:' + r.call.id).v);
kvc.created = Date.now() - 4 * 60e3; DB.raw.prepare('UPDATE kv SET v=? WHERE k=?').run(JSON.stringify(kvc), 'call:' + r.call.id);
await call('POST', '/call/ping', { id: r.call.id });
await W.scheduled({}, env, ctx); await flush();
ok(!!DB.raw.prepare('SELECT 1 FROM kv WHERE k=?').get('call:' + r.call.id), 'dialing call kept while app pings (long GPU wake)');
kvc = JSON.parse(DB.raw.prepare('SELECT v FROM kv WHERE k=?').get('call:' + r.call.id).v);
kvc.lastAt = Date.now() - 3 * 60e3; DB.raw.prepare('UPDATE kv SET v=? WHERE k=?').run(JSON.stringify(kvc), 'call:' + r.call.id);
await W.scheduled({}, env, ctx); await flush();
ok(!DB.raw.prepare('SELECT 1 FROM kv WHERE k=?').get('call:' + r.call.id), 'dialing call removed when app stopped pinging');
try { await call('POST', '/gcall/connect', { id: r.call.id }); ok(false, 'connect after removed'); } catch (e) { ok(e.status === 409 && e.message.includes('途中で切れて'), 'connect after removed: clear message'); }
const saveReply = answer.reply;
answer.reply = { lines: [], wait_user: false };
r = await call('POST', '/gcall/start', { groupId: g.id, test: true });
try { await call('POST', '/gcall/connect', { id: r.call.id }); ok(false, 'connect AI failure'); } catch (e) { ok(e.status === 500, 'connect AI failure returns error'); }
const lgs = JSON.parse(DB.raw.prepare("SELECT v FROM kv WHERE k='log'").get().v);
ok(lgs.some((x) => x.msg.includes('最初の言葉')) && !DB.raw.prepare('SELECT 1 FROM kv WHERE k=?').get('call:' + r.call.id), 'connect AI failure logged and call removed');
answer.reply = saveReply;

// ---- 放置された通話は毎分の見回りで終わる・残った通話の片付け
r = await call('POST', '/gcall/start', { groupId: g.id, test: true });
await call('POST', '/gcall/connect', { id: r.call.id });
kvc = JSON.parse(DB.raw.prepare('SELECT v FROM kv WHERE k=?').get('call:' + r.call.id).v);
kvc.lastAt = Date.now() - 10 * 60e3; DB.raw.prepare('UPDATE kv SET v=? WHERE k=?').run(JSON.stringify(kvc), 'call:' + r.call.id);
await W.scheduled({}, env, ctx); await flush();
ok(!DB.raw.prepare("SELECT 1 FROM kv WHERE k=?").get('call:' + r.call.id), 'idle group call ended by cron');
r = await call('POST', '/gcall/start', { groupId: g.id, test: true });
await call('POST', '/gcall/connect', { id: r.call.id });
await call('POST', '/call/start', { charId: s.id, force: true }); // アプリは通話していない → 残っていたグループ通話を片付けて1対1へ
ok(!DB.raw.prepare("SELECT 1 FROM kv WHERE k=?").get('call:' + r.call.id), 'stale group call cleared by force');
for (const x of (await call('GET', '/sync?since=0')).calls) await call('POST', '/call/decline', { id: x.id });

// ---- 記憶を消す・メンバーのキャラを消す・グループを消す
await call('POST', '/ogroup/memory/delete', { id: g.id, mid: gm[0].id });
ok(!(await call('GET', '/ogroup/memory?id=' + g.id)).memory.some((x) => x.id === gm[0].id), 'delete one memory');
await call('DELETE', '/char?id=' + s.id);
ok(!(await call('GET', '/sync?since=0')).ogroups.find((x) => x.id === g.id).members.includes(s.id), 'deleted char removed from group');
const ck = await call('GET', '/backup/check');
ok(!ck.warnings.some((w) => w.includes('持ち主のいない')), 'no orphan warning for group call logs');
await call('DELETE', '/ogroup?id=' + g.id);
const sy2 = await call('GET', '/sync?since=0');
ok(!sy2.ogroups.length && !DB.raw.prepare('SELECT 1 FROM messages WHERE char_id=?').get(g.id) && !DB.raw.prepare('SELECT 1 FROM kv WHERE k=?').get('gmem:' + g.id), 'delete group removes logs and memory');
ok(!DB.raw.prepare("SELECT 1 FROM kv WHERE k LIKE 'gclog:%'").get(), 'delete group removes call texts');

console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
