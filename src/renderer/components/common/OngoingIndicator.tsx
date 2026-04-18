/**
 * OngoingIndicator - Pulsing green dot for sessions/groups in progress.
 * Shared across SessionItem (sidebar) and LastOutputDisplay (chat).
 */

import React from 'react';

import { Loader2 } from 'lucide-react';

interface OngoingIndicatorProps {
  /** Size variant */
  size?: 'sm' | 'md';
  /** Whether to show text label */
  showLabel?: boolean;
  /** Custom label text */
  label?: string;
  /** Accessible title/tooltip text */
  title?: string;
}

/**
 * Pulsing green dot indicator for ongoing sessions.
 * Use size="sm" for compact displays (sidebar), size="md" for larger displays (chat).
 */
export const OngoingIndicator = ({
  size = 'sm',
  showLabel = false,
  label = 'Session in progress...',
  title = label,
}: Readonly<OngoingIndicatorProps>): React.JSX.Element => {
  const dotSize = size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5';

  return (
    <span className="inline-flex items-center gap-2" title={title}>
      <span className={`relative flex ${dotSize} shrink-0`}>
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-green-400 opacity-75" />
        <span className={`relative inline-flex rounded-full ${dotSize} bg-green-500`} />
      </span>
      {showLabel && (
        <span className="text-sm" style={{ color: 'var(--info-text)' }}>
          {label}
        </span>
      )}
    </span>
  );
};

/**
 * OngoingBanner - Full-width banner variant for the LastOutputDisplay.
 * Shows animated spinner and text.
 */
export const OngoingBanner = (): React.JSX.Element => {
  return (
    <div
      className="flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3"
      style={{
        backgroundColor: 'var(--info-bg)',
        border: '1px solid var(--info-border)',
      }}
    >
      <Loader2 className="size-4 shrink-0 animate-spin" style={{ color: 'var(--info-text)' }} />
      <span className="text-sm font-medium" style={{ color: 'var(--info-text)' }}>
        Session is in progress...
      </span>
    </div>
  );
};
