import type { GraphEdge, GraphNode } from '../ports/types';

function getEdgeTypeLabel(edgeType: GraphEdge['type']): string {
  switch (edgeType) {
    case 'blocking':
      return 'Blocking';
    case 'ownership':
      return 'Ownership';
    case 'related':
      return 'Related';
    case 'message':
      return 'Message';
    case 'parent-child':
      return 'Parent-child';
  }
}

export interface GraphEdgeOverlayProps {
  edge: GraphEdge;
  sourceNode: GraphNode | undefined;
  targetNode: GraphNode | undefined;
  onClose: () => void;
}

export function GraphEdgeOverlay({
  edge,
  sourceNode,
  targetNode,
  onClose,
}: GraphEdgeOverlayProps): React.JSX.Element {
  return (
    <div
      className="rounded-lg p-3 min-w-[180px] max-w-[240px] shadow-xl"
      style={{
        background: 'rgba(10, 15, 30, 0.92)',
        border: '1px solid rgba(100, 200, 255, 0.15)',
        backdropFilter: 'blur(8px)',
      }}
    >
      <div className="text-[10px] font-mono uppercase tracking-[0.14em]" style={{ color: '#66ccff90' }}>
        {getEdgeTypeLabel(edge.type)}
      </div>
      <div className="mt-1 text-xs font-mono font-bold" style={{ color: edge.color ?? '#aaeeff' }}>
        {sourceNode?.label ?? edge.source} -&gt; {targetNode?.label ?? edge.target}
      </div>
      {edge.label && (
        <div className="mt-1 text-[10px] leading-relaxed" style={{ color: '#d7f2ffcc' }}>
          {edge.label}
        </div>
      )}
      <div className="mt-2 flex gap-1">
        <button
          onClick={onClose}
          className="text-[10px] px-2 py-1 rounded font-mono cursor-pointer"
          style={{
            background: 'rgba(100, 200, 255, 0.08)',
            border: '1px solid rgba(100, 200, 255, 0.15)',
            color: '#aaeeff',
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}
