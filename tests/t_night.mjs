import * as X from './worker.mjs';
let fails = 0; const ok = (c, m) => { if (!c) fails++; console.log(c ? 'ok' : 'FAIL', m); };
const st = { quietEnabled: true, quietStart: 1, quietEnd: 7 };
const c = { perDay: 6, nudgeRate: 50 };
const at = (h) => Date.UTC(2026, 9, 14, (h - 9 + 24) % 24, 30);
const hist = [{ sender: 'char', at: at(12) - 5 * 3600e3 }, { sender: 'me', at: at(12) - 4 * 3600e3 }, { sender: 'char', at: at(12) - 3 * 3600e3 }];
const rate = (h) => { let n = 0; const N = 200000; const h2 = hist.map(m => ({ ...m, at: m.at - at(12) + at(h) })); for (let i = 0; i < N; i++) if (X.decide(c, h2, at(h), at(h), st)) n++; return n / N; };
const day = rate(15), night = rate(3);
console.log('talk per tick day', day.toFixed(5), 'night', night.toFixed(5), 'ratio', (night / day).toFixed(3));
ok(night > 0 && Math.abs(night / day - X.QUIET_RATE) < 0.03, 'night talk ~12% of day');
ok(X.nightNote(at(2)).includes('深夜') && X.nightNote(at(5)).includes('早朝'), 'night note 深夜/早朝');
const perNight = 6 / ((24 - 6) * 60 / 13) * X.QUIET_RATE * (6 * 60 / 13);
console.log('expected night messages per char (perDay 6):', perNight.toFixed(2));
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
{
  const t3 = at(3), t15 = at(15);
  const a = X.deferQuiet(t3 + 600e3, st, 'omote', 0.9, t3);   // night post, night reaction → as-is
  const b = X.deferQuiet(t3 + 600e3, st, 'omote', 0.9, at(23)); // evening post, reaction lands at night → deferred
  console.log(a === t3 + 600e3 ? 'ok' : 'FAIL', 'night post: reactions not deferred');
  console.log(b > t3 + 600e3 ? 'ok' : 'FAIL', 'day post reaction landing at night: still deferred');
}
