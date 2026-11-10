import { useEffect, useRef, useState } from 'react';

import { cn } from '@renderer/lib/utils';
import { Check, X } from 'lucide-react';

export interface StepProgressBarStep {
  key: string;
  label: string;
}

export interface StepProgressBarProps {
  steps: StepProgressBarStep[];
  /** 0-based index of the current step, -1 if not started */
  currentIndex: number;
  /** Whether the current step should show in-progress animations */
  active?: boolean;
  /** If set, this step shows a red error indicator instead of active/pending */
  errorIndex?: number;
  className?: string;
}

/**
 * Circular step progress indicator with animated connecting lines.
 *
 * - Completed steps: green circle with checkmark + jelly bounce on completion
 * - Current step: green outlined circle with pulsing ring + number
 * - Error step: red circle with X icon
 * - Pending steps: gray circle with number
 */
export const StepProgressBar = ({
  steps,
  currentIndex,
  active = true,
  errorIndex,
  className,
}: StepProgressBarProps): React.JSX.Element => {
  const prevIndexRef = useRef(currentIndex);
  const [justCompletedIndex, setJustCompletedIndex] = useState<number | null>(null);
  const canAnimate = active && errorIndex === undefined;

  useEffect(() => {
    const prev = prevIndexRef.current;
    prevIndexRef.current = currentIndex;

    if (!canAnimate) {
      const clearTimer = window.setTimeout(() => setJustCompletedIndex(null), 0);
      return () => window.clearTimeout(clearTimer);
    }

    if (currentIndex > prev && prev >= 0) {
      const lastDoneIndex = Math.min(currentIndex - 1, steps.length - 1);
      const startTimer = window.setTimeout(() => setJustCompletedIndex(lastDoneIndex), 0);
      const clearTimer = window.setTimeout(() => setJustCompletedIndex(null), 500);
      return () => {
        window.clearTimeout(startTimer);
        window.clearTimeout(clearTimer);
      };
    }
  }, [canAnimate, currentIndex, steps.length]);

  return (
    <div className={cn('flex items-start justify-center', className)}>
      {steps.map((step, index) => {
        const isError = errorIndex !== undefined && index === errorIndex;
        const isDone = !isError && currentIndex >= 0 && index < currentIndex;
        const isCurrent = !isError && currentIndex >= 0 && index === currentIndex;
        const isLast = index === steps.length - 1;
        const isJustCompleted = canAnimate && justCompletedIndex === index;
        const isAnimatingCurrent = canAnimate && isCurrent;

        // The connecting line between this step and the next
        const lineState: 'done' | 'active' | 'pending' =
          isDone && !isLast ? 'done' : isAnimatingCurrent && !isLast ? 'active' : 'pending';

        return (
          <div
            key={step.key}
            className="flex items-start"
            style={{ flex: isLast ? '0 0 auto' : '1 1 0%' }}
          >
            {/* Step circle + label column */}
            <div className="flex flex-col items-center" style={{ width: 56 }}>
              {/* Circle wrapper - holds flash overlay */}
              <div className="relative flex items-center justify-center">
                {/* Green flash burst on completion */}
                {isJustCompleted && isDone && (
                  <div
                    className="absolute size-7 rounded-full bg-[var(--stepper-done)]"
                    style={{ animation: 'stepper-flash 0.4s ease-out forwards' }}
                  />
                )}

                {/* Circle */}
                <div
                  className={cn(
                    'relative flex items-center justify-center rounded-full transition-all duration-300',
                    'size-7',
                    isError &&
                      'bg-[var(--stepper-error)] shadow-[0_0_8px_var(--stepper-error-glow)]',
                    isDone && 'bg-[var(--stepper-done)] shadow-[0_0_8px_var(--stepper-done-glow)]',
                    isCurrent && 'border-2 border-[var(--stepper-current)] bg-transparent',
                    !isDone &&
                      !isCurrent &&
                      !isError &&
                      'border border-[var(--stepper-pending-border)] bg-[var(--stepper-pending)]'
                  )}
                  style={
                    isJustCompleted && isDone
                      ? { animation: 'stepper-jelly 0.45s ease-out' }
                      : isAnimatingCurrent
                        ? { animation: 'stepper-pulse-ring 2s ease-in-out infinite' }
                        : undefined
                  }
                >
                  {isError ? (
                    <X className="size-3.5 text-white" strokeWidth={3} />
                  ) : isDone ? (
                    <Check className="size-3.5 text-white" strokeWidth={3} />
                  ) : (
                    <span
                      className={cn(
                        'text-[11px] font-semibold leading-none',
                        isCurrent
                          ? 'text-[var(--stepper-current)]'
                          : 'text-[var(--stepper-pending-text)]'
                      )}
                    >
                      {index + 1}
                    </span>
                  )}
                </div>
              </div>

              {/* Label */}
              <span
                className={cn(
                  'mt-1.5 text-center text-[10px] leading-tight transition-colors duration-300',
                  isError
                    ? 'font-medium text-[var(--stepper-label-error)]'
                    : isDone || isCurrent
                      ? 'font-medium text-[var(--stepper-label-active)]'
                      : 'text-[var(--stepper-label)]'
                )}
              >
                {step.label}
              </span>
            </div>

            {/* Connecting line */}
            {!isLast && (
              <div
                className="relative mt-3.5 h-[2px] flex-1 overflow-hidden"
                style={{ minWidth: 16 }}
              >
                {/* Background track */}
                <div className="absolute inset-0 rounded-full bg-[var(--stepper-line)]" />

                {lineState === 'done' ? (
                  <div className="absolute inset-0 rounded-full bg-[var(--stepper-line-done)]" />
                ) : lineState === 'active' ? (
                  <div
                    className="absolute top-0 h-full rounded-full bg-[var(--stepper-line-done)]"
                    style={{
                      width: '40%',
                      animation: 'stepper-line-sweep 1.2s ease-in-out infinite',
                    }}
                  />
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
