import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog';
import { MemberSelect } from '@renderer/components/ui/MemberSelect';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { selectResolvedMembersForTeamName } from '@renderer/store/slices/teamSlice';
import { isLeadMember } from '@shared/utils/leadDetection';
import { Brain, Expand, MessageSquare, Terminal, Wrench } from 'lucide-react';

import { MemberLogStreamWithLegacyFallback } from './members/MemberLogStreamWithLegacyFallback';
import { ClaudeLogsPanel } from './ClaudeLogsPanel';
import { CollapsibleTeamSection } from './CollapsibleTeamSection';
import {
  buildSelectableLogMembers,
  formatMemberLogSourceDescription,
  formatMemberLogSourceLabel,
  getMemberNameFromLogSourceKey,
  LEAD_LOG_SOURCE_KEY,
  memberLogSourceKey,
  normalizeMemberLogSourceName,
  resolveLeadLogMember,
} from './teamLogSources';
import { useClaudeLogsController } from './useClaudeLogsController';

import type { TeamLogSourceKey } from './teamLogSources';
import type { LastLogPreview } from './useClaudeLogsController';
import type { ResolvedTeamMember } from '@shared/types';

// =============================================================================
// Constants
// =============================================================================

const PREVIEW_ICONS = {
  output: <MessageSquare size={12} className="shrink-0" />,
  thinking: <Brain size={12} className="shrink-0" />,
  tool: <Wrench size={12} className="shrink-0" />,
} as const;

const LogsHeaderSkeletonPill = ({
  className,
}: Readonly<{ className?: string }>): React.JSX.Element => (
  <span
    aria-hidden="true"
    className={cn(
      'inline-flex animate-pulse rounded-full shadow-[inset_0_0_0_1px_rgba(148,163,184,0.08)]',
      className
    )}
    style={{ backgroundColor: 'color-mix(in srgb, var(--color-text-muted) 30%, transparent)' }}
  />
);

// =============================================================================
// Sub-components
// =============================================================================

interface ClaudeLogsSectionProps {
  teamName: string;
  position?: 'sidebar' | 'inline';
  sidebarViewerMaxHeight?: number;
  onOpenChange?: (isOpen: boolean) => void;
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

const TeamLogsSourceSelector = ({
  leadMember,
  members,
  selectedKey,
  onChange,
  className,
  triggerVariant = 'default',
}: {
  leadMember: ResolvedTeamMember;
  members: readonly ResolvedTeamMember[];
  selectedKey: TeamLogSourceKey;
  onChange: (key: TeamLogSourceKey) => void;
  className?: string;
  triggerVariant?: 'default' | 'avatar';
}): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const sourceMembers = useMemo(() => [leadMember, ...members], [leadMember, members]);
  const selectedMemberName =
    selectedKey === LEAD_LOG_SOURCE_KEY
      ? leadMember.name
      : getMemberNameFromLogSourceKey(selectedKey);

  if (sourceMembers.length <= 1) return null;

  return (
    <div className={cn('min-w-0 pb-2', className)}>
      <MemberSelect
        members={sourceMembers}
        value={selectedMemberName}
        onChange={(memberName) => {
          const selectedMember = sourceMembers.find((member) => member.name === memberName);
          if (!selectedMember || isLeadMember(selectedMember)) {
            onChange(LEAD_LOG_SOURCE_KEY);
            return;
          }
          onChange(memberLogSourceKey(selectedMember.name));
        }}
        placeholder={t('claudeLogs.sourceSelect.placeholder')}
        searchPlaceholder={t('claudeLogs.sourceSelect.searchPlaceholder')}
        emptyMessage={t('claudeLogs.sourceSelect.emptyMessage')}
        ariaLabel={t('claudeLogs.sourceSelect.ariaLabel')}
        triggerVariant={triggerVariant}
        getMemberLabel={(member) =>
          isLeadMember(member)
            ? t('claudeLogs.sourceSelect.leadLabel')
            : formatMemberLogSourceLabel(member)
        }
        getMemberDescription={formatMemberLogSourceDescription}
      />
    </div>
  );
};

const MemberLogsSourcePanel = ({
  teamName,
  member,
  enabled,
  maxHeight,
}: {
  teamName: string;
  member: ResolvedTeamMember;
  enabled: boolean;
  maxHeight?: number;
}): React.JSX.Element => {
  const content = (
    <MemberLogStreamWithLegacyFallback teamName={teamName} member={member} enabled={enabled} />
  );

  if (maxHeight === undefined) {
    return content;
  }

  return (
    <div className="min-h-0 overflow-auto pr-1" style={{ maxHeight }}>
      {content}
    </div>
  );
};

