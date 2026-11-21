import type { Unit, Squad, Side, UnitKind, Order } from './types';
import { UNIT_SPECS, DEFENDER_ROSTER, ATTACKER_ROSTER, rosterKinds, rosterSize } from './roster';
import { CITY_MAX, WALL_INNER, GRID_SIZE, makeRng, idx } from './mapgen';
import type { MapData } from './mapgen';

let nextUnitId = 1;
let nextSquadId = 1;

export function resetIds(): void {
  nextUnitId = 1;
  nextSquadId = 1;
}

function makeUnit(side: Side, kind: UnitKind, x: number, y: number, squadId: number): Unit {
  const spec = UNIT_SPECS[kind];
  return {
    id: nextUnitId++, side, kind,
    x: x + 0.5, y: y + 0.5,
    hp: spec.maxHp, cooldown: 0, squadId, alive: true, work: 0,
  };
}

const PER_SQUAD = 10;

// 按兵种位置列表直接建队,同时返回所有单位
function formSquads(
  side: Side,
  positions: Map<UnitKind, { x: number; y: number }[]>,
): { squads: Squad[]; units: Unit[] } {
  const squads: Squad[] = [];
  const units: Unit[] = [];
  let serial = 1;
  for (const [kind, spots] of positions) {
    for (let i = 0; i < spots.length; i += PER_SQUAD) {
      const chunk = spots.slice(i, i + PER_SQUAD);
      const id = nextSquadId++;
      const anchor = chunk[0];
      const squad: Squad = {
        id, side,
        name: `${UNIT_SPECS[kind].label}${serial++}队`,
        unitIds: [],
        order: { type: 'hold', x: anchor.x + 0.5, y: anchor.y + 0.5 },
        orderTick: 0,
      };
      for (const spot of chunk) {
        const u = makeUnit(side, kind, spot.x, spot.y, id);
        squad.unitIds.push(u.id);
        units.push(u);
      }
      squads.push(squad);
    }
  }
  return { squads, units };
}

// 沿内墙四周分配守军站位;远程上墙,近战在内侧
function defenderPositions(map: MapData, seed: number): Map<UnitKind, { x: number; y: number }[]> {
  const rng = makeRng(seed ^ 0x51e6);
  const c = (CITY_MAX + 88) >> 1; // 城心 127
  const positions = new Map<UnitKind, { x: number; y: number }[]>();
  const push = (k: UnitKind, x: number, y: number) => {
    if (!positions.has(k)) positions.set(k, []);
    positions.get(k)!.push({ x, y });
  };
  const kinds = [...rosterKinds(DEFENDER_ROSTER)];
  kinds.forEach((k, i) => {
    const ang = (i / kinds.length) * Math.PI * 2 + rng() * 0.1;
    const r = 30;
    const x = Math.round(c + Math.cos(ang) * r);
    const y = Math.round(c + Math.sin(ang) * r);
    if (UNIT_SPECS[k].isRanged) {
      push(k, projectToWall(x, y, map).x, projectToWall(x, y, map).y);
    } else {
      push(k, x, y);
    }
  });
  return positions;
}

function projectToWall(px: number, py: number, map: MapData): { x: number; y: number } {
  const c = 127;
  const ang = Math.atan2(py - c, px - c);
  for (let r = 4; r < 40; r++) {
    const x = Math.round(c + Math.cos(ang) * r);
    const y = Math.round(c + Math.sin(ang) * r);
    const t = map.terrain[idx(x, y)];
    if (t === 1 || t === 2) return { x, y };
  }
  return { x: WALL_INNER, y: c };
}

// 攻方在城外四角营地集结
function attackerPositions(seed: number): Map<UnitKind, { x: number; y: number }[]> {
  const rng = makeRng(seed ^ 0xa77ac);
  const positions = new Map<UnitKind, { x: number; y: number }[]>();
  const push = (k: UnitKind, x: number, y: number) => {
    if (!positions.has(k)) positions.set(k, []);
    positions.get(k)!.push({ x, y });
  };
  const camps = [
    { x: 30, y: 30 }, { x: GRID_SIZE - 31, y: 30 },
    { x: 30, y: GRID_SIZE - 31 }, { x: GRID_SIZE - 31, y: GRID_SIZE - 31 },
  ];
  [...rosterKinds(ATTACKER_ROSTER)].forEach((k, i) => {
    const camp = camps[i % camps.length];
    push(
      k,
      camp.x + Math.floor(rng() * 18) - 9,
      camp.y + Math.floor(rng() * 18) - 9,
    );
  });
  return positions;
}

export interface SpawnResult {
  units: Unit[];
  squads: Squad[];
}

export function spawnArmies(map: MapData, seed: number): SpawnResult {
  resetIds();
  const def = formSquads('defender', defenderPositions(map, seed));
  const atk = formSquads('attacker', attackerPositions(seed));
  return {
    units: [...def.units, ...atk.units],
    squads: [...def.squads, ...atk.squads],
  };
}

export function defaultOrderFor(u: Unit): Order {
  return { type: 'hold', x: u.x, y: u.y };
}

export { rosterSize };
