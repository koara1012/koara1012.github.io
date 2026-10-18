import W from './worker.mjs';
import { makeDB, installFetch, calls } from './fake.mjs';
const DB = makeDB(); installFetch([]);
const env = { DB, APP_TOKEN: 'pw', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' };
const ctx = { waitUntil() {} };
const call = async (m, p, b) => { const r = await W.fetch(new Request('https://w' + p, { method: m, headers: { 'X-App-Token': 'pw' }, body: b ? JSON.stringify(b) : undefined }), env, ctx); return r.json(); };
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
// wrap fetch: Google News RSS + AI answers that pick news
const base = globalThis.fetch; const rssHits = [];
const rss = (kw) => `<?xml version="1.0"?><rss><channel>
<item><title>${kw}の新店が渋谷にオープン &amp; 行列 - テスト新聞</title><pubDate>${new Date(Date.now()-3600e3).toUTCString()}</pubDate><source url="x">テスト新聞</source></item>
<item><title><![CDATA[古いニュース ${kw}]]></title><pubDate>${new Date(Date.now()-10*86400e3).toUTCString()}</pubDate><source url="x">古新聞</source></item>
</channel></rss>`;
let pickNews = 0;
globalThis.fetch = async (u, i) => {
  u = String(u);
  if (u.startsWith('https://news.google.com/')) { const kw = decodeURIComponent(new URL(u).searchParams.get('q')).replace(' when:3d',''); rssHits.push(kw); return new Response(rss(kw)); }
  if (u.includes('generativelanguage') || u.includes('x.ai')) {
    const body = JSON.parse(i.body); const sch = JSON.stringify(u.includes('x.ai') ? body.response_format : body.generationConfig.responseSchema);
    let out = null;
    if (sch.includes('keywords')) out = { keywords: ['ロシア料理', '猫', '天体観測'] };
    else if (sch.includes('used_news')) out = { messages: ['ねえ、ニュースで見たんですけど'], used_news: pickNews };
    if (out) { calls.push({ sys: u.includes('x.ai') ? body.messages[0].content : body.systemInstruction.parts[0].text, sch }); const t = JSON.stringify(out);
      return new Response(JSON.stringify(u.includes('x.ai') ? { choices: [{ message: { content: t } }] } : { candidates: [{ content: { parts: [{ text: t }] } }] })); }
  }
  return base(u, i);
};
const c = (await call('POST', '/char', { char: { name: 'シャロ', prompt: 'ロシア出身。料理と猫と星が好き' } })).char;
await call('POST', '/send', { charId: c.id, text: 'こんにちは' }); await call('POST', '/reply', { charId: c.id });

let r = await call('POST', '/poke', { charId: c.id, news: true });
ok(r.news && r.news.includes('新店が渋谷にオープン & 行列') && !r.news.includes('テスト新聞'), 'news used, title cleaned: ' + r.news);
ok(r.newsCandidates === 3, 'old news (10 days) filtered, 3 fresh candidates');
const sys = calls.filter(x => (x.sch||x.schemaStr||'').includes('used_news')).pop().sys;
ok(sys.includes('話題の候補：ここ数日の実際のニュース') && sys.includes('無理にニュースを使わない') && sys.includes('付け足さない'), 'prompt asks to pick only fitting news');
const kwCalls = calls.filter(x => (x.sch||x.schemaStr||'').includes('keywords')).length;
await call('POST', '/poke', { charId: c.id, news: true });
ok(calls.filter(x => (x.sch||x.schemaStr||'').includes('keywords')).length === kwCalls, 'keywords cached (no second AI call)');
ok(rssHits.length === 3, 'RSS cached for 2h (no refetch): ' + rssHits.length);
r = await call('POST', '/poke', { charId: c.id, news: true });
ok(r.newsCandidates === 1, 'already-used news excluded next time');
pickNews = -1; r = await call('POST', '/poke', { charId: c.id, news: true });
ok(r.news === null && r.messages.length, 'AI can decline news');
// own keywords override
await call('POST', '/char', { char: { ...c, newsKeywords: 'バレエ、紅茶' } });
rssHits.length = 0; pickNews = 0; r = await call('POST', '/poke', { charId: c.id, news: true });
ok(rssHits.every(k => ['バレエ', '紅茶'].includes(k)) && rssHits.length === 2, 'own keywords used: ' + rssHits);
// disabled setting → tick topic never uses news
await call('POST', '/settings', { settings: { newsEnabled: false } });
const st = (await call('GET', '/sync?since=0')).settings;
ok(st.newsEnabled === false, 'setting saved');
// RSS failure is harmless
globalThis.fetch = async (u, i) => String(u).startsWith('https://news.google.com/') ? new Response('', { status: 503 }) : base(u, i);
await call('POST', '/char', { char: { ...c, newsKeywords: '失敗テスト' } });
r = await call('POST', '/poke', { charId: c.id, news: true });
ok(r.messages.length && r.newsCandidates === 0, 'RSS failure falls back to normal topic');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
