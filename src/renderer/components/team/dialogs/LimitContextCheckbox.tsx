import React from 'react';

import { Info } from 'lucide-react';

import { Checkbox } from '@renderer/components/ui/checkbox';
import { Label } from '@renderer/components/ui/label';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';

interface LimitContextCheckboxProps {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

export const LimitContextCheckbox: React.FC<LimitContextCheckboxProps> = ({
  id,
  checked,
  onCheckedChange,
  disabled = false,
}) => (
  <div className="mt-4 flex items-center gap-2">
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
      Limit context to 200K tokens
      {disabled && <span className="text-[10px] italic">(always 200K for this model)</span>}
    </Label>
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Info
            className={`size-3.5 shrink-0 ${disabled ? 'text-text-muted opacity-50' : 'text-text-muted hover:text-text-secondary'} cursor-help`}
          />
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[260px]">
          <p>
            Agents will use 200K context window instead of the default 1M. Useful if you want to
            save tokens and reduce costs.
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
);
