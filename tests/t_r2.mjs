// 第69版：自動バックアップ「毎日の分」・ノベル画面の素材を R2 に預ける・この iPhone の設定を預ける・R2 の使用量と知らせ
import W from './worker.mjs';
import { makeDB } from './fake.mjs';
import { createHash } from 'node:crypto';
const DB = makeDB();
const store = new Map(); let ops = { put: 0, get: 0, list: 0, head: 0 };
const R2 = {
  async put(key, body, opt = {}) {
    ops.put++;
    const buf = Buffer.from(typeof body === 'string' ? body : body instanceof ArrayBuffer ? new Uint8Array(body) : body);
    if (opt.sha256 && createHash('sha256').update(buf).digest('hex') !== opt.sha256) throw new Error('sha mismatch');
    store.set(key, buf);
  },
  async get(key) { ops.get++; const b = store.get(key); if (!b) return null; return { text: async () => b.toString('utf8'), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; },
  async head(key) { ops.head++; return store.has(key) ? { size: store.get(key).length } : null; },
  async delete(keys) { for (const k of [].concat(keys)) store.delete(k); },
  async list({ prefix = '', cursor, limit = 1000 } = {}) { ops.list++; const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort(); const s = cursor ? Number(cursor) : 0; return { objects: all.slice(s, s + limit).map((key) => ({ key, size: store.get(key).length })), truncated: s + limit < all.length, cursor: String(s + limit) }; },
};
const env = { DB, APP_TOKEN: 'pw', GEMINI_API_KEY: 'g', BACKUP: R2, BARK_DEVICE_KEY: 'dev' };
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
const flush = async () => { while (waits.length) await waits.shift(); };
const raw = async (m, p, b, bin) => W.fetch(new Request('https://w' + p, { method: m, headers: { 'X-App-Token': 'pw' }, body: bin || (b ? JSON.stringify(b) : undefined) }), env, ctx);
const call = async (m, p, b, bin) => { const r = await raw(m, p, b, bin); const d = await r.json(); await flush(); if (!r.ok) throw Object.assign(new Error(d.error), { status: r.status }); return d; };
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
const barks = [];
globalThis.fetch = async (u, i) => { u = String(u); if (u.includes('day.app')) barks.push(String(i && i.body || u)); return new Response('{"code":200}', { status: 200 }); };
const RN = Date.now; let clock = RN(); Date.now = () => clock;
const jst = (y, mo, d, h) => Date.UTC(y, mo - 1, d, h - 9, 3);
const cron = async (n = 1) => { for (let i = 0; i < n; i++) { clock += 60e3; const w = []; await W.scheduled({ scheduledTime: clock }, env, { waitUntil: (p) => w.push(p) }); await Promise.allSettled(w); } };
const runJob = async () => { for (let i = 0; i < 40 && (await call('GET', '/backup/status')).job; i++) await cron(1); return call('GET', '/backup/status'); };
const slotsJson = () => JSON.parse(store.get('talk/slots.json').toString());
await call('GET', '/sync?since=0');
await call('POST', '/settings', { settings: { notifyVia: 'bark' } });
const c = (await call('POST', '/char', { char: { name: 'シャロ', prompt: 'p' } })).char;
const ins = DB.raw.prepare('INSERT INTO messages (char_id,sender,text,at) VALUES (?,?,?,?)');
for (let i = 0; i < 120; i++) ins.run(c.id, i % 2 ? 'char' : 'me', 'メッセージ' + i, clock - (200 - i) * 60e3);

// ---- 1. 毎日の分＋1日用（同じ中身を2つの枠に・書き出しは1回）
clock = jst(2026, 12, 1, 3); await cron(1);
ok(!(await call('GET', '/backup/status')).job, 'daily: waits until 4am');
clock = jst(2026, 12, 1, 4); await cron(1);
let st = await call('GET', '/backup/status');
ok(st.job && st.job.slots.join() === 'd,a', 'first run fills 毎日の分 and 1日用 together');
st = await runJob();
let sj = slotsJson();
ok(st.slots.d && st.slots.a && sj.d.gen === sj.a.gen && st.slots.d.name === '毎日の分', 'same generation in d and a');
ok(st.cycle.ok && st.cycle.name === '毎日の分', 'today done; next is 毎日の分');
const gen1 = sj.d.gen;
await cron(5);
ok(!(await call('GET', '/backup/status')).job, 'no second run on the same day');
// 次の日：毎日の分だけ入れ替わる。1日用は残る（同じ中身なので消さない）
ins.run(c.id, 'me', '2日目', clock);
clock = jst(2026, 12, 2, 4); await cron(1);
st = await call('GET', '/backup/status');
ok(st.job && st.job.slots.join() === 'd', 'day 2: only 毎日の分');
st = await runJob(); sj = slotsJson();
ok(sj.d.gen !== gen1 && sj.a.gen === gen1 && store.has(`talk/gens/${gen1}/manifest.json`), 'day 2: d replaced, a (shared gen) kept');
const gen2 = sj.d.gen;
clock = jst(2026, 12, 3, 4); await cron(1); st = await runJob(); sj = slotsJson();
ok(sj.d.gen !== gen2 && !store.has(`talk/gens/${gen2}/manifest.json`), 'day 3: old 毎日の分 removed after the new one is saved');
// 3時台はまだ前の日の分
clock = jst(2026, 12, 4, 3); await cron(2);
ok(!(await call('GET', '/backup/status')).job, 'before 4am counts as the previous day');
// 15日：毎日の分と15日用
clock = jst(2026, 12, 15, 4); await cron(1);
ok((await call('GET', '/backup/status')).job.slots.join() === 'd,b', 'the 15th: 毎日の分 and 15日用');
st = await runJob(); sj = slotsJson();
ok(sj.b && sj.b.gen === sj.d.gen && sj.a.gen === gen1, '15日用 saved, 1日用 untouched');
// 失敗しても前のものは残る（書き込みが壊れる）
const okPut = R2.put; R2.put = async (k, b, o) => { if (k.includes('/gens/')) throw new Error('R2 down'); return okPut(k, b, o); };
const dBefore = slotsJson().d.gen;
clock = jst(2026, 12, 16, 4); await cron(1); st = await runJob();
ok(!st.last.ok && slotsJson().d.gen === dBefore && store.has(`talk/gens/${dBefore}/manifest.json`), 'failed run keeps the previous 毎日の分');
R2.put = okPut;
clock += 6 * 3600e3 + 120e3; await cron(1); st = await runJob();
ok(st.last.ok && slotsJson().d.gen !== dBefore, 'retried 6 hours later and saved');
// 今すぐ取る：毎日の分を上書き
const dNow = slotsJson().d.gen;
await call('POST', '/backup/now', {});
for (let i = 0; i < 40 && (await call('GET', '/backup/status')).job; i++) await call('POST', '/backup/step');
sj = slotsJson();
ok(sj.d.gen !== dNow && sj.b.gen !== sj.d.gen, '今すぐ取る overwrites only 毎日の分 when 15日用 is done');
// 毎日の分から戻せる・iPhoneに保存できる
let r = await raw('GET', '/backup/download?slot=d'); await flush();
ok(/talk-backup-daily/.test(r.headers.get('Content-Disposition')) && JSON.parse(await r.text()).counts.messages > 100, 'download 毎日の分');

// ---- 2. ノベル画面の素材
const fileA = Buffer.from('PNGDATA-'.repeat(1000)), hA = createHash('sha256').update(fileA).digest('hex');
const fileB = Buffer.from('FONT'.repeat(500)), hB = createHash('sha256').update(fileB).digest('hex');
let n = await call('POST', '/assets/need', { items: [{ id: 'i1', h: hA, name: '立ち絵.png', type: 'image/png', size: fileA.length }, { id: 'i2', h: hB, name: 'font.ttf', type: '', size: fileB.length }, { id: 'i3', h: hA, name: '立ち絵のコピー.png', type: 'image/png', size: fileA.length }] });
ok(n.need.length === 2 && n.need.includes(hA) && n.need.includes(hB), 'need: new files listed once (same file twice → once)');
const put = (id, h, name, type, buf) => call('POST', `/assets/put?id=${id}&h=${h}&name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, null, buf);
let e = ''; try { await put('i1', hB, 'x', '', fileA); } catch (x) { e = x.message; }
ok(/指紋と合いません/.test(e), 'wrong fingerprint rejected');
await put('i1', hA, '立ち絵.png', 'image/png', fileA); await put('i2', hB, 'font.ttf', '', fileB);
n = await call('POST', '/assets/need', { items: [{ id: 'i1', h: hA }, { id: 'i2', h: hB }, { id: 'i3', h: hA, name: '立ち絵のコピー.png', type: 'image/png', size: fileA.length }] });
ok(n.need.length === 0, 'need: nothing to send again');
let ix = await call('GET', '/assets/index');
ok(ix.items.i1.h === hA && ix.items.i3.h === hA && ix.items.i1.name === '立ち絵.png' && ix.files === 2 && ix.bytes === fileA.length + fileB.length, 'index: ids → fingerprints, deduped size');
r = await raw('GET', '/assets/get?h=' + hA); await flush();
ok(Buffer.from(await r.arrayBuffer()).equals(fileA), 'get returns the same bytes');
// 素材を差し替えても、古いものは R2 に残る
const fileC = Buffer.from('NEWPNG'.repeat(800)), hC = createHash('sha256').update(fileC).digest('hex');
n = await call('POST', '/assets/need', { items: [{ id: 'i4', h: hC, name: '新しい立ち絵.png', type: 'image/png', size: fileC.length }] });
await put('i4', hC, '新しい立ち絵.png', 'image/png', fileC);
ok(store.has('assets/' + hA) && store.has('assets/' + hC), 'old asset stays in R2');
// 素材は自動バックアップの世代消しで消えない
clock = jst(2026, 12, 17, 4); await cron(1); await runJob();
clock = jst(2026, 12, 18, 4); await cron(1); await runJob();
ok(store.has('assets/' + hA) && store.has('assets/index.json'), 'assets survive backup rotation');
// R2 の中の素材が壊れていたら渡さない
store.set('assets/' + hB, Buffer.from('broken'));
r = await raw('GET', '/assets/get?h=' + hB); await flush();
ok(r.status === 500, 'damaged asset not returned');

// ---- 3. この iPhone の設定
await call('POST', '/device/prefs', { prefs: { 'call.fx': true, 'vol.char': { [c.id]: 0.5 }, 'sleep.min': 3, 'chat.cfg': { url: 'u', token: 'SECRET' }, 'my.token': 'x', apiKey: 'y' } });
let pr = await call('GET', '/device/prefs');
ok(pr.prefs['call.fx'] === true && pr.prefs['vol.char'][c.id] === 0.5 && pr.prefs['sleep.min'] === 3, 'prefs saved');
ok(!('chat.cfg' in pr.prefs) && !('my.token' in pr.prefs) && !('apiKey' in pr.prefs) && !JSON.stringify(DB.raw.prepare('SELECT v FROM kv').all()).includes('SECRET'), 'token/cfg/keys never stored');
await call('POST', '/device/prefs', { lab: true, prefs: { 'call.fx': false } });
ok((await call('GET', '/device/prefs')).prefs['call.fx'] === true && (await call('GET', '/device/prefs?lab=1')).prefs['call.fx'] === false, 'lab prefs kept apart');
const ex = JSON.parse(await (await raw('GET', '/export')).text()); await flush();
ok(ex.tables.kv.some((x) => x.k === 'dev:prefs'), 'prefs are inside the backup');
ok(!ex.tables.kv.some((x) => x.k === 'bk:r2use'), 'usage counter is not inside the backup');

// ---- 4. 使用量
let u = await call('GET', '/backup/usage?scan=1');
const realBytes = [...store.values()].reduce((a, b) => a + b.length, 0);
ok(u.size && u.size.bytes === realBytes && u.size.objects === store.size, 'storage size measured: ' + u.size.bytes);
ok(u.a > 0 && u.b > 0 && u.free.a === 1e6 && u.free.b === 10e6 && u.free.bytes === 10e9, `ops counted (A ${u.a} / B ${u.b})`);
const a0 = u.a, b0 = u.b, o0 = { ...ops };
await call('GET', '/assets/index');
u = await call('GET', '/backup/usage');
ok(u.b - b0 === ops.get + ops.head - o0.get - o0.head && u.a - a0 === ops.put + ops.list - o0.put - o0.list, 'counter matches the real calls');
ok((await call('GET', '/backup/status')).usage.a === u.a, 'status carries usage');
// 50%・80%で1回ずつ知らせる
barks.length = 0;
const use = JSON.parse(DB.raw.prepare("SELECT v FROM kv WHERE k='bk:r2use'").get().v);
use.a = 499995; DB.raw.prepare("UPDATE kv SET v=? WHERE k='bk:r2use'").run(JSON.stringify(use));
await call('GET', '/assets/index'); await call('POST', '/assets/need', { items: [{ id: 'z', h: hA }] });
for (let i = 0; i < 6; i++) await call('POST', '/assets/need', { items: [{ id: 'z' + i, h: hA }] });
ok(barks.filter((b) => b.includes('50%')).length === 1, 'notified once at 50%');
const use2 = JSON.parse(DB.raw.prepare("SELECT v FROM kv WHERE k='bk:r2use'").get().v);
use2.a = 799999; DB.raw.prepare("UPDATE kv SET v=? WHERE k='bk:r2use'").run(JSON.stringify(use2));
for (let i = 0; i < 4; i++) await call('POST', '/assets/need', { items: [{ id: 'y' + i, h: hA }] });
ok(barks.filter((b) => b.includes('80%')).length === 1 && barks.filter((b) => b.includes('50%')).length === 1, 'notified once at 80%');
// 1日で急に増えた
const use3 = JSON.parse(DB.raw.prepare("SELECT v FROM kv WHERE k='bk:r2use'").get().v);
const dd = new Date(clock).toISOString().slice(8, 10); use3.days[dd].b = 299999; DB.raw.prepare("UPDATE kv SET v=? WHERE k='bk:r2use'").run(JSON.stringify(use3));
for (let i = 0; i < 3; i++) await call('GET', '/assets/index');
ok(barks.filter((b) => b.includes('急に増えて')).length === 1, 'daily spike notified once');
// 保存量 50%
store.set('assets/huge', { length: 5.1e9 }); // 大きさだけの偽物
await call('GET', '/backup/usage?scan=1');
ok(barks.some((b) => b.includes('保存している量') && b.includes('50%')), 'storage 50% notified');
store.delete('assets/huge');
// 次の月は数え直し
clock = Date.UTC(2027, 0, 2, 0, 0); await call('GET', '/assets/index');
u = await call('GET', '/backup/usage');
ok(u.month === '2027-01' && u.a < 10 && u.b < 10, 'new month resets counters');
// R2 が無いとき
const env2 = { DB, APP_TOKEN: "pw" };
const r2 = await W.fetch(new Request('https://w/assets/index', { headers: { 'X-App-Token': 'pw' } }), env2, ctx);
ok(r2.status === 400 && (await (await W.fetch(new Request('https://w/backup/status', { headers: { 'X-App-Token': 'pw' } }), env2, ctx)).json()).r2 === false, 'no R2: clear error, status says not connected');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
