import type { Unit } from './types';
import { UNIT_SPECS } from './roster';
import { GRID_SIZE, idx, inBounds, type MapData } from './mapgen';

// 影响力地图:综合兵力、射程、城墙完整度、视野
// 每层都是 256*256 Float32Array;force/threat/ranged/vision 按攻防双方各一份
export interface InfluenceLayers {
  force: Float32Array; // 该方在场(且对另一方可见)的兵力权重
  threat: Float32Array; // 该方即时威胁 = 兵力 * 距离衰减 * 新鲜度
  ranged: Float32Array; // 该方远程火力覆盖
  vision: Float32Array; // 该方视野覆盖(0/1 软遮罩)
}

export interface InfluenceMap {
  size: number;
  defender: InfluenceLayers;
  attacker: InfluenceLayers;
  wall: Float32Array; // 城墙完整度 0..1(全局共享)
  // 每个扇区聚合的威胁/兵力,供行为树直接读
  sectorThreat: { defender: Float32Array; attacker: Float32Array };
  sectorForce: { defender: Float32Array; attacker: Float32Array };
  updateMs: number;
}

export function createInfluenceMap(size = GRID_SIZE): InfluenceMap {
  const n = size * size;
  const layers = (): InfluenceLayers => ({
    force: new Float32Array(n),
    threat: new Float32Array(n),
    ranged: new Float32Array(n),
    vision: new Float32Array(n),
  });
  return {
    size,
    defender: layers(),
    attacker: layers(),
    wall: new Float32Array(n),
    sectorThreat: { defender: new Float32Array(8), attacker: new Float32Array(8) },
    sectorForce: { defender: new Float32Array(8), attacker: new Float32Array(8) },
    updateMs: 0,
  };
}

// 预算径向核:给定半径返回相对坐标与权重
interface Kernel {
  r: number;
  cells: { dx: number; dy: number; w: number }[];
}
const kernelCache = new Map<number, Kernel>();

function kernel(radius: number): Kernel {
  const r = Math.max(1, Math.round(radius));
  const hit = kernelCache.get(r);
  if (hit) return hit;
  const cells: { dx: number; dy: number; w: number }[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue;
      const w = 1 - Math.sqrt(d2) / (r + 1);
      cells.push({ dx, dy, w });
    }
  }
  const k = { r, cells };
  kernelCache.set(r, k);
  return k;
}

function stamp(
  arr: Float32Array, size: number, cx: number, cy: number,
  radius: number, value: number,
): void {
  const k = kernel(radius);
  const x0 = Math.max(0, cx - k.r);
  const x1 = Math.min(size - 1, cx + k.r);
  const y0 = Math.max(0, cy - k.r);
  const y1 = Math.min(size - 1, cy + k.r);
  for (const { dx, dy, w } of k.cells) {
    const x = cx + dx;
    const y = cy + dy;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    arr[idx(x, y)] += value * w;
  }
}

function clearLayers(l: InfluenceLayers): void {
  l.force.fill(0);
  l.threat.fill(0);
  l.ranged.fill(0);
  l.vision.fill(0);
}

export interface ContactInfo {
  // 敌方单位对该方是否可见
  visible: boolean;
  // 新鲜度 0..1(最后可见时间越久越低)
  freshness: number;
}

export interface UpdateInput {
  map: MapData;
  units: Unit[];
  // contacts[unitId] = 该单位对"另一方"的可见性信息(由 World 的战争迷雾维护)
  contacts: Map<number, ContactInfo>;
  sightScale: number;
}

// 一次完整重算。目标:256*256 下 < 10ms
export function updateInfluenceMap(im: InfluenceMap, input: UpdateInput): void {
  const t0 = nowMs();
  const size = im.size;
  clearLayers(im.defender);
  clearLayers(im.attacker);
  im.sectorThreat.defender.fill(0);
  im.sectorThreat.attacker.fill(0);
  im.sectorForce.defender.fill(0);
  im.sectorForce.attacker.fill(0);

  // 城墙完整度层
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = idx(x, y);
      if (map_isWall(input.map, i)) {
        im.wall[i] = input.map.wallHp[i] / input.map.wallMaxHp[i];
      } else {
        im.wall[i] = 1;
      }
    }
  }

  for (const u of input.units) {
    if (!u.alive) continue;
    const spec = UNIT_SPECS[u.kind];
    const own: InfluenceLayers = u.side === 'defender' ? im.defender : im.attacker;
    const cx = Math.round(u.x);
    const cy = Math.round(u.y);
    if (!inBounds(cx, cy)) continue;

    // 视野只受视野半径与感知档位影响
    const sightR = Math.round(spec.sight * input.sightScale);
    stamp(own.vision, size, cx, cy, sightR, 1);

    // 自己的兵力/火力总是可知的
    const hpRatio = u.hp / spec.maxHp;
    stamp(own.force, size, cx, cy, 4, hpRatio);
    if (spec.isRanged) {
      stamp(own.ranged, size, cx, cy, Math.round(spec.range), hpRatio * spec.damage / 10);
    }

    // 对另一方的威胁层:只有被看见的敌人计入,并按情报新鲜度衰减
    const contact = input.contacts.get(u.id);
    if (contact && contact.visible) {
      const enemy: InfluenceLayers = u.side === 'defender' ? im.attacker : im.defender;
      const v = hpRatio * contact.freshness;
      stamp(enemy.threat, size, cx, cy, Math.round(spec.sight * 0.8), v);
      stamp(enemy.force, size, cx, cy, 4, v);
      if (spec.isRanged) {
        stamp(enemy.ranged, size, cx, cy, Math.round(spec.range), v * spec.damage / 10);
      }
      const sec = input.map.wallSector[idx(cx, cy)];
      if (sec >= 0) {
        const key = u.side === 'defender' ? 'defender' : 'attacker';
        im.sectorThreat[key][sec] += v;
        im.sectorForce[key][sec] += v;
      } else {
        // 城外敌人按最近墙扇区聚合
        const secNearest = nearestSector(input.map, cx, cy);
        const key = u.side === 'defender' ? 'defender' : 'attacker';
        im.sectorThreat[key][secNearest] += v * 0.8;
        im.sectorForce[key][secNearest] += v * 0.8;
      }
    }
  }

  im.updateMs = nowMs() - t0;
}

function map_isWall(map: MapData, i: number): boolean {
  const t = map.terrain[i];
  return t === 1 || t === 2;
}

function nearestSector(map: MapData, x: number, y: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let s = 0; s < map.sectorAnchor.length; s++) {
    const a = map.sectorAnchor[s];
    const d = (a.x - x) ** 2 + (a.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

// Node 与浏览器都可用的计时
function nowMs(): number {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  const hr = processHr();
  return hr;
}
function processHr(): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.process && g.process.hrtime) {
    const [s, ns] = g.process.hrtime();
    return s * 1000 + ns / 1e6;
  }
  return Date.now();
}
