import { getTeamColorSet } from '@renderer/constants/teamColors';
import { agentAvatarUrl } from '@renderer/utils/memberHelpers';

interface MemberBadgeProps {
  name: string;
  color?: string;
  /** Avatar + badge size variant */
  size?: 'sm' | 'md';
  onClick?: (name: string) => void;
}

/**
 * Reusable member avatar + colored name badge.
 * Avatar is rendered OUTSIDE the badge, to the left.
 * When onClick is provided, both avatar and badge are clickable as one unit.
 */
export const MemberBadge = ({
  name,
  color,
  size = 'sm',
  onClick,
}: MemberBadgeProps): React.JSX.Element => {
  const colors = getTeamColorSet(color ?? '');
  const avatarSize = size === 'md' ? 32 : 24;
  const avatarClass = size === 'md' ? 'size-6' : 'size-5';
  const textClass = size === 'md' ? 'text-xs' : 'text-[10px]';

  const badgeStyle = {
    backgroundColor: colors.badge,
    color: colors.text,
    border: `1px solid ${colors.border}40`,
  };

  const avatar = (
    <img
      src={agentAvatarUrl(name, avatarSize)}
      alt=""
      className={`${avatarClass} shrink-0 rounded-full bg-[var(--color-surface-raised)]`}
      loading="lazy"
    />
  );

  const badge = (
    <span
      className={`rounded px-1.5 py-0.5 ${textClass} font-medium tracking-wide`}
      style={badgeStyle}
    >
      {name === 'team-lead' ? 'lead' : name}
    </span>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded transition-opacity hover:opacity-90 focus:outline-none focus:ring-1 focus:ring-[var(--color-border)]"
        onClick={(e) => {
          e.stopPropagation();
          onClick(name);
        }}
      >
        {avatar}
        {badge}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      {avatar}
      {badge}
    </span>
  );
};
