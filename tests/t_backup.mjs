// 自動バックアップ（R2）・確認・戻す・ファイルから戻す・写真のJPEG差し替え
import W, * as X from './worker.mjs';
import { makeDB } from './fake.mjs';
import { createHash } from 'node:crypto';
const DB = makeDB();
// ---- R2 の偽物（指紋の確認・一覧・削除）
const store = new Map();
const R2 = {
  async put(key, body, opt = {}) {
    const buf = Buffer.from(typeof body === 'string' ? body : body);
    if (opt.sha256 && createHash('sha256').update(buf).digest('hex') !== opt.sha256) throw new Error('sha mismatch');
    store.set(key, buf);
  },
  async get(key) { const b = store.get(key); if (!b) return null; return { text: async () => b.toString('utf8'), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; },
  async delete(keys) { for (const k of [].concat(keys)) store.delete(k); },
  async list({ prefix = '', cursor, limit = 1000 }) { const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort(); const s = cursor ? Number(cursor) : 0; return { objects: all.slice(s, s + limit).map((key) => ({ key })), truncated: s + limit < all.length, cursor: String(s + limit) }; },
};
const env = { DB, APP_TOKEN: 'pw', GEMINI_API_KEY: 'g', BACKUP: R2 };
const ctx = { waitUntil: () => {} };
const raw = async (m, p, b) => W.fetch(new Request('https://w' + p, { method: m, headers: { 'X-App-Token': 'pw' }, body: b ? JSON.stringify(b) : undefined }), env, ctx);
const call = async (m, p, b) => { const r = await raw(m, p, b); const d = await r.json(); if (!r.ok) throw Object.assign(new Error(d.error), { status: r.status }); return d; };
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
globalThis.fetch = async () => new Response('{}', { status: 200 });
const RN = Date.now; let clock = RN(); Date.now = () => clock;
const jst = (y, mo, d, h) => Date.UTC(y, mo - 1, d, h - 9, 3);
const cron = async (n = 1) => { for (let i = 0; i < n; i++) { clock += 60e3; const w = []; await W.scheduled({ scheduledTime: clock }, env, { waitUntil: (p) => w.push(p) }); await Promise.allSettled(w); } };
const ensure = await call('GET', '/sync?since=0');

// ---- データを作る
const c = (await call('POST', '/char', { char: { name: 'シャロ', prompt: 'p' } })).char;
const ins = DB.raw.prepare('INSERT INTO messages (char_id,sender,text,at) VALUES (?,?,?,?)');
for (let i = 0; i < 3400; i++) ins.run(i % 4 === 3 ? c.id + '#ura' : c.id, i % 2 ? 'char' : 'me', 'メッセージ' + i + (i % 50 === 0 ? 'あ'.repeat(3000) : ''), clock - (4000 - i) * 60e3);
const big = 'A'.repeat(1500000); // 写真1枚（3つに分かれる）
for (let p = 0; p < 3; p++) DB.raw.prepare('INSERT INTO images (id,part,mime,data) VALUES (?,?,?,?)').run('img1', p, 'image/png', big.slice(p * 700000, (p + 1) * 700000));
DB.raw.prepare("INSERT INTO messages (char_id,sender,text,at,image) VALUES (?,?,?,?,?)").run(c.id, 'char', '', clock, 'img1');
DB.raw.prepare("INSERT INTO tl_posts (world,author,text,at,planned) VALUES ('omote',?, '投稿', ?, 1)").run(c.id, clock);
DB.raw.prepare("INSERT OR REPLACE INTO kv (k,v) VALUES ('vapid','{\"jwk\":\"SECRET\"}'),('origin','\"https://w\"')").run();
const countMsgs = () => DB.raw.prepare('SELECT COUNT(*) n FROM messages').get().n;
const N0 = countMsgs();

// ---- 手動の書き出し：件数つき・端末専用の値は入らない
let r = await raw('GET', '/export?images=1'); let txt = await r.text(); let d = JSON.parse(txt);
ok(d.counts.messages === N0 && d.tables.messages.length === N0 && d.counts.images === 3, 'manual export carries counts');
ok(!txt.includes('SECRET') && !d.tables.kv.some((x) => x.k === 'origin' || x.k.startsWith('bk:')), 'manual export excludes vapid/origin/bk:*');
const chk = await call('GET', '/backup/check');
ok(chk.problems.length === 0 && chk.photos === 1, 'integrity check clean');

// ---- 自動：1日の3時は待つ、4時を過ぎたら始まる
clock = jst(2026, 11, 1, 3); await cron(1);
ok(!(await call('GET', '/backup/status')).job, 'waits until 4am on the 1st');
clock = jst(2026, 11, 1, 4); await cron(1);
let st = await call('GET', '/backup/status');
ok(st.job && st.job.slot === 'a', 'auto backup starts after 4am (slot 1日用)');
for (let i = 0; i < 40 && (await call('GET', '/backup/status')).job; i++) await cron(1);
st = await call('GET', '/backup/status');
ok(st.slots.a && st.last.ok && st.slots.a.counts.messages === N0 && st.slots.a.photos === 1, 'slot a saved with all messages and photo');
ok(st.cycle.ok, 'cycle marked done');
const slotsJson = JSON.parse(store.get('talk/slots.json').toString());
const man = JSON.parse(store.get(`talk/gens/${slotsJson.a.gen}/manifest.json`).toString());
ok(man.parts.every((p) => createHash('sha256').update(store.get(p.key)).digest('hex') === p.sha), 'every part matches its fingerprint');
ok(man.parts.length > 3 && man.parts.filter((p) => p.table === 'images').length === 2, 'data split into parts');
const firstGen = slotsJson.a.gen;
await cron(3);
ok(!(await call('GET', '/backup/status')).job, 'no second backup in the same cycle');

// ---- 15日：バグで急に減った → 保存しない
DB.raw.prepare('DELETE FROM messages WHERE id > 100').run();
clock = jst(2026, 11, 15, 4); await cron(1);
for (let i = 0; i < 40 && (await call('GET', '/backup/status')).job; i++) await cron(1);
st = await call('GET', '/backup/status');
ok(!st.slots.b && st.last && !st.last.ok && st.last.blocked && st.cycle.blocked, 'sudden drop → not saved, blocked');
ok([...store.keys()].filter((k) => k.includes('/gens/') && !k.includes(firstGen)).length === 0, 'blocked generation cleaned up');
await cron(5);
ok(!(await call('GET', '/backup/status')).job, 'blocked cycle does not retry by itself');
// 押せば保存できる
await call('POST', '/backup/now', { force: true });
for (let i = 0; i < 40 && (await call('GET', '/backup/status')).job; i++) await call('POST', '/backup/step');
st = await call('GET', '/backup/status');
ok(st.slots.b && st.slots.b.counts.messages === 100 && st.slots.a.counts.messages === N0 && st.last.warnings.some((w) => w.includes('減って')), 'forced save → slot b, slot a untouched');

// ---- 自分で消したのなら、減っても保存する（警告つき）
clock = jst(2026, 12, 1, 5);
await call('POST', '/messages/delete', { charId: c.id, ids: [1, 3, 5] }); // 消した記録が付く
DB.raw.prepare('DELETE FROM messages WHERE id > 60').run();
await cron(1);
for (let i = 0; i < 40 && (await call('GET', '/backup/status')).job; i++) await cron(1);
st = await call('GET', '/backup/status');
ok(st.last.ok && st.slots.a.counts.messages < 101 && st.slots.a.warnings.some((w) => w.includes('消した分')), 'user deletion explains the drop');
ok(!store.has(`talk/gens/${firstGen}/manifest.json`), 'old generation of slot a removed after overwrite');

// ---- 戻す：15日用（101件）へ
DB.raw.prepare("INSERT OR REPLACE INTO kv (k,v) VALUES ('reply:' || ?, '{}')").run(c.id);
DB.raw.prepare("INSERT INTO tl_jobs (world,char_id,kind,post_id,due) VALUES ('omote',?,'like',1,0)").run(c.id);
let e = ''; try { await call('POST', '/backup/restore', { source: 'b', confirm: 'もどす' }); } catch (x) { e = x.message; }
ok(/「戻す」と入力/.test(e), 'needs the word 戻す');
const before = countMsgs();
await call('POST', '/backup/restore', { source: 'b', confirm: '戻す' });
e = 0; try { await call('GET', '/sync?since=0'); } catch (x) { e = x.status; }
ok(e === 503, 'other requests blocked while restoring');
let phases = new Set();
for (let i = 0; i < 80; i++) { st = await call('POST', '/backup/step'); if (st.restore) phases.add(st.restore.phase); else break; }
ok(!st.restore && !st.lock && st.restoreResult.ok, 'restore finished and unlocked: ' + [...phases].join('→'));
ok(countMsgs() === 100, 'messages back to slot b (100)');
ok(st.slots.pre && st.slots.pre.counts.messages === before, '戻す前の状態 saved first');
ok(DB.raw.prepare("SELECT v FROM kv WHERE k='vapid'").get()?.v.includes('SECRET'), 'device keys kept');
ok(!DB.raw.prepare("SELECT 1 FROM kv WHERE k='reply:' || ?").get(c.id) && DB.raw.prepare('SELECT COUNT(*) n FROM tl_jobs').get().n === 0, 'stale reply/TL jobs dropped');
ok(DB.raw.prepare("SELECT COUNT(*) n FROM images WHERE id='img1'").get().n === 3, 'photos restored');
ok((await call('GET', '/sync?since=0')).messages.length > 0, 'app works again');

// ---- 取り消し：戻す前の状態へ戻す（元に戻る）
await call('POST', '/backup/restore', { source: 'pre', confirm: '戻す' });
for (let i = 0; i < 80; i++) { st = await call('POST', '/backup/step'); if (!st.restore) break; }
ok(countMsgs() === before && st.restoreResult.ok, 'undo via 戻す前の状態 works');

// ---- 壊れたバックアップからは戻さない（何も消さない）
const sl = JSON.parse(store.get('talk/slots.json').toString());
const m2 = JSON.parse(store.get(`talk/gens/${sl.a.gen}/manifest.json`).toString());
const victim = m2.parts[m2.parts.length - 1].key; store.set(victim, Buffer.from('broken'));
const n1 = countMsgs();
await call('POST', '/backup/restore', { source: 'a', confirm: '戻す' });
for (let i = 0; i < 80; i++) { st = await call('POST', '/backup/step'); if (!st.restore) break; }
ok(!st.restoreResult.ok && /問題/.test(st.restoreResult.msg) && countMsgs() === n1 && !st.lock, 'damaged backup → aborted before deleting anything');
r = await raw('GET', '/backup/download?slot=a&images=1'); let failed = false; try { JSON.parse(await r.text()); } catch (_) { failed = true; }
ok(failed, 'download of damaged backup does not produce a valid file');

// ---- 自動バックアップをiPhoneへ（手動と同じ形）
r = await raw('GET', '/backup/download?slot=b&images=1'); d = JSON.parse(await r.text());
ok(d.tables.messages.length === 100 && d.counts.messages === 100 && d.tables.images.length === 3 && /talk-backup-15th/.test(r.headers.get('Content-Disposition')), 'slot download = manual format');

// ---- ファイルから戻す（手動で書き出したファイル）
DB.raw.prepare('DELETE FROM messages WHERE id > 20').run();
const file = d;
const { gen } = await call('POST', '/backup/upload/start', { images: file.images });
let seq = 0;
for (const [t, rows] of Object.entries(file.tables)) for (let i = 0; i < rows.length; i += 500) { await call('POST', '/backup/upload/part', { gen, seq, table: t, rows: rows.slice(i, i + 500) }); seq++; }
const again = await call('POST', '/backup/upload/part', { gen, seq: 0, table: 'messages', rows: [{}] }); // 送り直しは無視
ok(again.seq === seq, 'resent part ignored');
e = ''; try { await call('POST', '/backup/upload/finish', { gen, counts: { ...file.counts, messages: 999 } }); } catch (x) { e = x.message; }
ok(/件数が合いません/.test(e), 'count mismatch rejected');
await call('POST', '/backup/upload/finish', { gen, counts: file.counts, version: file.version, exportedAt: file.exportedAt });
await call('POST', '/backup/restore', { source: 'upload', confirm: '戻す' });
for (let i = 0; i < 80; i++) { st = await call('POST', '/backup/step'); if (!st.restore) break; }
ok(st.restoreResult.ok && countMsgs() === 100, 'restore from uploaded file');
ok(![...store.keys()].some((k) => k.includes(gen)), 'uploaded staging removed after restore');

// ---- 写真をJPEGに差し替え
const jpg = 'data:image/jpeg;base64,/9j/' + 'B'.repeat(800000);
let rr = await call('POST', '/img/replace', { id: 'img1', data: jpg });
ok(rr.ok && DB.raw.prepare("SELECT COUNT(*) n, MIN(mime) m FROM images WHERE id='img1'").get().n === 2 && DB.raw.prepare("SELECT mime FROM images WHERE id='img1'").get().mime === 'image/jpeg', 'PNG replaced by JPEG (fewer parts)');
const img = await raw('GET', '/img?id=img1');
ok(img.headers.get('Content-Type') === 'image/jpeg', 'served as jpeg');
ok((await call('POST', '/img/replace', { id: 'img1', data: jpg })).skip === 'not-png', 'jpeg not replaced again');
DB.raw.prepare("INSERT INTO images (id,part,mime,data) VALUES ('img2',0,'image/png','QUJD')").run();
ok((await call('POST', '/img/replace', { id: 'img2', data: 'data:image/jpeg;base64,/9j/QUJDREVGR0g=' })).skip === 'not-smaller', 'larger JPEG ignored');
e = ''; try { await call('POST', '/img/replace', { id: 'img2', data: 'data:image/jpeg;base64,QUJD' }); } catch (x) { e = x.message; }
ok(/JPEG/.test(e), 'non-JPEG data rejected');
// 手動のバックアップを保存した日時（第37版）
ok((await call('GET', '/backup/status')).manual === null, 'no manual backup recorded yet');
const mb = await call('POST', '/backup/manual', { photos: true, bytes: 12345678, messages: 100 });
st = await call('GET', '/backup/status');
ok(st.manual && st.manual.at === mb.manual.at && st.manual.photos === true && st.manual.bytes === 12345678, 'last manual backup time is remembered');
const ex2 = JSON.parse(await (await raw('GET', '/export')).text());
ok(!ex2.tables.kv.some((x) => x.k === 'bk:manual'), 'the record itself is not inside backups');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
