import type { Unit, Squad, Side, Order, Ladder, Tunnel, Difficulty } from '../core/types';
import { SECTOR_COUNT } from '../core/types';
import { UNIT_SPECS, DIFFICULTY } from '../core/roster';
import {
  GRID_SIZE, idx, inBounds, isWallTile, generateMap,
  type MapData, WALL_INNER, WALL_OUTER, CITY_MIN, CITY_MAX,
} from '../core/mapgen';
import { spawnArmies } from '../core/units';
import {
  createInfluenceMap, updateInfluenceMap, type InfluenceMap, type ContactInfo,
} from '../core/influence';
import { Tracer, type DecisionEvent } from '../ai/bt';

export interface EngineConfig {
  seed: number;
  difficulty: Difficulty;
  maxTicks: number;
}

export type BattleResult = 'defender_hold' | 'city_broken' | 'attacker_wiped' | 'timeout';

// 空间哈希,避免每 tick O(n^2) 接敌检测
class SpatialHash {
  private cell = 16;
  private buckets = new Map<number, Unit[]>();

  clear(): void {
    this.buckets.clear();
  }

  private key(cx: number, cy: number): number {
    return cy * 1024 + cx;
  }

  insert(u: Unit): void {
    const cx = Math.floor(u.x / this.cell);
    const cy = Math.floor(u.y / this.cell);
    const k = this.key(cx, cy);
    let b = this.buckets.get(k);
    if (!b) {
      b = [];
      this.buckets.set(k, b);
    }
    b.push(u);
  }

  query(x: number, y: number, radius: number, out: Unit[]): Unit[] {
    out.length = 0;
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    for (let oy = -r; oy <= r; oy++) {
      for (let ox = -r; ox <= r; ox++) {
        const b = this.buckets.get(this.key(cx + ox, cy + oy));
        if (b) for (const u of b) out.push(u);
      }
    }
    return out;
  }
}

export class World {
  map: MapData;
  units: Unit[];
  squads: Squad[];
  ladders: Ladder[] = [];
  tunnels: Tunnel[] = [];
  tick = 0;
  difficulty: Difficulty;
  cfg = DIFFICULTY.normal;
  maxTicks: number;
  seed: number;
  influence: InfluenceMap;
  tracer = new Tracer();
  result: BattleResult | null = null;

  // 战争迷雾:side 对每个敌方单位最后可见 tick
  private lastSeen = new Map<number, number>(); // key: unitId
  private contacts = new Map<number, ContactInfo>();
  private hash = new SpatialHash();
  private queryBuf: Unit[] = [];
  private nextObjectId = 1;
  // 水源被断后的累计 tick,影响守军战斗力
  waterCutTicks = 0;
  // 攻方是否已有单位进城(用于"破城"判定)
  attackerEntered = false;
  // 城内攻方连续形成有效立足点的 tick 数
  footholdTicks = 0;
  // 每个扇区被突破(墙塌/登城)的 tick
  sectorBreachedAt = new Int32Array(SECTOR_COUNT).fill(-1);
  // 每个扇区正在作业的工兵数(由 engineerWork 维护,供守军感知)
  sectorEngineers = new Int32Array(SECTOR_COUNT);
  // 每个地道最近一次受扰 tick(守军反挖会压制进度)
  tunnelInterfered = new Map<number, number>();

  constructor(config: EngineConfig) {
    this.seed = config.seed;
    this.difficulty = config.difficulty;
    this.cfg = DIFFICULTY[config.difficulty];
    this.maxTicks = config.maxTicks;
    this.map = generateMap(config.seed);
    const spawn = spawnArmies(this.map, config.seed);
    this.units = spawn.units;
    this.squads = spawn.squads;
    this.influence = createInfluenceMap(GRID_SIZE);
  }

  squadById(id: number): Squad | undefined {
    return this.squads.find((s) => s.id === id);
  }

  unitById(id: number): Unit | undefined {
    return this.units.find((u) => u.id === id);
  }

