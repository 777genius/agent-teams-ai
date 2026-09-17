import { MemberBadge } from '@renderer/components/team/MemberBadge';

import type { JSX } from 'react';

interface ComposerLockedRecipientProps {
  readonly name: string;
  readonly color?: string;
  readonly avatarUrl?: string;
}

export const ComposerLockedRecipient = ({
  name,
  color,
  avatarUrl,
}: Readonly<ComposerLockedRecipientProps>): JSX.Element => {
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
};
