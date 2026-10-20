// サーバー（server/worker.js）のテストをまとめて実行する。
//   node --no-warnings tests/run-all.mjs            … 全部
//   node --no-warnings tests/run-all.mjs t_stamp    … 名前に t_stamp を含むものだけ
// 本物のAI・D1・通知には一切つながない（fake.mjs の偽物を使う）。鍵も不要。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const dir = dirname(fileURLToPath(import.meta.url));
// テストから中の関数を直接呼べるように、export を足した写しを作る（.gitignore 済み）
const EXPORTS = 'planReactions, runTlJobs, deferQuiet, reactDelay, threadRoot, tlContextForTalk, toGeminiSchema, extractMemories, dailyUpdate, lifeDecide, occasionsToday, lifeContext, applyRetracts, decide, shouldCharPost, nightNote, QUIET_RATE, parsePlan, activityAt, replyTiming, runDueReplies, actNorm, actFactor, lateNote, withChanges, schedDue, decideReply, runDisasters, disasterContext, sagaStep, barkEncrypt, sendBark, runDueProactive, nextProactiveSlot, recordCost, costSummary, priceFor, runDuePostscripts, generateAndStore, buildContents, daysToMD, normChar';
writeFileSync(join(dir, 'worker.mjs'), readFileSync(join(dir, '../server/worker.js'), 'utf8') + `\nexport { ${EXPORTS} };\n`);
const only = process.argv[2] || '';
const files = readdirSync(dir).filter((f) => /^t_.*\.mjs$/.test(f) && f.includes(only)).sort();
let bad = 0;
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--no-warnings', join(dir, 'daytime.mjs'), './' + f], { cwd: dir, encoding: 'utf8', timeout: 300e3 });
  const out = (r.stdout || '') + (r.stderr || '');
  const passed = r.status === 0 && out.includes('ALL PASSED') && !/^FAIL|\d+ FAILED/m.test(out);
  if (!passed) bad++;
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${f} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (!passed) console.log(out.split('\n').filter((l) => /FAIL|Error|at /.test(l)).slice(0, 15).map((l) => '     ' + l).join('\n'));
}
console.log(bad ? `${bad}/${files.length} 失敗` : `全${files.length}本 成功`);
process.exit(bad ? 1 : 0);
