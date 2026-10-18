import nodeCrypto from 'node:crypto';
import W, { runTlJobs, deferQuiet, reactDelay, threadRoot, toGeminiSchema } from './worker.mjs';
import { makeDB, installFetch, calls, control } from './fake.mjs';
const DB = makeDB(); const pushes = []; installFetch(pushes);
const env = { DB, APP_TOKEN: 'pw', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' };
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
const flush = async () => { while (waits.length) await waits.shift(); };
async function call(method, path, body) {
  const r = await W.fetch(new Request('https://w.test' + path, { method, headers: { 'X-App-Token': 'pw', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  const d = await r.json(); if (!r.ok) throw new Error(path + ' ' + r.status + ' ' + JSON.stringify(d)); return d;
}
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok', m); };
const decrypt = (()=>{ const ua = nodeCrypto.createECDH('prime256v1'); ua.generateKeys(); const auth = nodeCrypto.randomBytes(16);
  const sub = { endpoint: 'https://push.example.test/x', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const hk=(s,i,info,l)=>Buffer.from(nodeCrypto.hkdfSync('sha256',i,s,info,l));
  const f = (b) => { b=Buffer.from(b); const salt=b.subarray(0,16), idl=b[20], as=b.subarray(21,21+idl), ct=b.subarray(21+idl);
    const ikm=hk(auth,ua.computeSecret(as),Buffer.concat([Buffer.from('WebPush: info\0'),ua.getPublicKey(),as]),32);
    const d=nodeCrypto.createDecipheriv('aes-128-gcm',hk(salt,ikm,Buffer.from('Content-Encoding: aes128gcm\0'),16),hk(salt,ikm,Buffer.from('Content-Encoding: nonce\0'),12));
    d.setAuthTag(ct.subarray(ct.length-16)); const pt=Buffer.concat([d.update(ct.subarray(0,ct.length-16)),d.final()]); return JSON.parse(pt.subarray(0,pt.length-1).toString()); };
  f.sub = sub; return f; })();
const lastPush = () => decrypt(pushes[pushes.length - 1].body);
const forceDue = () => DB.raw.prepare('UPDATE tl_jobs SET due=0').run();

// setup
await call('POST', '/settings', { settings: { quietEnabled: false } });
await call('POST', '/subscribe', { subscription: decrypt.sub });
const sharo = (await call('POST', '/char', { char: { name: 'シャロ', prompt: '甘えん坊', affinity: 95, snsActivity: 90 } })).char;
const cool = (await call('POST', '/char', { char: { name: 'クール', prompt: 'そっけない', affinity: 20, snsActivity: 10 } })).char;
const old = (await call('POST', '/char', { char: { name: '古い' } })).char; // fields default
DB.raw.prepare('UPDATE chars SET data=? WHERE id=?').run(JSON.stringify({ id: old.id, name: '古い', prompt: '' }), old.id); // simulate pre-TL char without new fields
ok(sharo.affinity === 95 && sharo.tlPerDay === 2 && sharo.uraTlPerDay === 1, 'new char fields saved with defaults');

// me profile
const st1 = (await call('POST', '/me', { world: 'omote', name: '転校生', icon: 'data:image/jpeg;base64,AAA' })).settings;
await call('POST', '/me', { world: 'ura', name: '裏の転校生' });
const ic = (await call('GET', '/icons?ids=@me,@me%23ura,' + sharo.id)).icons;
ok(st1.meName === '転校生' && st1.meIconVer > 0 && ic['@me'].data === 'data:image/jpeg;base64,AAA' && ic['@me#ura'].data === null && sharo.id in ic, 'me profile + icons');

// scoring: sharo loves it, cool doesn't
control.scoreFor = (id) => id === sharo.id ? { interest: 95, eagerness: 95, bond: 95 } : { interest: 5, eagerness: 5, bond: 5 };
const R0 = Math.random; Math.random = () => 0.01;
const post = (await call('POST', '/tl/post', { world: 'omote', text: 'ブリヌイ焼いた！' })).post;
await flush(); Math.random = R0;
const scoreCall = calls.find(c => c.schemaStr.includes('scores'));
ok(scoreCall && !scoreCall.grok && scoreCall.user.includes('ブリヌイ') && scoreCall.user.includes('甘えん坊') && scoreCall.user.includes('仲の良さ（設定値）: 95'), 'omote scoring uses Gemini with post + persona + slider values');
const jobs = DB.raw.prepare('SELECT * FROM tl_jobs').all();
console.log('  jobs:', jobs.map(j => j.kind + ':' + (j.char_id===sharo.id?'シャロ':j.char_id===cool.id?'クール':'古い') + ':' + Math.round((j.due-Date.now())/60000)+'分'));
ok(DB.raw.prepare('SELECT planned FROM tl_posts WHERE id=?').get(post.id).planned === 1, 'post marked planned');

// statistics of planReactions: run many posts to see probabilities by personality
const stats = { [sharo.id]: { like: 0, comment: 0, d: [] }, [cool.id]: { like: 0, comment: 0, d: [] }, [old.id]: { like: 0, comment: 0, d: [] } };
const { planReactions } = await import('./worker.mjs');
for (let i = 0; i < 300; i++) {
  const r = DB.raw.prepare("INSERT INTO tl_posts (world,author,text,at,planned) VALUES ('omote','me','x',?,0)").run(Date.now());
  const p = DB.raw.prepare('SELECT * FROM tl_posts WHERE id=?').get(Number(r.lastInsertRowid));
  for (const j of await planReactions(env, p)) { stats[j.char][j.kind]++; if (j.kind === 'comment') stats[j.char].d.push(j.inMin); }
}
const med = (a) => a.length ? a.sort((x,y)=>x-y)[Math.floor(a.length/2)] : null;
for (const [k, v] of Object.entries(stats)) console.log(`  ${k===sharo.id?'シャロ':k===cool.id?'クール':'古い(既定値)'}: いいね${Math.round(v.like/3)}% コメント${Math.round(v.comment/3)}% コメントまで中央値${med(v.d)}分`);
ok(stats[sharo.id].comment > 200 && stats[cool.id].comment < 15 && stats[cool.id].like < 60, 'personality+topic drive reaction rates');
ok(med(stats[sharo.id].d) < med(stats[old.id].d), 'eager char reacts faster');
DB.raw.prepare("DELETE FROM tl_posts WHERE text='x'").run(); DB.raw.prepare('DELETE FROM tl_jobs WHERE post_id<>?').run(post.id);

// execute jobs → notifications
pushes.length = 0; forceDue(); const n = await runTlJobs(env, 20);
const tl = (await call('GET', '/tl?world=omote')).posts; await flush();
const p0 = tl.find(p => p.id === post.id);
ok(n >= 1 && p0.comments.some(c => c.author === sharo.id) && p0.likes.some(l => l.author === sharo.id), 'sharo liked and commented');
const pl = pushes.map(p => decrypt(p.body));
ok(pl.some(x => x.title.includes('いいね')) && pl.some(x => x.title.includes('コメント')) && pl.every(x => x.tl === 'omote' && x.postId === post.id), 'like+comment notifications with tl/postId');
const cmCall = calls.filter(c => c.sys.includes('コメントを書きます') && c.sys.includes('シャロ')).pop();
ok(cmCall && cmCall.user.includes('ブリヌイ') && cmCall.user.includes(sharo.id + 'の気持ち') && cmCall.user.includes('トークでのやり取り'), 'comment prompt has post, note, talk context');

// user replies to sharo's comment → sharo replies (thread), notify tlReply
const sc = p0.comments.find(c => c.author === sharo.id);
Math.random = (()=>{ const r = Math.random; return () => 0.01; })(); // force yes
await call('POST', '/tl/comment', { postId: post.id, text: 'ありがとう', replyTo: sc.id }); await flush();
pushes.length = 0; forceDue(); await runTlJobs(env, 20);
const p1 = (await call('GET', '/tl?world=omote')).posts.find(p => p.id === post.id); await flush();
const replies = p1.comments.filter(c => c.author === sharo.id && c.replyTo);
ok(replies.length === 1 && decrypt(pushes[0].body).title.includes('返信'), 'char replies to my reply + tlReply notification');
// 3-exchange limit
for (let i = 0; i < 4; i++) { const last = (await call('GET', '/tl?world=omote')).posts.find(p=>p.id===post.id).comments.filter(c=>c.author===sharo.id).pop(); await flush();
  await call('POST', '/tl/comment', { postId: post.id, text: 'まだ' + i, replyTo: last.id }); await flush(); forceDue(); await runTlJobs(env, 20); }
const p2 = (await call('GET', '/tl?world=omote')).posts.find(p => p.id === post.id); await flush();
ok(p2.comments.filter(c => c.author === sharo.id && c.replyTo).length === 3, 'thread capped at 3 char replies');

// notify flags off
await call('POST', '/settings', { settings: { notify: { tlLike: false } } });
const st2 = (await call('GET', '/sync?since=0')).settings;
ok(st2.notify.tlLike === false && st2.notify.tlComment === true, 'notify flags saved individually');
const post2 = (await call('POST', '/tl/post', { world: 'omote', text: 'もう一回' })).post; await flush();
pushes.length = 0; forceDue(); await runTlJobs(env, 20);
ok(!pushes.map(p => decrypt(p.body)).some(x => x.title.includes('いいね')), 'like notification suppressed when off');

// ura world: Grok, no notifications, separate
pushes.length = 0; calls.length = 0;
const up = (await call('POST', '/tl/post', { world: 'ura', text: '裏の投稿' })).post; await flush(); forceDue(); await runTlJobs(env, 20);
ok(calls.length && calls.every(c => c.grok), 'ura TL uses Grok');
ok(pushes.length === 0, 'ura TL never notifies');
const omoteIds = (await call('GET', '/tl?world=omote')).posts.map(p => p.id); await flush();
ok(!omoteIds.includes(up.id), 'ura post not in omote TL');
ok(calls.some(c => c.sys.includes('表での出来事は知らない')), 'ura prompt keeps worlds separate');

// char spontaneous post via poke + notification + char-char
Math.random = () => 0.01;
pushes.length = 0; calls.length = 0;
const cp = (await call('POST', '/tl/poke', { charId: cool.id, world: 'omote' })).post; await flush();
ok(cp.author === cool.id && decrypt(pushes[0].body).title === 'クール', 'char post + tlCharPost notification');
forceDue(); await runTlJobs(env, 20); forceDue(); await runTlJobs(env, 20);
const cpp = (await call('GET', '/tl?world=omote')).posts.find(p => p.id === cp.id); await flush();
ok(cpp.comments.some(c => c.author === sharo.id) && cpp.comments.some(c => c.author === cool.id && c.replyTo), 'char-to-char comment and author reply');
ok(!pushes.slice(1).map(p=>decrypt(p.body)).some(x => x.title.includes('コメントしました')), 'no comment notification for char-char');

// talk ⇔ TL link
calls.length = 0;
await call('POST', '/send', { charId: sharo.id, text: 'やっほー' }); await call('POST', '/reply', { charId: sharo.id });
ok(calls[0].sys.includes('SNS（タイムライン）での最近の出来事') && calls[0].sys.includes('ブリヌイ'), 'talk prompt includes TL context');
const postGen = (await call('POST', '/tl/poke', { charId: sharo.id, world: 'omote' })); await flush();
ok(calls.filter(c=>c.sys.includes('つぶやき')).pop().user.includes('やっほー'), 'TL post prompt includes talk context');

// quiet hours deferral (omote only)
const st = { quietEnabled: true, quietStart: 1, quietEnd: 7 };
const t3am = Date.UTC(2026, 9, 14, 18, 0) ; // 3:00 JST
const d1 = deferQuiet(t3am, st, 'omote', 0.5), d2 = deferQuiet(t3am, st, 'ura'), d1b = deferQuiet(t3am, st, 'omote', 0.05);
ok(new Date(d1 + 9*3600e3).getUTCHours() >= 7 && d2 === t3am && d1b === t3am, 'quiet hours: mostly defer omote, sometimes react at night');

// tick: spontaneous posts + job run
Math.random = () => 0.0001;
DB.raw.prepare('UPDATE tl_posts SET at=0').run();
await call('POST', '/settings', { settings: { quietEnabled: false } });
const t = []; await W.scheduled({}, env, { waitUntil: (x) => t.push(x) }); await Promise.all(t);
const lt = (await call('GET', '/ping')).lastTick; await flush();
ok(lt.done.some(d => d.includes('TL投稿(表)')) && lt.done.some(d => d.includes('TL投稿(裏)')), 'cron makes TL posts in both worlds: ' + JSON.stringify(lt.done));

// deletes
await call('POST', '/tl/delete', { postId: post2.id });
await call('POST', '/tl/clear', { world: 'ura' });
ok(!(await call('GET', '/tl?world=ura')).posts.length, 'clear ura TL'); await flush();
await call('DELETE', '/char?id=' + cool.id);
const left = DB.raw.prepare('SELECT COUNT(*) n FROM tl_comments WHERE author=?').get(cool.id).n + DB.raw.prepare('SELECT COUNT(*) n FROM tl_posts WHERE author=?').get(cool.id).n;
ok(left === 0, 'deleting char removes its TL data');
ok(JSON.stringify(toGeminiSchema({type:'object',properties:{a:{type:'array',items:{type:'string'}}},additionalProperties:false})) === '{"type":"OBJECT","properties":{"a":{"type":"ARRAY","items":{"type":"STRING"}}}}', 'gemini schema conversion');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
