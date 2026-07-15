import { memo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { CARD_BG, CARD_BORDER_STYLE, CARD_ICON_MUTED } from '@renderer/constants/cssVariables';
import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import {
  agentAvatarUrl,
  buildMemberAvatarMap,
  buildMemberColorMap,
  displayMemberName,
  getMemberRuntimeAdvisoryLabel,
  getMemberRuntimeAdvisoryTitle,
} from '@renderer/utils/memberHelpers';
import { nameColorSet } from '@renderer/utils/projectColor';
import { formatDistanceToNowStrict } from 'date-fns';
import { Check, Clock3, Loader2, ShieldQuestion, Users } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { getPendingMemberDeliveryState } from '../messages/messagesPanelLogic';

import type { InboxMessage, ResolvedTeamMember } from '@shared/types';
import type { ReactNode } from 'react';

export interface PendingCrossTeamReply {
  teamName: string;
  sentAtMs: number;
}

interface PendingRepliesBlockProps {
  members: ResolvedTeamMember[];
  pendingRepliesByMember: Record<string, number>;
  messages?: InboxMessage[];
  isTeamAlive?: boolean;
  pendingCrossTeamReplies?: PendingCrossTeamReply[];
  headerRight?: ReactNode;
  onMemberClick?: (member: ResolvedTeamMember) => void;
}

export const PendingRepliesBlock = memo(function PendingRepliesBlock({
  members,
  pendingRepliesByMember,
  messages = [],
  isTeamAlive,
  pendingCrossTeamReplies = [],
  headerRight,
  onMemberClick,
}: PendingRepliesBlockProps): React.JSX.Element | null {
  const { t } = useAppTranslation('team');
  const { isLight } = useTheme();
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
        const since = formatDistanceToNowStrict(entry.sentAtMs, { addSuffix: true });

        if (entry.kind === 'member') {
          const { member } = entry;
          const colors = getTeamColorSet(colorMap.get(member.name) ?? '');
          const roleLabel = formatAgentRole(
            member.role ?? (member.agentType !== 'general-purpose' ? member.agentType : undefined)
          );
          const advisoryLabel = getMemberRuntimeAdvisoryLabel(
            member.runtimeAdvisory,
            member.providerId
          );
          const advisoryTitle = getMemberRuntimeAdvisoryTitle(
            member.runtimeAdvisory,
            member.providerId
          );
          const deliveryState = getPendingMemberDeliveryState(
            isTeamAlive,
            messages,
            member.name,
            entry.sentAtMs
          );
          const isQueued = deliveryState === 'queued';
          const isDelivered = deliveryState === 'delivered';
          const showRuntimeAdvisory = deliveryState === 'delivering' && advisoryLabel !== null;
          const statusLabel = isQueued
            ? 'Queued'
            : isDelivered
              ? 'Delivered'
              : showRuntimeAdvisory
                ? advisoryLabel
                : 'Delivering';
          const statusTitle = isQueued
            ? 'Queued - will be delivered after the team starts'
            : isDelivered
              ? 'The member runtime has read this message'
              : showRuntimeAdvisory
                ? advisoryTitle
                : 'Team is online - waiting for the member runtime to read this message';
          const statusColorClass = isQueued
            ? 'text-amber-300'
            : isDelivered
              ? 'text-emerald-300'
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
                {onMemberClick ? (
                  <button
                    type="button"
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide transition-opacity hover:opacity-90 focus:outline-none focus:ring-1 focus:ring-[var(--color-border)]"
                    style={{
                      backgroundColor: getThemedBadge(colors, isLight),
                      color: colors.text,
                      border: `1px solid ${colors.border}40`,
                    }}
                    onClick={() => onMemberClick(member)}
                    title={t('activity.pendingReplies.openMember')}
                  >
                    {displayMemberName(member.name)}
                  </button>
                ) : (
                  <span
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide"
                    style={{
                      backgroundColor: getThemedBadge(colors, isLight),
                      color: colors.text,
                      border: `1px solid ${colors.border}40`,
                    }}
                  >
                    {displayMemberName(member.name)}
                  </span>
                )}
                {roleLabel ? (
                  <span className="text-[10px]" style={{ color: CARD_ICON_MUTED }}>
                    {roleLabel}
                  </span>
                ) : null}
                <span
                  className={`min-w-0 flex-1 truncate text-[10px] ${statusColorClass}`}
                  title={statusTitle ?? undefined}
                >
                  {statusLabel}
                </span>
                {isQueued ? (
                  <Clock3 className="size-3 shrink-0 text-amber-400" />
                ) : isDelivered ? (
                  <Check className="size-3 shrink-0 text-emerald-400" />
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
