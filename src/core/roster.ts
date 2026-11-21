import type { UnitSpec, UnitKind, Roster, Difficulty } from './types';

// 兵种属性表 —— 攻防双方共用同一张表,难度不改变兵种数值
export const UNIT_SPECS: Record<UnitKind, UnitSpec> = {
  militia: {
    kind: 'militia', label: '民兵', maxHp: 60, damage: 8, range: 1, sight: 7,
    speed: 1.0, cooldownTicks: 10, isRanged: false, canClimb: true, canDig: false, cost: 1,
  },
  spear: {
    kind: 'spear', label: '长矛兵', maxHp: 95, damage: 14, range: 1.2, sight: 8,
    speed: 0.95, cooldownTicks: 12, isRanged: false, canClimb: true, canDig: false, cost: 2,
  },
  archer: {
    kind: 'archer', label: '弓手', maxHp: 55, damage: 10, range: 9, sight: 12,
    speed: 1.0, cooldownTicks: 14, isRanged: true, canClimb: true, canDig: false, cost: 2,
  },
  crossbow: {
    kind: 'crossbow', label: '弩手', maxHp: 60, damage: 18, range: 11, sight: 13,
    speed: 0.9, cooldownTicks: 22, isRanged: true, canClimb: false, canDig: false, cost: 3,
  },
  cavalry: {
    kind: 'cavalry', label: '骑兵', maxHp: 120, damage: 16, range: 1, sight: 11,
    speed: 1.9, cooldownTicks: 11, isRanged: false, canClimb: false, canDig: false, cost: 4,
  },
  engineer: {
    kind: 'engineer', label: '工兵', maxHp: 70, damage: 7, range: 1, sight: 8,
    speed: 1.0, cooldownTicks: 12, isRanged: false, canClimb: true, canDig: true, cost: 3,
  },
  guard: {
    kind: 'guard', label: '精锐卫队', maxHp: 150, damage: 20, range: 1.2, sight: 9,
    speed: 1.05, cooldownTicks: 10, isRanged: false, canClimb: true, canDig: false, cost: 5,
  },
};

// 双方使用完全相同的兵种与数量规模,难度差异只来自 AI 感知/反应配置
export const DEFENDER_ROSTER: Roster = {
  militia: 28, spear: 18, archer: 14, crossbow: 8, cavalry: 10, engineer: 4, guard: 8,
};
export const ATTACKER_ROSTER: Roster = {
  militia: 26, spear: 16, archer: 12, crossbow: 6, cavalry: 10, engineer: 8, guard: 4,
};

export function rosterSize(r: Roster): number {
  return Object.values(r).reduce((a, b) => a + b, 0);
}

export function* rosterKinds(r: Roster): Generator<UnitKind> {
  for (const k of Object.keys(r) as UnitKind[]) {
    for (let i = 0; i < r[k]; i++) yield k;
  }
}

// 难度只决定 AI 能看到多少信息、反应多快;不增兵、不强化属性
export interface PerceptionConfig {
  // 视野倍率:看到的敌人信息受此折扣(简单档大量信息要靠单位靠近才能确认)
  sightScale: number;
  // 影响力地图重算间隔(tick)
  mapInterval: number;
  // 决策周期(tick):越小反应越快
  decisionInterval: number;
  // 敌情确认需要的连续观测 tick 数(简单档反应慢)
  confirmTicks: number;
  // 预备队最低比例
  reserveFloor: number;
  // 佯攻判定:佯攻方向兵力承诺达到该比例才视为"真主攻"
  commitThreshold: number;
  // 佯攻判定:敌情持续不足该 tick 数时降级为佯攻
  feintSustainTicks: number;
  // 简单档是否启用地道/水源预警
  engineerWarning: boolean;
}

export const DIFFICULTY: Record<Difficulty, PerceptionConfig> = {
  easy: {
    sightScale: 0.55, mapInterval: 20, decisionInterval: 15, confirmTicks: 18,
    reserveFloor: 0.15, commitThreshold: 0.55, feintSustainTicks: 90, engineerWarning: false,
  },
  normal: {
    sightScale: 0.8, mapInterval: 10, decisionInterval: 8, confirmTicks: 8,
    reserveFloor: 0.35, commitThreshold: 0.35, feintSustainTicks: 45, engineerWarning: true,
  },
  hard: {
    sightScale: 1.0, mapInterval: 5, decisionInterval: 4, confirmTicks: 3,
    reserveFloor: 0.4, commitThreshold: 0.28, feintSustainTicks: 30, engineerWarning: true,
  },
};
