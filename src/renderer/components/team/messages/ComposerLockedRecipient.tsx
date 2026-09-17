import { MemberBadge } from '@renderer/components/team/MemberBadge';

import type { JSX } from 'react';

interface ComposerLockedRecipientProps {
  name: string;
  color?: string;
  avatarUrl?: string;
}

export function ComposerLockedRecipient({
  name,
  color,
  avatarUrl,
}: ComposerLockedRecipientProps): JSX.Element {
  return (
    <div className="message-composer-target-selectors flex w-fit min-w-0 max-w-full items-center overflow-hidden px-2">
      <MemberBadge
        name={name}
        color={color}
        size="sm"
        avatarUrl={avatarUrl}
        hideAvatar={name === 'user'}
        disableHoverCard
        variant="text"
      />
    </div>
  );
}
