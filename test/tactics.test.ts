import { describe, it, expect } from 'vitest';
import { createSimulation } from '../src/sim/engine';
import { buildPlan } from '../src/ai/attacker';
import { tickDefender } from '../src/ai/defender';
import { World } from '../src/sim/world';
import type { TacticId } from '../src/core/types';

describe('攻城战术多步依赖', () => {
  const w = new World({ seed: 3, difficulty: 'normal', maxTicks: 30 });

  it('云梯强攻:登城依赖架梯,架梯依赖掩护到位', () => {
    const plan = buildPlan('ladderAssault', w);
    const byId = new Map(plan.steps.map((s) => [s.id, s]));
    expect(byId.get('ladder')?.dependsOn).toContain('escort');
    expect(byId.get('climb')?.dependsOn).toContain('ladder');
    expect(byId.get('exploit')?.dependsOn).toContain('climb');
  });

  it('地道破墙:涌入依赖塌陷', () => {
    const plan = buildPlan('tunnelBreach', w);
    const byId = new Map(plan.steps.map((s) => [s.id, s]));
    expect(byId.get('pourIn')?.dependsOn).toContain('dig');
  });

  it('断水源:强攻依赖破坏与等待脱水,且依赖链有序', () => {
    const plan = buildPlan('waterSabotage', w);
    const byId = new Map(plan.steps.map((s) => [s.id, s]));
    expect(byId.get('sabotage')?.dependsOn).toContain('march');
    expect(byId.get('waitWeakness')?.dependsOn).toContain('sabotage');
    expect(byId.get('storm')?.dependsOn).toContain('waitWeakness');
  });

  it('每个战术的步骤依赖都指向已存在的步骤', () => {
    for (const t of ['ladderAssault', 'tunnelBreach', 'waterSabotage', 'feintEastThenWest', 'allOut'] as TacticId[]) {
      const plan = buildPlan(t, w);
      const ids = new Set(plan.steps.map((s) => s.id));
      for (const s of plan.steps) {
        for (const dep of s.dependsOn) expect(ids.has(dep)).toBe(true);
      }
    }
  });
});

describe('守城 AI 预备队与佯攻识别', () => {
  it('初始化后保留预备队,且八个扇区都有驻防划分', () => {
    const sim = createSimulation({ seed: 5, difficulty: 'normal', tactic: 'feintEastThenWest' });
    // 必须通过 AI 驱动(决策 tick 才执行初始化叶子),跑到第一个决策周期之后
    for (let i = 0; i < 40; i++) {
      tickDefender(sim.defender, sim.world);
      sim.world.step();
    }
    const bb = sim.defender.bb;
    expect(bb.reserveSquadIds.size).toBeGreaterThan(0);
    expect(bb.garrison.size).toBe(8);
  });
});
