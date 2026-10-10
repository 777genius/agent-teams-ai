import { Users } from 'lucide-react';

import type { JSX } from 'react';

interface GroupAvatarMember {
  name: string;
  displayName?: string;
  avatarUrl: string;
}

const MAX_VISIBLE_MEMBERS = 8;
const AVATAR_SIZE = 34;

export const GroupChatAvatar = ({
  members = [],
}: {
  members?: readonly GroupAvatarMember[];
}): JSX.Element => {
  if (!members.length) {
    return (
      <span
        aria-hidden="true"
        className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-raised)] text-[var(--color-text-muted)]"
      >
        <Users size={14} />
      </span>
    );
  }

  const overflow = members.length > MAX_VISIBLE_MEMBERS;
  const visible = members.slice(0, overflow ? MAX_VISIBLE_MEMBERS - 1 : MAX_VISIBLE_MEMBERS);
  const count = visible.length;
  const size = count === 1 ? AVATAR_SIZE : count <= 2 ? 22 : count <= 4 ? 18 : count <= 6 ? 14 : 12;
  const radius = (AVATAR_SIZE - size) / 2;
  const position = (index: number) => {
    const angle = (index * 2 * Math.PI) / count - (count === 2 ? (3 * Math.PI) / 4 : Math.PI / 2);
    const top = radius + (count === 1 ? 0 : Math.sin(angle) * radius);
    return {
      zIndex: Math.round(top * 100),
      width: size,
      height: size,
      left: radius + (count === 1 ? 0 : Math.cos(angle) * radius),
      top,
    };
  };

  return (
    <span
      role="img"
      aria-label={`${members.length}: ${members.map((member) => member.displayName ?? member.name).join(', ')}`}
      className="pointer-events-none relative isolate block size-[34px] shrink-0"
      data-group-avatar-count={members.length}
    >
      {visible.map((member, index) => (
        <img
          key={member.name}
          src={member.avatarUrl}
          alt=""
          loading="lazy"
          className="absolute object-contain"
          style={position(index)}
        />
      ))}
      {overflow ? (
        <span
          aria-hidden="true"
          className="absolute flex items-center justify-center font-medium text-[var(--color-text-secondary)]"
          style={{
            width: 16,
            height: 16,
            left: 9,
            top: 9,
            fontSize: 8,
            lineHeight: 1,
            zIndex: 10000,
          }}
        >
          +{members.length - visible.length}
        </span>
      ) : null}
    </span>
  );
};
