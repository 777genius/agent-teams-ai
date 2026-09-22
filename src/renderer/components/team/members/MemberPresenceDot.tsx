import { memo } from 'react';

import { useSyncedAnimationStyle } from '@renderer/hooks/useSyncedAnimationStyle';
import { cn } from '@renderer/lib/utils';

const PULSE_DURATION_MS = 2000;

interface MemberPresenceDotProps {
  className?: string;
  label: string;
}

export const MemberPresenceDot = memo(
  ({ className, label }: MemberPresenceDotProps): React.JSX.Element => {
    const shouldSyncPulse = className?.includes('animate-pulse') === true;
    const syncedPulseStyle = useSyncedAnimationStyle(shouldSyncPulse, PULSE_DURATION_MS);

    return (
      <span
        className={cn(
          'absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-[var(--color-surface)]',
          className
        )}
        style={syncedPulseStyle}
        aria-label={label}
      />
    );
  }
);

MemberPresenceDot.displayName = 'MemberPresenceDot';
