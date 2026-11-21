import { describe, it, expect } from 'vitest';
import { runBatch } from '../src/sim/batch';
import { World } from '../src/sim/world';
import type { Difficulty, TacticId } from '../src/core/types';

// 核心验收:同一招连续打穿概率 < 20%(在普通与困难档)
describe('守城 AI 抗打穿(硬指标 <20%)', () => {
  const tactics: TacticId[] = [
    'feintEastThenWest', 'feintNorthThenSouth', 'ladderAssault',
    'tunnelBreach', 'waterSabotage', 'allOut',
  ];
  const levels: Difficulty[] = ['normal', 'hard'];

  for (const difficulty of levels) {
    for (const tactic of tactics) {
      it(`${difficulty} 档应对「${tactic}」连续打穿率 < 20%`, () => {
        const r = runBatch({ episodes: 20, difficulty, tactic });
        expect(r.consecutiveBreakRate).toBeLessThan(0.2);
      });
    }
  }
});

describe('难度只靠信息/反应,不加兵', () => {
  it('三档双方初始兵力完全一致', () => {
    const counts = new Map<string, number>();
    for (const d of ['easy', 'normal', 'hard'] as Difficulty[]) {
      const w = new World({ seed: 7, difficulty: d, maxTicks: 10 });
      counts.set(d, w.units.length);
    }
    expect(counts.get('easy')).toBe(counts.get('normal'));
    expect(counts.get('normal')).toBe(counts.get('hard'));
  });
});
