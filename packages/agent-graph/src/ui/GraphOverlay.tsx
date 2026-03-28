/**
 * GraphOverlay — HTML popovers positioned over Canvas nodes.
 * Uses camera worldToScreen transform for positioning.
 *
 * Styled to match the host app's MemberHoverCard / MemberCard look:
 * avatar + status dot, name, role, status badges, action buttons.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { GraphNode } from '../ports/types';
import type { GraphEventPort } from '../ports/GraphEventPort';
import { COLORS, getStateColor, getTaskStatusColor } from '../constants/colors';

export interface GraphOverlayProps {
  selectedNode: GraphNode | null;
  worldToScreen: (wx: number, wy: number) => { x: number; y: number };
  events?: GraphEventPort;
  onDeselect: () => void;
}

export function GraphOverlay({
  selectedNode,
  worldToScreen,
  events,
  onDeselect,
}: GraphOverlayProps): React.JSX.Element | null {
  if (!selectedNode) return null;

  const screenPos = worldToScreen(selectedNode.x ?? 0, selectedNode.y ?? 0);

  return (
    <div
      className="absolute z-20 pointer-events-auto"
      style={{
        left: `${screenPos.x + 20}px`,
        top: `${screenPos.y - 20}px`,
        transform: 'translateY(-50%)',
      }}
    >
      <NodePopover node={selectedNode} events={events} onClose={onDeselect} />
    </div>
  );
}

// ─── SVG Icons (inline — package cannot import lucide-react) ────────────────

function IconMessage({ size = 13 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function IconExternalLink({ size = 12 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function IconGlobe({ size = 12 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function IconClipboard({ size = 12 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  );
}

// ─── State helpers ──────────────────────────────────────────────────────────

function getPresenceLabel(state: GraphNode['state']): string {
  switch (state) {
    case 'active': return 'active';
    case 'thinking': return 'thinking';
    case 'tool_calling': return 'tool calling';
    case 'idle': return 'idle';
    case 'waiting': return 'waiting';
    case 'complete': return 'done';
    case 'error': return 'error';
    case 'terminated': return 'offline';
  }
}

function getStatusDotClass(state: GraphNode['state']): string {
  switch (state) {
    case 'active':
    case 'thinking':
    case 'tool_calling':
      return 'animate-pulse';
    default:
      return '';
  }
}

/** Capitalise first letter, replace underscores with spaces */
function formatLabel(s: string): string {
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Truncate display name: "team-lead" → "Team Lead", "alice" → "Alice" */
function displayName(name: string): string {
  return name
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ─── Node Popover ───────────────────────────────────────────────────────────

function NodePopover({
  node,
  events,
  onClose,
}: {
  node: GraphNode;
  events?: GraphEventPort;
  onClose: () => void;
}): React.JSX.Element {
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid closing immediately from the click that opened it
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [onClose]);

  const handleAction = useCallback(
    (action: string) => {
      const ref = node.domainRef;
      switch (action) {
        case 'sendMessage':
          if (ref.kind === 'member' || ref.kind === 'lead') {
            events?.onSendMessage?.(ref.kind === 'member' ? ref.memberName : 'team-lead', ref.teamName);
          }
          break;
        case 'openDetail':
          if (ref.kind === 'task') events?.onOpenTaskDetail?.(ref.taskId, ref.teamName);
          else if (ref.kind === 'member') events?.onOpenMemberProfile?.(ref.memberName, ref.teamName);
          else if (ref.kind === 'lead') events?.onOpenMemberProfile?.('team-lead', ref.teamName);
          break;
        case 'openUrl':
          if (node.processUrl) window.open(node.processUrl, '_blank');
          break;
      }
      onClose();
    },
    [node, events, onClose],
  );

  const isMemberLike = node.kind === 'member' || node.kind === 'lead';
  const color = node.kind === 'task'
    ? getTaskStatusColor(node.taskStatus)
    : node.color ?? getStateColor(node.state);
  const stateColor = getStateColor(node.state);

  if (isMemberLike) {
    return <MemberPopover ref={popoverRef} node={node} color={color} stateColor={stateColor} onAction={handleAction} />;
  }
  if (node.kind === 'task') {
    return <TaskPopover ref={popoverRef} node={node} color={color} stateColor={stateColor} onAction={handleAction} />;
  }
  return <ProcessPopover ref={popoverRef} node={node} color={color} onAction={handleAction} />;
}

// ─── Member / Lead Popover ──────────────────────────────────────────────────

import { forwardRef } from 'react';

const MemberPopover = forwardRef<
  HTMLDivElement,
  { node: GraphNode; color: string; stateColor: string; onAction: (a: string) => void }
>(function MemberPopover({ node, color, stateColor, onAction }, ref) {
  const presenceText = getPresenceLabel(node.state);
  const dotAnim = getStatusDotClass(node.state);

  return (
    <div
      ref={ref}
      className="rounded-lg min-w-[220px] max-w-[280px] shadow-xl overflow-hidden"
      style={{
        background: COLORS.glassBg,
        border: `1px solid ${color}30`,
        backdropFilter: 'blur(12px)',
      }}
    >
      {/* Colored top accent */}
      <div style={{ height: 3, background: `linear-gradient(to right, ${color}, transparent)` }} />

      <div className="p-3 flex flex-col gap-2.5">
        {/* Header: avatar + name + status */}
        <div className="flex items-center gap-3">
          {node.avatarUrl ? (
            <div className="relative shrink-0">
              <img
                src={node.avatarUrl}
                alt={node.label}
                className="rounded-full"
                style={{
                  width: 40,
                  height: 40,
                  background: 'rgba(100, 200, 255, 0.08)',
                  border: `2px solid ${color}40`,
                }}
                loading="lazy"
              />
              <span
                className={`absolute rounded-full ${dotAnim}`}
                style={{
                  bottom: -1,
                  right: -1,
                  width: 12,
                  height: 12,
                  background: stateColor,
                  border: '2px solid rgba(10, 15, 30, 0.9)',
                }}
              />
            </div>
          ) : (
            <div className="relative shrink-0">
              <div
                className="rounded-full flex items-center justify-center"
                style={{
                  width: 40,
                  height: 40,
                  background: `${color}20`,
                  border: `2px solid ${color}40`,
                  color: COLORS.holoBright,
                  fontSize: 14,
                  fontWeight: 700,
                }}
              >
                {node.label.charAt(0).toUpperCase()}
              </div>
              <span
                className={`absolute rounded-full ${dotAnim}`}
                style={{
                  bottom: -1,
                  right: -1,
                  width: 12,
                  height: 12,
                  background: stateColor,
                  border: '2px solid rgba(10, 15, 30, 0.9)',
                }}
              />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span
                className="truncate font-bold"
                style={{ color, fontSize: 13 }}
              >
                {displayName(node.label)}
              </span>
            </div>
            {node.role && (
              <div
                className="truncate"
                style={{ color: COLORS.textDim, fontSize: 11, marginTop: 1 }}
              >
                {node.role}
              </div>
            )}
          </div>
        </div>

        {/* Status badge */}
        <div className="flex gap-1.5 flex-wrap">
          <StatusBadge label={presenceText} color={stateColor} />
          {node.kind === 'lead' && (
            <StatusBadge label="lead" color={COLORS.dispatch} />
          )}
          {node.spawnStatus && node.spawnStatus !== 'online' && (
            <StatusBadge label={node.spawnStatus} color={
              node.spawnStatus === 'error' ? COLORS.error :
              node.spawnStatus === 'spawning' ? COLORS.waiting :
              COLORS.terminated
            } />
          )}
        </div>

        {/* Context usage bar (lead only) */}
        {node.contextUsage != null && node.contextUsage > 0 && (
          <div>
            <div className="flex justify-between" style={{ fontSize: 10, color: COLORS.textDim, marginBottom: 2 }}>
              <span>Context</span>
              <span>{Math.round(node.contextUsage * 100)}%</span>
            </div>
            <div
              className="rounded-full overflow-hidden"
              style={{ height: 3, background: 'rgba(100, 200, 255, 0.1)' }}
            >
              <div
                className="rounded-full h-full transition-all"
                style={{
                  width: `${Math.round(node.contextUsage * 100)}%`,
                  background: node.contextUsage > 0.8 ? COLORS.error : color,
                }}
              />
            </div>
          </div>
        )}

        {/* Sublabel (current activity) */}
        {node.sublabel && (
          <div
            className="rounded px-2 py-1.5 truncate"
            style={{
              fontSize: 10,
              color: COLORS.textDim,
              background: 'rgba(100, 200, 255, 0.05)',
              border: `1px solid ${COLORS.glassBorder}`,
            }}
          >
            {node.sublabel}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-1.5">
          <ActionButton icon={<IconMessage />} label="Message" onClick={() => onAction('sendMessage')} color={color} />
          <ActionButton icon={<IconExternalLink />} label="Profile" onClick={() => onAction('openDetail')} color={color} />
        </div>
      </div>
    </div>
  );
});

// ─── Task Popover ───────────────────────────────────────────────────────────

const TaskPopover = forwardRef<
  HTMLDivElement,
  { node: GraphNode; color: string; stateColor: string; onAction: (a: string) => void }
>(function TaskPopover({ node, color, stateColor, onAction }, ref) {
  const taskStatusLabel = node.taskStatus ? formatLabel(node.taskStatus) : 'pending';

  return (
    <div
      ref={ref}
      className="rounded-lg min-w-[200px] max-w-[280px] shadow-xl overflow-hidden"
      style={{
        background: COLORS.glassBg,
        border: `1px solid ${color}30`,
        backdropFilter: 'blur(12px)',
      }}
    >
      {/* Colored top accent */}
      <div style={{ height: 3, background: `linear-gradient(to right, ${color}, transparent)` }} />

      <div className="p-3 flex flex-col gap-2">
        {/* Header: display ID + label */}
        <div className="flex items-center gap-2">
          {node.displayId && (
            <span
              className="shrink-0 font-mono font-bold"
              style={{ color, fontSize: 12 }}
            >
              {node.displayId}
            </span>
          )}
          <span
            className="truncate font-bold"
            style={{ color: COLORS.holoBright, fontSize: 12 }}
          >
            {node.label}
          </span>
        </div>

        {/* Subject / description */}
        {node.sublabel && (
          <div
            className="truncate"
            style={{ color: COLORS.textDim, fontSize: 11 }}
          >
            {node.sublabel}
          </div>
        )}

        {/* Status badges */}
        <div className="flex gap-1.5 flex-wrap">
          <StatusBadge label={taskStatusLabel} color={color} />
          {node.state !== 'idle' && (
            <StatusBadge label={getPresenceLabel(node.state)} color={stateColor} />
          )}
          {node.reviewState && node.reviewState !== 'none' && (
            <StatusBadge
              label={node.reviewState === 'needsFix' ? 'needs fix' : node.reviewState}
              color={
                node.reviewState === 'approved' ? COLORS.complete :
                node.reviewState === 'needsFix' ? COLORS.error :
                COLORS.waiting
              }
            />
          )}
          {node.needsClarification && (
            <StatusBadge label={`needs ${node.needsClarification}`} color={COLORS.waiting} />
          )}
        </div>

        {/* Action */}
        <div className="flex gap-1.5 mt-0.5">
          <ActionButton icon={<IconClipboard />} label="Open task" onClick={() => onAction('openDetail')} color={color} />
        </div>
      </div>
    </div>
  );
});

// ─── Process Popover ────────────────────────────────────────────────────────

const ProcessPopover = forwardRef<
  HTMLDivElement,
  { node: GraphNode; color: string; onAction: (a: string) => void }
>(function ProcessPopover({ node, color, onAction }, ref) {
  return (
    <div
      ref={ref}
      className="rounded-lg min-w-[180px] max-w-[260px] shadow-xl overflow-hidden"
      style={{
        background: COLORS.glassBg,
        border: `1px solid ${color}30`,
        backdropFilter: 'blur(12px)',
      }}
    >
      <div style={{ height: 3, background: `linear-gradient(to right, ${color}, transparent)` }} />

      <div className="p-3 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div
            className="rounded-full"
            style={{ width: 8, height: 8, background: color }}
          />
          <span
            className="truncate font-bold"
            style={{ color: COLORS.holoBright, fontSize: 12 }}
          >
            {node.label}
          </span>
        </div>

        {node.sublabel && (
          <div className="truncate" style={{ color: COLORS.textDim, fontSize: 11 }}>
            {node.sublabel}
          </div>
        )}

        <div className="flex gap-1.5 flex-wrap">
          <StatusBadge label={getPresenceLabel(node.state)} color={getStateColor(node.state)} />
        </div>

        {node.processUrl && (
          <div className="flex gap-1.5 mt-0.5">
            <ActionButton icon={<IconGlobe />} label="Open URL" onClick={() => onAction('openUrl')} color={color} />
          </div>
        )}
      </div>
    </div>
  );
});

// ─── UI Primitives ──────────────────────────────────────────────────────────

function StatusBadge({ label, color }: { label: string; color: string }): React.JSX.Element {
  return (
    <span
      className="px-2 py-0.5 rounded-full font-medium"
      style={{
        fontSize: 10,
        background: `${color}18`,
        color,
        border: `1px solid ${color}25`,
        letterSpacing: '0.01em',
      }}
    >
      {label}
    </span>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  color: string;
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md cursor-pointer transition-all"
      style={{
        fontSize: 11,
        background: `${color}10`,
        border: `1px solid ${color}20`,
        color: COLORS.holoBright,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = `${color}25`;
        e.currentTarget.style.borderColor = `${color}40`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = `${color}10`;
        e.currentTarget.style.borderColor = `${color}20`;
      }}
    >
      {icon}
      {label}
    </button>
  );
}
