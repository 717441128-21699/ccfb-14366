// 冒烟跑:每种战术 x 每个难度各跑一局,确认模拟可完成且无异常
import { createSimulation } from '../src/sim/engine';
import type { Difficulty, TacticId } from '../src/core/types';

const tactics: TacticId[] = [
  'feintEastThenWest', 'feintNorthThenSouth', 'ladderAssault',
  'tunnelBreach', 'waterSabotage', 'allOut',
];
const difficulties: Difficulty[] = ['easy', 'normal', 'hard'];

for (const difficulty of difficulties) {
  for (const tactic of tactics) {
    const sim = createSimulation({ seed: 1234, difficulty, tactic, trace: false });
    const w = sim.run();
    console.log(
      `${difficulty.padEnd(6)} ${tactic.padEnd(22)} -> ${(w.result ?? 'timeout').padEnd(15)} ` +
      `tick=${w.tick} 守军${w.countAlive('defender')} 攻方${w.countAlive('attacker')} ` +
      `进城=${w.attackerEntered} 断水=${w.waterCutTicks}`,
    );
  }
}
