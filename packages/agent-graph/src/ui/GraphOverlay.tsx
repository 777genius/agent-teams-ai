/**
 * GraphOverlay — minimal built-in popover fallback.
 * Used ONLY when host app doesn't provide renderOverlay prop.
 * For full-featured popovers, use renderOverlay with project UI components.
 */

import type { GraphNode } from '../ports/types';
import type { GraphEventPort } from '../ports/GraphEventPort';

export interface GraphOverlayProps {
  selectedNode: GraphNode | null;
  events?: GraphEventPort;
  onDeselect: () => void;
}

export function GraphOverlay({
  selectedNode,
  events,
  onDeselect,
}: GraphOverlayProps): React.JSX.Element | null {
  if (!selectedNode) return null;

  return (
    <div
      className="rounded-lg p-3 min-w-[160px] max-w-[220px] shadow-xl"
      style={{
        background: 'rgba(10, 15, 30, 0.9)',
        border: '1px solid rgba(100, 200, 255, 0.15)',
        backdropFilter: 'blur(8px)',
      }}
    >
      <div className="text-xs font-mono font-bold" style={{ color: selectedNode.color ?? '#aaeeff' }}>
        {selectedNode.label}
      </div>
      {selectedNode.sublabel && (
        <div className="mt-0.5 text-[10px] truncate" style={{ color: '#66ccff90' }}>
          {selectedNode.sublabel}
        </div>
      )}
      {selectedNode.role && (
        <div className="mt-0.5 text-[10px]" style={{ color: '#66ccff70' }}>
          {selectedNode.role}
        </div>
      )}
      <div className="mt-2 flex gap-1">
        {(selectedNode.kind === 'member' || selectedNode.kind === 'lead') && (
          <FallbackButton
            label="Message"
            onClick={() => {
              const ref = selectedNode.domainRef;
              if (ref.kind === 'member') events?.onSendMessage?.(ref.memberName, ref.teamName);
              onDeselect();
            }}
          />
        )}
        <FallbackButton label="Close" onClick={onDeselect} />
      </div>
    </div>
  );
}

function FallbackButton({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="text-[10px] px-2 py-1 rounded font-mono cursor-pointer"
      style={{
        background: 'rgba(100, 200, 255, 0.08)',
        border: '1px solid rgba(100, 200, 255, 0.15)',
        color: '#aaeeff',
      }}
    >
      {label}
    </button>
  );
}
