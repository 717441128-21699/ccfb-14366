import type { TacticId, Difficulty, Order } from '../core/types';
import { World } from './world';
import {
  buildDefenderTree, createDefenderBB, tickDefender, type DefenderAI,
} from '../ai/defender';
import {
  buildAttackerTree, createAttackerAI, tickAttacker, type AttackerAI,
} from '../ai/attacker';

export interface SimulationOptions {
  seed: number;
  difficulty: Difficulty;
  tactic: TacticId;
  maxTicks?: number;
  // 使用旧版 if 守城 AI(对照基线)
  legacyDefender?: boolean;
  trace?: boolean;
}

export interface SimulationHandle {
  world: World;
  defender: DefenderAI;
  attacker: AttackerAI;
  run(): World;
}

export function createSimulation(opts: SimulationOptions): SimulationHandle {
  const world = new World({
    seed: opts.seed,
    difficulty: opts.difficulty,
    maxTicks: opts.maxTicks ?? 600,
  });
  world.tracer.enabled = opts.trace ?? true;

  const defender: DefenderAI = { tree: buildDefenderTree(world, createDefenderBB()), bb: createDefenderBB() };
  // buildDefenderTree 内部 new 了一块黑板,统一替换为外部这块
  defender.tree = buildDefenderTree(world, defender.bb);

  const attacker = createAttackerAI();
  attacker.tree = buildAttackerTree(world, attacker, opts.tactic);

  if (opts.legacyDefender) {
    return { world, defender, attacker, run: () => runLegacy(world, defender, attacker, opts.tactic) };
  }
  return { world, defender, attacker, run: () => runLoop(world, defender, attacker) };
}

function runLoop(world: World, defender: DefenderAI, attacker: AttackerAI): World {
  while (!world.result) {
    tickDefender(defender, world);
    tickAttacker(attacker, world);
    world.step();
  }
  return world;
}

// ---- 旧版 if 守城 AI:短视反应式,被当前可见威胁牵着走(被同一招打穿的版本) ----
// 典型缺陷:无佯攻识别、无预备队比例、无主攻方向记忆,
// 东门一有动静就全军压上,等主力转到西门时守军还在东门,西门空虚被打穿。
function runLegacy(world: World, defender: DefenderAI, attacker: AttackerAI, tactic: TacticId): World {
  void defender;
  void tactic;
  while (!world.result) {
    tickAttacker(attacker, world);
    if (world.tick % 10 === 0) {
      const summary = world.sectorSummary();
      // 只看当前可见敌人,选人数最多的扇区;看不见就维持上一道命令(不会主动回防)
      const threatened = summary.filter((s) => s.visibleEnemies > 0);
      if (threatened.length > 0) {
        threatened.sort((a, b) => b.visibleEnemies - a.visibleEnemies);
        const targetSector = threatened[0].sector;
        const rally = world.sectorInsideRally(targetSector);
        // 无脑:把所有守军小队全部调过去,预备队清零
        for (const s of world.squads) {
          if (s.side !== 'defender' || s.unitIds.length === 0) continue;
          const order: Order = { type: 'assault', x: rally.x, y: rally.y };
          world.setOrder(s.id, order);
        }
        world.recordEvent({
          side: 'defender', kind: 'legacy_if',
          detail: `旧if-AI:全军压向${targetSector}号扇区(无预备队/无主攻识别)`,
        });
      }
    }
    world.step();
  }
  return world;
}
