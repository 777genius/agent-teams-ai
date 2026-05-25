import { useEffect, useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useStore } from '@renderer/store';
import { selectResolvedMembersForTeamName } from '@renderer/store/slices/teamSlice';

import { useMemberLogStream } from '../hooks/useMemberLogStream';
import { ExecutionLogStreamView } from '../ui/ExecutionLogStreamView';

import type { MemberLogStreamSegment } from '../../contracts';
import type { ResolvedTeamMember } from '@shared/types';

interface MemberLogStreamSectionProps {
  teamName: string;
  member: ResolvedTeamMember;
  enabled?: boolean;
  onInitialLoadErrorChange?: (hasError: boolean) => void;
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

export const MemberLogStreamSection = ({
  teamName,
  member,
  enabled = true,
  onInitialLoadErrorChange,
}: Readonly<MemberLogStreamSectionProps>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const teamMembers = useStore((s) => selectResolvedMembersForTeamName(s, teamName));
  const { stream, loading, error } = useMemberLogStream({ teamName, member, enabled });
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
    <ExecutionLogStreamView
      title=""
      description=""
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
      showIntro={false}
      showSegmentParticipantBadge={false}
      buildSegmentRenderKey={buildMemberSegmentRenderKey}
      getSegmentMetaLabel={getSegmentMetaLabel}
    />
  );
};
