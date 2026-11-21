// 第81版：通話中の［📝状況］（すべての通話。ずっと効く・書き直し・消す・記録とまとめに入る・記憶に残さない通話には残さない）と、
// 裏のグループ通話の「しゃべり続ける子」（ひとり話は別に返す・ほかの子は触れない・あなたが話しかけたときだけ返事・記録とまとめに入れない）
import W from './worker.mjs';
import { makeDB } from './fake.mjs';
const DB = makeDB();
const env = { DB, APP_TOKEN: 'pw', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' };
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
const flush = async () => { while (waits.length) await waits.shift(); };
const call = async (m, p, b) => { const r = await W.fetch(new Request('https://w' + p, { method: m, headers: { 'X-App-Token': 'pw' }, body: b ? JSON.stringify(b) : undefined }), env, ctx); const d = await r.json(); await flush(); if (!r.ok) throw Object.assign(new Error(p + ' ' + JSON.stringify(d)), { status: r.status }); return d; };
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
const ai = []; const G = { lines: [{ speaker: 'アカリ', text: 'ねえ、聞いてる？' }, { speaker: 'ウラ', text: 'うん、聞いてるよ。' }], ramble: [{ speaker: 'トリビア', text: 'ところでカタツムリの歯は一万本以上あるらしくて' }, { speaker: 'トリビア', text: 'しかも生え変わるんだって' }] };
globalThis.fetch = async (u, i) => {
  u = String(u);
  if (!u.includes('googleapis') && !u.includes('x.ai')) return new Response('{}');
  const body = JSON.parse(i.body); const grok = u.includes('x.ai');
  const sys = grok ? body.messages[0].content : body.systemInstruction.parts[0].text, sch = JSON.stringify(grok ? body.response_format : body.generationConfig.responseSchema);
  const user = grok ? body.messages.slice(1).map((x) => typeof x.content === 'string' ? x.content : '').join('\n') : body.contents.map((c) => c.parts.map((p) => p.text || '').join('|')).join('\n');
  ai.push({ sys, sch, user, grok });
  let out;
  if (sch.includes('wait_user')) out = { lines: G.lines, wait_user: false, ...(sch.includes('ramble') ? { ramble: G.ramble } : {}) };
  else if (sch.includes('"ramble"')) out = { ramble: ['次はタコの心臓の話なんだけど', '三つあるんだよ'] };
  else if (sch.includes('"members"')) out = { members: [] };
  else if (sch.includes('leave_voicemail')) out = { leave_voicemail: false, voicemail: '', send_line: false, line: '' };
  else if (sch.includes('"after"')) out = { answer: true, reason: '', after: 'none', line: '' };
  else if (sch.includes('"hangup"')) out = { messages: ['……うん、そうなんだ。'], hangup: false, ...(sch.includes('"wake"') ? { wake: '' } : {}), ...(sch.includes('reminders') ? { reminders: [] } : {}) };
  else if (sch.includes('"summary"')) out = { summary: '雨宿りしながら話した。' };
  else out = { messages: ['うん'] };
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: JSON.stringify(out) } }] } : { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
};
await call('POST', '/settings', { settings: { delayEnabled: false, lifeEnabled: false, quietEnabled: false } });
const a = (await call('POST', '/char', { char: { name: '朱里', uraName: 'アカリ', prompt: '表の設定', uraCharPrompt: '裏の設定', voice: 'akari' } })).char;
const u = (await call('POST', '/char', { char: { name: 'ウラ', prompt: 'p', uraOnly: true, voice: 'ura' } })).char;
const t = (await call('POST', '/char', { char: { name: 'トリビア', prompt: '豆知識が好き', uraOnly: true, voice: 'tri' } })).char;
await call('POST', '/send', { charId: a.id, text: 'こんにちは' }); await call('POST', '/reply', { charId: a.id });

