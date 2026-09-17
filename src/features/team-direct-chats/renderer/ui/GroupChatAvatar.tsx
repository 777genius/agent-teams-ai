import { Users } from 'lucide-react';

import type { JSX } from 'react';

export const GroupChatAvatar = (): JSX.Element => (
  <span className="flex size-[34px] items-center justify-center rounded-full bg-[var(--color-surface-raised)] text-[var(--color-text-muted)]">
    <Users size={14} />
  </span>
);
