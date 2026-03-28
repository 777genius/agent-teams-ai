/**
 * GraphControls — floating toolbar over the canvas.
 * Positioned below system buttons (top-10) to avoid overlap on macOS.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Columns3,
  Expand,
  Settings2,
  Eye,
  EyeOff,
  Maximize2,
  Pause,
  Pin,
  Play,
  Server,
  X,
  ZoomIn,
  ZoomOut,
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
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const toggle = useCallback(
    (key: keyof GraphFilterState) => {
      onFiltersChange({ ...filters, [key]: !filters[key] });
    },
    [filters, onFiltersChange],
  );

  useEffect(() => {
    if (!isSettingsOpen) return;

    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (settingsRef.current?.contains(target)) return;
      setIsSettingsOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsSettingsOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isSettingsOpen]);

  const nameColor = teamColor ?? '#aaeeff';

  return (
    <>
      <div className="absolute left-3 top-3 z-10 flex items-center gap-3 pointer-events-none">
        <div
          className="pointer-events-auto flex items-center gap-2 rounded-lg px-3 py-1.5 backdrop-blur-sm"
          style={{
            background: 'rgba(8, 12, 24, 0.8)',
            border: `1px solid ${nameColor}25`,
          }}
        >
          {isAlive && (
            <div className="size-2 rounded-full animate-pulse" style={{ background: nameColor }} />
          )}
          <span className="text-xs font-mono font-semibold" style={{ color: nameColor }}>
            {teamName}
          </span>
        </div>
      </div>

      <div className="absolute right-3 top-3 z-10 flex items-center gap-2 pointer-events-none">
        <div ref={settingsRef} className="relative pointer-events-auto">
          <div
            className="flex items-center gap-0.5 rounded-lg px-1 py-0.5 backdrop-blur-sm"
            style={{
              background: 'rgba(8, 12, 24, 0.8)',
              border: '1px solid rgba(100, 200, 255, 0.08)',
            }}
          >
            <ToolbarButton
              onClick={() => setIsSettingsOpen((value) => !value)}
              icon={<Settings2 size={14} />}
              label="View"
              active={isSettingsOpen}
            />
          </div>

          {isSettingsOpen && (
            <div
              className="absolute right-0 top-[calc(100%+0.5rem)] w-44 rounded-xl p-1.5 shadow-2xl"
              style={{
                background: 'rgba(8, 12, 24, 0.96)',
                border: '1px solid rgba(100, 200, 255, 0.12)',
              }}
            >
              <ToolbarToggle
                active={filters.showTasks}
                onClick={() => toggle('showTasks')}
                icon={<Columns3 size={13} />}
                label="Tasks"
                block
              />
              <ToolbarToggle
                active={filters.showProcesses}
                onClick={() => toggle('showProcesses')}
                icon={<Server size={13} />}
                label="Processes"
                block
              />
              <ToolbarToggle
                active={filters.showEdges}
                onClick={() => toggle('showEdges')}
                icon={filters.showEdges ? <Eye size={13} /> : <EyeOff size={13} />}
                label="Edges"
                block
              />
              <div className="my-1 h-px bg-[rgba(100,200,255,0.08)]" />
              <ToolbarToggle
                active={!filters.paused}
                onClick={() => toggle('paused')}
                icon={filters.paused ? <Play size={13} /> : <Pause size={13} />}
                label={filters.paused ? 'Resume' : 'Pause'}
                block
              />
            </div>
          )}
        </div>

        <div
          className="flex items-center gap-2 rounded-lg px-3 py-1.5 backdrop-blur-sm"
          style={{
            background: 'rgba(8, 12, 24, 0.8)',
            border: '1px solid rgba(100, 200, 255, 0.08)',
          }}
        >
          {onRequestPinAsTab && <ToolbarButton onClick={onRequestPinAsTab} icon={<Pin size={13} />} />}
          {onRequestFullscreen && (
            <ToolbarButton
              onClick={onRequestFullscreen}
              icon={<Expand size={13} />}
              label="Fullscreen"
            />
          )}
          {onRequestClose && <ToolbarButton onClick={onRequestClose} icon={<X size={13} />} />}
        </div>
      </div>

      <div className="absolute bottom-3 right-3 z-10 pointer-events-none">
        <div
          className="pointer-events-auto flex items-center gap-0.5 rounded-lg px-1 py-0.5 backdrop-blur-sm"
          style={{
            background: 'rgba(8, 12, 24, 0.86)',
            border: '1px solid rgba(100, 200, 255, 0.1)',
          }}
        >
          <ToolbarButton onClick={onZoomOut} icon={<ZoomOut size={14} />} />
          <ToolbarButton onClick={onZoomToFit} icon={<Maximize2 size={14} />} label="Fit" />
          <ToolbarButton onClick={onZoomIn} icon={<ZoomIn size={14} />} />
        </div>
      </div>
    </>
  );
}

// ─── Primitives ─────────────────────────────────────────────────────────────

function ToolbarButton({
  onClick,
  icon,
  label,
  active = false,
}: {
  onClick?: () => void;
  icon: React.ReactNode;
  label?: string;
  active?: boolean;
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-mono transition-colors cursor-pointer ${
        active
          ? 'text-[#aaeeff] bg-[rgba(100,200,255,0.14)]'
          : 'text-[#66ccff90] hover:text-[#aaeeff] hover:bg-[rgba(100,200,255,0.1)]'
      }`}
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
  block = false,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  block?: boolean;
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-mono transition-all cursor-pointer border ${
        block ? 'w-full justify-start' : ''
      } ${
        active
          ? 'text-[#aaeeff] bg-[rgba(100,200,255,0.15)] border-[rgba(100,200,255,0.25)]'
          : 'text-[#66ccff50] bg-transparent border-transparent hover:text-[#66ccff90] hover:bg-[rgba(100,200,255,0.06)]'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
