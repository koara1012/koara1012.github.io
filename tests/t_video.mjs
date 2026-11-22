// 第83版：ビデオ通話（表の通話だけ）。カメラのオン・オフ（video）・写真（photo：その番だけ AI に見せる・残さない・記録とまとめには文字で）・
// 「見せて」（ask_photo）・立ち絵の表情（facesO があれば言葉ごとに《表情》）・グループは通話に出ていた子だけが見た（seen）・裏には付かない
import W from './worker.mjs';
import { makeDB } from './fake.mjs';
const DB = makeDB();
const env = { DB, APP_TOKEN: 'pw', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' };
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
const flush = async () => { while (waits.length) await waits.shift(); };
const call = async (m, p, b) => { const r = await W.fetch(new Request('https://w' + p, { method: m, headers: { 'X-App-Token': 'pw' }, body: b ? JSON.stringify(b) : undefined }), env, ctx); const d = await r.json(); await flush(); if (!r.ok) throw Object.assign(new Error(p + ' ' + JSON.stringify(d)), { status: r.status }); return d; };
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
const ai = []; const O = { msgs: ['もしもし'], ask: false, desc: '湯気の立つラーメン', lines: null };
globalThis.fetch = async (u, i) => {
  u = String(u);
  if (!u.includes('googleapis') && !u.includes('x.ai')) return new Response('{}');
  const body = JSON.parse(i.body); const grok = u.includes('x.ai');
  const sys = grok ? body.messages[0].content : body.systemInstruction.parts[0].text, sch = JSON.stringify(grok ? body.response_format : body.generationConfig.responseSchema);
  const imgs = grok ? body.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((x) => x.type === 'image_url') : []) : body.contents.flatMap((c) => c.parts.filter((p) => p.inlineData));
  const user = grok ? body.messages.slice(1).map((x) => typeof x.content === 'string' ? x.content : '').join('\n') : body.contents.map((c) => c.parts.map((p) => p.text || '').join('|')).join('\n');
  ai.push({ sys, sch, user, grok, imgs: imgs.length });
  let out;
  if (sch.includes('wait_user')) out = { lines: O.lines || [{ speaker: '朱里', text: '《笑顔》わあ、おいしそう' }, { speaker: '花', text: '《驚き》すごい！' }], wait_user: false, ...(sch.includes('ask_photo') ? { ask_photo: O.ask } : {}), ...(sch.includes('photo_desc') ? { photo_desc: O.desc } : {}) };
  else if (sch.includes('"members"')) out = { members: [] };
  else if (sch.includes('leave_voicemail')) out = { leave_voicemail: false, voicemail: '', send_line: false, line: '' };
  else if (sch.includes('"after"')) out = { answer: true, reason: '', after: 'none', line: '' };
  else if (sch.includes('"hangup"')) { out = { messages: O.msgs, hangup: false }; const S0 = JSON.parse(sch); for (const k of Object.keys(S0.properties || (S0.json_schema && S0.json_schema.schema.properties) || {})) if (!(k in out)) out[k] = k === 'ask_photo' ? O.ask : k === 'photo_desc' ? O.desc : k === 'reminders' ? [] : ''; }
  else if (sch.includes('"summary"')) out = { summary: 'ラーメンの写真を見せてもらった。' };
  else out = { messages: ['うん'] };
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: JSON.stringify(out) } }] } : { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
};
const PHOTO = 'data:image/jpeg;base64,' + Buffer.from('fakejpegdata').toString('base64');
await call('POST', '/settings', { settings: { delayEnabled: false, lifeEnabled: false, quietEnabled: false } });
const a = (await call('POST', '/char', { char: { name: '朱里', uraName: 'アカリ', prompt: '表', voice: 'akari' } })).char;
const h = (await call('POST', '/char', { char: { name: '花', prompt: 'p', voice: 'hana' } })).char;
const n = (await call('POST', '/char', { char: { name: '雪', prompt: 'p', voice: 'yuki' } })).char;
await call('POST', '/faces', { charId: a.id, kind: 'omote', faces: [{ name: '通常', desc: '' }, { name: '笑顔', desc: 'にこにこ' }, { name: '照れ', desc: '' }] });
await call('POST', '/faces', { charId: h.id, kind: 'omote', faces: [{ name: '通常', desc: '' }, { name: '驚き', desc: '' }] });
await call('POST', '/send', { charId: a.id, text: 'やあ' });

