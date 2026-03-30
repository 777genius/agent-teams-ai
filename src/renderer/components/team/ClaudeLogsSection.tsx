import { useMemo, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { Brain, Expand, MessageSquare, Wrench } from 'lucide-react';

import { ClaudeLogsDialog } from './ClaudeLogsDialog';
import { ClaudeLogsPanel } from './ClaudeLogsPanel';
import { CollapsibleTeamSection } from './CollapsibleTeamSection';
import { useClaudeLogsController } from './useClaudeLogsController';

import type { LastLogPreview } from './useClaudeLogsController';

// =============================================================================
// Constants
// =============================================================================

const PREVIEW_ICONS = {
  output: <MessageSquare size={12} className="shrink-0" />,
  thinking: <Brain size={12} className="shrink-0" />,
  tool: <Wrench size={12} className="shrink-0" />,
} as const;

// =============================================================================
// Sub-components
// =============================================================================

interface ClaudeLogsSectionProps {
  teamName: string;
  position?: 'sidebar' | 'inline';
}

/**
 * Compact inline preview of the most recent log item, shown in the section header.
 */
const LogPreviewInline = ({ preview }: { preview: LastLogPreview }): React.JSX.Element => {
  const summaryText =
    preview.summary.length > 60 ? preview.summary.slice(0, 60) + '...' : preview.summary;

  return (
    <span className="flex min-w-0 items-center gap-1.5 opacity-70">
      <span className="shrink-0" style={{ color: 'var(--tool-item-muted)' }}>
        {PREVIEW_ICONS[preview.type]}
      </span>
      <span className="shrink-0 text-[11px] font-medium" style={{ color: 'var(--tool-item-name)' }}>
        {preview.label}
      </span>
      {summaryText && (
        <>
          <span className="text-[11px]" style={{ color: 'var(--tool-item-muted)' }}>
            -
          </span>
          <span
            className="min-w-0 truncate text-[11px]"
            style={{ color: 'var(--tool-item-summary)' }}
          >
            {summaryText}
          </span>
        </>
      )}
    </span>
  );
};

// =============================================================================
// Main component
// =============================================================================

export const ClaudeLogsSection = ({
  teamName,
  position = 'inline',
}: ClaudeLogsSectionProps): React.JSX.Element => {
  const ctrl = useClaudeLogsController(teamName);
  const [dialogOpen, setDialogOpen] = useState(false);

  const isSidebar = position === 'sidebar';

  const sectionHeaderExtra = useMemo(
    () => (
      <span className={cn('flex min-w-0 items-center gap-2', isSidebar && 'basis-full pt-0.5')}>
        {ctrl.online ? (
          <span className="pointer-events-none relative inline-flex size-2 shrink-0">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
          </span>
        ) : null}
        {ctrl.lastLogPreview ? <LogPreviewInline preview={ctrl.lastLogPreview} /> : null}
      </span>
    ),
    [ctrl.online, ctrl.lastLogPreview, isSidebar]
  );

  return (
    <>
      <CollapsibleTeamSection
        sectionId="claude-logs"
        title="Claude logs"
        icon={null}
        badge={ctrl.badge}
        afterBadge={
          ctrl.data.total > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="pointer-events-auto ml-auto size-6 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDialogOpen(true);
                  }}
                  aria-label="Open fullscreen logs"
                >
                  <Expand size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Fullscreen</TooltipContent>
            </Tooltip>
          ) : undefined
        }
        headerContentClassName={isSidebar ? 'flex-wrap items-center gap-y-1 py-1 pr-1' : 'pr-1'}
        headerExtra={sectionHeaderExtra}
        defaultOpen={false}
        contentClassName="pt-0 [overflow-anchor:none]"
      >
        {/* When dialog is open, hide the compact log viewer to avoid two competing scroll containers */}
        {dialogOpen ? (
          <div className="flex items-center gap-2 p-2 text-xs text-[var(--color-text-muted)]">
            <Expand size={12} />
            Viewing in fullscreen mode
          </div>
        ) : (
          <ClaudeLogsPanel ctrl={ctrl} viewerClassName="max-h-[213px]" />
        )}
      </CollapsibleTeamSection>

      <ClaudeLogsDialog open={dialogOpen} onOpenChange={setDialogOpen} ctrl={ctrl} />
    </>
  );
};
