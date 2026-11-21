// 全局共享类型定义

export type Side = 'defender' | 'attacker';

export type UnitKind =
  | 'militia' // 民兵:便宜近战,守城填充
  | 'spear' // 长矛:反近战,守门/反登城
  | 'archer' // 弓手:远程
  | 'crossbow' // 弩手:高伤远程,射速慢
  | 'cavalry' // 骑兵:机动预备队
  | 'engineer' // 工兵:地道/云梯/破坏水源
  | 'guard'; // 精锐卫队:高血量近战

export interface UnitSpec {
  kind: UnitKind;
  label: string;
  maxHp: number;
  damage: number;
  range: number; // 攻击射程(格)
  sight: number; // 视野半径(格)
  speed: number; // 每 tick 移动格数(浮点)
  cooldownTicks: number; // 攻击间隔
  isRanged: boolean;
  canClimb: boolean; // 可爬云梯
  canDig: boolean; // 可挖地道/破坏
  cost: number; // 用于生成兵力的资源权重
}

export interface Unit {
  id: number;
  side: Side;
  kind: UnitKind;
  x: number;
  y: number;
  hp: number;
  cooldown: number; // 剩余冷却 tick
  squadId: number;
  alive: boolean;
  // 工兵工程进度(地道/云梯/水源),通用计时字段
  work: number;
}

export type OrderType =
  | 'hold' // 驻守锚点
  | 'move' // 移动到锚点
  | 'assault' // 进攻(移动到锚点,接敌自动打)
  | 'climb' // 登城:走向云梯
  | 'tunnel' // 挖地道(工兵)
  | 'sabotage' // 破坏水源(工兵)
  | 'buildLadder' // 架云梯(工兵)
  | 'retreat'; // 撤退

export interface Order {
  type: OrderType;
  x: number;
  y: number;
  // 工程目标 id(云梯/地道/水源点)
  targetId?: number;
}

export interface Squad {
  id: number;
  side: Side;
  name: string;
  unitIds: number[];
  order: Order;
  // 最近一次换令的 tick,用于反应延迟统计
  orderTick: number;
}

// 地形
export type Terrain =
  | 0 // 平地
  | 1 // 城墙
  | 2 // 城门
  | 3 // 建筑(城内,遮挡视线)
  | 4 // 水域(护城河/河)
  | 5 // 水源点(井/河渠入口)
  | 6; // 地道塌陷区

export const TERRAIN_NAMES = ['平地', '城墙', '城门', '建筑', '水域', '水源点', '塌陷区'];

// 城墙八方位扇区
export type SectorId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const SECTOR_LABELS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
export const SECTOR_COUNT = 8;

export interface WallState {
  hp: number; // 当前耐久
  maxHp: number;
  sector: SectorId;
  isGate: boolean;
}

export interface Ladder {
  id: number;
  x: number;
  y: number; // 靠在城墙外侧的格
  sector: number;
  built: boolean;
  destroyed: boolean;
  hp: number;
  // 最近一次(重)架设的 tick,保护期内守军射击伤害大幅降低
  placedTick: number;
}

export interface Tunnel {
  id: number;
  targetSector: number;
  // 工兵从城外起点向墙基推进的进度 0..1
  progress: number;
  collapsed: boolean;
  // 塌陷生效的墙格
  wallX: number;
  wallY: number;
}

export interface WaterSource {
  id: number;
  x: number;
  y: number;
  sabotaged: boolean;
}

export type Difficulty = 'easy' | 'normal' | 'hard';

export type TacticId =
  | 'feintEastThenWest' // 东门佯攻→西门主攻(经典打穿 if-AI 的招)
  | 'feintNorthThenSouth'
  | 'ladderAssault' // 云梯强攻
  | 'tunnelBreach' // 地道破墙
  | 'waterSabotage' // 断水源
  | 'allOut'; // 全军压上

export interface Roster {
  militia: number;
  spear: number;
  archer: number;
  crossbow: number;
  cavalry: number;
  engineer: number;
  guard: number;
}

// 行为树节点定义(也用于编辑页渲染)
export type BTNodeStatus = 'success' | 'failure' | 'running';

export interface BTNodeDef {
  id: string;
  kind: 'root' | 'sequence' | 'selector' | 'parallel' | 'leaf' | 'decorator';
  label: string;
  desc: string;
  children?: BTNodeDef[];
  // 叶子/装饰器可调参数(编辑页可改)
  params?: Record<string, number | string | boolean>;
}
