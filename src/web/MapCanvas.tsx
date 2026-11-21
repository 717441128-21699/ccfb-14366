import { useEffect, useRef } from 'react';
import type { FrameSnapshot } from './replayTypes';
import { TERRAIN_NAMES } from '../core/types';

// 256 格地图缩放到画布的渲染器:画地形、单位、工程与影响力扇区威胁
export function MapCanvas({
  frame,
  terrainRef,
  size,
}: {
  frame: FrameSnapshot;
  // 地形 Uint8Array 的引用(每帧不变,避免重复传)
  terrainRef: React.RefObject<Uint8Array | null>;
  size: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const scale = W / size;

    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, W);

    // 地形(降采样:每像素代表一格,256 -> 画布)
    const terrain = terrainRef.current;
    if (terrain) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const t = terrain[y * size + x];
          ctx.fillStyle = TERRAIN_COLOR[t] ?? '#0b1220';
          ctx.fillRect(x * scale, y * scale, Math.ceil(scale), Math.ceil(scale));
        }
      }
    }

    // 扇区威胁热力(半透明红)
    const cx = size / 2;
    const cy = size / 2;
    frame.sectorThreat.forEach((threat, s) => {
      if (threat <= 0) return;
      const ang = (s * 45 - 90) * (Math.PI / 180);
      const r = size * 0.32;
      const hx = cx + Math.cos(ang) * r;
      const hy = cy + Math.sin(ang) * r;
      const radius = 12 + Math.min(28, threat * 4);
      const grad = ctx.createRadialGradient(hx, hy, 0, hx, hy, radius);
      grad.addColorStop(0, `rgba(239,68,68,${Math.min(0.6, threat * 0.15)})`);
      grad.addColorStop(1, 'rgba(239,68,68,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(hx, hy, radius, 0, Math.PI * 2);
      ctx.fill();
    });

    // 工程:云梯/地道
    for (const l of frame.ladders) {
      ctx.fillStyle = l.destroyed ? '#525252' : l.built ? '#f59e0b' : '#fbbf24';
      ctx.fillRect(l.x * scale - 2, l.y * scale - 2, 4, 4);
    }
    for (const t of frame.tunnels) {
      if (!t.collapsed) continue;
      ctx.fillStyle = '#78350f';
      ctx.beginPath();
      ctx.arc((size / 2) * scale, (size / 2) * scale, 2, 0, Math.PI * 2);
      void t;
    }

    // 单位
    for (const u of frame.units) {
      if (!u.alive) continue;
      const isDef = u.side === 'defender';
      ctx.fillStyle = isDef ? '#38bdf8' : '#f87171';
      const px = u.x * scale;
      const py = u.y * scale;
      ctx.beginPath();
      ctx.arc(px, py, isDef ? 1.6 : 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // 图例状态
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '11px monospace';
    ctx.fillText(`tick ${frame.tick}  破城=${frame.attackerEntered ? '是' : '否'}  断水=${frame.waterCut ? '是' : '否'}`, 8, 14);
  }, [frame, terrainRef, size]);

  return <canvas ref={canvasRef} width={560} height={560} className="map-canvas" />;
}

const TERRAIN_COLOR: Record<number, string> = {
  0: '#111827', // 平地
  1: '#475569', // 城墙
  2: '#a16207', // 城门
  3: '#1e293b', // 建筑
  4: '#0e7490', // 水域
  5: '#0891b2', // 水源
  6: '#78350f', // 塌陷
};

void TERRAIN_NAMES;
