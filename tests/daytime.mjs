// 時計を「今日の日本時間14:00ごろ」にずらしてからテストを読み込む（深夜に走らせても、静かな時間や睡眠の予定で止まらないように）
const file = process.argv[2];
const off = ((14 - new Date(Date.now() + 9 * 3600e3).getUTCHours() + 24) % 24) * 3600e3;
const RN = Date.now; Date.now = () => RN() + off;
const RD = Date; globalThis.Date = class extends RD { constructor(...a) { a.length ? super(...a) : super(RN() + off); } static now() { return RN() + off; } };
await import(new URL(file, import.meta.url).href);
