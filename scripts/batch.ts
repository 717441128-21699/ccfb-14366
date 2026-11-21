// 批量模拟:同一招连续多局,统计被打穿率(核心验收 <20%)
import { runBatch, type BatchReport } from '../src/sim/batch';
import type { Difficulty, TacticId } from '../src/core/types';

const tactics: TacticId[] = [
  'feintEastThenWest', 'feintNorthThenSouth', 'ladderAssault',
  'tunnelBreach', 'waterSabotage', 'allOut',
];
const difficulties: Difficulty[] = ['easy', 'normal', 'hard'];
const episodes = Number(process.argv[2] ?? 60);

function print(r: BatchReport, legacy: boolean): void {
  console.log(
    `[${legacy ? '旧if' : '行为树'}] ${r.difficulty.padEnd(6)} ${r.tactic.padEnd(22)} ` +
    `破城${r.broken}/${r.episodes} = ${(r.breakRate * 100).toFixed(1)}%  ` +
    `连续打穿${(r.consecutiveBreakRate * 100).toFixed(1)}%  ` +
    `平均tick=${r.avgTicks.toFixed(0)} 守军存活=${r.avgDefenderAlive.toFixed(1)} 攻方存活=${r.avgAttackerAlive.toFixed(1)}`,
  );
}

for (const difficulty of difficulties) {
  for (const tactic of tactics) {
    print(runBatch({ episodes, difficulty, tactic }), false);
  }
  console.log('');
}
console.log('===== 旧 if-AI 基线(normal) =====');
for (const tactic of tactics) {
  print(runBatch({ episodes, difficulty: 'normal', tactic, legacyDefender: true }), true);
}
