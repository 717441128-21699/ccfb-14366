import type { BTNodeDef } from '../core/types';

const KIND_COLOR: Record<string, string> = {
  root: '#b45309',
  sequence: '#1d4ed8',
  selector: '#0e7490',
  parallel: '#7c3aed',
  leaf: '#15803d',
  decorator: '#9d174d',
};

const KIND_LABEL: Record<string, string> = {
  root: '根',
  sequence: '顺序',
  selector: '选择',
  parallel: '并行',
  decorator: '装饰',
  leaf: '叶子',
};

// 递归渲染行为树节点(编辑页与复盘页共用)
export function TreeNodeView({
  node,
  activeNodeIds,
  depth = 0,
}: {
  node: BTNodeDef;
  activeNodeIds?: Set<string>;
  depth?: number;
}) {
  const color = KIND_COLOR[node.kind] ?? '#374151';
  const active = activeNodeIds?.has(node.id) ?? false;
  return (
    <div className="tn-node" style={{ marginLeft: depth === 0 ? 0 : 18 }}>
      <div
        className={`tn-card${active ? ' tn-active' : ''}`}
        style={{ borderColor: color }}
      >
        <span className="tn-kind" style={{ background: color }}>
          {KIND_LABEL[node.kind] ?? node.kind}
        </span>
        <div className="tn-body">
          <div className="tn-label">{node.label}</div>
          {node.desc && node.desc !== node.label && (
            <div className="tn-desc">{node.desc}</div>
          )}
          {node.params && Object.keys(node.params).length > 0 && (
            <div className="tn-params">
              {Object.entries(node.params).map(([k, v]) => (
                <span key={k} className="tn-param">
                  {k}: {String(v)}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {node.children && node.children.length > 0 && (
        <div className="tn-children">
          {node.children.map((child) => (
            <TreeNodeView key={child.id} node={child} activeNodeIds={activeNodeIds} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
