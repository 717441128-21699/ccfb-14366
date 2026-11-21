import { useMemo, useRef, useState } from 'react';
import { recordReplay } from './record';
import type { ReplayPackage } from './replayTypes';
import { TreeNodeView } from './TreeNodeView';
import { MapCanvas } from './MapCanvas';
import { DIFFICULTY, UNIT_SPECS } from '../core/roster';
import { TACTIC_NAMES } from '../ai/attacker';
import { SECTOR_LABELS } from '../core/types';
import type { BTNodeDef, Difficulty, TacticId } from '../core/types';
import { generateMap } from '../core/mapgen';

type Tab = 'editor' | 'replay';

const TACTICS = Object.keys(TACTIC_NAMES) as TacticId[];

export function App() {
  const [tab, setTab] = useState<Tab>('replay');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [tactic, setTactic] = useState<TacticId>('feintEastThenWest');
  const [seed, setSeed] = useState(1234);
  const [replay, setReplay] = useState<ReplayPackage | null>(null);
  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const terrainRef = useRef<Uint8Array | null>(null);

  const map = useMemo(() => generateMap(seed), [seed]);
  if (!terrainRef.current) terrainRef.current = map.terrain;

  const run = () => {
    const pkg = recordReplay({ seed, difficulty, tactic });
    terrainRef.current = generateMap(seed).terrain;
    setReplay(pkg);
    setFrameIdx(0);
    setPlaying(true);
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>守城 / 攻城 AI 工作台</h1>
        <nav className="tabs">
          <button className={tab === 'editor' ? 'active' : ''} onClick={() => setTab('editor')}>
            AI 编辑页
          </button>
          <button className={tab === 'replay' ? 'active' : ''} onClick={() => setTab('replay')}>
            复盘页
          </button>
        </nav>
      </header>

      <section className="controls">
        <label>
          难度
          <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty)}>
            <option value="easy">简单(视野差/反应慢)</option>
            <option value="normal">普通</option>
            <option value="hard">困难(全感知/快反应)</option>
          </select>
        </label>
        <label>
          攻方战术
          <select value={tactic} onChange={(e) => setTactic(e.target.value as TacticId)}>
            {TACTICS.map((t) => (
              <option key={t} value={t}>{TACTIC_NAMES[t]}</option>
            ))}
          </select>
        </label>
        <label>
          种子
          <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} />
        </label>
        <button className="primary" onClick={run}>运行仿真</button>
      </section>

      {tab === 'editor' ? (
        <EditorPage difficulty={difficulty} replay={replay} />
      ) : (
        <ReplayPage
          replay={replay}
          frameIdx={frameIdx}
          setFrameIdx={setFrameIdx}
          playing={playing}
          setPlaying={setPlaying}
          terrainRef={terrainRef}
        />
      )}
    </div>
  );
}

