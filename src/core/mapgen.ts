import type { Terrain, SectorId, WaterSource } from './types';
import { SECTOR_COUNT } from './types';

export const GRID_SIZE = 256;
export const CITY_MIN = 88;
export const CITY_MAX = 167;
export const WALL_OUTER = 86;
export const WALL_INNER = 89;
export const GATE_HALF = 1; // 门洞半宽(门洞宽 3 格,只在墙皮开口)
export const CITY_CENTER = 127;

export interface MapData {
  size: number;
  terrain: Uint8Array; // Terrain
  wallHp: Float32Array;
  wallMaxHp: Float32Array;
  wallSector: Int8Array; // -1 表示非墙
  isGate: Uint8Array;
  waterSources: WaterSource[];
  sectorAnchor: { x: number; y: number }[];
  gateTiles: { x: number; y: number; sector: SectorId }[];
}

export function idx(x: number, y: number): number {
  return y * GRID_SIZE + x;
}

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE;
}

export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 由相对城心的方位得到 8 扇区(0=北,顺时针)
export function sectorOf(x: number, y: number): SectorId {
  const dx = x - CITY_CENTER;
  const dy = y - CITY_CENTER;
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  if (deg < 0) deg += 360;
  return Math.min(SECTOR_COUNT - 1, Math.floor(deg / 45)) as SectorId;
}

// 点是否落在东西/南北门洞的开放列上
function onGateAxis(p: number): boolean {
  return Math.abs(p - CITY_CENTER) <= GATE_HALF;
}

export function generateMap(seed = 20261122): MapData {
  const size = GRID_SIZE;
  const terrain = new Uint8Array(size * size);
  const wallHp = new Float32Array(size * size);
  const wallMaxHp = new Float32Array(size * size);
  const wallSector = new Int8Array(size * size).fill(-1);
  const isGate = new Uint8Array(size * size);
  const rng = makeRng(seed);
  const c = CITY_CENTER;

  const set = (x: number, y: number, t: Terrain) => {
    if (inBounds(x, y)) terrain[idx(x, y)] = t;
  };

  // 城墙几何:城心 c,外墙皮半径 rOut,内皮半径 rIn
  const rOut = c - WALL_OUTER; // 41
  const rIn = c - WALL_INNER; // 38

  // 1. 护城河:外墙外第 2 格一圈(半径 rOut+2),门洞轴上留桥
  const moatR = rOut + 2;
  for (let a = -moatR; a <= moatR; a++) {
    const axis = c + a;
    if (!onGateAxis(axis)) {
      // 上下横护城河
      set(axis, c - moatR, 4);
      set(axis, c + moatR, 4);
      // 左右竖护城河
      set(c - moatR, axis, 4);
      set(c + moatR, axis, 4);
    }
  }

  // 2. 城墙:四条边各 4 格厚,门洞轴上开门(东西南北各一门)
  const gateTiles: MapData['gateTiles'] = [];
  const placeWallOrGate = (x: number, y: number, gateAxisCoord: number) => {
    const sec = sectorOf(x, y);
    const opening = Math.abs(gateAxisCoord - c) <= GATE_HALF;
    if (opening) {
      set(x, y, 2);
      isGate[idx(x, y)] = 1;
      wallHp[idx(x, y)] = 300;
      wallMaxHp[idx(x, y)] = 300;
      wallSector[idx(x, y)] = sec;
      gateTiles.push({ x, y, sector: sec });
    } else {
      set(x, y, 1);
      wallHp[idx(x, y)] = 460;
      wallMaxHp[idx(x, y)] = 460;
      wallSector[idx(x, y)] = sec;
    }
  };
  // 厚度 4 格(半径 rIn..rOut),沿每条边扫过 -rOut..rOut
  for (let r = rIn; r <= rOut; r++) {
    for (let a = -rOut; a <= rOut; a++) {
      // 左右竖墙:x = c±r,门轴看 y
      placeWallOrGate(c - r, c + a, c + a);
      placeWallOrGate(c + r, c + a, c + a);
      // 上下横墙:y = c±r,门轴看 x
      placeWallOrGate(c + a, c - r, c + a);
      placeWallOrGate(c + a, c + r, c + a);
    }
  }

  // 3. 城内建筑街区(遮挡视线),避开十字门洞通道
  for (let bx = CITY_MIN + 6; bx < CITY_MAX - 8; bx += 14) {
    for (let by = CITY_MIN + 6; by < CITY_MAX - 8; by += 14) {
      const w = 3 + Math.floor(rng() * 4);
      const h = 3 + Math.floor(rng() * 4);
      const ox = bx + Math.floor(rng() * 4);
      const oy = by + Math.floor(rng() * 4);
      for (let x = ox; x < ox + w && x < CITY_MAX - 2; x++) {
        for (let y = oy; y < oy + h && y < CITY_MAX - 2; y++) {
          if (onGateAxis(x) || onGateAxis(y)) continue; // 留出门洞通道
          set(x, y, 3);
        }
      }
    }
  }

  // 4. 水源:北墙外渠首(攻方工兵可破坏),暗渠穿过北墙门洞入城
  const waterSources: WaterSource[] = [];
  const aqueductY = WALL_OUTER - 4;
  set(c, aqueductY, 5);
  waterSources.push({ id: 0, x: c, y: aqueductY, sabotaged: false });
  for (let y = WALL_INNER + 1; y <= WALL_INNER + 8; y++) set(c, y, 5);

  // 5. 八扇区墙外锚点(墙外 4 格,工兵集结用)
  const sectorAnchor: { x: number; y: number }[] = [];
  for (let s = 0; s < SECTOR_COUNT; s++) {
    const ang = (s * 45 - 90) * (Math.PI / 180);
    const r = WALL_OUTER - 4;
    sectorAnchor.push({
      x: Math.round(c + Math.cos(ang) * r),
      y: Math.round(c + Math.sin(ang) * r),
    });
  }

  return {
    size, terrain, wallHp, wallMaxHp, wallSector, isGate,
    waterSources, sectorAnchor, gateTiles,
  };
}

export function isWallTile(map: MapData, x: number, y: number): boolean {
  if (!inBounds(x, y)) return false;
  const t = map.terrain[idx(x, y)];
  return t === 1 || t === 2;
}

export function tileSector(map: MapData, x: number, y: number): number {
  if (!inBounds(x, y)) return -1;
  return map.wallSector[idx(x, y)];
}