  aliveUnits(side?: Side): Unit[] {
    return this.units.filter((u) => u.alive && (!side || u.side === side));
  }

  countAlive(side: Side): number {
    let n = 0;
    for (const u of this.units) if (u.alive && u.side === side) n++;
    return n;
  }

  setOrder(squadId: number, order: Order): void {
    const s = this.squadById(squadId);
    if (!s) return;
    s.order = order;
    s.orderTick = this.tick;
  }

  recordEvent(e: Omit<DecisionEvent, 'tick'>): void {
    this.tracer.event({ ...e, tick: this.tick });
  }

  newLadder(x: number, y: number, sector: number): Ladder {
    // 同扇区已有梯子则复用(被毁后重置),避免无限刷对象
    const existing = this.ladders.find((l) => l.sector === sector);
    if (existing) {
      existing.x = x;
      existing.y = y;
      existing.built = false;
      existing.destroyed = false;
      existing.hp = 120;
      existing.placedTick = this.tick;
      return existing;
    }
    const l: Ladder = {
      id: this.nextObjectId++, x, y, sector,
      built: false, destroyed: false, hp: 120, placedTick: this.tick,
    };
    this.ladders.push(l);
    return l;
  }

  newTunnel(sector: number): Tunnel {
    const anchor = this.map.sectorAnchor[sector];
    // 目标墙格:从锚点向城心找墙
    const wall = this.findWallTowardCenter(anchor.x, anchor.y);
    const t: Tunnel = {
      id: this.nextObjectId++, targetSector: sector, progress: 0, collapsed: false,
      wallX: wall.x, wallY: wall.y,
    };
    this.tunnels.push(t);
    return t;
  }

  private findWallTowardCenter(x: number, y: number): { x: number; y: number } {
    const c = 127;
    const ang = Math.atan2(c - y, c - x);
    for (let r = 2; r < 60; r++) {
      const wx = Math.round(x + Math.cos(ang) * r);
      const wy = Math.round(y + Math.sin(ang) * r);
      if (isWallTile(this.map, wx, wy)) return { x: wx, y: wy };
    }
    return { x: WALL_OUTER, y: c };
  }

  // 推进一个 tick
  step(): void {
    if (this.result) return;
    this.tick++;
    this.hash.clear();
    for (const u of this.units) if (u.alive) this.hash.insert(u);

    this.updateFog();
    this.moveUnits();
    this.engineerWork();
    this.combat();
    this.cleanupDead();
    this.waterTick();
    this.repairTick();

    if (this.tick % this.cfg.mapInterval === 0 || this.tick === 1) {
      updateInfluenceMap(this.influence, {
        map: this.map, units: this.units, contacts: this.contacts,
        sightScale: this.cfg.sightScale,
      });
    }
    this.checkResult();
  }

  // ---- 战争迷雾 ----
  private updateFog(): void {
    this.contacts.clear();
    const alive = this.aliveUnits();
    for (const observer of alive) {
      const spec = UNIT_SPECS[observer.kind];
      let sight = spec.sight * this.sightScaleOf(observer.side);
      // 守军墙顶哨位拥有瞭望塔级警戒视野,可提前发现城外集结;
      // 警戒半径受难度感知档缩放(简单档瞭望效率低),不靠加兵只靠信息差
      if (observer.side === 'defender' && this.standsOnWall(observer.x, observer.y)) {
        const lookout = spec.isRanged ? 55 : 40;
        sight = Math.max(sight, lookout * this.cfg.sightScale);
      }
      const near = this.hash.query(observer.x, observer.y, sight, this.queryBuf);
      const wallLookout = observer.side === 'defender' && this.standsOnWall(observer.x, observer.y);
      for (const target of near) {
        if (target.side === observer.side || !target.alive) continue;
        const d = Math.hypot(target.x - observer.x, target.y - observer.y);
        if (d > sight) continue;
        // 墙顶哨位可越过自己的城墙向外瞭望,只被城内建筑遮挡
        if (!wallLookout && this.blockedByWall(observer.x, observer.y, target.x, target.y)) continue;
        this.lastSeen.set(target.id, this.tick);
      }
    }
    // 汇总为 contact(以"另一方视角")
    for (const u of this.units) {
      if (!u.alive) continue;
      const ls = this.lastSeen.get(u.id);
      const age = ls === undefined ? 999 : this.tick - ls;
      const visible = age === 0;
      const freshness = Math.max(0, 1 - age / 40);
      this.contacts.set(u.id, { visible, freshness });
    }
  }

