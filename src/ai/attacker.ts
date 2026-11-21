import type { Squad, TacticId, Order } from '../core/types';
import { SECTOR_LABELS } from '../core/types';
import { BTBuilder, type BuiltTree, type BTContext } from './bt';
import type { World } from '../sim/world';

// 战术步骤状态机:步骤之间存在显式依赖
export type StepState = 'pending' | 'active' | 'running' | 'done' | 'failed';

export interface TacticStep {
  id: string;
  label: string;
  // 依赖步骤必须全部 done 才能激活
  dependsOn: string[];
  state: StepState;
  // 激活时的 tick(用于持续时间类步骤),惰性初始化
  startedAt?: number;
  // 执行条件判定 + 下令;返回 running/success/failure
  run: (world: World, ai: AttackerAI) => StepState;
}

export interface AttackerPlan {
  tactic: TacticId;
  name: string;
  steps: TacticStep[];
  active: boolean;
}

export interface AttackerAI {
  tree: BuiltTree;
  plan: AttackerPlan | null;
  bb: {
    feintSector: number;
    mainSector: number;
    lastSwitch: number;
    stalledTicks: number;
    log: string[];
  };
}

export function createAttackerAI(): AttackerAI {
  return {
    tree: null as unknown as BuiltTree,
    plan: null,
    bb: { feintSector: 2, mainSector: 6, lastSwitch: -999, stalledTicks: 0, log: [] },
  };
}

function engineerSquads(world: World): Squad[] {
  return world.squads.filter(
    (s) => s.side === 'attacker' && s.unitIds.length > 0
      && world.unitById(s.unitIds[0])?.kind === 'engineer',
  );
}

function meleeSquads(world: World): Squad[] {
  return world.squads.filter((s) => {
    if (s.side !== 'attacker' || s.unitIds.length === 0) return false;
    const k = world.unitById(s.unitIds[0])?.kind;
    return k !== 'engineer';
  });
}

function orderAll(world: World, squads: Squad[], make: (s: Squad) => Order, reason: string): void {
  for (const s of squads) {
    world.setOrder(s.id, make(s));
  }
  if (squads[0]) {
    world.recordEvent({
      side: 'attacker', kind: 'order', detail: `${squads.length} 队执行:${reason}`,
    });
  }
}

// 小队首单位实时位置(用于"是否到位"判定)
function squadPos(world: World, s: Squad | undefined): { x: number; y: number } | null {
  if (!s || s.unitIds.length === 0) return null;
  const u = world.unitById(s.unitIds[0]);
  return u ? { x: u.x, y: u.y } : null;
}

// ---- 战术计划工厂:每个计划的步骤带显式依赖 ----

