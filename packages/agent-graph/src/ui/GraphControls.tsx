/**
 * GraphControls — floating toolbar over the canvas.
 * Positioned below system buttons (top-10) to avoid overlap on macOS.
 */

import { useCallback } from 'react';
import {
  Columns3,
  Expand,
  Eye,
  EyeOff,
  Maximize2,
  Minus,
  Pause,
  Pin,
  Play,
  Plus,
  Server,
  X,
} from 'lucide-react';

export interface GraphFilterState {
  showTasks: boolean;
  showProcesses: boolean;
  showEdges: boolean;
  paused: boolean;
}

export interface GraphControlsProps {
  filters: GraphFilterState;
  onFiltersChange: (filters: GraphFilterState) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomToFit: () => void;
  onRequestClose?: () => void;
  onRequestPinAsTab?: () => void;
  onRequestFullscreen?: () => void;
  teamName: string;
  teamColor?: string;
  isAlive?: boolean;
}

export function GraphControls({
  filters,
  onFiltersChange,
  onZoomIn,
  onZoomOut,
  onZoomToFit,
  onRequestClose,
  onRequestPinAsTab,
  onRequestFullscreen,
  teamName,
  teamColor,
  isAlive,
}: GraphControlsProps): React.JSX.Element {
  const toggle = useCallback(
    (key: keyof GraphFilterState) => {
      onFiltersChange({ ...filters, [key]: !filters[key] });
    },
    [filters, onFiltersChange],
  );

  const nameColor = teamColor ?? '#aaeeff';

  return (
    <div className="absolute top-2 left-20 right-3 flex items-center justify-between pointer-events-none z-10">
      {/* Left: team name + status indicator */}
      <div className="flex items-center pointer-events-auto">
        <div
          className="flex items-center gap-2 rounded-lg px-3 py-1.5 backdrop-blur-sm"
          style={{
            background: 'rgba(8, 12, 24, 0.8)',
            border: `1px solid ${nameColor}25`,
          }}
        >
          {isAlive && (
            <div
              className="size-2 rounded-full animate-pulse"
              style={{ background: nameColor }}
            />
          )}
          <span
            className="text-xs font-mono font-semibold"
            style={{ color: nameColor }}
          >
            {teamName}
          </span>
        </div>
      </div>

      {/* Center: filter toggles */}
      <div
        className="flex items-center gap-0.5 rounded-lg px-1 py-0.5 pointer-events-auto backdrop-blur-sm"
        style={{ background: 'rgba(8, 12, 24, 0.8)', border: '1px solid rgba(100, 200, 255, 0.08)' }}
      >
        <ToolbarToggle
          active={filters.showTasks}
          onClick={() => toggle('showTasks')}
          icon={<Columns3 size={13} />}
          label="Tasks"
        />
        <ToolbarToggle
          active={filters.showProcesses}
          onClick={() => toggle('showProcesses')}
          icon={<Server size={13} />}
          label="Proc"
        />
        <ToolbarToggle
          active={filters.showEdges}
          onClick={() => toggle('showEdges')}
          icon={filters.showEdges ? <Eye size={13} /> : <EyeOff size={13} />}
          label="Edges"
        />
        <Separator />
        <ToolbarButton
          onClick={() => toggle('paused')}
          icon={filters.paused ? <Play size={13} /> : <Pause size={13} />}
        />
      </div>

      {/* Right: zoom + actions */}
      <div
        className="flex items-center gap-0.5 rounded-lg px-1 py-0.5 pointer-events-auto backdrop-blur-sm"
        style={{ background: 'rgba(8, 12, 24, 0.8)', border: '1px solid rgba(100, 200, 255, 0.08)' }}
      >
        <ToolbarButton onClick={onZoomOut} icon={<Minus size={13} />} />
        <ToolbarButton onClick={onZoomToFit} icon={<Maximize2 size={13} />} />
        <ToolbarButton onClick={onZoomIn} icon={<Plus size={13} />} />
        {onRequestPinAsTab && (
          <>
            <Separator />
            <ToolbarButton
              onClick={onRequestPinAsTab}
              icon={<Pin size={13} />}
              label="Pin"
            />
          </>
        )}
        {onRequestFullscreen && (
          <>
            <Separator />
            <ToolbarButton
              onClick={onRequestFullscreen}
              icon={<Expand size={13} />}
              label="Fullscreen"
            />
          </>
        )}
        {onRequestClose && (
          <ToolbarButton onClick={onRequestClose} icon={<X size={13} />} />
        )}
      </div>
    </div>
  );
}

// ─── Primitives ─────────────────────────────────────────────────────────────

function ToolbarButton({
  onClick,
  icon,
  label,
}: {
  onClick?: () => void;
  icon: React.ReactNode;
  label?: string;
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-mono transition-colors
        text-[#66ccff90] hover:text-[#aaeeff] hover:bg-[rgba(100,200,255,0.1)] cursor-pointer"
    >
      {icon}
      {label && <span>{label}</span>}
    </button>
  );
}

function ToolbarToggle({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-mono transition-all cursor-pointer border
        ${active
          ? 'text-[#aaeeffcc] bg-[rgba(100,200,255,0.08)] border-[rgba(100,200,255,0.12)]'
          : 'text-[#66ccff40] bg-transparent border-transparent hover:text-[#66ccff70] hover:border-[rgba(100,200,255,0.08)]'
        }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Separator(): React.JSX.Element {
  return <div className="mx-0.5 h-4 w-px bg-[rgba(100,200,255,0.08)]" />;
}
