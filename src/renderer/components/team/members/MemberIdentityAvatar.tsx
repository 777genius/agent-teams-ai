import { MemberPresenceDot } from '@renderer/components/team/members/MemberPresenceDot';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { agentAvatarUrl } from '@renderer/utils/memberHelpers';

import type { JSX } from 'react';

interface MemberIdentityAvatarProps {
  name: string;
  color?: string;
  avatarUrl?: string;
  presenceClass: string;
  presenceLabel: string;
}

export const MemberIdentityAvatar = ({
  name,
  color,
  avatarUrl,
  presenceClass,
  presenceLabel,
}: MemberIdentityAvatarProps): JSX.Element => {
  const { isLight } = useTheme();
  const colors = getTeamColorSet(color ?? '');

  return (
    <span className="relative inline-flex shrink-0">
      <span
        className="rounded-full border-2 p-px"
        style={{
          borderColor: colors.border,
          boxShadow: isLight ? 'none' : `0 0 0 1px ${colors.badge}`,
        }}
      >
        <img
          src={avatarUrl ?? agentAvatarUrl(name)}
          alt=""
          className="size-7 rounded-full bg-[var(--color-surface-raised)]"
          loading="lazy"
        />
      </span>
      <MemberPresenceDot className={`size-2.5 ${presenceClass}`} label={presenceLabel} />
    </span>
  );
};