export function buildPlan(tactic: TacticId, world: World): AttackerPlan {
  const anchor = (sec: number) => world.map.sectorAnchor[sec];
  const steps: TacticStep[] = [];

  const feintStep = (feintSec: number, sustain: number): TacticStep => ({
    id: 'feint', label: `佯攻${SECTOR_LABELS[feintSec]}门牵制`, dependsOn: [], state: 'pending',
    run: (w, ai) => {
      const a = anchor(feintSec);
      const mob = meleeSquads(w).slice(0, Math.ceil(meleeSquads(w).length / 3));
      orderAll(w, mob, () => ({ type: 'assault', x: a.x, y: a.y }), `佯攻${SECTOR_LABELS[feintSec]}`);
      const step = ai.plan!.steps.find((s) => s.id === 'feint')!;
      if (step.startedAt === undefined) step.startedAt = w.tick;
      // 佯攻持续 sustain tick 后视为完成(不真爬墙)
      if (w.tick - step.startedAt >= sustain) return 'done';
      return 'running';
    },
  });

  switch (tactic) {
    case 'feintEastThenWest': {
      steps.push(feintStep(2, 70));
      steps.push({
        id: 'shift', label: '主力转移至西门并破门', dependsOn: ['feint'], state: 'pending',
        run: (w, ai) => {
          // 直接以西门内集结点为目标,部队沿门轴一路接敌破门,不在城外停顿
          const rally = w.sectorInsideRally(ai.bb.mainSector);
          const mob = meleeSquads(w);
          orderAll(w, mob, () => ({ type: 'assault', x: rally.x, y: rally.y }), '主力西移强攻');
          return w.attackerEntered ? 'done' : 'running';
        },
      });
      steps.push(stormStep('mainAssault', ['shift']));
      break;
    }
    case 'feintNorthThenSouth': {
      steps.push(feintStep(0, 70));
      steps.push({
        id: 'shift', label: '主力转移至南门并破门', dependsOn: ['feint'], state: 'pending',
        run: (w) => {
          const rally = w.sectorInsideRally(4);
          const mob = meleeSquads(w);
          orderAll(w, mob, () => ({ type: 'assault', x: rally.x, y: rally.y }), '主力南移强攻');
          return w.attackerEntered ? 'done' : 'running';
        },
      });
      steps.push(stormStep('mainAssault', ['shift']));
      break;
    }
    case 'ladderAssault': {
      steps.push({
        id: 'escort', label: '工兵集结后共同推进到墙基', dependsOn: [], state: 'pending',
        run: (w, ai) => {
          const base = w.sectorWallBase(ai.bb.mainSector);
          const eng = engineerSquads(w);
          orderAll(w, eng, () => ({ type: 'move', x: base.x, y: base.y }), '工兵集结推进');
          // 等过半数工兵小队抵达墙基附近再开工,避免先到的被逐个射杀
          let arrived = 0;
          for (const s of eng) {
            const pos = squadPos(w, s);
            if (pos && Math.hypot(base.x - pos.x, base.y - pos.y) < 6) arrived++;
          }
          if (arrived >= Math.max(1, Math.ceil(eng.length / 2))) return 'done';
          return 'running';
        },
      });
      steps.push({
        id: 'ladder', label: '架设云梯(依赖掩护到位,墙顶火力下作业)', dependsOn: ['escort'], state: 'pending',
        run: (w, ai) => {
          const base = w.sectorWallBase(ai.bb.mainSector);
          // 该扇区维持一个梯子:被毁则由 newLadder 复用重置,不重复创建
          const ladder = w.ladders.find((l) => l.sector === ai.bb.mainSector && !l.destroyed)
            ?? w.newLadder(base.x, base.y, ai.bb.mainSector);
          const eng = engineerSquads(w);
          orderAll(w, eng, () => ({ type: 'buildLadder', x: base.x, y: base.y, targetId: ladder.id }), '架云梯');
          if (ladder.built) return 'done';
          if (eng.every((s) => s.unitIds.length === 0)) return 'failed';
          return 'running';
        },
      });
      steps.push({
        id: 'climb', label: '步兵登城(依赖云梯架设)', dependsOn: ['ladder'], state: 'pending',
        run: (w, ai) => {
          const ladder = w.ladders.find((l) => l.sector === ai.bb.mainSector && l.built);
          if (!ladder) return 'failed';
          const mob = meleeSquads(w).filter((s) => {
            const k = w.unitById(s.unitIds[0])?.kind;
            return k && UNIT_canClimb(k);
          });
          orderAll(w, mob, () => ({ type: 'climb', x: ladder.x, y: ladder.y, targetId: ladder.id }), '登城');
          return w.attackerEntered ? 'done' : 'running';
        },
      });
      steps.push({
        id: 'exploit', label: '突破口扩张(依赖登城成功)', dependsOn: ['climb'], state: 'pending',
        run: (w, ai) => {
          const rally = w.sectorInsideRally(ai.bb.mainSector);
          const mob = meleeSquads(w);
          orderAll(w, mob, () => ({ type: 'assault', x: rally.x, y: rally.y }), '向城内纵深推进');
          return 'running';
        },
      });
      break;
    }
    case 'tunnelBreach': {
      steps.push({
        id: 'dig', label: '工兵墙基挖掘地道(暴露在守军火力下)', dependsOn: [], state: 'pending',
        run: (w, ai) => {
          const base = w.sectorWallBase(ai.bb.mainSector);
          const tunnel = w.tunnels.find((t) => t.targetSector === ai.bb.mainSector)
            ?? w.newTunnel(ai.bb.mainSector);
          const eng = engineerSquads(w);
          orderAll(w, eng, () => ({ type: 'tunnel', x: base.x, y: base.y, targetId: tunnel.id }), '墙基挖地道');
          if (tunnel.collapsed) return 'done';
          if (eng.every((s) => s.unitIds.length === 0)) return 'failed';
          return 'running';
        },
      });
      steps.push({
        id: 'pourIn', label: '主力从缺口涌入(依赖地道塌陷)', dependsOn: ['dig'], state: 'pending',
        run: (w, ai) => {
          const tunnel = w.tunnels.find((t) => t.targetSector === ai.bb.mainSector && t.collapsed);
          if (!tunnel) return 'failed';
          const rally = w.sectorInsideRally(ai.bb.mainSector);
          const mob = meleeSquads(w);
          orderAll(w, mob, () => ({ type: 'assault', x: rally.x, y: rally.y }), '缺口涌入');
          return w.attackerEntered ? 'done' : 'running';
        },
      });
      break;
    }
    case 'waterSabotage': {
      steps.push({
        id: 'march', label: '工兵北上接近渠首', dependsOn: [], state: 'pending',
        run: (w) => {
          const ws = w.map.waterSources[0];
          const eng = engineerSquads(w);
          // 直接以水源邻接格为目标,确保工兵真正贴到渠首
          orderAll(w, eng, () => ({ type: 'move', x: ws.x, y: ws.y - 1 }), '接近水源');
          // 用全部存活工兵的最近距离判定,避免被远处掉队小队卡住
          const engineers = w.units.filter((u) => u.alive && u.side === 'attacker' && u.kind === 'engineer');
          const nearest = engineers.reduce(
            (m, u) => Math.min(m, Math.hypot(ws.x - u.x, ws.y - u.y)),
            Infinity,
          );
          return Number.isFinite(nearest) && nearest < 4 ? 'done' : 'running';
        },
      });
      steps.push({
        id: 'sabotage', label: '破坏渠首断水(依赖接近到位)', dependsOn: ['march'], state: 'pending',
        run: (w) => {
          const ws = w.map.waterSources[0];
          const eng = engineerSquads(w);
          orderAll(w, eng, () => ({ type: 'sabotage', x: ws.x, y: ws.y }), '断水源');
          if (ws.sabotaged) return 'done';
          if (eng.every((s) => s.unitIds.length === 0)) return 'failed';
          return 'running';
        },
      });
      steps.push({
        id: 'waitWeakness', label: '等待守军脱水削弱', dependsOn: ['sabotage'], state: 'pending',
        run: (w) => (w.waterCutTicks >= 80 ? 'done' : 'running'),
      });
      steps.push(stormStep('storm', ['waitWeakness']));
      break;
    }
    case 'allOut': {
      steps.push(stormStep('storm', []));
      break;
    }
  }

  return { tactic, name: TACTIC_NAMES[tactic], steps, active: true };
}

