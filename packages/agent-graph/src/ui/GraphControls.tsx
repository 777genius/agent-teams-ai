/**
 * GraphControls — floating toolbar over the canvas.
 * Positioned below system buttons (top-10) to avoid overlap on macOS.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
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
  Plus,
  Server,
  Users,
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
  onOpenTeamPage?: () => void;
  onCreateTask?: () => void;
  teamName: string;
  teamColor?: string;
  isAlive?: boolean;
}

const TOPBAR_BUTTON_SIZE = 25;
const TOPBAR_ICON_SIZE = 10;

export function GraphControls({
  filters,
  onFiltersChange,
  onZoomIn,
  onZoomOut,
  onZoomToFit,
  onRequestClose,
  onRequestPinAsTab,
  onRequestFullscreen,
  onOpenTeamPage,
  onCreateTask,
  teamColor,
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
      <div className="absolute left-3 top-3 z-20 flex items-center gap-0.5 pointer-events-none">
        {onOpenTeamPage ? (
          <div
            className="pointer-events-auto flex items-center rounded-md p-0 backdrop-blur-sm"
            style={{
              background: 'rgba(8, 12, 24, 0.8)',
              border: `1px solid ${nameColor}25`,
            }}
          >
            <ToolbarButton
              onClick={onOpenTeamPage}
              icon={<Users size={TOPBAR_ICON_SIZE} />}
              toolbar
              title="Open team page"
            />
          </div>
        ) : null}
        {onCreateTask ? (
          <div
            className="pointer-events-auto flex items-center rounded-md p-0 backdrop-blur-sm"
            style={{
              background: 'rgba(8, 12, 24, 0.8)',
              border: `1px solid ${nameColor}25`,
            }}
          >
            <ToolbarButton
              onClick={onCreateTask}
              icon={<Plus size={TOPBAR_ICON_SIZE} />}
              toolbar
              title="Create task"
            />
          </div>
        ) : null}
      </div>

      <div className="absolute right-3 top-3 z-20 flex items-center gap-0.5 pointer-events-none">
        <div
          className="pointer-events-auto flex items-center rounded-md p-0 backdrop-blur-sm"
          style={{
            background: 'rgba(8, 12, 24, 0.8)',
            border: '1px solid rgba(100, 200, 255, 0.08)',
          }}
        >
          <ToolbarButton
            onClick={() => toggle('paused')}
            icon={filters.paused ? <Play size={TOPBAR_ICON_SIZE} /> : <Pause size={TOPBAR_ICON_SIZE} />}
            toolbar
            title={filters.paused ? 'Resume animation' : 'Pause animation'}
          />
        </div>

        <div ref={settingsRef} className="relative pointer-events-auto">
          <div
            className="flex items-center gap-0.5 rounded-md p-0 backdrop-blur-sm"
            style={{
              background: 'rgba(8, 12, 24, 0.8)',
              border: '1px solid rgba(100, 200, 255, 0.08)',
            }}
          >
            <ToolbarButton
              onClick={() => setIsSettingsOpen((value) => !value)}
              icon={<Settings2 size={TOPBAR_ICON_SIZE} />}
              active={isSettingsOpen}
              toolbar
              title="Graph settings"
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
            </div>
          )}
        </div>

        <div
          className="pointer-events-auto flex items-center gap-0.5 rounded-md p-0 backdrop-blur-sm"
          style={{
            background: 'rgba(8, 12, 24, 0.8)',
            border: '1px solid rgba(100, 200, 255, 0.08)',
          }}
        >
          {onRequestPinAsTab && (
            <ToolbarButton
              onClick={onRequestPinAsTab}
              icon={<Pin size={TOPBAR_ICON_SIZE} />}
              toolbar
              title="Pin as tab"
            />
          )}
          {onRequestFullscreen && (
            <ToolbarButton
              onClick={onRequestFullscreen}
              icon={<Expand size={TOPBAR_ICON_SIZE} />}
              toolbar
              title="Fullscreen"
            />
          )}
          {onRequestClose && (
            <ToolbarButton
              onClick={onRequestClose}
              icon={<X size={TOPBAR_ICON_SIZE} />}
              toolbar
              title="Close graph"
            />
          )}
        </div>
      </div>

      <div className="absolute bottom-3 right-3 z-20 pointer-events-none">
        <div
          className="pointer-events-auto flex items-center gap-0.5 rounded-lg px-0.5 py-[2px] backdrop-blur-sm"
          style={{
            background: 'rgba(8, 12, 24, 0.86)',
            border: '1px solid rgba(100, 200, 255, 0.1)',
          }}
        >
          <ToolbarButton onClick={onZoomOut} icon={<ZoomOut size={11} />} compact />
          <ToolbarButton onClick={onZoomToFit} icon={<Maximize2 size={11} />} label="Fit" compact />
          <ToolbarButton onClick={onZoomIn} icon={<ZoomIn size={11} />} compact />
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
  compact = false,
  mini = false,
  toolbar = false,
  title,
}: {
  onClick?: () => void;
  icon: React.ReactNode;
  label?: string;
  active?: boolean;
  compact?: boolean;
  mini?: boolean;
  toolbar?: boolean;
  title?: string;
}): React.JSX.Element {
  const button = (
    <button
      onClick={onClick}
      aria-label={title}
      style={
        toolbar
          ? {
              width: TOPBAR_BUTTON_SIZE,
              height: TOPBAR_BUTTON_SIZE,
              minWidth: TOPBAR_BUTTON_SIZE,
              minHeight: TOPBAR_BUTTON_SIZE,
              padding: 0,
            }
          : mini
            ? {
                width: 16,
                height: 16,
                minWidth: 16,
                minHeight: 16,
                padding: 0,
              }
            : undefined
      }
      className={`flex items-center rounded-md font-mono transition-colors cursor-pointer ${
        toolbar
          ? 'justify-center text-[0]'
          : mini
            ? 'justify-center text-[0]'
            : compact
              ? 'gap-0.5 px-1 py-0.5 text-[9px]'
              : 'gap-1 px-2 py-1 text-[11px]'
      } ${
        active
          ? 'text-[#aaeeff] bg-[rgba(100,200,255,0.14)]'
          : 'text-[#66ccff90] hover:text-[#aaeeff] hover:bg-[rgba(100,200,255,0.1)]'
      }`}
    >
      {icon}
      {label && <span>{label}</span>}
    </button>
  );

  if (!title) {
    return button;
  }

  return (
    <Tooltip.Root delayDuration={180}>
      <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="bottom"
          sideOffset={8}
          className="z-[100] rounded-md border border-[rgba(100,200,255,0.14)] bg-[rgba(8,12,24,0.96)] px-2 py-1 text-[11px] font-mono text-[#dff6ff] shadow-xl backdrop-blur-sm"
        >
          {title}
          <Tooltip.Arrow className="fill-[rgba(8,12,24,0.96)]" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
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
