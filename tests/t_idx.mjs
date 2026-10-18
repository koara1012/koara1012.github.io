import { makeDB } from './fake.mjs';
const W = (await import('./worker.mjs')).default;
const DB = makeDB(); const env = { DB, APP_TOKEN: 'pw' };
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok ' : 'FAIL ') + m); if (!c) fails++; };
const call = async (method, path, body) => { const r = await W.fetch(new Request('http://x' + path, { method, headers: { 'X-App-Token': 'pw', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, {}); return r; };
await call('GET', '/sync?since=0');
// seed data
DB.raw.exec("INSERT INTO chars (id,data,created) VALUES ('a','{\"name\":\"A\"}',1),('b','{\"name\":\"B\"}',1)");
const ins = DB.raw.prepare('INSERT INTO messages (char_id,sender,text,at) VALUES (?,?,?,?)');
const T = Date.now();
for (let i = 0; i < 3000; i++) ins.run(['a', 'b', 'a#ura'][i % 3], i % 2 ? 'me' : 'char', 'm' + i, T - (3000 - i) * 60e3);
DB.raw.exec("INSERT INTO reads (char_id,at) VALUES ('a'," + (T - 100 * 60e3) + ")");
DB.raw.exec("INSERT INTO images (id,part,mime,data) VALUES ('img1',0,'image/png','AAAA')");
DB.raw.exec('ANALYZE');
const plan = (sql) => DB.raw.prepare('EXPLAIN QUERY PLAN ' + sql).all().map(r => r.detail).join(' | ');
const qs = {
  rx: "SELECT id,reaction FROM messages WHERE reacted_at>1",
  rt: "SELECT id FROM messages WHERE retracted=1 AND at>1",
  rtq: "UPDATE messages SET retracted=1 WHERE retract_at IS NOT NULL AND retract_at<=1 AND retracted=0",
  unread: "SELECT SUM((SELECT COUNT(*) FROM messages m WHERE m.char_id=c.id AND m.sender='char' AND m.at > COALESCE((SELECT at FROM reads WHERE char_id=c.id),0))) AS n FROM chars c",
  me: "SELECT MAX((SELECT MAX(at) FROM messages WHERE char_id=c.id AND sender='me')) AS t FROM chars c",
  tl: "SELECT * FROM tl_posts WHERE planned=0 ORDER BY id LIMIT 2",
  kv: "SELECT k,v FROM kv WHERE k >= 'reply:' AND k < 'reply;'",
};
for (const [k, q] of Object.entries(qs)) { const p = plan(q); console.log(k, '→', p); ok(!/SCAN (messages|m|tl_posts|kv)\b(?! USING)/.test(p.replace(/SCAN c\b/, '')), k + ' uses an index'); }
// correctness of rewritten queries
const old = DB.raw.prepare("SELECT COUNT(*) AS n FROM messages m LEFT JOIN reads r ON r.char_id=m.char_id WHERE m.sender='char' AND m.char_id NOT LIKE '%#ura' AND m.at > COALESCE(r.at,0)").get().n;
ok(DB.raw.prepare(qs.unread).get().n === old && old > 0, 'unread count unchanged (' + old + ')');
const oldMe = DB.raw.prepare("SELECT MAX(at) AS t FROM messages WHERE sender='me' AND char_id NOT LIKE '%#ura'").get().t;
ok(DB.raw.prepare(qs.me).get().t === oldMe, 'last-active unchanged');
DB.raw.exec(`INSERT INTO kv (k,v) VALUES ('reply:a','1'),('reply:b','2'),('replygo:a','3'),('proj:a','4'),('rhythm:a','5')`);
ok(DB.raw.prepare(qs.kv).all().length === 2, 'kv range picks only reply: keys');
// export
let r = await call('GET', '/export');
const txt = await r.text(); const d = JSON.parse(txt);
ok(d.tables.messages.length === 3000 && d.tables.chars.length === 2 && !('images' in d.tables) && !('subs' in d.tables), 'export: all messages, no images/subs');
ok(/talk-backup-\d{4}-\d\d-\d\d\.json/.test(r.headers.get('Content-Disposition')), 'filename');
ok(!txt.includes('"pw"'), 'token not in export');
r = await call('GET', '/export?images=1');
ok(JSON.parse(await r.text()).tables.images.length === 1, 'export with photos');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