// ---------------- AI 编辑页 ----------------
function EditorPage({ difficulty, replay }: { difficulty: Difficulty; replay: ReplayPackage | null }) {
  const cfg = DIFFICULTY[difficulty];
  const [which, setWhich] = useState<'defender' | 'attacker'>('defender');
  const tree = (replay
    ? (which === 'defender' ? replay.defenderTree : replay.attackerTree)
    : null) as BTNodeDef | null;

  return (
    <div className="editor">
      <div className="editor-side">
        <div className="seg">
          <button className={which === 'defender' ? 'active' : ''} onClick={() => setWhich('defender')}>
            守城 AI 树
          </button>
          <button className={which === 'attacker' ? 'active' : ''} onClick={() => setWhich('attacker')}>
            攻城 AI 树
          </button>
        </div>
        <div className="cfg-card">
          <h3>{difficulty} 档感知/反应参数</h3>
          <table>
            <tbody>
              <tr><td>视野倍率</td><td>{cfg.sightScale}</td></tr>
              <tr><td>影响力地图间隔(tick)</td><td>{cfg.mapInterval}</td></tr>
              <tr><td>决策周期(tick)</td><td>{cfg.decisionInterval}</td></tr>
              <tr><td>敌情确认(tick)</td><td>{cfg.confirmTicks}</td></tr>
              <tr><td>预备队底线</td><td>{(cfg.reserveFloor * 100).toFixed(0)}%</td></tr>
              <tr><td>主攻承诺阈值</td><td>{cfg.commitThreshold}</td></tr>
              <tr><td>佯攻持续判定(tick)</td><td>{cfg.feintSustainTicks}</td></tr>
              <tr><td>工程预警</td><td>{cfg.engineerWarning ? '开' : '关'}</td></tr>
            </tbody>
          </table>
          <p className="hint">三档差异只来自可见信息与反应速度,双方兵力与兵种数值完全相同。</p>
        </div>
        <div className="cfg-card">
          <h3>兵种数值(攻防共用)</h3>
          <div className="roster-grid">
            {Object.values(UNIT_SPECS).map((s) => (
              <div key={s.kind} className="roster-item">
                <b>{s.label}</b>
                <span>血{s.maxHp} 伤{s.damage} 程{s.range} 视{s.sight}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="editor-tree">
        {tree ? (
          <TreeNodeView node={tree} />
        ) : (
          <div className="empty">先在上方选择参数并「运行仿真」,即可在此查看行为树结构与叶子节点判定逻辑。</div>
        )}
      </div>
    </div>
  );
}

// ---------------- 复盘页 ----------------
function ReplayPage({
  replay, frameIdx, setFrameIdx, playing, setPlaying, terrainRef,
}: {
  replay: ReplayPackage | null;
  frameIdx: number;
  setFrameIdx: (n: number) => void;
  playing: boolean;
  setPlaying: (b: boolean) => void;
  terrainRef: React.RefObject<Uint8Array | null>;
}) {
  // 自动播放
  usePlayback(playing, replay, frameIdx, setFrameIdx, setPlaying);

  if (!replay) {
    return <div className="empty">运行一局仿真后,这里会逐秒回放地图、单位行动与 AI 当时的判断依据。</div>;
  }
  const frame = replay.frames[Math.min(frameIdx, replay.frames.length - 1)];
  const tick = frame.tick;

  // 当前 tick 附近的行为树轨迹与事件(判断依据)
  const nearbyTraces = replay.traces.filter((t) => Math.abs(t.tick - tick) <= replay.maxTicks / 40);
  const activeNodeIds = new Set(nearbyTraces.map((t) => t.nodeId));
  const recentEvents = replay.events.filter((e) => e.tick <= tick).slice(-12).reverse();

  return (
    <div className="replay">
      <div className="replay-map">
        <MapCanvas frame={frame} terrainRef={terrainRef} size={replay.mapSize} />
        <div className="timeline">
          <button onClick={() => setPlaying(!playing)}>{playing ? '暂停' : '播放'}</button>
          <input
            type="range"
            min={0}
            max={replay.frames.length - 1}
            value={Math.min(frameIdx, replay.frames.length - 1)}
            onChange={(e) => { setPlaying(false); setFrameIdx(Number(e.target.value)); }}
          />
          <span className="tick-label">
            {frameIdx + 1}/{replay.frames.length} 帧 · tick {tick}
          </span>
        </div>
        <div className="sector-bar">
          {frame.sectorThreat.map((th, s) => (
            <div key={s} className="sector-cell" title={`${SECTOR_LABELS[s]}扇区 威胁${th.toFixed(1)}`}>
              <span className="sector-name">{SECTOR_LABELS[s]}</span>
              <div className="sector-meter">
                <div className="sector-fill" style={{ height: `${Math.min(100, th * 8)}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="replay-side">
        <div className="cfg-card">
          <h3>AI 判断依据(当前 tick 附近)</h3>
          <div className="trace-list">
            {nearbyTraces.length === 0 && <p className="hint">该时刻无决策节点触发</p>}
            {nearbyTraces.slice(-14).reverse().map((t, i) => (
              <div key={i} className={`trace-item trace-${t.status}`}>
                <span className="trace-tick">t{t.tick}</span>
                <span className="trace-label">{t.label}</span>
                <span className="trace-status">{t.status}</span>
                {t.evidence && (
                  <div className="trace-evidence">
                    {Object.entries(t.evidence).map(([k, v]) => (
                      <span key={k}>{k}={String(v)}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="cfg-card">
          <h3>决策事件时间线</h3>
          <div className="event-list">
            {recentEvents.map((e, i) => (
              <div key={i} className={`event-item event-${e.side}`}>
                <span className="event-tick">t{e.tick}</span>
                <span className="event-detail">{e.detail}</span>
              </div>
            ))}
          </div>
        </div>
        {replay.attackerSteps.length > 0 && (
          <div className="cfg-card">
            <h3>攻城战术步骤依赖</h3>
            <ol className="step-list">
              {replay.attackerSteps.map((s) => (
                <li key={s.id} className={`step-${s.state}`}>
                  {s.label}
                  <span className="step-deps">
                    {s.dependsOn.length > 0 ? ` 依赖: ${s.dependsOn.join(',')}` : ' (起始步骤)'}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
        <div className="cfg-card">
          <h3>守城行为树(高亮=当前激活节点)</h3>
          <TreeNodeView node={replay.defenderTree as BTNodeDef} activeNodeIds={activeNodeIds} />
        </div>
      </div>
    </div>
  );
}

function usePlayback(
  playing: boolean,
  replay: ReplayPackage | null,
  frameIdx: number,
  setFrameIdx: (n: number) => void,
  setPlaying: (b: boolean) => void,
) {
  const idxRef = useRef(frameIdx);
  idxRef.current = frameIdx;
  const cbRef = useRef<number | null>(null);
  if (typeof window !== 'undefined') {
    if (cbRef.current !== null) {
      window.clearInterval(cbRef.current);
      cbRef.current = null;
    }
    if (playing && replay) {
      cbRef.current = window.setInterval(() => {
        const next = idxRef.current + 1;
        if (next >= replay.frames.length) {
          setPlaying(false);
        } else {
          setFrameIdx(next);
        }
      }, 120);
    }
  }
}
