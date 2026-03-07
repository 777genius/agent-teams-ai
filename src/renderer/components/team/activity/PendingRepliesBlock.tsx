import { CARD_BG, CARD_BORDER_STYLE, CARD_ICON_MUTED } from '@renderer/constants/cssVariables';
import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { agentAvatarUrl, buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { formatDistanceToNowStrict } from 'date-fns';

import type { ResolvedTeamMember } from '@shared/types';

interface PendingRepliesBlockProps {
  members: ResolvedTeamMember[];
  pendingRepliesByMember: Record<string, number>;
  onMemberClick?: (member: ResolvedTeamMember) => void;
}

export const PendingRepliesBlock = ({
  members,
  pendingRepliesByMember,
  onMemberClick,
}: PendingRepliesBlockProps): React.JSX.Element | null => {
  const { isLight } = useTheme();
  const colorMap = buildMemberColorMap(members);
  const pending = Object.entries(pendingRepliesByMember)
    .map(([name, sentAtMs]) => ({
      member: members.find((m) => m.name === name) ?? null,
      name,
      sentAtMs,
    }))
    .filter((p): p is { member: ResolvedTeamMember; name: string; sentAtMs: number } => !!p.member)
    .sort((a, b) => b.sentAtMs - a.sentAtMs);

  if (pending.length === 0) return null;

  return (
    <div className="mb-3 space-y-1.5">
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
        Awaiting replies
      </p>
      {pending.map(({ member, sentAtMs }) => {
        const colors = getTeamColorSet(colorMap.get(member.name) ?? '');
        const roleLabel = formatAgentRole(
          member.role ?? (member.agentType !== 'general-purpose' ? member.agentType : undefined)
        );
        const since = formatDistanceToNowStrict(sentAtMs, { addSuffix: true });

        return (
          <article
            key={`pending-reply:${member.name}:${sentAtMs}`}
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
                <span className="absolute -bottom-0.5 -right-0.5 flex h-2.5 w-2.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                  <span className="relative inline-flex size-full rounded-full bg-emerald-500" />
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
                  {member.name}
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
                  {member.name}
                </span>
              )}
              {roleLabel ? (
                <span className="text-[10px]" style={{ color: CARD_ICON_MUTED }}>
                  {roleLabel}
                </span>
              ) : null}
              <span
                className="min-w-0 flex-1 truncate text-[10px]"
                style={{ color: CARD_ICON_MUTED }}
                title="Message sent, awaiting reply"
              >
                awaiting reply
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
