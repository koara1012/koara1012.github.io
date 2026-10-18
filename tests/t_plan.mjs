import * as X from './worker.mjs';
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
const day = '2026-10-16';
const raw = [
  { start: '07:30', end: '08:10', act: '身支度', kind: 'chores', avail: 40 },
  { start: '08:30', end: '12:00', act: '訓練', kind: 'busy', avail: 10 },
  { start: '12:00', end: '13:00', act: 'お昼ごはん', kind: 'meal', avail: 50 },
  { start: '13:00', end: '18:00', act: '自由時間', kind: 'free', avail: 85 },
  { start: '18:00', end: '19:00', act: '夕ごはんを作る', kind: 'chores', avail: 35 },
  { start: '21:00', end: '21:40', act: 'お風呂', kind: 'bath', avail: 5 },
  { start: '21:40', end: '23:50', act: 'ベッドで紅茶', kind: 'free', avail: 90 },
  { start: '23:50', end: '07:20', act: '眠っている', kind: 'sleep', avail: 0 },
];
const plan = X.parsePlan(raw, day);
const J = (h, m = 0) => Date.parse(`${day}T00:00:00+09:00`) + (h * 60 + m) * 60e3;
const hm = (t) => new Date(t + 9 * 3600e3).toISOString().slice(11, 16);
console.log(plan.blocks.map(b => `${hm(b.s)}-${hm(b.e)} ${b.kind}:${b.act}`).join('\n'));
ok(plan.blocks[0].kind === 'sleep' && plan.blocks[0].e === J(7, 30), 'morning sleep prepended');
ok(plan.blocks.some(b => b.act === 'ひと息ついている' && b.s === J(8, 10)), 'gap filled');
const last = plan.blocks[plan.blocks.length - 1];
ok(last.kind === 'sleep' && last.s === J(23, 50) && last.e === J(31, 20), 'night sleep crosses midnight');
// "01:00" written after 23:00 → next day
const p2 = X.parsePlan([{ start: '22:00', end: '23:00', act: 'a', kind: 'free', avail: 80 }, { start: '01:00', end: '08:00', act: 's', kind: 'sleep', avail: 0 }], day);
ok(p2.blocks.find(b => b.act === 's').s === J(25), '01:00 after 22:00 read as next day');
const state = { plan };
const at = (h, m) => X.activityAt(state, J(h, m), 'x');
ok(at(21, 20).kind === 'bath' && at(3 + 24, 0).kind === 'sleep' && at(14, 0).kind === 'free', 'activityAt');
ok(X.activityAt({}, J(21, 30)).kind === 'bath', 'default plan without data');

// reply timing statistics
const c = { id: 'x', replySpeed: 'auto' }, rh = { speed: 'normal', nightOwl: 30, napper: 30 };
const hist = [{ sender: 'char', at: J(0) - 3600e3 }, { sender: 'me', at: 0 }];
function stats(h, m, N = 4000, cc = c, r = rh) {
  let now = 0, read = [], rep = [], glance = 0, twice = 0;
  for (let i = 0; i < N; i++) {
    const t = J(h, m); const res = X.replyTiming(cc, r, state, hist.map(x => ({ ...x, at: x.sender === 'me' ? t : x.at })), t);
    if (res.now) { now++; continue; }
    read.push((res.readAt - t) / 60e3); rep.push((res.replyAt - t) / 60e3); if (res.glanced) glance++; if (res.twice) twice++;
  }
  const med = (a) => a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(0) : '-';
  return { now: (now / N * 100).toFixed(0) + '%', readMed: med(read), replyMed: med(rep), glance: (glance / N * 100).toFixed(0) + '%', twice: (twice / N * 100).toFixed(0) + '%' };
}
const rows = { '14:00 自由時間': stats(14, 0), '12:30 昼食': stats(12, 30), '10:00 訓練(残り2h)': stats(10, 0), '21:10 お風呂': stats(21, 10), '03:00 睡眠': stats(27, 0), '06:30 起床前': stats(30, 30), '23:55 寝入り': stats(23, 55) };
console.table(rows);
ok(parseFloat(rows['14:00 自由時間'].now) > 40, 'free time mostly immediate');
ok(parseFloat(rows['21:10 お風呂'].now) < 5 && +rows['21:10 お風呂'].replyMed >= 30, 'bath: replies after bath');
ok(parseFloat(rows['03:00 睡眠'].now) < 15 && +rows['03:00 睡眠'].replyMed > 200, 'sleep: mostly morning');
ok(parseFloat(rows['06:30 起床前'].twice) > 10, 'twice-sleep happens near wake');
const fast = stats(12, 30, 4000, { ...c, replySpeed: 'fast' }), slow = stats(12, 30, 4000, { ...c, replySpeed: 'slow' });
console.log('meal fast', fast, 'slow', slow);
ok(+fast.replyMed < +slow.replyMed, 'fast replies sooner than slow');
// momentum
const live = [{ sender: 'char', at: J(12, 28) }, { sender: 'me', at: J(12, 30) }];
let n = 0; for (let i = 0; i < 2000; i++) if (X.replyTiming(c, rh, state, live, J(12, 30)).now) n++;
ok(n / 2000 > 0.8, 'ongoing conversation → mostly immediate (' + (n / 20).toFixed(0) + '%)');
// proactive normalization
const st = { quietEnabled: true, quietStart: 1, quietEnd: 7 };
const norm = X.actNorm(state, st, 'x', J(12));
let sum = 0, cnt = 0;
for (let t = J(0); t < J(24); t += 15 * 60e3) { if (t >= J(1) && t < J(7)) continue; sum += X.actFactor(X.activityAt(state, t, 'x'), t) / norm; cnt++; }
ok(Math.abs(sum / cnt - 1) < 0.01, 'normalized factor averages 1 over active hours');
console.log('factor: 14:00', (X.actFactor(at(14, 0), J(14)) / norm).toFixed(2), '13:05 (just after lunch)', (X.actFactor(at(13, 5), J(13, 5)) / norm).toFixed(2), '10:00 訓練', (X.actFactor(at(10, 0), J(10)) / norm).toFixed(2), '21:20 bath', (X.actFactor(at(21, 20), J(21, 20)) / norm).toFixed(2));
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
