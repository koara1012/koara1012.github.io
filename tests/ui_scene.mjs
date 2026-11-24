// 画面の確かめ（Playwright）。run-all には入らない。使い方：node --no-warnings tests/run-all.mjs t_video（worker.mjs を作る）のあと、tests で node --no-warnings ui_scene.mjs
// 第81版の画面の確かめ：本物のアプリ（chat/index.html）を Chromium で開き、サーバーは worker を同じプロセスで動かす（AI と声は偽物）
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const require = createRequire(REPO + '/tests/');
const { chromium } = require('playwright');
const W = (await import(REPO + '/tests/worker.mjs')).default;
const { makeDB } = await import(REPO + '/tests/fake.mjs');
const DB = makeDB();
const env = { DB, APP_TOKEN: 'pw', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' };
const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
let ramN = 0;
globalThis.fetch = async (u, i) => {
  u = String(u);
  if (!u.includes('googleapis') && !u.includes('x.ai')) return new Response('{}');
  const body = JSON.parse(i.body); const grok = u.includes('x.ai');
  const sch = JSON.stringify(grok ? body.response_format : body.generationConfig.responseSchema);
  let out;
  if (sch.includes('wait_user')) out = { lines: [{ speaker: 'アカリ', text: 'ねえ、今日はね、すごく長い話があるんだけど、ちゃんと聞いてくれる？' }, { speaker: 'アカリ', text: 'うん、だからね、続けて話すけど、全部聞いてね。' }], wait_user: true, ...(sch.includes('ramble') ? { ramble: [{ speaker: 'トリビア', text: 'カタツムリの歯は一万本以上あるらしくて' }, { speaker: 'トリビア', text: 'しかも生え変わるんだって' }, { speaker: 'ウラ', text: '昔のゲーム機はね' }] } : {}) };
  else if (sch.includes('"ramble"')) out = { ramble: ['続きの豆知識その' + (++ramN), 'さらに続き'] };
  else if (sch.includes('"members"')) out = { members: [] };
  else if (sch.includes('"after"')) out = { answer: true, reason: '', after: 'none', line: '' };
  else if (sch.includes('"hangup"')) out = { messages: ['……うん、雨宿りだね。'], hangup: false, ...(sch.includes('"wake"') ? { wake: '' } : {}) };
  else if (sch.includes('"summary"')) out = { summary: '雨宿りの話をした。' };
  else out = { messages: ['うん'] };
  return new Response(JSON.stringify(grok ? { choices: [{ message: { content: JSON.stringify(out) } }] } : { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
};
const wapi = async (m, p, b) => { const r = await W.fetch(new Request('https://api.test' + p, { method: m, headers: { 'X-App-Token': 'pw' }, body: b ? JSON.stringify(b) : undefined }), env, ctx); while (waits.length) await waits.shift(); return r.json(); };
await wapi('POST', '/settings', { settings: { delayEnabled: false, lifeEnabled: false, quietEnabled: false } });
const a = (await wapi('POST', '/char', { char: { name: '朱里', uraName: 'アカリ', prompt: '表', voice: 'akari' } })).char;
const u = (await wapi('POST', '/char', { char: { name: 'ウラ', prompt: 'p', uraOnly: true, voice: 'ura' } })).char;
const t = (await wapi('POST', '/char', { char: { name: 'トリビア', prompt: '豆知識', uraOnly: true, voice: 'tri' } })).char;
const g = (await wapi('POST', '/group', { group: { name: '屋上組', members: [a.id, u.id, t.id] } })).group;
await wapi('POST', '/send', { charId: a.id, text: 'やあ' });

function wav(sec) { // 無音に近い小さな音の WAV
  const sr = 8000, n = Math.round(sr * sec), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(200 * Math.sin(i / 5)), 44 + i * 2);
  return b;
}
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => { fails++; console.log('PAGE ERROR', e.message); });
const ttsLog = [];
await page.route('https://app.test/**', (r) => { const p = new URL(r.request().url()).pathname; try { r.fulfill({ body: readFileSync(REPO + p), contentType: p.endsWith('.html') ? 'text/html' : p.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' }); } catch (_) { r.fulfill({ status: 404, body: '' }); } });
await page.route('https://tts.test/**', async (r) => {
  const req = r.request();
  if (req.url().includes('/health')) return r.fulfill({ body: '{"ok":true}' });
  const b = JSON.parse(req.postData() || '{}'); ttsLog.push(b.voice + ':' + b.input);
  await new Promise((res) => setTimeout(res, 150));
  r.fulfill({ body: wav(Math.min(2.5, 0.5 + b.input.length * 0.05)), contentType: 'audio/wav' });
});
await page.route('https://api.test/**', async (r) => {
  const req = r.request();
  const res = await W.fetch(new Request(req.url(), { method: req.method(), headers: { 'X-App-Token': 'pw', 'Content-Type': 'application/json' }, body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData() }), env, ctx);
  while (waits.length) await waits.shift();
  r.fulfill({ status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
});
await page.addInitScript(() => { localStorage.setItem('chat.cfg', JSON.stringify({ url: 'https://api.test', token: 'pw' })); localStorage.setItem('novel.settings', JSON.stringify({ ttsUrl: 'https://tts.test' })); });
await page.goto('https://app.test/chat/index.html');
await page.waitForFunction(() => window.S && S.synced, null, { timeout: 15000 }).catch(() => {});
ok(await page.evaluate(() => /^第\d+版/.test(APP_VERSION)), 'version 81');

// ---- グループの設定：しゃべり続ける子
await page.evaluate((id) => openGroupEdit(id), g.id);
const rows = await page.$$eval('#grRamblers .rmb', (os) => os.map((o) => o.textContent));
ok(rows.length === 3, 'a row per voiced member (' + rows.join(',') + ')');
const rowT = `#grRamblers .rmb[data-id="${t.id}"]`, rowU = `#grRamblers .rmb[data-id="${u.id}"]`;
ok(await page.isHidden(rowT + ' textarea'), 'topic hidden until chosen');
await page.check(rowT + ' input'); await page.check(rowU + ' input');
ok(await page.isVisible(rowT + ' textarea'), 'topic shown when chosen');
await page.fill(rowT + ' textarea', '生き物の豆知識'); await page.fill(rowU + ' textarea', '昔のゲームの話');
await page.screenshot({ path: (process.env.SHOT_DIR || '/tmp') + '/e2e-edit.png', fullPage: true });
await page.click('#grSave');
await page.waitForTimeout(500);
const g2 = (await wapi('GET', '/sync?since=0')).groups.find((x) => x.id === g.id);
ok(g2.ramblers.length === 2 && g2.ramblers.find((x) => x.id === u.id).topic === '昔のゲームの話', 'saved to the server');
await page.evaluate((id) => openGroupEdit(id), g.id);
ok(await page.isChecked(rowU + ' input') && await page.inputValue(rowT + ' textarea') === '生き物の豆知識', 'editor reloads the choices');
await page.evaluate((id) => openChat(id, 'ura'), g.id);
await page.screenshot({ path: (process.env.SHOT_DIR || '/tmp') + '/e2e-chat.png' });

// ---- 裏のグループ通話
await page.evaluate((id) => { startGroupCall(groupById(id), true, undefined, undefined, true); }, g.id);
await page.waitForFunction(() => CALL.cur && CALL.cur.answeredAt, null, { timeout: 30000 });
ok((await page.evaluate(() => CALL.cur.ramblers)).length === 2, 'client knows the ramblers');
let overlap = false, rambSub = false;
for (let i = 0; i < 80 && !overlap; i++) { // ふつうに話す子（アカリ）の声と、しゃべり続ける子2人の声が同時に鳴っているか
  const st = await page.evaluate(() => ({ both: !!(voiceSrc && rambling() >= 2), sub: !!document.querySelector('#cvSub .ramb') }));
  overlap = st.both; rambSub = rambSub || st.sub;
  await page.waitForTimeout(100);
}
ok(overlap, 'rambler voice overlaps the others');
ok(rambSub || await page.$('#cvSub .ramb'), 'ramble subtitle in its own color');
await page.screenshot({ path: (process.env.SHOT_DIR || '/tmp') + '/e2e-gcall.png' });
await page.waitForFunction(() => CALL.cur && CALL.cur.batchDone, null, { timeout: 30000 });
await page.waitForTimeout(400);
ok(await page.evaluate(() => !rambling() && !Object.values(RMB.p).some((P) => P.on)), 'ramblers stop when nobody else talks');
ok(ttsLog.some((x) => x.startsWith('tri:')) && ttsLog.some((x) => x.startsWith('ura:続き')), 'each rambler uses its own voice');
// 状況
ok(await page.isVisible('#cvSceneBtn'), 'scene button shown');
await page.click('#cvSceneBtn');
ok(await page.isVisible('#cvSceneRow'), 'scene editor opens');
await page.screenshot({ path: (process.env.SHOT_DIR || '/tmp') + '/e2e-editor.png' });
{ const bb = await page.$eval('#cvEnd', (e) => { const r = e.getBoundingClientRect(); return r.bottom; }); ok(bb <= 667, 'end button still on screen with the editor open (' + Math.round(bb) + ')'); }
ok(await page.evaluate(() => CALL.cur.typing === true), 'typing pauses listening');
await page.fill('#cvSceneText', 'みんなで雨宿りしている');
await page.click('#cvSceneSend');
await page.waitForTimeout(300);
ok((await page.textContent('#cvScene')).includes('雨宿り') && await page.isVisible('#cvScene'), 'scene shown on the call screen');
ok(await page.$('#cvSub .scene'), 'scene line in subtitles');
await page.waitForFunction(() => CALL.cur && !CALL.cur.busy && CALL.cur.batchDone, null, { timeout: 30000 });
const live = await wapi('GET', '/call?id=' + (await page.evaluate(() => CALL.cur.id)));
ok(live.call.scene === 'みんなで雨宿りしている', 'server has the scene');
await page.screenshot({ path: (process.env.SHOT_DIR || '/tmp') + '/e2e-scene.png' });
// 書き直し（エディタに今の状況が入っている）・消す
await page.click('#cvScene');
ok(await page.inputValue('#cvSceneText') === 'みんなで雨宿りしている' && await page.isVisible('#cvSceneClear'), 'editor prefilled; clear available');
await page.click('#cvSceneClear');
await page.waitForTimeout(400);
ok(await page.isHidden('#cvScene'), 'cleared');
ok((await wapi('GET', '/call?id=' + (await page.evaluate(() => CALL.cur.id)))).call.scene === undefined, 'server cleared');
await page.click('#cvSceneBtn'); await page.fill('#cvSceneText', '雷が鳴り始めた'); await page.click('#cvSceneSend');
await page.waitForFunction(() => CALL.cur && !CALL.cur.busy && CALL.cur.batchDone, null, { timeout: 30000 });
await page.click('#cvEnd');
await page.waitForTimeout(800);
const sy = await wapi('GET', '/sync?since=0');
const rec = sy.messages.filter((x) => x.kind === 'callog').at(-1);
ok(rec && rec.meta.scenes && rec.meta.scenes.includes('雷が鳴り始めた'), 'group record keeps scenes');
ok(!DB.raw.prepare("SELECT 1 FROM kv WHERE k LIKE 'gramble:%'").get(), 'ramble log cleaned');
const html = await page.evaluate(() => document.body.innerHTML);
ok(html.includes('📝 状況：みんなで雨宿りしている → 雷が鳴り始めた'), 'record bubble shows the scenes');
await page.screenshot({ path: (process.env.SHOT_DIR || '/tmp') + '/e2e-record.png' });

// ---- 表の1対1：状況
await page.evaluate((id) => { setWorld && setWorld('omote'); }, a.id).catch(() => {});
await page.evaluate((id) => startOutgoing(charById(id), true), a.id);
await page.waitForFunction(() => CALL.cur && CALL.cur.answeredAt && !CALL.cur.speaking, null, { timeout: 30000 });
await page.click('#cvSceneBtn'); await page.fill('#cvSceneText', '駅のホームで電車を待っている'); await page.click('#cvSceneSend');
await page.waitForTimeout(300);
ok((await page.textContent('#cvSub')).includes('📝 状況：駅のホーム'), '1:1 scene subtitle');
await page.waitForFunction(() => CALL.cur && !CALL.cur.busy && !CALL.cur.speaking, null, { timeout: 30000 });
ok((await page.textContent('#cvSub')).includes('雨宿りだね'), '1:1 reply after the scene');
await page.screenshot({ path: (process.env.SHOT_DIR || '/tmp') + '/e2e-1to1.png' });
await page.click('#cvEnd'); await page.waitForTimeout(500);
// 裏のグループの🌙：寝落ち通話になる（第81版で直したところ）
await page.evaluate((id) => startGroupCall(groupById(id), false, undefined, undefined, true, { sleep: true, keep: true }), g.id);
await page.waitForFunction(() => CALL.cur && CALL.cur.answeredAt, null, { timeout: 30000 });
const sc = await wapi('GET', '/call?id=' + (await page.evaluate(() => CALL.cur.id)));
ok(await page.evaluate(() => !!CALL.cur.sleep), 'ura group 🌙 is a sleep call now');
await page.evaluate(() => endGroupCall()); await page.waitForTimeout(500);
await browser.close();
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