// ================= ［📝状況］：表の1対1
let r = await call('POST', '/call/start', { charId: a.id, test: true });
r = await call('POST', '/call/connect', { id: r.call.id });
const id1 = r.call.id;
ok(!ai.at(-1).sys.includes('いまの状況'), 'no scene yet');
ai.length = 0;
let d = await call('POST', '/call/say', { id: id1, scene: '急に雨が降ってきて、二人とも軒下で雨宿りしている' });
let q = ai.find((x) => x.sch.includes('"hangup"'));
ok(q && q.sys.includes('# いまの状況') && q.sys.includes('軒下で雨宿り') && q.user.includes('【状況・指示】急に雨が') && d.lines.length && d.scene.includes('雨宿り'), 'scene: prompt + reaction + returned');
ai.length = 0;
await call('POST', '/call/say', { id: id1, text: '寒くない？' });
q = ai.find((x) => x.sch.includes('"hangup"'));
ok(q.sys.includes('軒下で雨宿り') && q.user.includes('寒くない？'), 'scene lasts until the call ends');
await call('POST', '/call/say', { id: id1, scene: '雨がやんで、虹が出た' });
q = ai.filter((x) => x.sch.includes('"hangup"')).at(-1);
ok(q.sys.includes('虹が出た') && !q.sys.includes('軒下で雨宿り'), 'rewritten scene replaces the old one');
ok((await call('GET', '/call?id=' + id1)).call.scene === '雨がやんで、虹が出た', 'call carries the scene');
ai.length = 0;
d = await call('POST', '/call/say', { id: id1, scene: '' });
ok(d.lines.length === 0 && d.scene === '' && !ai.length, 'clearing: no reply');
await call('POST', '/call/say', { id: id1, text: 'ねえ' });
q = ai.filter((x) => x.sch.includes('"hangup"')).at(-1);
ok(!q.sys.includes('# いまの状況') && q.user.includes('ふだんどおり'), 'cleared scene is gone (and told so)');
let m = (await call('POST', '/call/end', { id: id1 })).message;
ok(m.meta.test && m.meta.nokeep && !m.meta.scenes, 'test call: scenes not kept');
// ふつうの通話：記録とまとめに入る
r = await call('POST', '/call/start', { charId: a.id });
r = await call('POST', '/call/connect', { id: r.call.id });
await call('POST', '/call/say', { id: r.call.id, scene: '夜の公園のベンチ' });
ai.length = 0;
m = (await call('POST', '/call/end', { id: r.call.id })).message;
q = ai.find((x) => x.sch.includes('"summary"'));
ok(q && q.user.includes('（状況）夜の公園のベンチ') && q.sys.includes('（状況）'), 'summary sees the scene');
ok(m.meta.sum && m.meta.scenes && m.meta.scenes[0] === '夜の公園のベンチ', 'record keeps the scene');
// 寝落ち通話（引き継がない）：残さない
r = await call('POST', '/call/start', { charId: a.id, sleep: true, keep: false });
r = await call('POST', '/call/connect', { id: r.call.id });
await call('POST', '/call/say', { id: r.call.id, scene: '布団の中' });
ok(ai.filter((x) => x.sch.includes('"hangup"')).at(-1).sys.includes('布団の中'), 'sleep call takes scenes');
m = (await call('POST', '/call/end', { id: r.call.id, by: 'sleep' })).message;
ok(m.meta.nokeep && !m.meta.scenes && !m.meta.sum, 'nokeep sleep call: nothing kept');
// 裏の1対1
r = await call('POST', '/call/start', { charId: a.id, ura: true });
r = await call('POST', '/call/connect', { id: r.call.id });
ai.length = 0;
await call('POST', '/call/say', { id: r.call.id, scene: '屋上に二人きり' });
q = ai.find((x) => x.sch.includes('"hangup"'));
ok(q.grok && q.sys.includes('屋上に二人きり') && q.sys.includes('【状況・指示】」で始まるもの'), 'ura 1:1: scene + direction rule');
await call('POST', '/call/end', { id: r.call.id });
// 着信（モーニングコールなど、かかってきた電話にも）
r = await call('POST', '/call/test', { charId: a.id, keep: true });
await call('POST', '/call/answer', { id: r.call.id });
ai.length = 0;
await call('POST', '/call/say', { id: r.call.id, scene: '寝ぼけている' });
ok(ai.some((x) => x.sys.includes('寝ぼけている')), 'incoming call takes scenes');
await call('POST', '/call/end', { id: r.call.id });

