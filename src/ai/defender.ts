import type { Squad, Unit, Order } from '../core/types';
import { SECTOR_LABELS } from '../core/types';
import { UNIT_SPECS } from '../core/roster';
import { BTBuilder, type BuiltTree, type BTContext } from './bt';
import type { World } from '../sim/world';
import { WALL_INNER } from '../core/mapgen';

// 守城 AI 黑板
export interface DefenderBB {
  // 每个扇区的敌情持续观测计数
  observed: Int32Array;
  // 每个扇区当前判定的威胁等级 0..1
  threatLevel: Float32Array;
  // 被标记为佯攻的扇区
  feintSectors: Set<number>;
  // 主攻扇区(承诺度最高且过阈值)
  mainSector: number;
  // 预备队小队 id
  reserveSquadIds: Set<number>;
  // 各扇区驻防小队 id
  garrison: Map<number, number[]>;
  // 最近一次调兵 tick
  lastRedeploy: number;
  // 首次发现各扇区突破的 tick
  breachNoticedAt: Int32Array;
  // 连续被同一招打穿的统计由外部 batch 模块处理
  decisionLog: string[];
}

export function createDefenderBB(): DefenderBB {
  return {
    observed: new Int32Array(8),
    threatLevel: new Float32Array(8),
    feintSectors: new Set(),
    mainSector: -1,
    reserveSquadIds: new Set(),
    garrison: new Map(),
    lastRedeploy: -999,
    breachNoticedAt: new Int32Array(8).fill(-1),
    decisionLog: [],
  };
}

export interface DefenderAI {
  tree: BuiltTree;
  bb: DefenderBB;
}

// 小队当前总战力(满血加权)
function squadPower(world: World, s: Squad): number {
  let p = 0;
  for (const id of s.unitIds) {
    const u = world.unitById(id);
    if (u && u.alive) p += (u.hp / UNIT_SPECS[u.kind].maxHp) * UNIT_SPECS[u.kind].cost;
  }
  return p;
}

function totalMobilePower(world: World): number {
  let p = 0;
  for (const s of world.squads) {
    if (s.side !== 'defender') continue;
    p += squadPower(world, s);
  }
  return p;
}

function reservePower(world: World, bb: DefenderBB): number {
  let p = 0;
  for (const id of bb.reserveSquadIds) {
    const s = world.squadById(id);
    if (s) p += squadPower(world, s);
  }
  return p;
}

// 给小队下令并记录事件
function issue(world: World, squad: Squad, order: Order, reason: string): void {
  world.setOrder(squad.id, order);
  world.recordEvent({
    side: 'defender', kind: 'redeploy',
    detail: `${squad.name} → ${order.type} (${reason})`,
    data: { squad: squad.name, x: Math.round(order.x), y: Math.round(order.y) },
  });
}

// 扇区墙内集结点
function sectorRally(world: World, sector: number): { x: number; y: number } {
  const a = world.map.sectorAnchor[sector];
  const c = 127;
  // 从墙外锚点向城心推进到墙内
  const ang = Math.atan2(c - a.y, c - a.x);
  return { x: a.x + Math.cos(ang) * (WALL_INNER - 4 + 12), y: a.y + Math.sin(ang) * (WALL_INNER - 4 + 12) };
}

