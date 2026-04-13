import { CARD_BG, CARD_BORDER_STYLE, CARD_ICON_MUTED } from '@renderer/constants/cssVariables';
import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import {
  agentAvatarUrl,
  buildMemberColorMap,
  displayMemberName,
  getMemberRuntimeAdvisoryLabel,
  getMemberRuntimeAdvisoryTitle,
} from '@renderer/utils/memberHelpers';
import { nameColorSet } from '@renderer/utils/projectColor';
import { formatDistanceToNowStrict } from 'date-fns';
import { Loader2, ShieldQuestion, Users } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import type { ResolvedTeamMember } from '@shared/types';
import type { ReactNode } from 'react';

export interface PendingCrossTeamReply {
  teamName: string;
  sentAtMs: number;
}

interface PendingRepliesBlockProps {
  members: ResolvedTeamMember[];
  pendingRepliesByMember: Record<string, number>;
  pendingCrossTeamReplies?: PendingCrossTeamReply[];
  headerRight?: ReactNode;
  onMemberClick?: (member: ResolvedTeamMember) => void;
}

export const PendingRepliesBlock = ({
  members,
  pendingRepliesByMember,
  pendingCrossTeamReplies = [],
  headerRight,
  onMemberClick,
}: PendingRepliesBlockProps): React.JSX.Element | null => {
  const { isLight } = useTheme();
  const pendingApprovals = useStore(useShallow((s) => s.pendingApprovals));
  const colorMap = buildMemberColorMap(members);
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
          Awaiting replies
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
          const isRetrying = advisoryLabel !== null;

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
                    src={agentAvatarUrl(member.name, 24)}
                    alt=""
                    className="size-5 rounded-full bg-[var(--color-surface-raised)]"
                    loading="lazy"
                  />
                  <span className="absolute -bottom-0.5 -right-0.5 flex size-2.5">
                    <span
                      className={`absolute inline-flex size-full animate-ping rounded-full opacity-70 ${isRetrying ? 'bg-amber-400' : 'bg-emerald-400'}`}
                    />
                    <span
                      className={`relative inline-flex size-full rounded-full ${isRetrying ? 'bg-amber-500' : 'bg-emerald-500'}`}
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
                    title="Open member"
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
                  className={`min-w-0 flex-1 truncate text-[10px] ${isRetrying ? 'text-amber-300' : ''}`}
                  style={isRetrying ? undefined : { color: CARD_ICON_MUTED }}
                  title={advisoryTitle ?? 'Message sent, awaiting reply'}
                >
                  {advisoryLabel ?? 'awaiting reply'}
                </span>
                {isRetrying ? (
                  <Loader2 className="size-3 shrink-0 animate-spin text-amber-400" />
                ) : null}
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
                  external team
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-[10px]"
                  style={{ color: CARD_ICON_MUTED }}
                  title="Cross-team message sent, awaiting reply"
                >
                  awaiting reply
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
                user
              </span>
              <span
                className="min-w-0 flex-1 truncate text-[10px]"
                style={{ color: CARD_ICON_MUTED }}
                title={`Tool approval: ${entry.toolName}`}
              >
                awaiting approval
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
};