// ================= 表のグループ通話
const og = (await call('POST', '/ogroup', { group: { name: '表組', members: [a.id] } })).group;
r = await call('POST', '/gcall/start', { groupId: og.id, test: true });
G.lines = [{ speaker: '朱里', text: 'もしもし' }, { speaker: '朱里', text: 'みんないる？' }];
await call('POST', '/gcall/connect', { id: r.call.id });
ai.length = 0;
d = await call('POST', '/gcall/say', { id: r.call.id, scene: 'みんなでお花見をしている', heard: 2 });
q = ai.find((x) => x.sch.includes('wait_user'));
ok(q && q.sys.includes('お花見') && q.user.includes('【状況・指示】みんなでお花見') && !q.sys.includes('黙って聞いている') && d.lines.length, 'omote group: scene');
m = (await call('POST', '/gcall/end', { id: r.call.id })).message;
ok(m.meta.scenes && m.meta.scenes[0].includes('お花見'), 'group record keeps the scene');
const lg = (await call('GET', `/gcall/log?group=${og.id}&id=${m.id}`)).log;
ok(lg.transcript.some((x) => x.scene && x.text.includes('お花見')), 'group log marks the scene line');

// ================= しゃべり続ける子（裏のグループ）
let g = (await call('POST', '/group', { group: { name: '屋上組', members: [a.id, u.id, t.id], rambler: t.id, rambleTopic: '生き物の豆知識' } })).group;
ok(g.ramblers.length === 1 && g.ramblers[0].id === t.id && g.ramblers[0].topic === '生き物の豆知識' && !('rambler' in g), 'old shape (rambler) is read');
ok((await call('POST', '/group', { group: { ...g, members: [a.id, u.id] } })).group.ramblers.length === 0, 'not a member → no rambler');
g = (await call('POST', '/group', { group: { ...g, members: [a.id, u.id, t.id], ramblers: [{ id: t.id, topic: '生き物の豆知識' }] } })).group;
r = await call('POST', '/gcall/start', { groupId: g.id, all: true });
ok(r.call.ramblers.join() === t.id, 'call has the rambler');
G.lines = [{ speaker: 'アカリ', text: 'もしもし' }, { speaker: 'トリビア', text: '知ってる？' }, { speaker: 'ウラ', text: 'やっほー' }];
ai.length = 0;
d = await call('POST', '/gcall/connect', { id: r.call.id });
q = ai.find((x) => x.sch.includes('wait_user'));
ok(q.grok && q.sch.includes('ramble') && q.sys.includes('しゃべり続ける子：トリビア') && q.sys.includes('生き物の豆知識') && q.sys.includes('一切触れない'), 'prompt: rambler rules');
ok(d.lines.length === 2 && !d.lines.some((x) => x.id === t.id) && d.ramble[t.id].length === 2, 'rambler kept out of the lines; ramble returned');
const gid = r.call.id;
// あなたが話しかけた → 返事をしてよい
G.lines = [{ speaker: 'トリビア', text: 'あ、うん。呼んだ？' }];
d = await call('POST', '/gcall/say', { id: gid, text: 'トリビアちゃん、今の話もう一回', heard: 2 });
ok(d.lines.length === 1 && d.lines[0].id === t.id, 'addressed by you → the rambler answers');
// 黙っているとき：出てきても外す。lines が rambler だけなら空で、ひとり話は返す
d = await call('POST', '/gcall/say', { id: gid, text: '', heard: 1 });
ok(d.lines.length === 0 && d.ramble[t.id].length === 2, 'silent turn: rambler lines dropped, ramble still returned');
q = ai.filter((x) => x.sch.includes('wait_user')).at(-1);
ok(q.sys.includes('カタツムリの歯'), 'ramble history fed back so it continues');
// 足りなくなったら続きだけ
ai.length = 0;
d = await call('POST', '/gcall/ramble', { id: gid, who: t.id });
q = ai[0];
ok(d.ramble[t.id].length === 2 && q.grok && q.sys.includes('ひとり話') && q.sys.includes('生き物の豆知識') && q.sys.includes('カタツムリ'), 'more ramble on request');
// 状況も
G.lines = [{ speaker: 'アカリ', text: '寒いね' }];
await call('POST', '/gcall/say', { id: gid, scene: '雪が降っている', heard: 0 });
ok(ai.filter((x) => x.sch.includes('wait_user')).at(-1).sys.includes('雪が降っている'), 'ura group: scene');
ai.length = 0;
await call('POST', '/gcall/ramble', { id: gid, who: t.id });
ok(ai[0].sys.includes('雪が降っている'), 'ramble knows the scene');
ok((await call('POST', '/gcall/ramble', { id: gid, who: a.id })).ramble[a.id] === undefined, 'ramble only for the chosen');
ai.length = 0;
m = (await call('POST', '/gcall/end', { id: gid })).message;
q = ai.find((x) => x.sch.includes('"summary"'));
ok(q && !q.user.includes('カタツムリ') && !q.user.includes('タコの心臓') && q.user.includes('呼んだ？'), 'summary: ramble excluded, your exchange with the rambler kept');
const lg2 = (await call('GET', `/gcall/log?group=${g.id}&id=${m.id}`)).log;
ok(!JSON.stringify(lg2).includes('カタツムリ') && JSON.stringify(lg2).includes('呼んだ？'), 'record: ramble excluded');
ok(!DB.raw.prepare("SELECT 1 FROM kv WHERE k LIKE 'gramble:%'").get(), 'ramble log removed after the call');
// 寝落ち通話でも
r = await call('POST', '/gcall/start', { groupId: g.id, sleep: true, keep: true });
ok(r.call.ramblers.join() === t.id, 'ura group sleep call: rambler too');
G.lines = [{ speaker: 'アカリ', text: 'おやすみ前だね' }];
d = await call('POST', '/gcall/connect', { id: r.call.id });
ok(d.ramble && d.ramble[t.id].length, 'sleep call ramble');
await call('POST', '/gcall/end', { id: r.call.id });
// 表のグループには付かない
r = await call('POST', '/gcall/start', { groupId: og.id, test: true });
ok(!r.call.ramblers, 'omote group: no rambler');
await call('POST', '/gcall/end', { id: r.call.id });
// 選んだ子だけしか出ないときは付けない（ほかに話す子がいない）
const g1 = (await call('POST', '/group', { group: { name: 'ひとり', members: [t.id], ramblers: [{ id: t.id }] } })).group;
r = await call('POST', '/gcall/start', { groupId: g1.id, all: true });
ok(!r.call.ramblers, 'alone → no rambler');
await call('POST', '/gcall/end', { id: r.call.id });