export function buildDefenderTree(world: World, bb: DefenderBB): BuiltTree {
  const b = new BTBuilder();

  // 初始化驻防/预备队划分(只跑一次)
  const init = b.leaf('初始化驻防与预备队', (ctx) => {
    const w = ctx.blackboard.world as World;
    if (bb.garrison.size > 0) return 'success';
    const defSquads = w.squads.filter((s) => s.side === 'defender' && s.unitIds.length > 0);
    // 骑兵 + 半数精锐卫队作为预备队(机动力量)
    defSquads.forEach((s, i) => {
      const kinds = s.unitIds.map((id) => w.unitById(id)?.kind).filter(Boolean) as Unit['kind'][];
      const isMobile = kinds.every((k) => k === 'cavalry' || k === 'guard');
      if (isMobile && (kinds[0] === 'cavalry' || i % 3 === 0)) {
        bb.reserveSquadIds.add(s.id);
      }
    });
    // 其余按起始方位摊到 8 个扇区
    const garrisonSquads = defSquads.filter((s) => !bb.reserveSquadIds.has(s.id));
    for (let s = 0; s < 8; s++) bb.garrison.set(s, []);
    garrisonSquads.forEach((s) => {
      const u = w.unitById(s.unitIds[0]);
      if (!u) return;
      const sec = w.nearestSectorOf(u.x, u.y);
      bb.garrison.get(sec)!.push(s.id);
    });
    bb.decisionLog.push(`预备队 ${bb.reserveSquadIds.size} 队,驻防 ${garrisonSquads.length} 队`);
    return 'success';
  });

  // 感知:更新各扇区观测计数与威胁等级
  const perceive = b.leaf('更新扇区敌情与威胁等级', (ctx) => {
    const w = ctx.blackboard.world as World;
    const summary = w.sectorSummary();
    let totalThreat = 0;
    for (const row of summary) {
      if (row.visibleEnemies > 0) {
        bb.observed[row.sector] = Math.min(9999, bb.observed[row.sector] + 1);
      } else {
        bb.observed[row.sector] = Math.max(0, bb.observed[row.sector] - 2);
      }
      // 威胁 = 可见兵力 + 城墙损坏 + 工程兵活动
      const wallDanger = (1 - row.wallRatio) * 3;
      const engineerDanger = row.engineers * 1.5;
      const level = Math.min(1, row.visibleEnemies / 14 + wallDanger + engineerDanger);
      bb.threatLevel[row.sector] = level;
      totalThreat += row.visibleEnemies;
    }
    ctx.blackboard.totalThreat = totalThreat;
    return 'success';
  }, undefined, '综合影响力地图 sectorThreat、城墙完整度与工程兵活动');

  // 佯攻判定
  const detectFeint = b.leaf('佯攻识别与主攻扇区判定', (ctx) => {
    const cfg = ctx.cfg;
    const w = ctx.blackboard.world as World;
    bb.feintSectors.clear();
    let bestSector = -1;
    let bestCommit = 0;
    const totalAtk = w.aliveUnits('attacker').length || 1;
    for (let s = 0; s < 8; s++) {
      const row = w.sectorSummary()[s];
      const commit = row.visibleEnemies / totalAtk;
      // 规则1:敌情持续观测不足 confirmTicks,且兵力承诺低于阈值 → 疑似佯攻
      const fleeting = bb.observed[s] < cfg.confirmTicks && commit < cfg.commitThreshold;
      // 规则2:被观测到一段时间后敌人不增反减(持续度低于 feintSustainTicks 所需)
      const unsustained = bb.observed[s] > 0 && bb.observed[s] < cfg.feintSustainTicks
        && commit < cfg.commitThreshold * 0.7;
      if (fleeting || unsustained) bb.feintSectors.add(s);
      if (commit > bestCommit && !bb.feintSectors.has(s)) {
        bestCommit = commit;
        bestSector = s;
      }
    }
    bb.mainSector = bestSector;
    ctx.tracer.log({
      tick: ctx.tick, nodeId: 'feint', label: '佯攻识别', status: 'success',
      evidence: {
        主攻扇区: bestSector >= 0 ? SECTOR_LABELS[bestSector] : '无',
        佯攻扇区: [...bb.feintSectors].map((s) => SECTOR_LABELS[s]).join(',') || '无',
        最高承诺: Number(bestCommit.toFixed(2)),
      },
    });
    return 'success';
  }, undefined, '承诺兵力占比 + 持续观测时间双条件,避免被单点佯攻牵走主力');

  // 突破应急:受难度门控——简单档感知延迟 confirmTicks 才确认突破,且投入兵力更少
  const handleBreach = b.leaf('突破应急响应(难度门控)', (ctx) => {
    const w = ctx.blackboard.world as World;
    const cfg = ctx.cfg;
    // 各难度单次最多投入的封堵小队数(靠反应/信息差区分,不靠兵力数值)
    const maxCommit = ctx.difficulty === 'hard' ? 4 : ctx.difficulty === 'normal' ? 3 : 2;
    const breached = w.sectorSummary().filter((r) => r.breached);
    if (breached.length === 0) return 'failure';
    // 选最新突破的扇区(以 sectorBreachedAt 为准),而不是敌人最多的扇区,避免被余兵误导
    const target = breached
      .map((r) => ({ r, at: w.sectorBreachedAt[r.sector] }))
      .sort((a, b2) => b2.at - a.at)[0].r;
    // 记录首次发现该扇区突破的 tick,简单档要等更久才"确认"
    if (bb.breachNoticedAt[target.sector] < 0) bb.breachNoticedAt[target.sector] = ctx.tick;
    if (ctx.tick - bb.breachNoticedAt[target.sector] < cfg.confirmTicks) {
      return 'running'; // 还在"确认情报",反应慢的档位按兵不动
    }
    const blockPoint = w.sectorInsideRally(target.sector);
    let blockers = 0;
    for (const s of w.squads) {
      if (s.side !== 'defender' || s.unitIds.length === 0) continue;
      if (Math.hypot(s.order.x - blockPoint.x, s.order.y - blockPoint.y) < 8) blockers++;
    }
    const need = Math.min(maxCommit, 1 + Math.ceil(target.visibleEnemies / 8));
    let moved = 0;
    if (blockers < need) {
      for (const sid of [...bb.reserveSquadIds]) {
        if (blockers + moved >= need) break;
        const s = w.squadById(sid);
        if (!s || s.unitIds.length === 0) continue;
        issue(w, s, { type: 'assault', x: blockPoint.x, y: blockPoint.y }, `肉搏封堵${SECTOR_LABELS[target.sector]}缺口`);
        bb.reserveSquadIds.delete(sid);
        moved++;
      }
      if (moved === 0) {
        const spare = pickGarrison(w, bb, (target.sector + 4) % 8, true);
        if (spare) {
          issue(w, spare, { type: 'assault', x: blockPoint.x, y: blockPoint.y }, '驻防队转堵缺口');
          moved++;
        }
      }
    }
    return moved > 0 || blockers > 0 ? 'success' : 'failure';
  }, undefined, '简单档确认慢、投入少(2队);普通3队;困难即时反应、最多4队');

  // 工程兵预警(中/高难度):发现工兵在墙基作业即派近战驱赶
  const engineerWarning = b.leaf('工兵工程预警(调弩手上墙俯射)', (ctx) => {
    if (!ctx.cfg.engineerWarning) return 'failure';
    const w = ctx.blackboard.world as World;
    const target = w.sectorSummary().find((r) => r.engineers > 0 && !r.breached);
    if (!target) return 'failure';
    if (ctx.tick - bb.lastRedeploy < ctx.cfg.decisionInterval * 3) return 'running';
    // 1) 先调一队弩手/弓手到该扇区墙顶,俯射墙基工兵
    const wallTop = w.sectorWallTop(target.sector);
    const ranged = w.squads.find((s) => {
      if (s.side !== 'defender' || s.unitIds.length === 0) return false;
      const k = w.unitById(s.unitIds[0])?.kind;
      return k === 'crossbow' || k === 'archer';
    });
    let acted = false;
    if (ranged && ctx.tick - ranged.orderTick >= 60
      && Math.hypot(ranged.order.x - wallTop.x, ranged.order.y - wallTop.y) > 6) {
      issue(w, ranged, { type: 'move', x: wallTop.x, y: wallTop.y }, `弩手上${SECTOR_LABELS[target.sector]}墙顶俯射工兵`);
      bb.lastRedeploy = ctx.tick;
      acted = true;
    }
    // 2) 同时派一队近战到内侧集结点(门破时肉搏)
    const squad = pickGarrison(w, bb, target.sector, true);
    if (squad && ctx.tick - squad.orderTick >= 60) {
      const rally = sectorRally(w, target.sector);
      issue(w, squad, { type: 'assault', x: rally.x, y: rally.y }, `近战戒备${SECTOR_LABELS[target.sector]}工兵`);
      acted = true;
    }
    return acted ? 'success' : 'running';
  }, undefined, '简单档关闭此预警,只能等城墙受损后反应');

  // 水源守卫:工兵接近北墙渠首时派一队近战拦截(中/高难度)
  const waterGuard = b.leaf('水源渠首守卫', (ctx) => {
    if (!ctx.cfg.engineerWarning) return 'failure';
    const w = ctx.blackboard.world as World;
    const ws = w.map.waterSources[0];
    if (ws.sabotaged) return 'failure';
    // 发现接近渠首的攻方工兵(目视)
    const intruder = w.units.find((u) => {
      if (!u.alive || u.side !== 'attacker' || u.kind !== 'engineer') return false;
      if (Math.hypot(u.x - ws.x, u.y - ws.y) > 12) return false;
      const c = w.getContact(u.id);
      return c && c.visible;
    });
    if (!intruder) return 'failure';
    const squad = pickGarrison(w, bb, 0, true);
    if (!squad || ctx.tick - squad.orderTick < 60) return 'running';
    issue(w, squad, { type: 'assault', x: ws.x, y: ws.y + 2 }, '近战守卫渠首驱赶工兵');
    return 'success';
  }, undefined, '简单档不守卫水源,断水战术更易得手');

  // 增援主受威胁扇区,但严守预备队底线
  const reinforce = b.leaf('按威胁等级增援(预备队底线约束)', (ctx) => {
    const w = ctx.blackboard.world as World;
    const cfg = ctx.cfg;
    if (bb.mainSector < 0) return 'failure';
    // 反应冷却:难度越低,调兵越慢
    if (ctx.tick - bb.lastRedeploy < cfg.decisionInterval * 2) return 'running';
    const total = totalMobilePower(w);
    const reserve = reservePower(w, bb);
    const ratio = total > 0 ? reserve / total : 0;
    if (ratio <= cfg.reserveFloor) {
      ctx.tracer.log({
        tick: ctx.tick, nodeId: 'reserve', label: '预备队底线', status: 'failure',
        evidence: { 预备队比例: Number(ratio.toFixed(2)), 底线: cfg.reserveFloor, 动作: '拒绝继续抽调' },
      });
      return 'failure';
    }
    const squad = pickReserve(w, bb);
    if (!squad) return 'failure';
    const rally = sectorRally(w, bb.mainSector);
    issue(w, squad, { type: 'assault', x: rally.x, y: rally.y }, `增援${SECTOR_LABELS[bb.mainSector]}主攻方向`);
    bb.reserveSquadIds.delete(squad.id);
    bb.lastRedeploy = ctx.tick;
    ctx.tracer.log({
      tick: ctx.tick, nodeId: 'reserve', label: '预备队抽调', status: 'success',
      evidence: { 抽调前比例: Number(ratio.toFixed(2)), 底线: cfg.reserveFloor },
    });
    return 'success';
  }, undefined, '预备队低于档位底线时停止抽兵,主力不会被佯攻抽空(简单15%/普通35%/困难40%)');

  // 驻防回收:佯攻扇区敌情消散后,把外调小队收回(重建预备队)
  const recall = b.leaf('佯攻消散回收预备队', (ctx) => {
    const w = ctx.blackboard.world as World;
    let recalled = false;
    for (const s of w.squads) {
      if (s.side !== 'defender' || s.unitIds.length === 0) continue;
      if (bb.reserveSquadIds.has(s.id)) continue;
      if (!w.unitById(s.unitIds[0])) continue;
      const sec = w.nearestSectorOf(s.order.x, s.order.y);
      const row = w.sectorSummary()[sec];
      // 需要:敌情归零且持续、当前是突击令、调令已过冷却,才回收,避免横跳
      const settled = ctx.tick - s.orderTick > 90;
      if (row && row.visibleEnemies === 0 && bb.observed[sec] === 0
        && s.order.type === 'assault' && settled) {
        const home = sectorRally(w, sec);
        issue(w, s, { type: 'move', x: home.x, y: home.y }, `${SECTOR_LABELS[sec]}敌情消散,回防`);
        bb.reserveSquadIds.add(s.id);
        recalled = true;
      }
    }
    return recalled ? 'success' : 'failure';
  });

  const hold = b.leaf('保持驻防', () => 'success');

  const emergency = b.selector('应急分支', [handleBreach, waterGuard, engineerWarning], '先处理突破/水源/工兵,再谈常规调度');
  const routine = b.selector('常规调度分支', [reinforce, recall, hold]);

  const monitor = b.parallel('持续监控', [perceive, detectFeint]);
  const loop = b.sequence('守城决策循环', [init, monitor, emergency, routine]);

  const tree = b.root('守城AI行为树', loop);
  void world;
  return tree;
}