// ================= 1対1
let r = await call('POST', '/call/start', { charId: a.id, test: true });
r = await call('POST', '/call/connect', { id: r.call.id });
const id1 = r.call.id;
let q = ai.filter((x) => x.sch.includes('"hangup"')).at(-1);
ok(q.sch.includes('ask_photo') && q.sys.includes('カメラはオフ') && q.sys.includes('見せて'), 'camera off: may ask to see');
ok(!q.sys.includes('《表情名》') && !r.faces, 'camera off: no faces');
O.ask = true; O.msgs = ['ラーメン？いいな、見せてよ'];
let d = await call('POST', '/call/say', { id: id1, text: '今ラーメン食べてる', video: false });
ok(d.askPhoto === true, 'askPhoto returned');
O.ask = false; O.msgs = ['《笑顔》わあ、おいしそう！', '《ないやつ》チャーシュー厚いね'];
ai.length = 0;
d = await call('POST', '/call/say', { id: id1, photo: PHOTO, video: true });
q = ai.find((x) => x.sch.includes('"hangup"'));
ok(q.imgs === 1 && q.sys.includes('カメラをオンにしている') && q.sys.includes('photo_desc') && q.sch.includes('photo_desc'), 'photo shown to the AI with the rules');
ok(q.sys.includes('《表情名》') && q.sys.includes('笑顔（にこにこ）'), 'faces offered while the camera is on');
ok(d.lines[0] === 'わあ、おいしそう！' && d.faces[0] === '笑顔' && d.faces[1] === '' && d.lines[1] === 'チャーシュー厚いね', 'faces split from the words');
let cl = (await call('GET', '/call?id=' + id1)).call;
const raw = JSON.parse(DB.raw.prepare('SELECT v FROM kv WHERE k=?').get('call:' + id1).v);
ok(!JSON.stringify(raw).includes('fakejpeg') && !JSON.stringify(raw).includes(Buffer.from('fakejpegdata').toString('base64')), 'photo itself is not stored');
ok(raw.transcript.some((m) => m.photo && m.text.includes('湯気の立つラーメン')), 'transcript keeps the description');
ai.length = 0; O.msgs = ['《照れ》ふふ'];
d = await call('POST', '/call/say', { id: id1, text: 'でしょ', video: true });
q = ai.find((x) => x.sch.includes('"hangup"'));
ok(q.imgs === 0 && q.user.includes('湯気の立つラーメン') && d.faces[0] === '照れ', 'next turn: no image, remembers it in words');
ai.length = 0; O.msgs = ['うん'];
d = await call('POST', '/call/say', { id: id1, text: 'カメラ切るね', video: false });
q = ai.find((x) => x.sch.includes('"hangup"'));
ok(!q.sys.includes('《表情名》') && !d.faces, 'camera off again: no faces');
let m = (await call('POST', '/call/end', { id: id1 })).message;
ok(m.meta.test && !m.meta.photos && !m.meta.sum, 'test call: nothing kept');
// ふつうの通話：まとめ・記録
r = await call('POST', '/call/start', { charId: a.id });
r = await call('POST', '/call/connect', { id: r.call.id });
O.msgs = ['《笑顔》きれい'];
await call('POST', '/call/say', { id: r.call.id, photo: PHOTO, video: true });
ai.length = 0;
m = (await call('POST', '/call/end', { id: r.call.id })).message;
q = ai.find((x) => x.sch.includes('"summary"'));
ok(q && q.user.includes('カメラで写真を撮って見せた：湯気の立つラーメン') && q.sys.includes('見せてくれた写真'), 'summary sees what was shown');
ok(m.meta.photos === 1 && m.meta.sum, 'record: photo count + summary');
// 第84版：写真の番の返事が作れなかった → 見せたことを取り消す（あとで「届いていない」と思わせない）
r = await call('POST', '/call/start', { charId: a.id, test: true }); r = await call('POST', '/call/connect', { id: r.call.id });
const F0 = globalThis.fetch; globalThis.fetch = async (u, i) => (String(u).includes('googleapis') ? new Response('{"error":{"message":"bad"}}', { status: 400 }) : F0(u, i));
let e0 = 0; try { await call('POST', '/call/say', { id: r.call.id, photo: PHOTO, video: true }); } catch (x) { e0 = x.status; }
globalThis.fetch = F0;
let raw2 = JSON.parse(DB.raw.prepare('SELECT v FROM kv WHERE k=?').get('call:' + r.call.id).v);
ok(e0 >= 400 && !raw2.transcript.some((x) => x.photo) && !raw2.photos, 'failed photo turn: the photo is taken back');
ok(JSON.parse(DB.raw.prepare("SELECT v FROM kv WHERE k='log'").get().v).some((x) => x.msg.includes('ビデオ通話の写真：返事を作れませんでした')), 'failure logged');
ai.length = 0; O.msgs = ['《笑顔》見えた！'];
await call('POST', '/call/say', { id: r.call.id, photo: PHOTO, video: true });
q = ai.find((x) => x.sch.includes('"hangup"'));
ok(q.imgs === 1 && q.user.includes('これが、ユーザーがいまカメラで撮って見せた写真') && q.sys.includes('「届いていない」「見えない」とは言わない') && q.sys.includes('暗くてよく見えない'), 'photo turn: image announced; never say it did not arrive');
O.desc = ''; O.msgs = ['うーん'];
await call('POST', '/call/say', { id: r.call.id, photo: PHOTO, video: true });
ok(JSON.parse(DB.raw.prepare("SELECT v FROM kv WHERE k='log'").get().v).some((x) => x.msg.includes('AI が写真の中身を書きませんでした')), 'empty description logged');
O.desc = '湯気の立つラーメン';
await call('POST', '/call/end', { id: r.call.id });
// 第85版：写真の番号（pid）で、返事をあとから受け取れる
r = await call('POST', '/call/start', { charId: a.id, test: true }); r = await call('POST', '/call/connect', { id: r.call.id });
ok((await call('GET', `/call/photo?id=${r.call.id}&pid=px1`)).state === 'failed', 'unknown photo → failed');
O.msgs = ['《笑顔》見えたよ'];
d = await call('POST', '/call/say', { id: r.call.id, photo: PHOTO, pid: 'px1', video: true });
let pr = await call('GET', `/call/photo?id=${r.call.id}&pid=px1`);
ok(pr.state === 'done' && pr.lines[0] === '見えたよ' && pr.faces[0] === '笑顔', 'photo answer can be fetched later');
let e1 = 0; try { await call('POST', '/call/say', { id: r.call.id, photo: 'data:image/jpeg;base64,abc', pid: 'px2' }); } catch (x) { e1 = x.status; }
ok(e1 === 400 && (await call('GET', `/call/photo?id=${r.call.id}&pid=px2`)).state === 'failed', 'broken base64 refused');
await call('POST', '/call/end', { id: r.call.id });
// 写真の形がおかしい
r = await call('POST', '/call/start', { charId: a.id, test: true }); r = await call('POST', '/call/connect', { id: r.call.id });
let e = 0; try { await call('POST', '/call/say', { id: r.call.id, photo: 'data:text/html;base64,AAAA' }); } catch (x) { e = x.status; }
ok(e === 400, 'bad photo refused');
await call('POST', '/call/end', { id: r.call.id });
// 裏の1対1：付かない
r = await call('POST', '/call/start', { charId: a.id, ura: true }); r = await call('POST', '/call/connect', { id: r.call.id });
ai.length = 0;
d = await call('POST', '/call/say', { id: r.call.id, text: 'これ', photo: PHOTO, video: true });
q = ai.find((x) => x.sch.includes('"hangup"'));
ok(q.grok && q.imgs === 0 && !q.sch.includes('ask_photo') && !q.sys.includes('ビデオ通話（ユーザーのカメラ）') && q.user.includes('これ'), 'ura: no video, photo ignored');
await call('POST', '/call/end', { id: r.call.id });

