import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';

import { resolveOpenSidebarLogsHeight } from '@renderer/store/team/sidebarLogsHeight';

import { ClaudeLogsSection } from '../ClaudeLogsSection';
import { MessagesPanel } from '../messages/MessagesPanel';

import type { MouseEventHandler } from 'react';
import type { ComponentProps } from 'react';

type SharedMessagesPanelProps = Omit<ComponentProps<typeof MessagesPanel>, 'position'>;

interface TeamSidebarRailProps {
  teamName: string;
  messagesPanelProps: SharedMessagesPanelProps;
  isResizing: boolean;
  onResizeMouseDown: MouseEventHandler<HTMLDivElement>;
  logsHeight: number;
  logsHeightIsCustom: boolean;
  isLogsResizing: boolean;
  onLogsResizeMouseDown: MouseEventHandler<HTMLDivElement>;
  onApplyDefaultLogsHeight: (height: number) => void;
}

export const TeamSidebarRail = memo(function TeamSidebarRail({
  teamName,
  messagesPanelProps,
  isResizing,
  onResizeMouseDown,
  logsHeight,
  logsHeightIsCustom,
  isLogsResizing,
  onLogsResizeMouseDown,
  onApplyDefaultLogsHeight,
}: TeamSidebarRailProps): React.JSX.Element {
  const railRef = useRef<HTMLDivElement>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const { onPositionChange } = messagesPanelProps;
  const moveMessagesToInline = useCallback(() => {
    onPositionChange('inline');
  }, [onPositionChange]);

  useLayoutEffect(() => {
    const node = railRef.current;
    if (!node || logsHeightIsCustom || isLogsResizing) return;

    const syncAutoHeight = (): void => {
      if (node.clientHeight <= 0) return;
      const next = resolveOpenSidebarLogsHeight(node.clientHeight, null);
      if (next !== logsHeight) onApplyDefaultLogsHeight(next);
    };

    syncAutoHeight();
    const observer = new ResizeObserver(syncAutoHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, [isLogsResizing, logsHeight, logsHeightIsCustom, onApplyDefaultLogsHeight]);

  const logsSeparator = logsOpen ? (
    <div
      data-team-sidebar-logs-resize=""
      className={`group relative z-30 h-3 shrink-0 cursor-row-resize border-b border-[var(--color-border)] ${isLogsResizing ? 'bg-blue-500/10' : ''}`}
      onMouseDown={onLogsResizeMouseDown}
    >
      <div
        className={`absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 transition-colors ${
          isLogsResizing
            ? 'bg-blue-500'
            : 'bg-[var(--color-text-muted)]/35 group-hover:bg-blue-500/90'
        }`}
      />
    </div>
  ) : (
    <div className="h-px shrink-0 bg-[var(--color-border)]" />
  );

  return (
    <div
      ref={railRef}
      className="flex size-full min-h-0 flex-col overflow-hidden bg-[var(--color-surface-sidebar)]"
    >
      <div data-team-sidebar-messages="" className="min-h-0 flex-1">
        <MessagesPanel position="sidebar" {...messagesPanelProps} />
      </div>
      {logsSeparator}
      <div data-team-sidebar-logs="" className="shrink-0 overflow-hidden px-3">
        <ClaudeLogsSection
          teamName={teamName}
          position="sidebar"
          sidebarViewerMaxHeight={logsHeight}
          onOpenChange={setLogsOpen}
          onMoveToInline={moveMessagesToInline}
        />
      </div>
      <div
        className={`absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize transition-colors hover:bg-blue-500/30 ${isResizing ? 'bg-blue-500/40' : ''}`}
        onMouseDown={onResizeMouseDown}
      />
    </div>
  );
});
