import { cn } from '@renderer/lib/utils';

import type React from 'react';

interface ActivePulseIndicatorProps {
  className?: string;
}

export const ActivePulseIndicator = ({
  className,
}: Readonly<ActivePulseIndicatorProps>): React.JSX.Element => (
  <span className={cn('relative inline-flex size-2.5', className)} aria-hidden="true">
    <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
    <span className="relative inline-flex size-full rounded-full bg-emerald-500" />
  </span>
);