  private sightScaleOf(side: Side): number {
    // 攻方侦察始终按 normal 档;守军难度决定其感知
    if (side === 'attacker') return DIFFICULTY.normal.sightScale;
    return this.cfg.sightScale;
  }

  // 直线视线是否被墙/建筑遮挡( Bresenham 采样)
  private blockedByWall(x0: number, y0: number, x1: number, y1: number): boolean {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = Math.round(x0 + (x1 - x0) * t);
      const y = Math.round(y0 + (y1 - y0) * t);
      if (!inBounds(x, y)) return true;
      const ter = this.map.terrain[idx(x, y)];
      if (ter === 1 || ter === 3) return true;
    }
    return false;
  }

  getContact(unitId: number): ContactInfo | undefined {
    return this.contacts.get(unitId);
  }

  // ---- 移动 ----
  // 攻方从城外到城内的最近门道路由点(无门可走时返回 null,表示需工程突破)
  private gateRoute(fromX: number, fromY: number, toX: number, toY: number): { x: number; y: number } | null {
    if (!this.insideCity(toX, toY) || this.insideCity(fromX, fromY)) return null;
    // 收集仍可通行(已砸开)的门格,否则用任意门洞作为中转目标
    const openGates = this.map.gateTiles.filter((g) => this.map.wallHp[idx(g.x, g.y)] <= 0);
    const pool = openGates.length > 0 ? openGates : this.map.gateTiles;
    let best = pool[0];
    let bestD = Infinity;
    for (const g of pool) {
      const d = (g.x - fromX) ** 2 + (g.y - fromY) ** 2;
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  private moveUnits(): void {
    for (const u of this.units) {
      if (!u.alive) continue;
      const squad = this.squadById(u.squadId);
      if (!squad) continue;
      const o = squad.order;
      if (o.type === 'hold') continue;
      const spec = UNIT_SPECS[u.kind];

      // 接敌自动攻击:突击/撤退指令下射程内有敌人就停下开火(由 combat 结算)
      // 工兵的机动/工程指令(move/tunnel/sabotage/buildLadder)优先赶路,不被沿途敌人拖住
      const engineerMoving = u.kind === 'engineer' && o.type !== 'assault';
      if ((o.type === 'assault' || o.type === 'retreat' || (o.type === 'move' && !engineerMoving))) {
        const near = this.hash.query(u.x, u.y, spec.range + 1, this.queryBuf);
        let enemy: Unit | null = null;
        let bestD = Infinity;
        for (const e of near) {
          if (e.side === u.side || !e.alive) continue;
          const d = Math.hypot(e.x - u.x, e.y - u.y);
          if (d > spec.range + 0.5 || d >= bestD) continue;
          if (spec.isRanged && this.blockedByWall(u.x, u.y, e.x, e.y)) continue;
          enemy = e;
          bestD = d;
        }
        // 近战贴脸才停下;远程进入 80% 射程即停下射击
        const stopDist = spec.isRanged ? spec.range * 0.8 : 1.2;
        if (enemy && bestD <= stopDist) continue;
      }

      let targetX = o.x;
      let targetY = o.y;

      if (o.type === 'climb' && o.targetId !== undefined) {
        const ladder = this.ladders.find((l) => l.id === o.targetId);
        if (ladder && ladder.built) {
          // 先到梯脚,到位后翻过墙顶落入城内
          if (Math.hypot(ladder.x - u.x, ladder.y - u.y) < 1.6) {
            u.x = ladder.x;
            u.y = WALL_INNER + 1;
            this.markBreach(ladder.sector);
            this.attackerEntered = true;
            continue;
          }
          targetX = ladder.x;
          targetY = ladder.y;
        }
      }

      // 攻方进城走门洞(或已塌陷墙格由 canEnter 放行)
      if (u.side === 'attacker') {
        const gate = this.gateRoute(u.x, u.y, targetX, targetY);
        if (gate) {
          targetX = gate.x;
          targetY = gate.y;
        }
      }

      const dx = targetX - u.x;
      const dy = targetY - u.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.6) {
        continue;
      }
      const stepLen = Math.min(spec.speed, dist);
      const nx = u.x + (dx / dist) * stepLen;
      const ny = u.y + (dy / dist) * stepLen;
      if (this.canEnter(u, nx, ny, o.type)) {
        u.x = nx;
        u.y = ny;
        if (u.side === 'attacker' && this.insideCity(nx, ny) && this.crossedWall()) {
          this.attackerEntered = true;
        }
      } else {
        // 简单绕行:尝试左右两个切线方向
        const sideStep = stepLen;
        const candidates = [
          { x: u.x + (-dy / dist) * sideStep, y: u.y + (dx / dist) * sideStep },
          { x: u.x + (dy / dist) * sideStep, y: u.y + (-dx / dist) * sideStep },
        ];
        let moved = false;
        for (const c of candidates) {
          if (this.canEnter(u, c.x, c.y, o.type)) {
            u.x = c.x;
            u.y = c.y;
            moved = true;
            if (u.side === 'attacker' && this.insideCity(c.x, c.y) && this.crossedWall()) {
              this.attackerEntered = true;
            }
            break;
          }
        }
        // 被门/墙挡住且是突击指令:贴近目标(砸门由 combat 结算),原地等门开
        if (!moved && (o.type === 'assault')) {
          // no-op:保持位置,combat 会持续砸门
        }
      }
    }
  }

  private insideCity(x: number, y: number): boolean {
    return x > CITY_MIN && x < CITY_MAX && y > CITY_MIN && y < CITY_MAX;
  }

  // 是否已有打通的入城通道(门破/塌陷/登城),用于判定真正入城而非贴门洞
  private crossedWall(): boolean {
    return this.sectorBreachedAt.some((t) => t >= 0);
  }

  private nearWall(x: number, y: number, radius: number): boolean {
    const cx = Math.round(x);
    const cy = Math.round(y);
    for (let oy = -radius; oy <= radius; oy++) {
      for (let ox = -radius; ox <= radius; ox++) {
        const px = cx + ox;
        const py = cy + oy;
        if (!inBounds(px, py)) continue;
        const t = this.map.terrain[idx(px, py)];
        if (t === 1 || t === 2) return true;
      }
    }
    return false;
  }

  // 守军远程是否站位在墙顶走道(墙环格及其紧邻内侧射击位)
  private standsOnWall(x: number, y: number): boolean {
    const cx = Math.round(x);
    const cy = Math.round(y);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (!inBounds(cx + ox, cy + oy)) continue;
        const t = this.map.terrain[idx(cx + ox, cy + oy)];
        if (t === 1 || t === 2) return true;
      }
    }
    return false;
  }

  private canEnter(u: Unit, x: number, y: number, orderType: Order['type']): boolean {
    if (!inBounds(x, y)) return false;
    const t = this.map.terrain[idx(Math.round(x), Math.round(y))];
    if (t === 4) return false; // 水域不可走(门缺口处无护城河)
    if (t === 5 && u.side === 'attacker') return false;
    if (t === 3) return false; // 建筑
    if (t === 1 || t === 2) {
      // 墙/门:只有工兵工程指令、或登城指令可接近(接触即可,不进入)
      if (orderType === 'tunnel' || orderType === 'buildLadder' || orderType === 'climb') return false;
      // 门被砸开后可通行
      if (t === 2) {
        const hp = this.map.wallHp[idx(Math.round(x), Math.round(y))];
        return hp <= 0;
      }
      // 塌陷墙格
      if (this.map.wallHp[idx(Math.round(x), Math.round(y))] <= 0) return true;
      return false;
    }
    if (t === 6) return true;
    return true;
  }

  // ---- 工程:地道/云梯/水源 ----
  // 扇区内墙附近的守军驻防力量(用于压制攻方工程作业)
  sectorDefenderPresence(sector: number): number {
    const rally = this.sectorInsideRally(sector);
    let n = 0;
    for (const u of this.units) {
      if (!u.alive || u.side !== 'defender') continue;
      if (Math.hypot(u.x - rally.x, u.y - rally.y) <= 12) n++;
    }
    return n;
  }

  private engineerWork(): void {
    this.sectorEngineers.fill(0);
    for (const u of this.units) {
      if (!u.alive || u.kind !== 'engineer') continue;
      const squad = this.squadById(u.squadId);
      if (!squad) continue;
      const o = squad.order;
      if (o.type === 'buildLadder' && o.targetId !== undefined) {
        const ladder = this.ladders.find((l) => l.id === o.targetId);
        if (ladder && !ladder.built && !ladder.destroyed
          && Math.hypot(ladder.x - u.x, ladder.y - u.y) < 2) {
          this.sectorEngineers[ladder.sector]++;
          // 守军压制:扇区驻防力量越强,架梯越慢(最多减速 55%)
          const presence = this.sectorDefenderPresence(ladder.sector);
          const suppression = Math.min(0.55, presence * 0.04);
          u.work += 1 - suppression;
          if (u.work >= 40) {
            ladder.built = true;
            u.work = 0;
            this.recordEvent({ side: 'attacker', kind: 'ladder_built', detail: `云梯架设于${ladder.sector}号扇区` });
          }
        }
      } else if (o.type === 'tunnel' && o.targetId !== undefined) {
        const tunnel = this.tunnels.find((t) => t.id === o.targetId);
        if (tunnel && !tunnel.collapsed) {
          this.sectorEngineers[tunnel.targetSector]++;
          const presence = this.sectorDefenderPresence(tunnel.targetSector);
          // 压制有下限:最多减速 55%,不会把工程冻结;守军杀伤工兵才是主要反制
          const suppression = Math.min(0.55, presence * 0.04);
          u.work += 1 - suppression;
          if (u.work >= 90) {
            u.work = 0;
            tunnel.progress = Math.min(1, tunnel.progress + 0.1);
            this.tunnelInterfered.set(tunnel.id, this.tick);
            if (tunnel.progress >= 1) this.collapseTunnel(tunnel);
          }
        }
      } else if (o.type === 'sabotage') {
        const ws = this.map.waterSources[0];
        if (!ws.sabotaged && Math.hypot(ws.x - u.x, ws.y - u.y) < 3.5) {
          u.work += 1;
          if (u.work >= 50) {
            ws.sabotaged = true;
            u.work = 0;
            this.recordEvent({ side: 'attacker', kind: 'water_cut', detail: '水源渠首被破坏' });
          }
        }
      }
    }
  }

  private collapseTunnel(t: Tunnel): void {
    t.collapsed = true;
    const i = idx(t.wallX, t.wallY);
    this.map.wallHp[i] = 0;
    this.map.terrain[i] = 6;
    this.markBreach(t.targetSector);
    this.recordEvent({
      side: 'attacker', kind: 'tunnel_collapse',
      detail: `地道塌陷,${t.targetSector}号扇区城墙出现缺口`,
    });
  }

  private markBreach(sector: number): void {
    if (this.sectorBreachedAt[sector] < 0) {
      this.sectorBreachedAt[sector] = this.tick;
    }
  }

  // ---- 战斗 ----
  private combat(): void {
    const waterDebuff = this.waterCutTicks > 100 ? 0.85 : 1; // 断水较久后守军伤害 -15%
    for (const u of this.units) {
      if (!u.alive) continue;
      if (u.cooldown > 0) {
        u.cooldown--;
        continue;
      }
      const spec = UNIT_SPECS[u.kind];
      const near = this.hash.query(u.x, u.y, spec.range + 1, this.queryBuf);
      let target: Unit | null = null;
      let bestD = Infinity;
      for (const e of near) {
        if (e.side === u.side || !e.alive) continue;
        const d = Math.hypot(e.x - u.x, e.y - u.y);
        if (d > spec.range + 0.5) continue;
        // 守军远程站在墙顶时可俯射墙外目标,不受自身城墙遮挡
        const wallTop = u.side === 'defender' && spec.isRanged && this.standsOnWall(u.x, u.y);
        if (spec.isRanged && !wallTop && this.blockedByWall(u.x, u.y, e.x, e.y)) continue;
        if (d < bestD) {
          bestD = d;
          target = e;
        }
      }
      if (target) {
        let dmg = spec.damage;
        if (u.side === 'defender') {
          dmg *= waterDebuff;
          // 守城地利:守军在墙/门 6 格内近战,伤害 +20%(狭口防御)
          if (!spec.isRanged && this.nearWall(u.x, u.y, 6)) dmg *= 1.2;
        }
        // 守军攻击受战争迷雾/感知档位影响:目标不可见或情报陈旧时按命中率折扣
        // 这让"看得清、反应快"的高难度直接转化为火力效率,而不靠加兵
        if (u.side === 'defender') {
          const contact = this.contacts.get(target.id);
          if (contact && !contact.visible) {
            // 雾中目标:命中率 = 视野系数 × 情报新鲜度,最低 0.25
            const accuracy = Math.max(0.25, this.cfg.sightScale * (0.4 + 0.6 * contact.freshness));
            dmg *= accuracy;
          }
          // 攻方工兵贴墙作业时有墙体掩护,守军远程对其伤害 -35%(工程仍可被打断,但不会被瞬秒)
          if (target.kind === 'engineer' && spec.isRanged && this.nearWall(target.x, target.y, 2)) {
            dmg *= 0.65;
          }
        }
        target.hp -= dmg;
        u.cooldown = spec.cooldownTicks;
        if (target.hp <= 0) target.alive = false;
      }
    }
    // 弩手/弓手射击未完工的云梯:每个远程每轮最多贡献一次小额伤害,避免集火秒杀
    for (const u of this.units) {
      if (!u.alive || u.side !== 'defender') continue;
      const spec = UNIT_SPECS[u.kind];
      if (!spec.isRanged) continue;
      const targetLadder = this.ladders.find(
        (l) => !l.built && !l.destroyed && Math.hypot(l.x - u.x, l.y - u.y) <= spec.range,
      );
      if (targetLadder) {
        // 架设保护期(25 tick)内伤害降为 1/5,让工兵有完工窗口
        const protected_ = this.tick - targetLadder.placedTick < 25;
        const factor = protected_ ? 0.016 : 0.08;
        targetLadder.hp -= spec.damage * factor * this.cfg.sightScale;
        if (targetLadder.hp <= 0) {
          targetLadder.destroyed = true;
          targetLadder.built = false;
          this.recordEvent({ side: 'defender', kind: 'ladder_destroyed', detail: `${targetLadder.sector}号扇区云梯被摧毁` });
        }
      }
    }
    // 近战攻击城门(攻方贴门时砸门)
    for (const u of this.units) {
      if (!u.alive || u.side !== 'attacker') continue;
      const gx = Math.round(u.x);
      const gy = Math.round(u.y);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const x = gx + ox;
          const y = gy + oy;
          if (!inBounds(x, y)) continue;
          const i = idx(x, y);
          if (this.map.isGate[i] && this.map.wallHp[i] > 0) {
            this.map.wallHp[i] -= UNIT_SPECS[u.kind].damage * 0.6;
            if (this.map.wallHp[i] <= 0) {
              this.map.wallHp[i] = 0;
              this.markBreach(this.map.wallSector[i]);
              this.recordEvent({ side: 'attacker', kind: 'gate_broken', detail: '城门被砸开' });
            }
          }
        }
      }
    }
  }

  private cleanupDead(): void {
    for (const s of this.squads) {
      s.unitIds = s.unitIds.filter((id) => {
        const u = this.unitById(id);
        return u && u.alive;
      });
    }
  }

  private waterTick(): void {
    if (this.map.waterSources.some((w) => w.sabotaged)) this.waterCutTicks++;
  }

  // 守军在门旁时持续修复门体(贴门驻防的小队会缓慢回满耐久)
  private repairTick(): void {
    for (const g of this.map.gateTiles) {
      const i = idx(g.x, g.y);
      if (this.map.wallHp[i] >= this.map.wallMaxHp[i]) continue;
      let defenders = 0;
      for (const u of this.units) {
        if (!u.alive || u.side !== 'defender') continue;
        if (Math.abs(u.x - g.x) <= 2 && Math.abs(u.y - g.y) <= 2) defenders++;
      }
      if (defenders > 0) {
        this.map.wallHp[i] = Math.min(this.map.wallMaxHp[i], this.map.wallHp[i] + defenders * 0.6);
      }
    }
  }

  private checkResult(): void {
    const def = this.countAlive('defender');
    const atk = this.countAlive('attacker');
    if (atk === 0) {
      this.result = 'attacker_wiped';
      return;
    }
    if (def === 0) {
      this.result = 'city_broken';
      return;
    }
    // 破城标准:入城通道已打通,且城内持续保有一支成规模的攻方立足点
    if (this.attackerEntered) {
      let insideAttackers = 0;
      for (const u of this.units) {
        if (u.alive && u.side === 'attacker' && this.insideCity(u.x, u.y)) insideAttackers++;
      }
      const breachOpen = this.sectorBreachedAt.some((t) => t >= 0);
      // 简单档守军协同差,较少攻方即可立足;困难档需要更多
      const footholdNeed = this.difficulty === 'hard' ? 16 : this.difficulty === 'normal' ? 13 : 10;
      if (breachOpen && insideAttackers >= footholdNeed) {
        this.footholdTicks++;
      } else {
        this.footholdTicks = 0;
      }
      if (this.footholdTicks >= 120) {
        this.result = 'city_broken';
        return;
      }
    }
    if (this.tick >= this.maxTicks) {
      // 超时未满足破城条件即守住
      this.result = 'defender_hold';
    }
  }

  private summaryCache: SectorSummary[] | null = null;
  private summaryTick = -1;

  // 供 AI 使用的扇区敌情摘要(每 tick 缓存,避免 AI 多次调用重复全表扫描)
  sectorSummary(): SectorSummary[] {
    if (this.summaryCache && this.summaryTick === this.tick) return this.summaryCache;
    const out: SectorSummary[] = [];
    for (let s = 0; s < SECTOR_COUNT; s++) {
      let visibleEnemies = 0;
      let lastSeenTick = -1;
      for (const u of this.units) {
        if (!u.alive || u.side !== 'attacker') continue;
        const sec = this.nearestSectorOf(u.x, u.y);
        if (sec !== s) continue;
        const c = this.contacts.get(u.id);
        if (c && c.visible) {
          visibleEnemies++;
          lastSeenTick = Math.max(lastSeenTick, this.tick);
        }
      }
      // 工兵感知受难度门控:困难档能凭动土声响全感知;普通档只在有可见敌兵时确认;
      // 简单档完全依赖目视(看不到就不知道在挖地道)
      const rawEngineers = this.sectorEngineers[s];
      let engineers = 0;
      if (this.difficulty === 'hard') {
        engineers = rawEngineers;
      } else if (this.difficulty === 'normal') {
        engineers = visibleEnemies > 0 ? rawEngineers : 0;
      } else {
        // easy:只统计当前确实被看见的工兵
        engineers = this.countVisibleEngineers(s);
      }
      const wallHp = this.sectorWallHp(s);
      out.push({
        sector: s,
        visibleEnemies,
        engineers,
        lastSeenTick,
        wallRatio: wallHp.ratio,
        breached: this.sectorBreachedAt[s] >= 0,
        threat: this.influence.sectorThreat.attacker[s],
      });
    }
    this.summaryCache = out;
    this.summaryTick = this.tick;
    return out;
  }

  private countVisibleEngineers(sector: number): number {
    let n = 0;
    for (const u of this.units) {
      if (!u.alive || u.side !== 'attacker' || u.kind !== 'engineer') continue;
      if (this.nearestSectorOf(u.x, u.y) !== sector) continue;
      const c = this.contacts.get(u.id);
      if (c && c.visible) n++;
    }
    return n;
  }

  nearestSectorOf(x: number, y: number): number {
    let best = 0;
    let bestD = Infinity;
    for (let s = 0; s < this.map.sectorAnchor.length; s++) {
      const a = this.map.sectorAnchor[s];
      const d = (a.x - x) ** 2 + (a.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  // 扇区对应的城内集结点(攻方过门后的目标)
  sectorInsideRally(sector: number): { x: number; y: number } {
    const a = this.map.sectorAnchor[sector];
    const c = 127;
    const ang = Math.atan2(c - a.y, c - a.x);
    // 从墙外锚点穿过墙,推进到城内 ~14 格
    return { x: Math.round(a.x + Math.cos(ang) * 30), y: Math.round(a.y + Math.sin(ang) * 30) };
  }

  // 扇区对应的墙外集结点(工兵/佯攻贴近墙基用)
  sectorOutsideAnchor(sector: number): { x: number; y: number } {
    return { ...this.map.sectorAnchor[sector] };
  }

  // 工兵墙基作业点:外墙外皮外 2 格,精确落在墙顶弩手射程内(弩手在墙内皮,射程可覆盖)
  sectorWallBase(sector: number): { x: number; y: number } {
    const c = 127;
    // 扇区中心方位角(0=北,顺时针)
    const ang = (sector * 45 - 90) * (Math.PI / 180);
    // 城墙外皮距城心 127-86=41;作业点再往外 2 格 → 半径 43
    const r = c - WALL_OUTER + 2;
    return {
      x: Math.round(c + Math.cos(ang) * r),
      y: Math.round(c + Math.sin(ang) * r),
    };
  }

  // 守军远程墙顶部署点:该扇区方位的墙顶走道(内皮 WALL_INNER)
  sectorWallTop(sector: number): { x: number; y: number } {
    const c = 127;
    const ang = (sector * 45 - 90) * (Math.PI / 180);
    const r = c - WALL_INNER;
    return {
      x: Math.round(c + Math.cos(ang) * r),
      y: Math.round(c + Math.sin(ang) * r),
    };
  }

  // 扇区的突破墙格(塌陷墙或门洞),没有则 null
  breachTile(sector: number): { x: number; y: number } | null {
    for (const t of this.tunnels) {
      if (t.collapsed && t.targetSector === sector) return { x: t.wallX, y: t.wallY };
    }
    const gate = this.map.gateTiles.find((g) => g.sector === sector && this.map.wallHp[idx(g.x, g.y)] <= 0);
    if (gate) return { x: gate.x, y: gate.y };
    // 该扇区任一耐久归零的墙格
    for (let i = 0; i < this.map.terrain.length; i++) {
      if (this.map.wallSector[i] === sector && this.map.wallHp[i] <= 0) {
        return { x: i % this.map.size, y: Math.floor(i / this.map.size) };
      }
    }
    return null;
  }

  private sectorWallHp(s: number): { ratio: number } {
    let hp = 0;
    let max = 0;
    for (let i = 0; i < this.map.terrain.length; i++) {
      if (this.map.wallSector[i] === s) {
        hp += this.map.wallHp[i];
        max += this.map.wallMaxHp[i];
      }
    }
    return { ratio: max > 0 ? hp / max : 1 };
  }
}

export interface SectorSummary {
  sector: number;
  visibleEnemies: number;
  engineers: number;
  lastSeenTick: number;
  wallRatio: number;
  breached: boolean;
  threat: number;
}