function pickReserve(world: World, bb: DefenderBB): Squad | undefined {
  // 优先骑兵(机动最快)
  let cavalry: Squad | undefined;
  let any: Squad | undefined;
  for (const sid of bb.reserveSquadIds) {
    const s = world.squadById(sid);
    if (!s || s.unitIds.length === 0) continue;
    any = any ?? s;
    const k = world.unitById(s.unitIds[0])?.kind;
    if (k === 'cavalry') {
      cavalry = s;
      break;
    }
  }
  return cavalry ?? any;
}

function pickGarrison(world: World, bb: DefenderBB, sector: number, meleeOnly: boolean): Squad | undefined {
  const isCombatMelee = (s: Squad): boolean => {
    const k = world.unitById(s.unitIds[0])?.kind;
    if (!k) return false;
    const spec = UNIT_SPECS[k];
    // 工兵不参与肉搏驱赶,远程留在墙顶
    return !spec.isRanged && k !== 'engineer';
  };
  const ids = bb.garrison.get(sector) ?? [];
  for (const sid of ids) {
    const s = world.squadById(sid);
    if (!s || s.unitIds.length === 0) continue;
    if (meleeOnly && !isCombatMelee(s)) continue;
    return s;
  }
  // 本扇区没有就借相邻扇区
  for (const [sec, list] of bb.garrison) {
    if (sec === sector) continue;
    for (const sid of list) {
      const s = world.squadById(sid);
      if (s && s.unitIds.length > 0 && (!meleeOnly || isCombatMelee(s))) return s;
    }
  }
  return undefined;
}

// 每 tick 驱动(内部按 decisionInterval 节流)
export function tickDefender(ai: DefenderAI, world: World): void {
  if (world.tick % world.cfg.decisionInterval !== 0) return;
  const ctx: BTContext = {
    tick: world.tick,
    difficulty: world.difficulty,
    cfg: world.cfg,
    blackboard: { world, bb: ai.bb },
    tracer: world.tracer,
    act: () => 'success',
    sense: () => 0,
  };
  ai.tree.root.tick(ctx);
}
