// 画面の確かめ（Playwright）。run-all には入らない。使い方：node --no-warnings tests/run-all.mjs t_video（worker.mjs を作る）のあと、tests で node --no-warnings ui_video.mjs
// 第83版の画面の確かめ：ビデオ通話（偽のカメラ・ノベル画面の立ち絵を IndexedDB に入れておく）
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, ''), SHOT = (process.env.SHOT_DIR || '/tmp') + '/';
const require = createRequire(REPO + '/tests/');
const { chromium } = require('playwright');
const W = (await import(REPO + '/tests/worker.mjs')).default;
const { makeDB } = await import(REPO + '/tests/fake.mjs');
const DB = makeDB();
const env = { DB, APP_TOKEN: 'pw', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' };
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
const seen = { imgs: 0 };
globalThis.fetch = async (u, i) => {
  u = String(u);
  if (!u.includes('googleapis') && !u.includes('x.ai')) return new Response('{}');
  const body = JSON.parse(i.body); const grok = u.includes('x.ai');
  const sch = JSON.stringify(grok ? body.response_format : body.generationConfig.responseSchema);
  if (!grok) seen.imgs += body.contents.flatMap((c) => c.parts.filter((p) => p.inlineData)).length;
  let out;
  const P = JSON.parse(sch).properties || {};
  if (sch.includes('wait_user')) out = { lines: [{ speaker: '朱里', text: '《笑顔》わあ、見えたよ。きれいな景色だね、ずっと見ていたいな' }, { speaker: '花', text: 'ほんとだね、すごくいい感じ' }], wait_user: true };
  else if (sch.includes('"members"')) out = { members: [] };
  else if (sch.includes('"after"')) out = { answer: true, reason: '', after: 'none', line: '' };
  else if (sch.includes('"hangup"')) out = { messages: [P.photo_desc ? '《笑顔》わあ、おいしそう。それ、どこのお店ですか？' : '《照れ》もしもし、聞こえてますよ。今日はどうでしたか？'], hangup: false };
  else if (sch.includes('"summary"')) out = { summary: '写真を見せてもらった。' };
  else out = { messages: ['うん'] };
  for (const k of Object.keys(P)) if (!(k in out)) out[k] = k === 'ask_photo' ? false : k === 'photo_desc' ? '夕焼けの川' : k === 'reminders' ? [] : '';
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: JSON.stringify(out) } }] } : { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
};
const wapi = async (m, p, b) => { const r = await W.fetch(new Request('https://api.test' + p, { method: m, headers: { 'X-App-Token': 'pw' }, body: b ? JSON.stringify(b) : undefined }), env, ctx); while (waits.length) await waits.shift(); return r.json(); };
await wapi('POST', '/settings', { settings: { delayEnabled: false, lifeEnabled: false, quietEnabled: false } });
const a = (await wapi('POST', '/char', { char: { name: '朱里', prompt: '表', voice: 'akari' } })).char;
const h = (await wapi('POST', '/char', { char: { name: '花', prompt: 'p', voice: 'hana' } })).char;
await wapi('POST', '/faces', { charId: a.id, kind: 'omote', faces: [{ name: '通常', desc: '' }, { name: '笑顔', desc: '' }, { name: '照れ', desc: '' }] });
const og = (await wapi('POST', '/ogroup', { group: { name: '二人', members: [a.id, h.id] } })).group;
await wapi('POST', '/send', { charId: a.id, text: 'やあ' });
function wav(sec) { const sr = 8000, n = Math.round(sr * sec), b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(200 * Math.sin(i / 5)), 44 + i * 2); return b; }
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const bctx = await browser.newContext({ viewport: { width: 375, height: 667 }, permissions: ['camera'] });
const page = await bctx.newPage();
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => { fails++; console.log('PAGE ERROR', e.message); });
await page.route('https://app.test/**', (r) => { const p = new URL(r.request().url()).pathname; try { r.fulfill({ body: readFileSync(REPO + p), contentType: p.endsWith('.html') ? 'text/html' : p.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' }); } catch (_) { r.fulfill({ status: 404, body: '' }); } });
await page.route('https://tts.test/**', async (r) => { const req = r.request(); if (req.url().includes('/health')) return r.fulfill({ body: '{"ok":true}' }); const b = JSON.parse(req.postData() || '{}'); await new Promise((res) => setTimeout(res, 100)); r.fulfill({ body: wav(Math.min(3, 0.6 + b.input.length * 0.06)), contentType: 'audio/wav' }); });
let lastSay = null, dropPhoto = false;
await page.route('https://api.test/**', async (r) => {
  const req = r.request();
  if (req.url().includes('/say')) lastSay = JSON.parse(req.postData() || '{}');
  const res = await W.fetch(new Request(req.url(), { method: req.method(), headers: { 'X-App-Token': 'pw', 'Content-Type': 'application/json' }, body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData() }), env, ctx);
  while (waits.length) await waits.shift();
  if (dropPhoto && req.url().includes('/say') && lastSay && lastSay.photo) { dropPhoto = false; return r.abort('connectionreset'); } // 通信が切れた（サーバーは最後まで作っている）
  r.fulfill({ status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
});
await page.addInitScript(() => { localStorage.setItem('chat.cfg', JSON.stringify({ url: 'https://api.test', token: 'pw' })); localStorage.setItem('novel.settings', JSON.stringify({ ttsUrl: 'https://tts.test' })); });
await page.goto('https://app.test/chat/index.html');
await page.waitForTimeout(1500);
ok(await page.evaluate(() => /^第\d+版/.test(APP_VERSION)), 'version 83');
// ノベル画面の立ち絵（朱里だけ）を IndexedDB に入れる：土台（体）・目（開・閉）・口（開・閉）を表情2つ分
await page.evaluate(async (lineId) => {
  const png = async (draw) => { const c = new OffscreenCanvas(300, 600), g = c.getContext('2d'); draw(g); return (await c.convertToBlob({ type: 'image/png' })).arrayBuffer(); };
  const db = await new Promise((res) => { const r = indexedDB.open('charaNovel', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); });
  const put = (k, v) => new Promise((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; });
  const img = async (id, draw) => put('img:' + id, { name: id + '.png', type: 'image/png', buf: await png(draw) });
  await img('base', (g) => { g.fillStyle = '#f3c9a8'; g.beginPath(); g.arc(150, 120, 80, 0, 7); g.fill(); g.fillStyle = '#556'; g.fillRect(60, 210, 180, 390); });
  await img('eo', (g) => { g.fillStyle = '#222'; g.fillRect(110, 100, 20, 20); g.fillRect(170, 100, 20, 20); });
  await img('ec', (g) => { g.fillStyle = '#222'; g.fillRect(110, 110, 20, 4); g.fillRect(170, 110, 20, 4); });
  await img('mo', (g) => { g.fillStyle = '#a33'; g.fillRect(135, 150, 30, 18); });
  await img('mc', (g) => { g.fillStyle = '#a33'; g.fillRect(135, 158, 30, 3); });
  await img('so', (g) => { g.fillStyle = '#e44'; g.beginPath(); g.arc(150, 155, 18, 0, 3.14); g.fill(); });
  await put('chars', [{ id: 'n1', name: '朱里', lineId, base: 'base', faces: [{ id: 'f1', name: '通常', eye: { open: 'eo', close: 'ec' }, mouth: { open: 'mo', close: 'mc' } }, { id: 'f2', name: '笑顔', eye: { open: 'eo', close: 'ec' }, mouth: { open: 'so', close: 'mc' } }, { id: 'f3', name: '照れ', eye: { open: 'ec' }, mouth: { open: 'mo', close: 'mc' } }] }]);
  db.close();
}, a.id);

// ---- 第84版：トーク画面の上の［⏸］
await page.evaluate((id) => openChat(id), a.id);
await page.waitForTimeout(300);
ok(await page.isVisible('#btnPauseChar') && (await page.textContent('#btnPauseChar')) === '⏸', 'pause button in the header');
await page.click('#btnPauseChar'); await page.waitForTimeout(500);
let stt = (await wapi('GET', '/sync?since=0')).settings;
ok((stt.omotePausedIds || []).includes(a.id) && (await page.textContent('#btnPauseChar')) === '▶' && await page.isVisible('#charPauseBar'), 'tap → paused (▶, red bar)');
await page.screenshot({ path: SHOT + 'v-pause.png' });
await page.click('#btnPauseChar'); await page.waitForTimeout(500);
stt = (await wapi('GET', '/sync?since=0')).settings;
ok(!(stt.omotePausedIds || []).includes(a.id) && (await page.textContent('#btnPauseChar')) === '⏸', 'tap again → resumed');
await page.evaluate((id) => openChat(id), og.id); await page.waitForTimeout(300);
ok(await page.isHidden('#btnPauseChar'), 'not on group chats');
// ---- 1対1
await page.evaluate((id) => startOutgoing(charById(id), true), a.id);
await page.waitForFunction(() => CALL.cur && CALL.cur.answeredAt && !CALL.cur.speaking, null, { timeout: 30000 });
ok(await page.isVisible('#cvCamBtn') && (await page.textContent('#cvCamBtn')).includes('OFF'), 'camera button (off at first)');
ok(await page.isHidden('#cvStage'), 'no stage while the camera is off');
await page.click('#cvCamBtn');
await page.waitForFunction(() => $('cvCam').videoWidth > 0, null, { timeout: 10000 });
ok(await page.isVisible('#cvStage') && await page.isVisible('#cvShutter') && await page.isHidden('.cvAvWrap'), 'camera on: stage + shutter, avatar hidden');
await page.waitForFunction(() => document.querySelector('.vSpr img.b') && document.querySelector('.vSpr img.b').style.display === 'block', null, { timeout: 5000 });
ok(true, 'sprite drawn from the novel assets');
// 話す → video:true と表情
await page.fill('#cvText', 'ただいま'); await page.click('#cvSend');
await page.waitForFunction(() => CALL.cur && !CALL.cur.busy && CALL.cur.speaking, null, { timeout: 15000 }).catch(() => {});
ok(lastSay && lastSay.video === true, 'say sends video:true');
await page.waitForTimeout(300);
const faceNow = await page.evaluate((id) => VID.st[id] && VID.st[id].face, a.id);
ok(faceNow === '照れ', 'face from the reply (' + faceNow + ')');
let mouthMoved = false;
for (let i = 0; i < 30 && !mouthMoved; i++) { mouthMoved = await page.evaluate((id) => VID.st[id].ms !== 'close', a.id); await page.waitForTimeout(60); }
ok(mouthMoved, 'mouth moves while speaking');
await page.screenshot({ path: SHOT + 'v-1to1.png' });
await page.waitForFunction(() => CALL.cur && !CALL.cur.speaking, null, { timeout: 30000 });
// シャッター
await page.click('#cvShutter');
await page.waitForTimeout(200);
ok(await page.$('#cvSub .photo img'), 'photo thumbnail in subtitles');
await page.waitForFunction(() => CALL.cur && !CALL.cur.busy, null, { timeout: 15000 });
ok(lastSay && /^data:image\/jpeg;base64,/.test(lastSay.photo) && lastSay.photo.length < 400000, 'photo sent as a small JPEG (' + (lastSay && lastSay.photo ? lastSay.photo.length : 0) + ')');
ok(seen.imgs >= 1, 'AI got the image');
const sp = await page.evaluate((id) => VID.st[id].face, a.id);
ok(sp === '笑顔', 'reaction face');
await page.screenshot({ path: SHOT + 'v-photo.png' });
// 第85版：通信が切れても、あとで返事を受け取る
await page.waitForFunction(() => CALL.cur && !CALL.cur.speaking && !CALL.cur.busy, null, { timeout: 30000 });
dropPhoto = true;
await page.evaluate((id) => { VID.st[id].face = '通常'; }, a.id);
await page.click('#cvShutter');
await page.waitForFunction(() => CALL.cur && !CALL.cur.busy, null, { timeout: 30000 });
ok(await page.evaluate((id) => VID.st[id].face, a.id) === '笑顔' && (await page.textContent('#cvSub')).includes('おいしそう') && !(await page.textContent('#cvSub')).includes('届きませんでした'), 'dropped connection: answer fetched later and played');
ok(await page.evaluate(() => JSON.stringify(diagLog).includes('あとで受け取れた')), 'diagnostic note');
const raw = JSON.parse(DB.raw.prepare("SELECT v FROM kv WHERE k LIKE 'call:%'").get().v);
ok(raw.transcript.some((m) => m.photo && m.text.includes('夕焼けの川')) && !JSON.stringify(raw).includes('base64'), 'server keeps only the description');
{ const bb = await page.$eval('#cvEnd', (e) => e.getBoundingClientRect().bottom); ok(bb <= 667, 'end button on screen (' + Math.round(bb) + ')'); }
// カメラを切る
await page.click('#cvCamBtn');
ok(await page.isHidden('#cvStage') && await page.isVisible('.cvAvWrap') && await page.evaluate(() => !VID.stream), 'camera off: back to the avatar');
await page.waitForFunction(() => CALL.cur && !CALL.cur.speaking && !CALL.cur.busy, null, { timeout: 30000 });
await page.fill('#cvText', 'またね'); await page.click('#cvSend');
await page.waitForTimeout(500);
ok(lastSay.video === false, 'say sends video:false after turning it off');
await page.waitForFunction(() => CALL.cur && !CALL.cur.speaking && !CALL.cur.busy, null, { timeout: 30000 });
await page.click('#cvEnd'); await page.waitForTimeout(600);

// ---- 表のグループ通話：出ている子を並べる（立ち絵がない子はアイコン）
await page.evaluate((id) => startGroupCall(ogroupById ? ogroupById(id) : null, true, undefined, undefined, true), og.id).catch(() => {});
await page.waitForFunction(() => CALL.cur && CALL.cur.answeredAt, null, { timeout: 30000 }).catch(() => {});
if (!(await page.evaluate(() => !!(CALL.cur && CALL.cur.answeredAt)))) { // 表のグループの探し方が違うとき
  await page.evaluate((id) => { const g = (S.ogroups || []).find((x) => x.id === id); startGroupCall(g, true, undefined, undefined, true); }, og.id);
  await page.waitForFunction(() => CALL.cur && CALL.cur.answeredAt, null, { timeout: 30000 });
}
await page.waitForFunction(() => CALL.cur && CALL.cur.batchDone, null, { timeout: 30000 });
await page.click('#cvCamBtn');
await page.waitForFunction(() => $('cvCam').videoWidth > 0 && document.querySelectorAll('.vSpr').length === 2, null, { timeout: 10000 });
ok(await page.$(`.vSpr[data-vs="${h.id}"].ic`) && await page.$(`.vSpr[data-vs="${a.id}"] img.b`), 'group: sprite + icon for the one without');
await page.click('#cvShutter');
await page.waitForFunction(() => CALL.cur && !CALL.cur.busy && !CALL.cur.batchDone, null, { timeout: 15000 }).catch(() => {});
ok(lastSay && lastSay.photo && lastSay.video, 'group: photo sent');
let talkSeen = false;
for (let i = 0; i < 40 && !talkSeen; i++) { talkSeen = await page.evaluate(() => !!document.querySelector('.vSpr.talk')); await page.waitForTimeout(100); }
ok(talkSeen, 'speaker highlighted');
await page.screenshot({ path: SHOT + 'v-group.png' });
const gr = JSON.parse(DB.raw.prepare("SELECT v FROM kv WHERE k LIKE 'call:%'").get().v);
ok(gr.transcript.some((m) => m.photo && m.seen && m.seen.length === 2), 'group: both saw it');
await page.waitForFunction(() => CALL.cur && CALL.cur.batchDone, null, { timeout: 30000 });
await page.evaluate(() => endGroupCall()); await page.waitForTimeout(500);
ok(await page.evaluate(() => !VID.stream && !Object.keys(VID.st).length), 'camera and sprites cleaned up after the call');
await browser.close();
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
