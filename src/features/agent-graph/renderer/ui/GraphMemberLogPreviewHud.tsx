import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  AlertCircle,
  Brain,
  CheckCircle2,
  MessageSquareText,
  Terminal,
  Wrench,
} from 'lucide-react';

import { useGraphActivityContext } from '../hooks/useGraphActivityContext';
import {
  buildGraphLogPreviewLaneIdsByMember,
  useGraphMemberLogPreviews,
} from '../hooks/useGraphMemberLogPreviews';

import type { GraphNode } from '@claude-teams/agent-graph';
import type {
  MemberLogPreviewItem,
  MemberLogPreviewMember,
} from '@features/member-log-stream/contracts';
import type {
  MemberActivityFilter,
  MemberDetailTab,
} from '@renderer/components/team/members/memberDetailTypes';

const LOG_PREVIEW_FALLBACK_WIDTH = 260;
const LOG_PREVIEW_FALLBACK_HEIGHT = 292;

interface StableRectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface GraphMemberLogPreviewHudProps {
  teamName: string;
  nodes: GraphNode[];
  getLogWorldRect?: (ownerNodeId: string) => StableRectLike | null;
  getCameraZoom?: () => number;
  worldToScreen?: (x: number, y: number) => { x: number; y: number };
  getViewportSize?: () => { width: number; height: number };
  focusNodeIds: ReadonlySet<string> | null;
  enabled?: boolean;
  onOpenMemberProfile?: (
    memberName: string,
    options?: {
      initialTab?: MemberDetailTab;
      initialActivityFilter?: MemberActivityFilter;
    }
  ) => void;
}

function normalizeMemberName(value: string): string {
  return value.trim().toLowerCase();
}