// ================= 表のグループ通話
const og = (await call('POST', '/ogroup', { group: { name: '三人', members: [a.id, h.id, n.id] } })).group;
r = await call('POST', '/gcall/start', { groupId: og.id, test: true });
O.lines = [{ speaker: '朱里', text: 'もしもし' }];
await call('POST', '/gcall/connect', { id: r.call.id });
const gid = r.call.id;
O.lines = null; ai.length = 0;
d = await call('POST', '/gcall/say', { id: gid, photo: PHOTO, pid: 'g1', video: true, heard: 1 });
q = ai.find((x) => x.sch.includes('wait_user'));
ok(q.imgs === 1 && q.sys.includes('いま通話に出ている子だけ') && q.sys.includes('朱里：通常、笑顔（にこにこ）、照れ') && q.sys.includes('花：通常、驚き') && !q.sys.includes('雪：'), 'group: photo + faces of those who have them');
ok(d.lines[0].face === '笑顔' && d.lines[0].text === 'わあ、おいしそう' && d.lines[1].face === '驚き', 'group lines carry faces');
let gr = JSON.parse(DB.raw.prepare('SELECT v FROM kv WHERE k=?').get('call:' + gid).v);
const pe = gr.transcript.find((x) => x.photo);
ok(pe && pe.seen.length === 3 && pe.text.includes('湯気の立つラーメン'), 'group photo: seen by those in the call');
pr = await call('GET', `/call/photo?id=${gid}&pid=g1`);
ok(pr.state === 'done' && pr.lines.length === 2 && pr.lines[0].face === '笑顔', 'group photo answer can be fetched later');
ai.length = 0;
await call('POST', '/gcall/say', { id: gid, text: 'どう？', video: true, heard: 2 });
q = ai.find((x) => x.sch.includes('wait_user'));
ok(q.imgs === 0 && q.user.includes('この写真を見たのは、そのとき通話にいた朱里・花・雪だけ'), 'group: who saw it is told');
m = (await call('POST', '/gcall/end', { id: gid })).message;
const lg = (await call('GET', `/gcall/log?group=${og.id}&id=${m.id}`)).log;
ok(lg.transcript.some((x) => x.photo && x.seen.length === 3), 'group log keeps who saw it (not the photo)');

