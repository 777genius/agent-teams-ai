import { memo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { CARD_BG, CARD_BORDER_STYLE, CARD_ICON_MUTED } from '@renderer/constants/cssVariables';
import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import { formatCompactRelativeTime } from '@renderer/utils/formatters';
import {
  agentAvatarUrl,
  buildMemberAvatarMap,
  buildMemberColorMap,
  getMemberRuntimeAdvisoryLabel,
  getMemberRuntimeAdvisoryTitle,
} from '@renderer/utils/memberHelpers';
import { nameColorSet } from '@renderer/utils/projectColor';
import { Check, Clock3, Loader2, ShieldQuestion, Users, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { MemberBadge } from '../MemberBadge';
import {
  countQueuedUserMessages,
  getPendingMemberDeliveryState,
} from '../messages/messagesPanelLogic';

import type {
  DiscardQueuedUserMessagesResult,
  InboxMessage,
  ResolvedTeamMember,
} from '@shared/types';
import type { ReactNode } from 'react';

export interface PendingCrossTeamReply {
  teamName: string;
  sentAtMs: number;
}

interface PendingRepliesBlockProps {
  members: ResolvedTeamMember[];
  nowMs: number;
  pendingRepliesByMember: Record<string, number>;
  messages?: InboxMessage[];
  isTeamAlive?: boolean;
  pendingCrossTeamReplies?: PendingCrossTeamReply[];
  headerRight?: ReactNode;
  /** Enables the queued-message discard control on queued entries. */
  teamName?: string;
  /** Called once a discard attempt settled against the inbox, with what it changed. */
  onQueuedDiscarded?: (memberName: string, result: DiscardQueuedUserMessagesResult) => void;
  onMemberClick?: (member: ResolvedTeamMember) => void;
}

export const PendingRepliesBlock = memo(function PendingRepliesBlock({
  members,
  nowMs,
  pendingRepliesByMember,
  messages = [],
  isTeamAlive,
  pendingCrossTeamReplies = [],
  headerRight,
  teamName,
  onQueuedDiscarded,
  onMemberClick,
}: PendingRepliesBlockProps): React.JSX.Element | null {
  const { t } = useAppTranslation('team');
  const { isLight } = useTheme();
  const [discardingMember, setDiscardingMember] = useState<string | null>(null);

  const handleDiscardQueued = (memberName: string): void => {
    if (!teamName || discardingMember) return;
    void (async () => {
      setDiscardingMember(memberName);
      try {
        // The message feed is a page of the head, so the queued rows it holds
        // are a subset of the ones the discard would remove. Ask the inbox
        // itself before naming a number in a permanent-delete confirmation.
        const snapshot = await api.teams.getQueuedUserMessages(teamName, memberName);
        // The discard names these rows and only these rows. A message that
        // reaches the inbox after this listing was never in the confirmation,
        // so it must survive the write instead of being swept up by it.
        const confirmedMessageIds = snapshot.messages.map((message) => message.messageId);
        const queuedCount = confirmedMessageIds.length;
        if (queuedCount === 0) {
          // Nothing left to authorise: the runtime consumed the rows between
          // the render and the click. Report it instead of asking the user to
          // confirm a delete that would remove nothing, and refresh the head so
          // the entry can settle into "delivered".
          onQueuedDiscarded?.(memberName, { discarded: 0, remainingQueued: 0 });
          void confirm({
            title: t('activity.pendingReplies.discardQueued.resultTitle'),
            message: t('activity.pendingReplies.discardQueued.alreadyDelivered', {
              member: memberName,
            }),
            confirmLabel: t('activity.pendingReplies.discardQueued.okLabel'),
          });
          return;
        }
        const confirmed = await confirm({
          title: t('activity.pendingReplies.discardQueued.title'),
          message: t('activity.pendingReplies.discardQueued.message', {
            count: queuedCount,
            member: memberName,
          }),
          confirmLabel: t('activity.pendingReplies.discardQueued.confirmLabel'),
          cancelLabel: t('activity.pendingReplies.discardQueued.cancelLabel'),
          variant: 'danger',
        });
        if (!confirmed) return;
        const result = await api.teams.discardQueuedUserMessages(
          teamName,
          memberName,
          confirmedMessageIds
        );
        onQueuedDiscarded?.(memberName, result);
        // A discard that removed nothing is not a success the user can see: the
        // runtime consumed the rows between the click and the write. Say so,
        // and say it when rows arrived meanwhile and are still waiting.
        if (result.discarded === 0) {
          void confirm({
            title: t('activity.pendingReplies.discardQueued.resultTitle'),
            message: t('activity.pendingReplies.discardQueued.alreadyDelivered', {
              member: memberName,
            }),
            confirmLabel: t('activity.pendingReplies.discardQueued.okLabel'),
          });
        } else if (result.remainingQueued > 0) {
          void confirm({
            title: t('activity.pendingReplies.discardQueued.resultTitle'),
            message: t('activity.pendingReplies.discardQueued.remaining', {
              discarded: result.discarded,
              remaining: result.remainingQueued,
            }),
            confirmLabel: t('activity.pendingReplies.discardQueued.okLabel'),
          });
        }
      } catch (err) {
        void confirm({
          title: t('activity.pendingReplies.discardQueued.failedTitle'),
          message:
            err instanceof Error
              ? err.message
              : t('activity.pendingReplies.discardQueued.failedFallbackMessage'),
          confirmLabel: t('activity.pendingReplies.discardQueued.okLabel'),
          variant: 'danger',
        });
      } finally {
        setDiscardingMember(null);
      }
    })();
  };

  const pendingApprovals = useStore(useShallow((s) => s.pendingApprovals));
  const colorMap = buildMemberColorMap(members);
  const avatarMap = buildMemberAvatarMap(members);
  const memberPending = Object.entries(pendingRepliesByMember)
    .map(([name, sentAtMs]) => ({
      kind: 'member' as const,
      member: members.find((m) => m.name === name) ?? null,
      name,
      sentAtMs,
    }))
    .filter(
      (p): p is { kind: 'member'; member: ResolvedTeamMember; name: string; sentAtMs: number } =>
        !!p.member
    );
  const teamPending = pendingCrossTeamReplies.map((entry) => ({
    kind: 'team' as const,
    teamName: entry.teamName,
    sentAtMs: entry.sentAtMs,
  }));

  // Tool approvals awaiting user response
  const userPending = pendingApprovals.map((a) => ({
    kind: 'user' as const,
    toolName: a.toolName,
    sentAtMs: new Date(a.receivedAt).getTime(),
  }));

  const pending = [...memberPending, ...teamPending, ...userPending].sort(
    (a, b) => b.sentAtMs - a.sentAtMs
  );

  if (pending.length === 0) return null;

  return (
    <div className="mb-3 space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
          {t('messages.status.title')}
        </p>
        {headerRight ? <div className="shrink-0">{headerRight}</div> : null}
      </div>
      {pending.map((entry) => {
        const since = formatCompactRelativeTime(new Date(entry.sentAtMs), new Date(nowMs));

        if (entry.kind === 'member') {
          const { member } = entry;
          const colors = getTeamColorSet(colorMap.get(member.name) ?? '');
          const advisoryLabel = getMemberRuntimeAdvisoryLabel(
            member.runtimeAdvisory,
            member.providerId,
            nowMs,
            member.model
          );
          const advisoryTitle = getMemberRuntimeAdvisoryTitle(
            member.runtimeAdvisory,
            member.providerId,
            member.model
          );
          const deliveryState = getPendingMemberDeliveryState(
            isTeamAlive,
            messages,
            member.name,
            entry.sentAtMs
          );
          const isQueued = deliveryState === 'queued';
          // Badge hint only, and read from the loaded feed: it can undercount a
          // long queue. The discard confirmation reads the inbox instead.
          const queuedCount = isQueued ? countQueuedUserMessages(messages, member.name) : 0;
          const isDelivered = deliveryState === 'delivered';
          const showRuntimeAdvisory = deliveryState === 'delivering' && advisoryLabel !== null;
          const statusLabel = isQueued
            ? 'Queued'
            : isDelivered
              ? t('activity.pendingReplies.awaitingReply')
              : showRuntimeAdvisory
                ? advisoryLabel
                : 'Delivering';
          const statusTitle = isQueued
            ? 'Queued - will be delivered after the team starts'
            : isDelivered
              ? t('activity.pendingReplies.messageSentAwaitingReply')
              : showRuntimeAdvisory
                ? advisoryTitle
                : 'Team is online - waiting for the member runtime to accept this message';
          const statusColorClass = isQueued
            ? 'text-amber-300'
            : isDelivered
              ? 'text-cyan-300'
              : showRuntimeAdvisory
                ? 'text-amber-300'
                : 'text-cyan-300';
          const dotColorClass = isQueued
            ? 'bg-amber-500'
            : isDelivered
              ? 'bg-emerald-500'
              : showRuntimeAdvisory
                ? 'bg-amber-500'
                : 'bg-cyan-500';

          return (
            <article
              key={`pending-reply:${member.name}:${entry.sentAtMs}`}
              className="activity-card-enter-animate overflow-hidden rounded-md"
              style={{
                backgroundColor: CARD_BG,
                border: CARD_BORDER_STYLE,
                borderLeft: `3px solid ${colors.border}`,
              }}
            >
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="relative inline-flex shrink-0">
                  <img
                    src={avatarMap.get(member.name) ?? agentAvatarUrl(member.name, 24)}
                    alt=""
                    className="size-5 rounded-full bg-[var(--color-surface-raised)]"
                    loading="lazy"
                  />
                  <span className="absolute -bottom-0.5 -right-0.5 flex size-2.5">
                    {!isQueued && !isDelivered ? (
                      <span
                        className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${dotColorClass}`}
                      />
                    ) : null}
                    <span
                      className={`relative inline-flex size-full rounded-full ${dotColorClass}`}
                    />
                  </span>
                </span>
                <MemberBadge
                  name={member.name}
                  color={colorMap.get(member.name)}
                  isLight={isLight}
                  size="sm"
                  hideAvatar
                  disableHoverCard
                  variant="text"
                  onClick={onMemberClick ? () => onMemberClick(member) : undefined}
                />
                <span
                  className={`min-w-0 flex-1 truncate text-[10px] ${statusColorClass}`}
                  title={statusTitle ?? undefined}
                >
                  {statusLabel}
                </span>
                {isQueued ? (
                  <>
                    {queuedCount > 1 ? (
                      <span className="shrink-0 text-[10px] text-amber-300">
                        {t('activity.pendingReplies.discardQueued.count', { count: queuedCount })}
                      </span>
                    ) : null}
                    <Clock3 className="size-3 shrink-0 text-amber-400" />
                    {teamName ? (
                      <button
                        type="button"
                        aria-label={t('activity.pendingReplies.discardQueued.action')}
                        title={t('activity.pendingReplies.discardQueued.tooltip')}
                        className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={discardingMember !== null}
                        onClick={() => handleDiscardQueued(member.name)}
                      >
                        <X className="size-3" />
                      </button>
                    ) : null}
                  </>
                ) : isDelivered ? (
                  <Check
                    aria-label={t('messages.delivery.fields.delivered')}
                    className="size-3 shrink-0 text-emerald-400"
                    role="img"
                  />
                ) : (
                  <Loader2
                    className={`size-3 shrink-0 animate-spin ${showRuntimeAdvisory ? 'text-amber-400' : 'text-cyan-400'}`}
                  />
                )}
                <span className="shrink-0 text-[10px]" style={{ color: CARD_ICON_MUTED }}>
                  {since}
                </span>
              </div>
            </article>
          );
        }

        if (entry.kind === 'team') {
          const colors = nameColorSet(entry.teamName, isLight);
          return (
            <article
              key={`pending-reply:team:${entry.teamName}:${entry.sentAtMs}`}
              className="activity-card-enter-animate overflow-hidden rounded-md"
              style={{
                backgroundColor: CARD_BG,
                border: CARD_BORDER_STYLE,
                borderLeft: `3px solid ${colors.border}`,
              }}
            >
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="relative inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-raised)] p-1">
                  <Users size={12} style={{ color: colors.border }} />
                  <span className="absolute -bottom-0.5 -right-0.5 flex size-2.5">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                    <span className="relative inline-flex size-full rounded-full bg-emerald-500" />
                  </span>
                </span>
                <span
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide"
                  style={{
                    backgroundColor: getThemedBadge(colors, isLight),
                    color: colors.text,
                    border: `1px solid ${colors.border}40`,
                  }}
                  title={entry.teamName}
                >
                  {entry.teamName}
                </span>
                <span className="text-[10px]" style={{ color: CARD_ICON_MUTED }}>
                  {t('activity.pendingReplies.externalTeam')}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-[10px]"
                  style={{ color: CARD_ICON_MUTED }}
                  title={t('activity.pendingReplies.crossTeamAwaitingReply')}
                >
                  {t('activity.pendingReplies.awaitingReply')}
                </span>
                <span className="shrink-0 text-[10px]" style={{ color: CARD_ICON_MUTED }}>
                  {since}
                </span>
              </div>
            </article>
          );
        }

        // User tool approval pending
        return (
          <article
            key={`pending-reply:user:${entry.sentAtMs}`}
            className="activity-card-enter-animate overflow-hidden rounded-md"
            style={{
              backgroundColor: CARD_BG,
              border: CARD_BORDER_STYLE,
              borderLeft: '3px solid var(--color-text-muted)',
            }}
          >
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="relative inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-raised)] p-1">
                <ShieldQuestion size={12} style={{ color: 'var(--color-text-muted)' }} />
                <span className="absolute -bottom-0.5 -right-0.5 flex size-2.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-70" />
                  <span className="relative inline-flex size-full rounded-full bg-amber-500" />
                </span>
              </span>
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide"
                style={{
                  backgroundColor: 'var(--color-surface-raised)',
                  color: 'var(--color-text-secondary)',
                  border: '1px solid var(--color-border-emphasis)',
                }}
              >
                {t('activity.pendingReplies.user')}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-[10px]"
                style={{ color: CARD_ICON_MUTED }}
                title={`Tool approval: ${entry.toolName}`}
              >
                {t('activity.pendingReplies.awaitingApproval')}
              </span>
              <span className="shrink-0 text-[10px]" style={{ color: CARD_ICON_MUTED }}>
                {since}
              </span>
            </div>
          </article>
        );
      })}
    </div>
  );
});
