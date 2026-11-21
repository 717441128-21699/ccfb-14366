import type { Difficulty, TacticId } from '../core/types';
import { createSimulation } from './engine';

export interface BatchConfig {
  episodes: number;
  difficulty: Difficulty;
  tactic: TacticId;
  baseSeed?: number;
  legacyDefender?: boolean;
}

export interface BatchReport {
  episodes: number;
  difficulty: Difficulty;
  tactic: TacticId;
  broken: number;
  held: number;
  wiped: number;
  breakRate: number; // 被打穿比例(核心指标,要求 < 0.20)
  avgTicks: number;
  avgDefenderAlive: number;
  avgAttackerAlive: number;
  // 连续两局都被打穿的比例(同一招连续打穿)
  consecutiveBreakRate: number;
  results: { seed: number; result: string; ticks: number; defAlive: number; atkAlive: number }[];
}

export function runBatch(cfg: BatchConfig): BatchReport {
  const results: BatchReport['results'] = [];
  let broken = 0;
  let held = 0;
  let wiped = 0;
  let tickSum = 0;
  let defSum = 0;
  let atkSum = 0;
  const breakFlags: boolean[] = [];

  for (let i = 0; i < cfg.episodes; i++) {
    const seed = (cfg.baseSeed ?? 777) + i * 131;
    const sim = createSimulation({
      seed,
      difficulty: cfg.difficulty,
      tactic: cfg.tactic,
      legacyDefender: cfg.legacyDefender,
      trace: false,
    });
    const world = sim.run();
    const isBroken = world.result === 'city_broken';
    breakFlags.push(isBroken);
    if (isBroken) broken++;
    else if (world.result === 'attacker_wiped') wiped++;
    else held++;
    tickSum += world.tick;
    defSum += world.countAlive('defender');
    atkSum += world.countAlive('attacker');
    results.push({
      seed,
      result: world.result ?? 'timeout',
      ticks: world.tick,
      defAlive: world.countAlive('defender'),
      atkAlive: world.countAlive('attacker'),
    });
  }

  let consecutive = 0;
  for (let i = 1; i < breakFlags.length; i++) {
    if (breakFlags[i] && breakFlags[i - 1]) consecutive++;
  }

  return {
    episodes: cfg.episodes,
    difficulty: cfg.difficulty,
    tactic: cfg.tactic,
    broken,
    held,
    wiped,
    breakRate: broken / cfg.episodes,
    avgTicks: tickSum / cfg.episodes,
    avgDefenderAlive: defSum / cfg.episodes,
    avgAttackerAlive: atkSum / cfg.episodes,
    consecutiveBreakRate: consecutive / Math.max(1, cfg.episodes - 1),
    results,
  };
}