// 続きから：前回いなかった子は見ていない
const og2 = (await call('POST', '/ogroup', { group: { ...og, members: [a.id, h.id, n.id] } })).group;
r = await call('POST', '/gcall/start', { groupId: og.id, test: true, from: m.id });
ai.length = 0; O.lines = [{ speaker: '雪', text: 'なになに' }];
await call('POST', '/gcall/connect', { id: r.call.id });
q = ai.find((x) => x.sch.includes('wait_user'));
ok(q.user.includes('見たのは、そのとき通話にいた') && q.user.includes('ほかの子は見ていない'), 'continued call keeps who saw it');
await call('POST', '/gcall/end', { id: r.call.id });
// 裏のグループ：付かない
const ug = (await call('POST', '/group', { group: { name: '裏', members: [a.id, h.id] } })).group;
r = await call('POST', '/gcall/start', { groupId: ug.id, all: true });
O.lines = [{ speaker: 'アカリ', text: 'やあ' }];
await call('POST', '/gcall/connect', { id: r.call.id });
ai.length = 0;
await call('POST', '/gcall/say', { id: r.call.id, photo: PHOTO, video: true, text: 'ねえ' });
q = ai.find((x) => x.sch.includes('wait_user'));
ok(q.grok && q.imgs === 0 && !q.sch.includes('ask_photo'), 'ura group: no video');
await call('POST', '/gcall/end', { id: r.call.id });
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