function stormStep(id: string, deps: string[]): TacticStep {
  return {
    id, label: '主力强攻城门/墙段', dependsOn: deps, state: 'pending',
    run: (w, ai) => {
      // 目标点放在城内,攻方会自动找门洞破门而入
      const rally = w.sectorInsideRally(ai.bb.mainSector);
      const mob = meleeSquads(w);
      orderAll(w, mob, () => ({ type: 'assault', x: rally.x, y: rally.y }), '强攻');
      return w.attackerEntered ? 'done' : 'running';
    },
  };
}

function UNIT_canClimb(kind: string): boolean {
  return kind !== 'crossbow' && kind !== 'cavalry';
}

export const TACTIC_NAMES: Record<TacticId, string> = {
  feintEastThenWest: '东门佯攻→西门主攻',
  feintNorthThenSouth: '北门佯攻→南门主攻',
  ladderAssault: '云梯强攻(掩护→架梯→登城)',
  tunnelBreach: '地道破墙(挖掘→塌陷→涌入)',
  waterSabotage: '断水源(接近→破坏→等脱水→强攻)',
  allOut: '全军强攻',
};

// ---- 行为树:计划选择 → 步骤依赖推进 → 卡住切换 ----

export function buildAttackerTree(world: World, ai: AttackerAI, tactic: TacticId): BuiltTree {
  const b = new BTBuilder();
  ai.plan = buildPlan(tactic, world);
  if (tactic === 'feintEastThenWest') {
    ai.bb.feintSector = 2;
    ai.bb.mainSector = 6;
  } else if (tactic === 'feintNorthThenSouth') {
    ai.bb.feintSector = 0;
    ai.bb.mainSector = 4;
  } else {
    ai.bb.mainSector = 6;
    ai.bb.feintSector = 2;
  }

  const selectPlan = b.leaf('选择战术计划', (ctx) => {
    if (!ai.plan || !ai.plan.active) return 'failure';
    ctx.tracer.log({
      tick: ctx.tick, nodeId: 'plan', label: '当前战术', status: 'success',
      evidence: { 战术: ai.plan!.name, 步骤: ai.plan!.steps.filter((s) => s.state === 'active').map((s) => s.label).join('|') || '待启动' },
    });
    return 'success';
  });

  const advanceSteps = b.leaf('按依赖推进战术步骤', (ctx) => {
    const w = ctx.blackboard.world as World;
    const plan = ai.plan!;
    let anyRunning = false;
    for (const step of plan.steps) {
      if (step.state === 'done' || step.state === 'failed') continue;
      const depsOk = step.dependsOn.every((d) => plan.steps.find((s) => s.id === d)?.state === 'done');
      if (!depsOk) continue;
      step.state = 'active';
      const result = step.run(w, ai);
      if (result === 'done') {
        step.state = 'done';
        w.recordEvent({ side: 'attacker', kind: 'step_done', detail: `${plan.name} → ${step.label} 完成` });
      } else if (result === 'failed') {
        step.state = 'failed';
        w.recordEvent({ side: 'attacker', kind: 'step_failed', detail: `${plan.name} → ${step.label} 失败` });
      } else {
        anyRunning = true;
      }
    }
    const allDone = plan.steps.every((s) => s.state === 'done');
    const hardFailed = plan.steps.some((s) => s.state === 'failed')
      && !plan.steps.some((s) => s.state === 'active' || s.state === 'pending');
    if (allDone) {
      plan.active = false;
      return 'success';
    }
    if (hardFailed) return 'failure';
    return anyRunning ? 'running' : 'running';
  }, undefined, '每个步骤声明 dependsOn,前置步骤未完成不会激活');

  const detectStall = b.leaf('检测推进停滞', (ctx) => {
    const w = ctx.blackboard.world as World;
    // 120 tick 没有步骤完成且伤亡在增加 → 停滞
    const recentDone = w.tracer.events.some(
      (e) => e.side === 'attacker' && e.kind === 'step_done' && w.tick - e.tick < 120,
    );
    if (recentDone) {
      ai.bb.stalledTicks = 0;
      return 'failure';
    }
    ai.bb.stalledTicks += ctx.cfg.decisionInterval;
    if (ai.bb.stalledTicks < 120) return 'failure';
    ctx.tracer.log({
      tick: ctx.tick, nodeId: 'stall', label: '战术停滞', status: 'success',
      evidence: { 停滞tick: ai.bb.stalledTicks },
    });
    return 'success';
  });

  const fallback = b.leaf('停滞兜底:转全军强攻另一扇区', (ctx) => {
    const w = ctx.blackboard.world as World;
    ai.bb.stalledTicks = 0;
    ai.bb.mainSector = (ai.bb.mainSector + 4) % 8;
    const fallbackPlan = buildPlan('allOut', w);
    fallbackPlan.steps.forEach((s) => (s.state = 'active'));
    ai.plan = fallbackPlan;
    w.recordEvent({
      side: 'attacker', kind: 'plan_switch',
      detail: `原战术停滞,转${TACTIC_NAMES.allOut}于${SECTOR_LABELS[ai.bb.mainSector]}`,
    });
    return 'success';
  });

  const root = b.root('攻城AI行为树',
    b.sequence('攻城决策循环', [
      selectPlan,
      b.selector('执行与容错', [
        b.sequence('正常推进', [advanceSteps]),
        b.sequence('停滞处理', [detectStall, fallback]),
      ]),
    ]));
  void world;
  return root;
}

export function tickAttacker(ai: AttackerAI, world: World): void {
  if (world.tick % world.cfg.decisionInterval !== 0) return;
  const ctx: BTContext = {
    tick: world.tick,
    difficulty: world.difficulty,
    cfg: world.cfg,
    blackboard: { world, ai },
    tracer: world.tracer,
    act: () => 'success',
    sense: () => 0,
  };
  ai.tree.root.tick(ctx);
}
