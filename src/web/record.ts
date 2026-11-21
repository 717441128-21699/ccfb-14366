import { createSimulation, type SimulationHandle } from '../sim/engine';
import { tickDefender } from '../ai/defender';
import { tickAttacker } from '../ai/attacker';
import type { Difficulty, TacticId } from '../core/types';
import type { FrameSnapshot, ReplayPackage } from './replayTypes';

export interface ReplayOptions {
  seed: number;
  difficulty: Difficulty;
  tactic: TacticId;
  maxTicks?: number;
  // 每 N tick 采样一帧(默认 5,控制回放体积)
  sampleEvery?: number;
}

// 跑一局并录制可回放的快照包
export function recordReplay(opts: ReplayOptions): ReplayPackage {
  const sampleEvery = opts.sampleEvery ?? 5;
  const sim: SimulationHandle = createSimulation({
    seed: opts.seed,
    difficulty: opts.difficulty,
    tactic: opts.tactic,
    maxTicks: opts.maxTicks ?? 600,
    trace: true,
  });
  const w = sim.world;
  const frames: FrameSnapshot[] = [];

  const snapshot = (): FrameSnapshot => ({
    tick: w.tick,
    units: w.units.map((u) => ({
      id: u.id, side: u.side, kind: u.kind,
      x: u.x, y: u.y, hp: u.hp, alive: u.alive,
    })),
    ladders: w.ladders.map((l) => ({
      x: l.x, y: l.y, built: l.built, destroyed: l.destroyed, sector: l.sector,
    })),
    tunnels: w.tunnels.map((t) => ({
      sector: t.targetSector, progress: t.progress, collapsed: t.collapsed,
    })),
    waterCut: w.waterCutTicks > 0,
    attackerEntered: w.attackerEntered,
    result: w.result,
    sectorThreat: Array.from(w.influence.sectorThreat.attacker),
  });

  frames.push(snapshot());
  while (!w.result) {
    if (w.tick % w.cfg.decisionInterval === 0) {
      tickDefender(sim.defender, w);
      tickAttacker(sim.attacker, w);
    }
    w.step();
    if (w.tick % sampleEvery === 0) frames.push(snapshot());
  }
  frames.push(snapshot());

  return {
    seed: opts.seed,
    difficulty: opts.difficulty,
    tactic: opts.tactic,
    maxTicks: w.maxTicks,
    mapSize: w.map.size,
    frames,
    traces: w.tracer.entries.map((e) => ({ ...e })),
    events: w.tracer.events.map((e) => ({ ...e })),
    defenderTree: sim.defender.tree.def,
    attackerTree: sim.attacker.tree.def,
    attackerSteps: sim.attacker.plan
      ? sim.attacker.plan.steps.map((s) => ({
        id: s.id, label: s.label, dependsOn: s.dependsOn, state: s.state,
      }))
      : [],
  };
}
