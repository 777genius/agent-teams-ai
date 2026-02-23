import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';
import { Loader2 } from 'lucide-react';

import { STEP_LABELS, STEP_ORDER } from './provisioningSteps';

import type { ProvisioningStep } from './provisioningSteps';

export interface ProvisioningProgressBlockProps {
  /** Title above the steps, e.g. "Launching team" */
  title: string;
  /** Optional status message */
  message?: string | null;
  /** Index of the current step in STEP_ORDER (0-based), or -1 if unknown */
  currentStepIndex: number;
  /** Show spinner next to title */
  loading?: boolean;
  /** Cancel button label and handler */
  onCancel?: (() => void) | null;
  className?: string;
}

export const ProvisioningProgressBlock = ({
  title,
  message,
  currentStepIndex,
  loading = false,
  onCancel,
  className,
}: ProvisioningProgressBlockProps): React.JSX.Element => {
  return (
    <div
      className={cn(
        'rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2',
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {loading ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-[var(--color-text-muted)]" />
          ) : null}
          <p className="text-xs font-medium text-[var(--color-text)]">{title}</p>
        </div>
        {onCancel ? (
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={onCancel}
          >
            Cancel
          </Button>
        ) : null}
      </div>
      {message ? <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">{message}</p> : null}
      <div className="mt-2 flex items-center gap-1 overflow-x-auto pb-0.5">
        {STEP_ORDER.filter((s): s is ProvisioningStep => s !== 'ready').map((step, index) => {
          const isDone = currentStepIndex >= 0 && index < currentStepIndex;
          const isCurrent = currentStepIndex >= 0 && index === currentStepIndex;

          return (
            <div key={step} className="flex items-center gap-1">
              <Badge
                variant="secondary"
                className={cn(
                  'whitespace-nowrap px-2 py-0.5 text-[11px] font-normal',
                  isDone && 'border-emerald-400/60 bg-emerald-500/10 text-emerald-200',
                  isCurrent &&
                    'border-[var(--color-accent)]/70 bg-[var(--color-accent)]/15 text-[var(--color-text)]'
                )}
              >
                <span className="mr-1 inline-flex size-4 items-center justify-center rounded-full border border-current text-[10px]">
                  {index + 1}
                </span>
                {STEP_LABELS[step]}
              </Badge>
              {index < STEP_ORDER.filter((s) => s !== 'ready').length - 1 ? (
                <span className="text-[var(--color-text-muted)]">&rarr;</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};
