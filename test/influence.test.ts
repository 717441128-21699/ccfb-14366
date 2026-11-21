import { describe, it, expect } from 'vitest';
import { World } from '../src/sim/world';
import { updateInfluenceMap } from '../src/core/influence';
import { GRID_SIZE } from '../src/core/mapgen';

describe('影响力地图', () => {
  it('256x256 单次更新 p95 低于 10ms', () => {
    const w = new World({ seed: 1, difficulty: 'hard', maxTicks: 40 });
    for (let i = 0; i < 25; i++) w.step();
    const samples: number[] = [];
    for (let i = 0; i < 120; i++) {
      updateInfluenceMap(w.influence, {
        map: w.map,
        units: w.units,
        contacts: (w as unknown as { contacts: Map<number, unknown> }).contacts as never,
        sightScale: w.cfg.sightScale,
      });
      samples.push(w.influence.updateMs);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(GRID_SIZE).toBe(256);
    expect(p95).toBeLessThan(10);
  });

  it('包含兵力/威胁/火力/视野/城墙完整度多层', () => {
    const w = new World({ seed: 1, difficulty: 'normal', maxTicks: 5 });
    // 主动重算一次以填充墙层
    updateInfluenceMap(w.influence, {
      map: w.map,
      units: w.units,
      contacts: (w as unknown as { contacts: Map<number, unknown> }).contacts as never,
      sightScale: w.cfg.sightScale,
    });
    const im = w.influence;
    expect(im.defender.force).toBeInstanceOf(Float32Array);
    expect(im.attacker.threat).toBeInstanceOf(Float32Array);
    expect(im.defender.ranged).toBeInstanceOf(Float32Array);
    expect(im.attacker.vision).toBeInstanceOf(Float32Array);
    expect(im.wall.length).toBe(GRID_SIZE * GRID_SIZE);
    // 城墙格完整度初始为 1
    let wallCell = -1;
    for (let i = 0; i < w.map.terrain.length; i++) {
      if (w.map.terrain[i] === 1) { wallCell = i; break; }
    }
    expect(wallCell).toBeGreaterThan(-1);
    expect(im.wall[wallCell]).toBeCloseTo(1, 2);
  });
});
