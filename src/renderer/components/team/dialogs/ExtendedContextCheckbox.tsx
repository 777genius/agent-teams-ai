import React from 'react';

import { Checkbox } from '@renderer/components/ui/checkbox';
import { Label } from '@renderer/components/ui/label';
import { AlertTriangle } from 'lucide-react';

interface ExtendedContextCheckboxProps {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

export const ExtendedContextCheckbox: React.FC<ExtendedContextCheckboxProps> = ({
  id,
  checked,
  onCheckedChange,
  disabled = false,
}) => (
  <>
    <div className="mt-2 flex items-center gap-2">
      <Checkbox
        id={id}
        checked={checked && !disabled}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <Label
        htmlFor={id}
        className={`flex cursor-pointer items-center gap-1.5 text-xs font-normal ${
          disabled ? 'cursor-not-allowed text-text-muted opacity-50' : 'text-text-secondary'
        }`}
      >
        Extended context (1M tokens)
        {disabled && <span className="text-[10px] italic">(not available for this model)</span>}
      </Label>
    </div>
    {checked && (
      <div className="mt-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
          <div className="space-y-1 text-amber-300/90">
            <p>
              Beyond 200K tokens, premium pricing applies: 2x input cost, 1.5x output cost. For
              subscribers, extra usage is billed separately.
            </p>
            <p>
              Requires API tier 4+ or extra usage enabled.{' '}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-amber-200"
                onClick={() =>
                  window.electronAPI.openExternal(
                    'https://platform.claude.com/docs/en/build-with-claude/context-windows#1m-token-context-window'
                  )
                }
              >
                Learn more
              </button>
            </p>
          </div>
        </div>
      </div>
    )}
  </>
);
