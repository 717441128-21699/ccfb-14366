// 仿真结果快照:供复盘页逐秒回放,只保留可序列化的轻量数据
export interface UnitSnapshot {
  id: number;
  side: 'defender' | 'attacker';
  kind: string;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
}

export interface FrameSnapshot {
  tick: number;
  units: UnitSnapshot[];
  ladders: { x: number; y: number; built: boolean; destroyed: boolean; sector: number }[];
  tunnels: { sector: number; progress: number; collapsed: boolean }[];
  waterCut: boolean;
  attackerEntered: boolean;
  result: string | null;
  // 该 tick 的扇区威胁等级(来自影响力地图聚合)
  sectorThreat: number[];
}

export interface ReplayPackage {
  seed: number;
  difficulty: string;
  tactic: string;
  maxTicks: number;
  mapSize: number;
  frames: FrameSnapshot[];
  // 行为树执行轨迹(决策 tick)
  traces: { tick: number; nodeId: string; label: string; status: string; evidence?: Record<string, unknown> }[];
  events: { tick: number; side: string; kind: string; detail: string }[];
  // 树定义(编辑页/复盘页共用渲染)
  defenderTree: unknown;
  attackerTree: unknown;
  attackerSteps: { id: string; label: string; dependsOn: string[]; state: string }[];
}
