import React from 'react';

import { Label } from '@renderer/components/ui/label';
import { cn } from '@renderer/lib/utils';
import { Brain } from 'lucide-react';

const EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
] as const;

export interface EffortLevelSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  id?: string;
}

export const EffortLevelSelector: React.FC<EffortLevelSelectorProps> = ({
  value,
  onValueChange,
  id,
}) => (
  <div className="mb-3">
    <Label htmlFor={id} className="label-optional mb-1.5 block">
      Effort level (optional)
    </Label>
    <div className="flex items-center gap-2">
      <Brain size={16} className="shrink-0 text-[var(--color-text-muted)]" />
      <div className="inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
        {EFFORT_OPTIONS.map((opt) => (
          <button
            key={opt.value || '__default__'}
            type="button"
            id={opt.value === value ? id : undefined}
            className={cn(
              'rounded-[3px] px-3 py-1 text-xs font-medium transition-colors',
              value === opt.value
                ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
            )}
            onClick={() => onValueChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
    <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
      Controls how much reasoning the selected provider invests before responding. Default uses the
      provider&apos;s standard behavior for the selected model.
    </p>
  </div>
);
