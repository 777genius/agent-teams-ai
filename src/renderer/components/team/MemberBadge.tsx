import {
  getTeamColorSet,
  getThemedBadge,
  getThemedBorder,
  getThemedText,
} from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { agentAvatarUrl, displayMemberName } from '@renderer/utils/memberHelpers';

import { MemberHoverCard } from './members/MemberHoverCard';

interface MemberBadgeProps {
  name: string;
  color?: string;
  /** Owning team context for hover-card store lookups. */
  teamName?: string;
  /** Avatar + badge size variant */
  size?: 'xs' | 'sm' | 'md';
  /** Hide the avatar icon, show only the name badge */
  hideAvatar?: boolean;
  onClick?: (name: string) => void;
  /** Disable the hover card (e.g. inside MemberHoverCard itself to avoid nesting) */
  disableHoverCard?: boolean;
}

/**
 * Reusable member avatar + colored name badge.
 * Avatar is rendered OUTSIDE the badge, to the left.
 * When onClick is provided, both avatar and badge are clickable as one unit.
 * Wrapped in MemberHoverCard to show member info on hover.
 */
export const MemberBadge = ({
  name,
  color,
  teamName,
  size = 'sm',
  hideAvatar,
  onClick,
  disableHoverCard,
}: MemberBadgeProps): React.JSX.Element => {
  const colors = getTeamColorSet(color ?? '');
  const { isLight } = useTheme();
  const avatarSize = size === 'md' ? 32 : size === 'sm' ? 24 : 18;
  const avatarClass = size === 'md' ? 'size-6' : size === 'sm' ? 'size-5' : 'size-4';
  const textClass = size === 'md' ? 'text-xs' : size === 'sm' ? 'text-[10px]' : 'text-[9px]';
  const paddingClass = size === 'xs' ? 'px-1 py-0.5' : 'px-1.5 py-0.5';

  const badgeStyle = {
    backgroundColor: getThemedBadge(colors, isLight),
    color: getThemedText(colors, isLight),
    border: `1px solid ${getThemedBorder(colors, isLight)}40`,
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
      className={`rounded ${paddingClass} ${textClass} font-medium tracking-wide`}
      style={badgeStyle}
    >
      {displayMemberName(name)}
    </span>
  );

  // Skip hover card for "user" and "system" pseudo-members
  const skipHoverCard = disableHoverCard || name === 'user' || name === 'system';

  const content = onClick ? (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded transition-opacity hover:opacity-90 focus:outline-none focus:ring-1 focus:ring-[var(--color-border)]"
      onClick={(e) => {
        e.stopPropagation();
        onClick(name);
      }}
    >
      {!hideAvatar && avatar}
      {badge}
    </button>
  ) : (
    <span className="inline-flex items-center gap-1">
      {!hideAvatar && avatar}
      {badge}
    </span>
  );

  if (skipHoverCard) {
    return content;
  }

  return (
    <MemberHoverCard name={name} color={color} teamName={teamName}>
      {content}
    </MemberHoverCard>
  );
};