const TeamLogsDialog = ({
  open,
  onOpenChange,
  teamName,
  leadMember,
  members,
  selectedKey,
  onSourceChange,
  showingLeadLogs,
  ctrl,
  selectedMember,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamName: string;
  leadMember: ResolvedTeamMember;
  members: readonly ResolvedTeamMember[];
  selectedKey: TeamLogSourceKey;
  onSourceChange: (key: TeamLogSourceKey) => void;
  showingLeadLogs: boolean;
  ctrl: ReturnType<typeof useClaudeLogsController>;
  selectedMember: ResolvedTeamMember | null;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const sourceSelector =
    members.length > 0 ? (
      <TeamLogsSourceSelector
        leadMember={leadMember}
        members={members}
        selectedKey={selectedKey}
        onChange={onSourceChange}
        className="w-64 max-w-[min(18rem,40vw)] shrink-0 pb-0"
      />
    ) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[90vh] w-[80vw] max-w-none flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <span className="inline-flex size-5 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] shadow-sm">
              <Terminal size={12} />
            </span>
            {t('claudeLogs.logsTitle')}
            {showingLeadLogs && ctrl.badge != null ? (
              <span className="font-mono text-[11px] text-[var(--color-text-muted)]">
                ({ctrl.badge})
              </span>
            ) : null}
            {showingLeadLogs && ctrl.online ? (
              <span className="pointer-events-none relative inline-flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
              </span>
            ) : null}
          </DialogTitle>
        </DialogHeader>

        <div
          className={cn('min-h-0 flex-1', showingLeadLogs ? 'overflow-hidden' : 'overflow-auto')}
        >
          {showingLeadLogs ? (
            <ClaudeLogsPanel
              ctrl={ctrl}
              viewerClassName="max-h-full h-full"
              className="flex h-full flex-col [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1"
              toolbarControlsStart={sourceSelector}
            />
          ) : selectedMember ? (
            <>
              {sourceSelector ? (
                <div className="mb-3 flex justify-end">{sourceSelector}</div>
              ) : null}
              <MemberLogsSourcePanel
                teamName={teamName}
                member={selectedMember}
                enabled={open && selectedKey === memberLogSourceKey(selectedMember.name)}
              />
            </>
          ) : (
            <div className="py-4 text-center text-xs text-[var(--color-text-muted)]">
              {t('claudeLogs.sourceSelect.selectSourceEmpty')}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

// =============================================================================
// Main component
// =============================================================================

export const ClaudeLogsSection = memo(function ClaudeLogsSection({
  teamName,
  position = 'inline',
  sidebarViewerMaxHeight,
  onOpenChange,
}: ClaudeLogsSectionProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const teamMembers = useStore((state) => selectResolvedMembersForTeamName(state, teamName));
  const [selectedSourceState, setSelectedSourceState] = useState<{
    teamName: string;
    sourceKey: TeamLogSourceKey;
  }>(() => ({ teamName, sourceKey: LEAD_LOG_SOURCE_KEY }));
  const selectedSourceKey =
    selectedSourceState.teamName === teamName ? selectedSourceState.sourceKey : LEAD_LOG_SOURCE_KEY;
  const setSelectedSourceKey = useCallback(
    (sourceKey: TeamLogSourceKey) => {
      setSelectedSourceState({ teamName, sourceKey });
    },
    [teamName]
  );
  const leadMember = useMemo(() => resolveLeadLogMember(teamMembers), [teamMembers]);
  const selectableMembers = useMemo(() => buildSelectableLogMembers(teamMembers), [teamMembers]);
  const selectedMemberName = getMemberNameFromLogSourceKey(selectedSourceKey);
  const selectedMemberSourceName = selectedMemberName
    ? normalizeMemberLogSourceName(selectedMemberName)
    : null;
  const selectedMember = useMemo(
    () =>
      selectedMemberSourceName
        ? (selectableMembers.find(
            (member) => normalizeMemberLogSourceName(member.name) === selectedMemberSourceName
          ) ?? null)
        : null,
    [selectableMembers, selectedMemberSourceName]
  );
  const effectiveSelectedSourceKey =
    selectedSourceKey === LEAD_LOG_SOURCE_KEY
      ? LEAD_LOG_SOURCE_KEY
      : selectedMember
        ? memberLogSourceKey(selectedMember.name)
        : LEAD_LOG_SOURCE_KEY;
  const showingLeadLogs = effectiveSelectedSourceKey === LEAD_LOG_SOURCE_KEY;
  const ctrl = useClaudeLogsController(teamName, { enabled: showingLeadLogs });
  const [dialogOpen, setDialogOpen] = useState(false);

  const isSidebar = position === 'sidebar';
  const showHeaderSkeleton =
    showingLeadLogs && ctrl.loading && ctrl.data.lines.length === 0 && !ctrl.error;

  useEffect(() => {
    if (selectedSourceState.teamName !== teamName) {
      setSelectedSourceState({ teamName, sourceKey: LEAD_LOG_SOURCE_KEY });
    }
  }, [selectedSourceState.teamName, teamName]);

  useEffect(() => {
    if (selectedSourceKey === LEAD_LOG_SOURCE_KEY) return;
    if (selectedMember) {
      const canonicalSourceKey = memberLogSourceKey(selectedMember.name);
      if (selectedSourceKey !== canonicalSourceKey) {
        setSelectedSourceKey(canonicalSourceKey);
      }
      return;
    }
    setSelectedSourceKey(LEAD_LOG_SOURCE_KEY);
  }, [selectedMember, selectedSourceKey, setSelectedSourceKey]);

  const sectionHeaderExtra = useMemo(
    () => (
      <span className={cn('flex min-w-0 items-center gap-2', isSidebar && 'basis-full pt-0.5')}>
        {showingLeadLogs && ctrl.online ? (
          <span className="pointer-events-none relative inline-flex size-2 shrink-0">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
          </span>
        ) : null}
        {showingLeadLogs && ctrl.lastLogPreview ? (
          <LogPreviewInline preview={ctrl.lastLogPreview} />
        ) : null}
        {showHeaderSkeleton ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 opacity-70">
            <LogsHeaderSkeletonPill className="size-3 rounded" />
            <LogsHeaderSkeletonPill className="h-3 w-12 rounded" />
            <LogsHeaderSkeletonPill className="h-3 w-2 rounded" />
            <LogsHeaderSkeletonPill className="h-3 min-w-0 flex-1 rounded" />
          </span>
        ) : null}
      </span>
    ),
    [ctrl.online, ctrl.lastLogPreview, isSidebar, showingLeadLogs, showHeaderSkeleton]
  );

  const canOpenFullscreen = showingLeadLogs ? ctrl.data.total > 0 : selectedMember !== null;

  const compactSourceSelector =
    selectableMembers.length > 0 ? (
      <TeamLogsSourceSelector
        leadMember={leadMember}
        members={selectableMembers}
        selectedKey={effectiveSelectedSourceKey}
        onChange={setSelectedSourceKey}
        className="shrink-0 pb-0"
        triggerVariant="avatar"
      />
    ) : null;

  const afterBadge = showHeaderSkeleton ? (
    <>
      <LogsHeaderSkeletonPill className="h-5 w-14" />
      <span className="pointer-events-auto ml-auto inline-flex size-6 items-center justify-center rounded text-[var(--color-text-muted)] opacity-70">
        <Expand size={14} />
      </span>
    </>
  ) : canOpenFullscreen ? (
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
          aria-label={t('claudeLogs.openFullscreen')}
        >
          <Expand size={14} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{t('claudeLogs.fullscreen')}</TooltipContent>
    </Tooltip>
  ) : undefined;

  return (
    <>
      <CollapsibleTeamSection
        sectionId="claude-logs"
        title={t('claudeLogs.logsTitle')}
        icon={null}
        badge={showingLeadLogs ? ctrl.badge : undefined}
        afterBadge={afterBadge}
        headerClassName={isSidebar ? '-mx-3 w-[calc(100%+1.5rem)] py-0' : undefined}
        headerSurfaceClassName={isSidebar ? '!rounded-none' : undefined}
        headerContentClassName={isSidebar ? 'flex-wrap items-center gap-y-1 py-1 pr-1' : 'pr-1'}
        headerExtra={sectionHeaderExtra}
        defaultOpen={false}
        onOpenChange={onOpenChange}
        contentWrapperClassName={isSidebar ? 'mt-0 pb-0' : undefined}
        contentClassName="pt-0 [overflow-anchor:none]"
      >
        {/* When dialog is open, hide the compact log viewer to avoid two competing scroll containers */}
        {dialogOpen ? (
          <div className="flex items-center gap-2 p-2 text-xs text-[var(--color-text-muted)]">
            <Expand size={12} />
            {t('claudeLogs.viewingFullscreen')}
          </div>
        ) : showingLeadLogs ? (
          <ClaudeLogsPanel
            ctrl={ctrl}
            viewerClassName={cn('max-h-[213px]', isSidebar && 'cli-logs-sidebar')}
            viewerMaxHeight={isSidebar ? sidebarViewerMaxHeight : undefined}
            compactMetaInTooltip={isSidebar}
            toolbarAccessory={compactSourceSelector}
          />
        ) : selectedMember ? (
          <>
            <div className="flex justify-end pb-2">{compactSourceSelector}</div>
            <MemberLogsSourcePanel
              teamName={teamName}
              member={selectedMember}
              enabled={effectiveSelectedSourceKey === memberLogSourceKey(selectedMember.name)}
              maxHeight={isSidebar ? sidebarViewerMaxHeight : undefined}
            />
          </>
        ) : (
          <div className="py-4 text-center text-xs text-[var(--color-text-muted)]">
            {t('claudeLogs.sourceSelect.selectSourceEmpty')}
          </div>
        )}
      </CollapsibleTeamSection>

      <TeamLogsDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        teamName={teamName}
        leadMember={leadMember}
        members={selectableMembers}
        selectedKey={effectiveSelectedSourceKey}
        onSourceChange={setSelectedSourceKey}
        showingLeadLogs={showingLeadLogs}
        ctrl={ctrl}
        selectedMember={selectedMember}
      />
    </>
  );
});