// ================= 第82版：何人でも（全員同時・一人ずつ話す内容・お互いにも触れない）
const g2 = (await call('POST', '/group', { group: { name: '三人', members: [a.id, u.id, t.id], ramblers: [{ id: t.id, topic: '生き物の豆知識' }, { id: u.id, topic: '昔のゲームの話' }] } })).group;
ok(g2.ramblers.length === 2 && g2.ramblers[1].topic === '昔のゲームの話', 'two ramblers with their own topics');
r = await call('POST', '/gcall/start', { groupId: g2.id, all: true });
ok(r.call.ramblers.length === 2, 'call has both');
G.lines = [{ speaker: 'アカリ', text: 'もしもし' }, { speaker: 'ウラ', text: 'ねえ' }];
G.ramble = [{ speaker: 'トリビア', text: 'カタツムリはね' }, { speaker: 'ウラ', text: '昔のゲーム機はね' }, { speaker: 'アカリ', text: 'これは混ざってはいけない' }];
ai.length = 0;
d = await call('POST', '/gcall/connect', { id: r.call.id });
q = ai.find((x) => x.sch.includes('wait_user'));
ok(q.sys.includes('トリビア・ウラ') && q.sys.includes('生き物の豆知識') && q.sys.includes('昔のゲームの話') && q.sys.includes('お互いのひとり話には一切触れない'), 'prompt: both ramblers, topics, ignore each other');
ok(d.lines.length === 1 && d.lines[0].id === a.id, 'both kept out of the lines');
ok(d.ramble[t.id][0] === 'カタツムリはね' && d.ramble[u.id][0] === '昔のゲーム機はね' && !d.ramble[a.id], 'ramble per rambler (others ignored)');
ai.length = 0;
d = await call('POST', '/gcall/ramble', { id: r.call.id, who: u.id });
ok(ai[0].sys.includes('昔のゲームの話') && ai[0].sys.includes('昔のゲーム機はね') && !ai[0].sys.includes('カタツムリはね') && d.ramble[u.id].length, 'more ramble: one at a time, own history');
const lg3 = JSON.parse(DB.raw.prepare("SELECT v FROM kv WHERE k LIKE 'gramble:%'").get().v);
ok(lg3[t.id].length === 1 && lg3[u.id].length === 3, 'ramble logs kept per rambler');
await call('POST', '/gcall/end', { id: r.call.id });
// 全員しゃべり続ける子：一人はふつうに話す
const g3 = (await call('POST', '/group', { group: { name: '二人', members: [u.id, t.id], ramblers: [{ id: u.id }, { id: t.id }] } })).group;
r = await call('POST', '/gcall/start', { groupId: g3.id, all: true });
ok(r.call.ramblers.length === 1, 'everyone chosen → one still talks normally');
await call('POST', '/gcall/end', { id: r.call.id });
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
