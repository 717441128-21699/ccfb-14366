// 影响力地图性能基准:256*256 单次更新必须 < 10ms
import { World } from '../src/sim/world';
import { updateInfluenceMap } from '../src/core/influence';

function percentile(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) * p)];
}

function main(): void {
  const world = new World({ seed: 42, difficulty: 'hard', maxTicks: 50 });
  // 先推进若干 tick 产生接触
  for (let i = 0; i < 30; i++) world.step();

  const samples: number[] = [];
  for (let i = 0; i < 200; i++) {
    updateInfluenceMap(world.influence, {
      map: world.map,
      units: world.units,
      contacts: world['contacts'] as never,
      sightScale: world.cfg.sightScale,
    });
    samples.push(world.influence.updateMs);
  }
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  const p99 = percentile(samples, 0.99);
  const max = Math.max(...samples);
  console.log('影响力地图更新耗时(ms),256x256,单位数:', world.units.length);
  console.log(`  p50=${p50.toFixed(3)}  p95=${p95.toFixed(3)}  p99=${p99.toFixed(3)}  max=${max.toFixed(3)}`);
  console.log(p95 < 10 ? 'PASS: p95 < 10ms' : 'FAIL: p95 >= 10ms');
  if (p95 >= 10) process.exit(1);
}

main();
