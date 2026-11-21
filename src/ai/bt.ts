import type { BTNodeDef, BTNodeStatus, Difficulty } from '../core/types';
import type { PerceptionConfig } from '../core/roster';

// 行为树运行时框架。节点定义同时用于 AI 编辑页渲染。
export interface TraceEntry {
  tick: number;
  nodeId: string;
  label: string;
  status: BTNodeStatus;
  // 叶子节点记录的判断依据(键值),复盘页逐秒展示
  evidence?: Record<string, number | string | boolean>;
}

export interface BTContext {
  tick: number;
  difficulty: Difficulty;
  cfg: PerceptionConfig;
  blackboard: Record<string, unknown>;
  tracer: Tracer;
  // 叶子执行动作的回调(由具体 AI 注入)
  act: (action: string, args?: Record<string, number | string | boolean>) => BTNodeStatus;
  // 叶子读取感知量的回调
  sense: (key: string) => number | string | boolean;
}

export interface BTNode {
  def: BTNodeDef;
  tick(ctx: BTContext): BTNodeStatus;
}

export class Tracer {
  // 只在决策 tick 记录,且限制总量,避免复盘文件膨胀
  entries: TraceEntry[] = [];
  enabled = true;
  maxEntries = 6000;
  // 决策事件(调兵/战术切换)单独存,复盘时间线用
  events: DecisionEvent[] = [];

  log(e: TraceEntry): void {
    if (!this.enabled || this.entries.length >= this.maxEntries) return;
    this.entries.push(e);
  }

  event(e: DecisionEvent): void {
    if (!this.enabled || this.events.length >= 1200) return;
    this.events.push(e);
  }

  reset(): void {
    this.entries = [];
    this.events = [];
  }
}

export interface DecisionEvent {
  tick: number;
  side: 'defender' | 'attacker';
  kind: string;
  detail: string;
  data?: Record<string, number | string | boolean>;
}

// ---- 组合节点 ----

class SequenceNode implements BTNode {
  constructor(public def: BTNodeDef, private children: BTNode[]) {}
  tick(ctx: BTContext): BTNodeStatus {
    for (const c of this.children) {
      const s = c.tick(ctx);
      if (s !== 'success') return s;
    }
    return 'success';
  }
}

class SelectorNode implements BTNode {
  constructor(public def: BTNodeDef, private children: BTNode[]) {}
  tick(ctx: BTContext): BTNodeStatus {
    for (const c of this.children) {
      const s = c.tick(ctx);
      if (s !== 'failure') return s;
    }
    return 'failure';
  }
}

class ParallelNode implements BTNode {
  constructor(public def: BTNodeDef, private children: BTNode[]) {}
  tick(ctx: BTContext): BTNodeStatus {
    let running = false;
    let failed = false;
    for (const c of this.children) {
      const s = c.tick(ctx);
      if (s === 'running') running = true;
      if (s === 'failure') failed = true;
    }
    if (failed) return 'failure';
    return running ? 'running' : 'success';
  }
}

export interface LeafFn {
  (ctx: BTContext): BTNodeStatus;
}

class LeafNode implements BTNode {
  constructor(public def: BTNodeDef, private fn: LeafFn) {}
  tick(ctx: BTContext): BTNodeStatus {
    const s = this.fn(ctx);
    ctx.tracer.log({
      tick: ctx.tick, nodeId: this.def.id, label: this.def.label, status: s,
      evidence: this.def.params ? { ...this.def.params } : undefined,
    });
    return s;
  }
}

class DecoratorNode implements BTNode {
  constructor(public def: BTNodeDef, private child: BTNode, private mode: 'invert' | 'cooldown') {}
  tick(ctx: BTContext): BTNodeStatus {
    if (this.mode === 'invert') {
      const s = this.child.tick(ctx);
      if (s === 'success') return 'failure';
      if (s === 'failure') return 'success';
      return s;
    }
    return this.child.tick(ctx);
  }
}

// ---- 构造 DSL,产出可渲染的 BTNodeDef 树 + 可执行节点树 ----

export class BTBuilder {
  private counter = 0;
  private uid(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  root(label: string, child: NodeRef): BuiltTree {
    const def: BTNodeDef = { id: this.uid('root'), kind: 'root', label, desc: label, children: [child.def] };
    return { def, root: child.node };
  }

  sequence(label: string, children: NodeRef[], desc = ''): NodeRef {
    const def: BTNodeDef = {
      id: this.uid('seq'), kind: 'sequence', label, desc: desc || label,
      children: children.map((c) => c.def),
    };
    return { def, node: new SequenceNode(def, children.map((c) => c.node)) };
  }

  selector(label: string, children: NodeRef[], desc = ''): NodeRef {
    const def: BTNodeDef = {
      id: this.uid('sel'), kind: 'selector', label, desc: desc || label,
      children: children.map((c) => c.def),
    };
    return { def, node: new SelectorNode(def, children.map((c) => c.node)) };
  }

  parallel(label: string, children: NodeRef[], desc = ''): NodeRef {
    const def: BTNodeDef = {
      id: this.uid('par'), kind: 'parallel', label, desc: desc || label,
      children: children.map((c) => c.def),
    };
    return { def, node: new ParallelNode(def, children.map((c) => c.node)) };
  }

  leaf(
    label: string,
    fn: LeafFn,
    params?: Record<string, number | string | boolean>,
    desc = '',
  ): NodeRef {
    const def: BTNodeDef = { id: this.uid('leaf'), kind: 'leaf', label, desc: desc || label, params };
    return { def, node: new LeafNode(def, fn) };
  }

  invert(label: string, child: NodeRef): NodeRef {
    const def: BTNodeDef = { id: this.uid('dec'), kind: 'decorator', label, desc: '取反', children: [child.def] };
    return { def, node: new DecoratorNode(def, child.node, 'invert') };
  }
}

export interface NodeRef {
  def: BTNodeDef;
  node: BTNode;
}

export interface BuiltTree {
  def: BTNodeDef;
  root: BTNode;
}
