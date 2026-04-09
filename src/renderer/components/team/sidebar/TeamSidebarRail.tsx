import { memo, useState } from 'react';

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
  isLogsResizing: boolean;
  onLogsResizeMouseDown: MouseEventHandler<HTMLDivElement>;
}

export const TeamSidebarRail = memo(function TeamSidebarRail({
  teamName,
  messagesPanelProps,
  isResizing,
  onResizeMouseDown,
  logsHeight,
  isLogsResizing,
  onLogsResizeMouseDown,
}: TeamSidebarRailProps): React.JSX.Element {
  const [logsOpen, setLogsOpen] = useState(false);
  const logsSeparator = logsOpen ? (
    <div
      className={`group relative h-3 shrink-0 cursor-row-resize ${isLogsResizing ? 'bg-blue-500/10' : ''}`}
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
    <div className="bg-[var(--color-text-muted)]/35 h-px shrink-0" />
  );

  return (
    <div className="flex size-full min-h-0 flex-col overflow-hidden bg-[var(--color-surface)]">
      <div className="shrink-0 overflow-hidden px-3">
        <ClaudeLogsSection
          teamName={teamName}
          position="sidebar"
          sidebarViewerMaxHeight={logsHeight}
          onOpenChange={setLogsOpen}
        />
      </div>
      {logsSeparator}
      <div className="min-h-0 flex-1">
        <MessagesPanel position="sidebar" {...messagesPanelProps} />
      </div>
      <div
        className={`absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize transition-colors hover:bg-blue-500/30 ${isResizing ? 'bg-blue-500/40' : ''}`}
        onMouseDown={onResizeMouseDown}
      />
    </div>
  );
});
