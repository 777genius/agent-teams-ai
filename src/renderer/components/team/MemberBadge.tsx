import { memo, useMemo } from 'react';

import {
  getTeamColorSet,
  getThemedBadge,
  getThemedBorder,
  getThemedText,
} from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import { selectResolvedMembersForTeamName } from '@renderer/store/slices/teamSlice';
import {
  agentAvatarUrl,
  buildMemberAvatarMap,
  displayMemberName,
} from '@renderer/utils/memberHelpers';

import { MemberHoverCard } from './members/MemberHoverCard';

import type { ResolvedTeamMember } from '@shared/types';

interface MemberBadgeProps {
  name: string;
  color?: string;
  /** Owning team context for hover-card store lookups. */
  teamName?: string;
  /** Pre-resolved theme flag from callers that already read theme state. */
  isLight?: boolean;
  /** Avatar + badge size variant */
  size?: 'xs' | 'sm' | 'md';
  /** Pre-resolved avatar URL from a caller that already owns the member roster. */
  avatarUrl?: string;
  /** Hide the avatar icon, show only the name badge */
  hideAvatar?: boolean;
  onClick?: (name: string) => void;
  /** Disable the hover card (e.g. inside MemberHoverCard itself to avoid nesting) */
  disableHoverCard?: boolean;
}

const EMPTY_TEAM_MEMBERS: readonly ResolvedTeamMember[] = [];
const memberAvatarMapCache = new WeakMap<readonly ResolvedTeamMember[], Map<string, string>>();

function getCachedMemberAvatarMap(members: readonly ResolvedTeamMember[]): Map<string, string> {
  const cached = memberAvatarMapCache.get(members);
  if (cached) {
    return cached;
  }

  const next = buildMemberAvatarMap(members);
  memberAvatarMapCache.set(members, next);
  return next;
}

/**
 * Reusable member avatar + colored name badge.
 * Avatar is rendered OUTSIDE the badge, to the left.
 * When onClick is provided, both avatar and badge are clickable as one unit.
 * Wrapped in MemberHoverCard to show member info on hover.
 */
type MemberBadgeContentProps = Omit<MemberBadgeProps, 'isLight'> & {
  isLight: boolean;
};

type MemberBadgeResolvedContentProps = MemberBadgeContentProps & {
  resolvedAvatarUrl?: string;
};

const MemberBadgeResolvedContent = memo(
  ({
    name,
    color,
    teamName,
    isLight,
    size = 'sm',
    resolvedAvatarUrl,
    hideAvatar,
    onClick,
    disableHoverCard,
  }: MemberBadgeResolvedContentProps): React.JSX.Element => {
    const colors = getTeamColorSet(color ?? '');
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
        src={resolvedAvatarUrl ?? agentAvatarUrl(name, avatarSize)}
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
  }
);

MemberBadgeResolvedContent.displayName = 'MemberBadgeResolvedContent';

const MemberBadgeWithResolvedAvatar = memo((props: MemberBadgeContentProps): React.JSX.Element => {
  const effectiveAvatarTeamName = useStore((s) => props.teamName ?? s.selectedTeamName);
  const teamMembers = useStore((s) =>
    effectiveAvatarTeamName
      ? selectResolvedMembersForTeamName(s, effectiveAvatarTeamName)
      : EMPTY_TEAM_MEMBERS
  );
  const avatarMap = useMemo(() => getCachedMemberAvatarMap(teamMembers), [teamMembers]);
  return <MemberBadgeResolvedContent {...props} resolvedAvatarUrl={avatarMap.get(props.name)} />;
});

MemberBadgeWithResolvedAvatar.displayName = 'MemberBadgeWithResolvedAvatar';

const MemberBadgeContent = memo((props: MemberBadgeContentProps): React.JSX.Element => {
  if (props.hideAvatar || props.avatarUrl != null) {
    return <MemberBadgeResolvedContent {...props} resolvedAvatarUrl={props.avatarUrl} />;
  }
  return <MemberBadgeWithResolvedAvatar {...props} />;
});

MemberBadgeContent.displayName = 'MemberBadgeContent';

const ThemedMemberBadge = memo(function ThemedMemberBadge({
  isLight: _isLight,
  ...props
}: MemberBadgeProps): React.JSX.Element {
  const { isLight } = useTheme();
  return <MemberBadgeContent {...props} isLight={isLight} />;
});

export const MemberBadge = memo(function MemberBadge(props: MemberBadgeProps): React.JSX.Element {
  if (typeof props.isLight === 'boolean') {
    return <MemberBadgeContent {...props} isLight={props.isLight} />;
  }
  return <ThemedMemberBadge {...props} />;
});

MemberBadge.displayName = 'MemberBadge';