function formatRelativeTime(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return '';
  const diffMs = Date.now() - parsed;
  if (diffMs < 60_000) return 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function itemIcon(item: MemberLogPreviewItem): React.JSX.Element {
  const className = 'size-3.5 shrink-0';
  const title = item.title.trim().toLowerCase();
  if (
    title === 'send message' ||
    title === 'message sent' ||
    title === 'add comment' ||
    title === 'comment added'
  ) {
    return <MessageSquareText className={`${className} text-sky-300`} />;
  }
  if (item.tone === 'error') {
    return <AlertCircle className={`${className} text-rose-300`} />;
  }
  if (item.kind === 'tool_result') {
    return <CheckCircle2 className={`${className} text-emerald-300`} />;
  }
  if (item.kind === 'tool_use') {
    return <Terminal className={`${className} text-amber-300`} />;
  }
  if (item.kind === 'thinking') {
    return <Brain className={`${className} text-sky-300`} />;
  }
  return <MessageSquareText className={`${className} text-slate-300`} />;
}

function resolveEmptyText(preview: MemberLogPreviewMember | undefined, loading: boolean): string {
  if (loading && !preview) return 'Loading logs';
  if (preview?.warnings.some((warning) => warning.code === 'codex_member_wide_not_supported')) {
    return 'Unsupported provider';
  }
  return 'No recent logs';
}

function setShellHidden(shell: HTMLDivElement): void {
  shell.style.opacity = '0';
  shell.style.pointerEvents = 'none';
}

export const GraphMemberLogPreviewHud = ({
  teamName,
  nodes,
  getLogWorldRect = () => null,
  getCameraZoom = () => 1,
  worldToScreen,
  getViewportSize,
  focusNodeIds,
  enabled = true,
  onOpenMemberProfile,
}: GraphMemberLogPreviewHudProps): React.JSX.Element | null => {
  const worldLayerRef = useRef<HTMLDivElement | null>(null);
  const shellRefs = useRef(new Map<string, HTMLDivElement | null>());
  const visibleKeyRef = useRef('');
  const [visibleMemberNames, setVisibleMemberNames] = useState<string[]>([]);
  const { teamData } = useGraphActivityContext(teamName);
  const members = teamData?.members ?? [];
  const laneIdsByMember = useMemo(() => buildGraphLogPreviewLaneIdsByMember(members), [members]);
  const ownerNodes = useMemo(
    () =>
      nodes.filter((node): node is GraphNode & { kind: 'lead' | 'member' } => {
        return (
          (node.kind === 'lead' || node.kind === 'member') &&
          (node.domainRef.kind === 'lead' || node.domainRef.kind === 'member')
        );
      }),
    [nodes]
  );
  const { previewsByMember, loading } = useGraphMemberLogPreviews({
    teamName,
    memberNames: visibleMemberNames,
    laneIdsByMember,
    enabled: enabled && visibleMemberNames.length > 0,
    maxItemsPerMember: 3,
    textLimit: 200,
  });

  const openLogs = useCallback(
    (memberName: string) => {
      onOpenMemberProfile?.(memberName, { initialTab: 'logs' });
    },
    [onOpenMemberProfile]
  );

  useLayoutEffect(() => {
    if (!enabled || ownerNodes.length === 0) {
      for (const shell of shellRefs.current.values()) {
        if (shell) setShellHidden(shell);
      }
      setVisibleMemberNames([]);
      visibleKeyRef.current = '';
      return;
    }

    let frameId = 0;
    const updatePositions = (): void => {
      const worldLayer = worldLayerRef.current;
      if (worldLayer && worldToScreen) {
        const origin = worldToScreen(0, 0);
        const zoom = Math.max(getCameraZoom(), 0.001);
        worldLayer.style.transform = `translate(${Math.round(origin.x)}px, ${Math.round(origin.y)}px) scale(${zoom.toFixed(3)})`;
      }

      const visibleNames: string[] = [];
      for (const node of ownerNodes) {
        const shell = shellRefs.current.get(node.id);
        if (!shell) continue;

        const laneRect = getLogWorldRect(node.id);
        if (!laneRect || !worldToScreen || laneRect.width <= 0 || laneRect.height <= 0) {
          setShellHidden(shell);
          continue;
        }

        const zoom = Math.max(getCameraZoom(), 0.001);
        const screenTopLeft = worldToScreen(laneRect.left, laneRect.top);
        const widthScreen = Math.max(1, laneRect.width * zoom);
        const heightScreen = Math.max(1, laneRect.height * zoom);
        const viewport = getViewportSize?.();
        const laneVisible =
          !viewport ||
          (screenTopLeft.x + widthScreen > -80 &&
            screenTopLeft.x < viewport.width + 80 &&
            screenTopLeft.y + heightScreen > -80 &&
            screenTopLeft.y < viewport.height + 80);
        if (!laneVisible) {
          setShellHidden(shell);
          continue;
        }

        const baseOpacity = focusNodeIds && !focusNodeIds.has(node.id) ? 0.25 : 1;
        shell.style.opacity = String(baseOpacity);
        shell.style.pointerEvents = 'auto';
        shell.style.left = `${Math.round(laneRect.left)}px`;
        shell.style.top = `${Math.round(laneRect.top)}px`;
        shell.style.width = `${Math.round(laneRect.width)}px`;
        shell.style.height = `${Math.round(laneRect.height)}px`;
        if (node.domainRef.kind === 'lead' || node.domainRef.kind === 'member') {
          visibleNames.push(node.domainRef.memberName);
        }
      }

      const nextVisibleKey = visibleNames
        .map(normalizeMemberName)
        .sort((left, right) => left.localeCompare(right))
        .join('|');
      if (nextVisibleKey !== visibleKeyRef.current) {
        visibleKeyRef.current = nextVisibleKey;
        setVisibleMemberNames(visibleNames);
      }

      frameId = window.requestAnimationFrame(updatePositions);
    };

    updatePositions();
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    enabled,
    focusNodeIds,
    getCameraZoom,
    getLogWorldRect,
    getViewportSize,
    ownerNodes,
    worldToScreen,
  ]);

  const forwardWheelToGraph = useCallback((event: WheelEvent, shell: HTMLDivElement) => {
    const graphRoot = shell.closest('.team-graph-view');
    const canvas = graphRoot?.querySelector('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) {
      return;
    }
    if (event.cancelable) {
      event.preventDefault();
    }
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        bubbles: true,
        cancelable: true,
      })
    );
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const listeners: { shell: HTMLDivElement; handler: (event: WheelEvent) => void }[] = [];
    for (const node of ownerNodes) {
      const shell = shellRefs.current.get(node.id);
      if (!shell) continue;
      const handler = (event: WheelEvent): void => forwardWheelToGraph(event, shell);
      shell.addEventListener('wheel', handler, { passive: false });
      listeners.push({ shell, handler });
    }
    return () => {
      for (const { shell, handler } of listeners) {
        shell.removeEventListener('wheel', handler);
      }
    };
  }, [enabled, forwardWheelToGraph, ownerNodes]);

  const renderItem = useCallback(
    (memberName: string, item: MemberLogPreviewItem) => (
      <button
        key={item.id}
        type="button"
        className="block h-14 min-h-14 w-full min-w-0 overflow-hidden rounded-md border border-white/10 bg-[rgba(8,14,28,0.52)] px-2.5 py-2 text-left text-[10px] leading-3 text-slate-400 transition-colors hover:border-white/20 hover:bg-[rgba(12,20,40,0.78)]"
        onClick={() => openLogs(memberName)}
      >
        <span
          className="mr-1.5 inline-flex size-4 shrink-0 translate-y-0.5 items-center justify-center rounded bg-white/5 align-middle"
          aria-hidden="true"
        >
          {itemIcon(item)}
        </span>
        <span className="align-baseline text-[11px] font-medium leading-4 text-slate-200">
          {item.title}
        </span>{' '}
        <span className="align-baseline text-[9px] leading-4 text-slate-500">
          {formatRelativeTime(item.timestamp)}
        </span>{' '}
        <span className="align-baseline">{item.preview || item.sourceLabel || 'Log event'}</span>
      </button>
    ),
    [openLogs]
  );

  if (!enabled || ownerNodes.length === 0) {
    return null;
  }

  return (
    <div
      ref={worldLayerRef}
      className="pointer-events-none absolute left-0 top-0 z-[8] origin-top-left select-none"
    >
      {ownerNodes.map((node) => {
        const laneRect = getLogWorldRect(node.id);
        const laneWidth = laneRect?.width ?? LOG_PREVIEW_FALLBACK_WIDTH;
        const laneHeight = laneRect?.height ?? LOG_PREVIEW_FALLBACK_HEIGHT;
        const memberName =
          node.domainRef.kind === 'lead' || node.domainRef.kind === 'member'
            ? node.domainRef.memberName
            : node.label;
        const preview = previewsByMember.get(normalizeMemberName(memberName));
        const items = preview?.items ?? [];

        return (
          <div
            key={node.id}
            ref={(element) => {
              shellRefs.current.set(node.id, element);
            }}
            className="pointer-events-auto absolute z-10 origin-top-left select-none opacity-0"
            style={{
              width: `${laneWidth}px`,
              maxWidth: `${laneWidth}px`,
              height: `${laneHeight}px`,
            }}
            onDragStart={(event) => {
              event.preventDefault();
            }}
          >
            <div className="flex h-full min-w-0 max-w-full flex-col overflow-hidden">
              <div className="mb-1 flex h-5 min-h-5 items-center gap-1 px-1 text-[10px] font-semibold tracking-[0.2em] text-slate-400/70">
                <Wrench className="size-3 text-slate-500" />
                Logs
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
                {items.length > 0 ? (
                  items.slice(0, 3).map((item) => renderItem(memberName, item))
                ) : (
                  <button
                    type="button"
                    className="flex h-14 min-h-14 items-center rounded-md border border-dashed border-white/10 bg-[rgba(8,14,28,0.28)] px-3 text-left text-[11px] text-slate-400/60"
                    onClick={() => openLogs(memberName)}
                  >
                    {resolveEmptyText(preview, loading)}
                  </button>
                )}
                {preview && preview.overflowCount > 0 ? (
                  <button
                    type="button"
                    className="h-8 min-h-8 w-full rounded-md border border-white/10 bg-[rgba(8,14,28,0.64)] px-3 py-1 text-center text-[11px] font-medium text-slate-300 transition-colors hover:border-white/20 hover:bg-[rgba(12,20,40,0.78)]"
                    onClick={() => openLogs(memberName)}
                  >
                    +{preview.overflowCount} more
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
