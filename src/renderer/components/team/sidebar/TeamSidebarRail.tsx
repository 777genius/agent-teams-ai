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
}

export const TeamSidebarRail = ({
  teamName,
  messagesPanelProps,
  isResizing,
  onResizeMouseDown,
}: TeamSidebarRailProps): React.JSX.Element => {
  return (
    <div className="flex size-full min-h-0 flex-col overflow-hidden bg-[var(--color-surface)]">
      <div className="shrink-0 overflow-hidden px-3">
        <ClaudeLogsSection teamName={teamName} position="sidebar" />
      </div>
      <div className="bg-[var(--color-text-muted)]/35 mx-3 h-px shrink-0" />
      <div className="min-h-0 flex-1">
        <MessagesPanel position="sidebar" {...messagesPanelProps} />
      </div>
      <div
        className={`absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize transition-colors hover:bg-blue-500/30 ${isResizing ? 'bg-blue-500/40' : ''}`}
        onMouseDown={onResizeMouseDown}
      />
    </div>
  );
};
