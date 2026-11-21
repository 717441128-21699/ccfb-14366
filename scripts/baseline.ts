// 旧 if-AI vs 新行为树 守城对比(同一招重复多局)
import { runBatch } from '../src/sim/batch';
import type { TacticId } from '../src/core/types';

const tactics: TacticId[] = ['feintEastThenWest', 'tunnelBreach', 'allOut'];
const n = Number(process.argv[2] ?? 40);
console.log(`每战术 ${n} 局,难度 normal`);
console.log('战术                    | 旧if-AI 破城率/连续打穿 | 行为树 破城率/连续打穿');
for (const t of tactics) {
  const legacy = runBatch({ episodes: n, difficulty: 'normal', tactic: t, legacyDefender: true });
  const modern = runBatch({ episodes: n, difficulty: 'normal', tactic: t });
  console.log(
    t.padEnd(22),
    `| ${(legacy.breakRate * 100).toFixed(0).padStart(3)}% / ${(legacy.consecutiveBreakRate * 100).toFixed(0).padStart(3)}%`,
    `        | ${(modern.breakRate * 100).toFixed(0).padStart(3)}% / ${(modern.consecutiveBreakRate * 100).toFixed(0).padStart(3)}%`,
  );
}
