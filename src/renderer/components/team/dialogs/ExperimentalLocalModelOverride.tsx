import { Checkbox } from '@renderer/components/ui/checkbox';
import { Label } from '@renderer/components/ui/label';

import type React from 'react';

export const ExperimentalLocalModelOverrideCheckbox = (props: {
  id: string;
  checked: boolean;
  label: string;
  hint: string;
  onCheckedChange: (checked: boolean) => void;
}): React.JSX.Element => {
  return (
    <div className="mt-2 flex items-start gap-2 pl-6">
      <Checkbox
        id={props.id}
        checked={props.checked}
        onCheckedChange={(checked) => props.onCheckedChange(checked === true)}
      />
      <div className="space-y-0.5">
        <Label htmlFor={props.id} className="cursor-pointer text-xs font-medium text-amber-200">
          {props.label}
        </Label>
        <p className="text-[10px] text-[var(--color-text-muted)]">{props.hint}</p>
      </div>
    </div>
  );
};
