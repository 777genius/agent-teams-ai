import { useSyncedAnimationStyle } from '@renderer/hooks/useSyncedAnimationStyle';
import { cn } from '@renderer/lib/utils';
import { Loader2 } from 'lucide-react';

import type { ComponentProps } from 'react';

const DEFAULT_SPIN_DURATION_MS = 1000;

export type SyncedLoader2Props = ComponentProps<typeof Loader2> & {
  spinDurationMs?: number;
  spinning?: boolean;
};

export const SyncedLoader2 = ({
  className,
  style,
  spinDurationMs = DEFAULT_SPIN_DURATION_MS,
  spinning = true,
  ...props
}: SyncedLoader2Props): React.JSX.Element => {
  const syncedStyle = useSyncedAnimationStyle(spinning, spinDurationMs);

  return (
    <Loader2
      {...props}
      className={cn(spinning && 'animate-spin', className)}
      style={{ ...syncedStyle, ...style }}
    />
  );
};
