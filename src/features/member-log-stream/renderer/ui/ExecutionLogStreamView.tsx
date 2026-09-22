import { useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { MemberExecutionLog } from '@renderer/components/team/members/MemberExecutionLog';
import {
  getTeamColorSet,
  getThemedBadge,
  getThemedBorder,
  getThemedText,
} from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { isLeadMember } from '@shared/utils/leadDetection';
import { AlertCircle, Clock, FileText, Loader2 } from 'lucide-react';

import { buildDefaultExecutionSegmentRenderKey } from './executionLogStreamUtils';

import type { ExecutionLogStreamLike } from './executionLogStreamUtils';
import type { BoardTaskLogActor, BoardTaskLogSegment, ResolvedTeamMember } from '@shared/types';

interface ParticipantVisual {
  name: string;
  color?: string;
}

export interface ExecutionLogStreamViewProps<TStream extends ExecutionLogStreamLike> {
  title: string;
  description?: string;
  stream: TStream | null;
  loading: boolean;
  error: string | null;
  teamName: string;
  teamMembers: readonly ResolvedTeamMember[];
  loadingText: string;
  emptyTitle: string;
  emptyDescription: string;
  selectionResetKey: string;
  boundedHistoryNote?: string | null;
  forceSegmentHeaders?: boolean;
  showIntro?: boolean;
  showSegmentParticipantBadge?: boolean;
  buildSegmentRenderKey?: (segment: TStream['segments'][number]) => string;
  getSegmentMetaLabel?: (segment: TStream['segments'][number]) => string | null;
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (!Number.isFinite(diffMs)) return '--';
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function actorLabel(actor: BoardTaskLogActor): string {
  if (actor.memberName) return actor.memberName;
  if (actor.role === 'lead' || actor.isSidechain === false) return 'lead session';
  if (actor.agentId) return `member ${actor.agentId.slice(0, 8)}`;
  return `member session ${actor.sessionId.slice(0, 8)}`;
}

function buildParticipantVisualMap(
  stream: ExecutionLogStreamLike | null,
  members: readonly ResolvedTeamMember[],
  memberColorMap: ReadonlyMap<string, string>
): Map<string, ParticipantVisual> {
  const visuals = new Map<string, ParticipantVisual>();
  const leadMember = members.find((member) => isLeadMember(member));

  for (const participant of stream?.participants ?? []) {
    const matchingSegment = stream?.segments.find(
      (segment) => segment.participantKey === participant.key
    );
    const name =
      matchingSegment?.actor.memberName ??
      (participant.isLead ? leadMember?.name : undefined) ??
      participant.label;

    visuals.set(participant.key, {
      name,
      color: memberColorMap.get(name) ?? memberColorMap.get(participant.label),
    });
  }

  for (const segment of stream?.segments ?? []) {
    if (visuals.has(segment.participantKey)) continue;
    const name = segment.actor.memberName ?? actorLabel(segment.actor);
    visuals.set(segment.participantKey, { name, color: memberColorMap.get(name) });
  }

  return visuals;
}

const SegmentMarker = <TSegment extends BoardTaskLogSegment>({
  segment,
  visual,
  teamName,
  metaLabel,
  showParticipantBadge,
}: {
  segment: TSegment;
  visual?: ParticipantVisual;
  teamName: string;
  metaLabel?: string | null;
  showParticipantBadge: boolean;
}): React.JSX.Element => (
  <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
    {showParticipantBadge && visual ? (
      <MemberBadge
        name={visual.name}
        color={visual.color}
        teamName={teamName}
        size="xs"
        disableHoverCard
      />
    ) : null}
    {metaLabel ? <span>{metaLabel}</span> : null}
    <span className="flex items-center gap-1">
      <Clock size={10} />
      {formatRelativeTime(segment.endTimestamp)}
    </span>
  </div>
);

const SegmentBlock = <TSegment extends BoardTaskLogSegment>({
  segment,
  showHeader,
  teamName,
  visual,
  metaLabel,
  showParticipantBadge,
}: {
  segment: TSegment;
  showHeader: boolean;
  teamName: string;
  visual?: ParticipantVisual;
  metaLabel?: string | null;
  showParticipantBadge: boolean;
}): React.JSX.Element => (
  <div className="min-w-0 overflow-hidden">
    {showHeader ? (
      <SegmentMarker
        segment={segment}
        visual={visual}
        teamName={teamName}
        metaLabel={metaLabel}
        showParticipantBadge={showParticipantBadge}
      />
    ) : null}
    <MemberExecutionLog
      chunks={segment.chunks}
      memberName={segment.actor.memberName}
      memberColor={visual?.color}
      teamName={teamName}
      hideMemberHeading={showHeader && Boolean(segment.actor.memberName)}
    />
  </div>
);

const ParticipantFilterChip = ({
  label,
  selected,
  visual,
  teamName,
  onClick,
}: {
  label: string;
  selected: boolean;
  visual?: ParticipantVisual;
  teamName: string;
  onClick: () => void;
}): React.JSX.Element => {
  const { isLight } = useTheme();
  const colors = getTeamColorSet(visual?.color ?? '');
  const borderColor = selected ? getThemedBorder(colors, isLight) : 'var(--color-border)';
  const backgroundColor = selected ? getThemedBadge(colors, isLight) : 'transparent';
  const textColor = selected ? getThemedText(colors, isLight) : 'var(--color-text-muted)';

  return (
    <button
      type="button"
      className="rounded-full border px-2 py-1 text-[11px] transition-colors hover:text-[var(--color-text)]"
      style={{ borderColor, backgroundColor, color: textColor }}
      onClick={onClick}
    >
      {visual ? (
        <MemberBadge
          name={visual.name}
          color={visual.color}
          teamName={teamName}
          size="xs"
          disableHoverCard
        />
      ) : (
        label
      )}
    </button>
  );
};

export const ExecutionLogStreamView = <TStream extends ExecutionLogStreamLike>({
  title,
  description,
  stream,
  loading,
  error,
  teamName,
  teamMembers,
  loadingText,
  emptyTitle,
  emptyDescription,
  selectionResetKey,
  boundedHistoryNote,
  forceSegmentHeaders = false,
  showIntro = true,
  showSegmentParticipantBadge = true,
  buildSegmentRenderKey,
  getSegmentMetaLabel,
}: Readonly<ExecutionLogStreamViewProps<TStream>>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [selectedParticipantKey, setSelectedParticipantKey] = useState<string>('all');
  const appliedSelectionResetKeyRef = useRef<string | null>(null);
  const participants = stream?.participants ?? [];
  const memberColorMap = useMemo(() => buildMemberColorMap([...teamMembers]), [teamMembers]);
  const participantVisuals = useMemo(
    () => buildParticipantVisualMap(stream, teamMembers, memberColorMap),
    [memberColorMap, stream, teamMembers]
  );

  useEffect(() => {
    if (!stream) {
      setSelectedParticipantKey('all');
      appliedSelectionResetKeyRef.current = null;
      return;
    }
    if (appliedSelectionResetKeyRef.current === selectionResetKey) {
      return;
    }
    appliedSelectionResetKeyRef.current = selectionResetKey;
    setSelectedParticipantKey(stream.defaultFilter);
  }, [selectionResetKey, stream]);

  useEffect(() => {
    if (!stream) return;
    const availableParticipantKeys = new Set([
      'all',
      ...stream.participants.map((participant) => participant.key),
    ]);
    setSelectedParticipantKey((prev) =>
      availableParticipantKeys.has(prev) ? prev : stream.defaultFilter
    );
  }, [stream]);

  const showChips = participants.length > 1;
  const visibleSegments = useMemo(() => {
    const source = stream?.segments ?? [];
    const filtered =
      selectedParticipantKey === 'all'
        ? source
        : source.filter((segment) => segment.participantKey === selectedParticipantKey);
    return [...filtered].reverse();
  }, [selectedParticipantKey, stream?.segments]);

  const showSegmentHeaders =
    forceSegmentHeaders ||
    participants.length > 1 ||
    (selectedParticipantKey !== 'all' && visibleSegments.length > 1);
  const renderKey = buildSegmentRenderKey ?? buildDefaultExecutionSegmentRenderKey;

  if (loading) {
    return (
      <div className="space-y-2">
        {showIntro ? (
          <h4 className="text-xs font-semibold uppercase text-[var(--color-text-muted)]">
            {title}
          </h4>
        ) : null}
        <div className="flex items-center gap-2 py-4 text-xs text-[var(--color-text-muted)]">
          <Loader2 size={12} className="animate-spin" />
          {loadingText}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2">
        {showIntro ? (
          <h4 className="text-xs font-semibold uppercase text-[var(--color-text-muted)]">
            {title}
          </h4>
        ) : null}
        <div className="flex items-center gap-2 py-4 text-xs text-red-400">
          <AlertCircle size={14} />
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {showIntro ? (
        <>
          <h4 className="text-xs font-semibold uppercase text-[var(--color-text-muted)]">
            {title}
          </h4>
          {description ? (
            <p className="text-xs text-[var(--color-text-muted)]">{description}</p>
          ) : null}
        </>
      ) : null}
      {boundedHistoryNote ? (
        <p className="text-[11px] text-amber-300">{boundedHistoryNote}</p>
      ) : null}

      {showChips ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
              selectedParticipantKey === 'all'
                ? 'bg-[var(--color-accent)]/10 border-[var(--color-accent)] text-[var(--color-text)]'
                : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
            onClick={() => setSelectedParticipantKey('all')}
          >
            {t('memberLogStream.filters.all')}
          </button>
          {participants.map((participant) => (
            <ParticipantFilterChip
              key={participant.key}
              label={participant.label}
              selected={selectedParticipantKey === participant.key}
              visual={participantVisuals.get(participant.key)}
              teamName={teamName}
              onClick={() => setSelectedParticipantKey(participant.key)}
            />
          ))}
        </div>
      ) : null}

      {visibleSegments.length === 0 ? (
        <div className="py-8 text-center text-xs text-[var(--color-text-muted)]">
          <FileText size={20} className="mx-auto mb-2 opacity-40" />
          {emptyTitle}
          <p className="mt-1 text-[10px] opacity-60">{emptyDescription}</p>
        </div>
      ) : (
        <div className="space-y-6">
          {visibleSegments.map((segment) => (
            <SegmentBlock
              key={renderKey(segment)}
              segment={segment}
              showHeader={showSegmentHeaders}
              teamName={teamName}
              visual={participantVisuals.get(segment.participantKey)}
              metaLabel={getSegmentMetaLabel?.(segment)}
              showParticipantBadge={showSegmentParticipantBadge}
            />
          ))}
        </div>
      )}
    </div>
  );
};
