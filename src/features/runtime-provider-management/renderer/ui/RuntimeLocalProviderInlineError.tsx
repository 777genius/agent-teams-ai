import { AlertTriangle } from 'lucide-react';

import type { JSX } from 'react';

export const RuntimeLocalProviderInlineError = ({
  message,
}: {
  readonly message: string;
}): JSX.Element => (
  <div
    role="alert"
    className="flex items-start gap-2 rounded-r-md border-l-2 border-red-400/70 bg-red-400/[0.06] px-3 py-2.5 text-xs text-red-200"
  >
    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
    <span>{message}</span>
  </div>
);
