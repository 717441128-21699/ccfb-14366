import { runBatch } from '../src/sim/batch';
import type { Difficulty, TacticId } from '../src/core/types';

const tactics: TacticId[] = ['feintEastThenWest', 'ladderAssault', 'tunnelBreach', 'waterSabotage', 'allOut'];
const n = Number(process.argv[2] ?? 20);
for (const d of ['easy', 'normal', 'hard'] as Difficulty[]) {
  for (const t of tactics) {
    const r = runBatch({ episodes: n, difficulty: d, tactic: t });
    console.log(
      d.padEnd(6), t.padEnd(20),
      '破城', String(r.broken).padStart(2), `/${n} =`, (r.breakRate * 100).toFixed(0) + '%',
      ' 连续打穿', (r.consecutiveBreakRate * 100).toFixed(0) + '%',
      ' 守军', r.avgDefenderAlive.toFixed(0), '攻方', r.avgAttackerAlive.toFixed(0),
    );
  }
  console.log('');
}
