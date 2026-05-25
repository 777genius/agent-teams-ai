import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { selectResolvedMembersForTeamName } from '@renderer/store/slices/teamSlice';

import { useMemberLogStream } from '../hooks/useMemberLogStream';
import { ExecutionLogStreamView } from '../ui/ExecutionLogStreamView';
import { MemberRuntimeProcessLogsPanel } from '../ui/MemberRuntimeProcessLogsPanel';

import type { MemberLogStreamSegment, MemberRuntimeLogKind } from '../../contracts';
import type { ResolvedTeamMember } from '@shared/types';

interface MemberLogStreamSectionProps {
  teamName: string;
  member: ResolvedTeamMember;
  enabled?: boolean;
  onInitialLoadErrorChange?: (hasError: boolean) => void;
}

function describeMemberStream(): string {
  return 'Member-scoped transcript and runtime logs rendered with the same execution-log components used in Task Log Stream.';
}

function getSegmentMetaLabel(segment: MemberLogStreamSegment): string {
  const details = [segment.source.label];
  if (segment.source.laneId) {
    details.push(`lane ${segment.source.laneId}`);
  } else if (segment.source.sessionId) {
    details.push(`session ${segment.source.sessionId.slice(0, 8)}`);
  }
  return details.join(' · ');
}

function buildMemberSegmentRenderKey(segment: MemberLogStreamSegment): string {
  const firstChunkId = segment.chunks[0]?.id;
  return `${segment.id}:${firstChunkId ?? segment.startTimestamp}`;
}

export function MemberLogStreamSection({
  teamName,
  member,
  enabled = true,
  onInitialLoadErrorChange,
}: Readonly<MemberLogStreamSectionProps>): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const [selectedLogView, setSelectedLogView] = useState<'execution' | 'process'>('execution');
  const teamMembers = useStore((s) => selectResolvedMembersForTeamName(s, teamName));
  const { stream, loading, error } = useMemberLogStream({ teamName, member, enabled });
  const loadRuntimeLogTail = useCallback(
    (input: {
      readonly kind: MemberRuntimeLogKind;
      readonly maxBytes: number;
      readonly forceRefresh?: boolean;
    }) => api.memberLogStream.getMemberRuntimeLogTail(teamName, member.name, input),
    [member.name, teamName]
  );
  const hasInitialLoadError = Boolean(error && !stream && !loading);
  const boundedHistoryNote = useMemo(() => {
    if (!stream) return null;
    const isBounded =
      stream.truncated ||
      stream.warnings.some((warning) => warning.code === 'large_log_window_limited');
    return isBounded ? 'Showing a bounded recent member log stream.' : null;
  }, [stream]);

  useEffect(() => {
    onInitialLoadErrorChange?.(hasInitialLoadError);
  }, [hasInitialLoadError, onInitialLoadErrorChange]);

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-xl bg-[var(--color-surface-subtle)] p-1">
        <button
          type="button"
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
            selectedLogView === 'execution'
              ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          }`}
          onClick={() => setSelectedLogView('execution')}
        >
          {t('memberLogStream.tabs.execution')}
        </button>
        <button
          type="button"
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
            selectedLogView === 'process'
              ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          }`}
          onClick={() => setSelectedLogView('process')}
        >
          {t('memberLogStream.tabs.process')}
        </button>
      </div>

      {selectedLogView === 'execution' ? (
        <ExecutionLogStreamView
          title={t('memberLogStream.logs.title')}
          description={describeMemberStream()}
          stream={stream}
          loading={loading}
          error={error}
          teamName={teamName}
          teamMembers={teamMembers}
          loadingText={t('memberLogStream.logs.loading')}
          emptyTitle={t('memberLogStream.logs.emptyTitle')}
          emptyDescription={t('memberLogStream.logs.emptyDescription')}
          selectionResetKey={`${teamName}:${member.name}`}
          boundedHistoryNote={boundedHistoryNote}
          forceSegmentHeaders
          buildSegmentRenderKey={buildMemberSegmentRenderKey}
          getSegmentMetaLabel={getSegmentMetaLabel}
        />
      ) : (
        <MemberRuntimeProcessLogsPanel
          enabled={enabled && selectedLogView === 'process'}
          loadRuntimeLogTail={loadRuntimeLogTail}
        />
      )}
    </div>
  );
}
