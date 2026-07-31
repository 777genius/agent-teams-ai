import { Checkbox } from '@renderer/components/ui/checkbox';
import { Label } from '@renderer/components/ui/label';

import type { RuntimeLocalProviderScopeDto } from '../../contracts';
import type { JSX } from 'react';

interface LocalProviderModelAssignmentControlsProps {
  readonly scope: RuntimeLocalProviderScopeDto;
  readonly setAsDefault: boolean;
  readonly setAsSmallModel: boolean;
  readonly disabled: boolean;
  readonly saved: boolean;
  readonly onSetAsDefaultChange: (checked: boolean) => void;
  readonly onSetAsSmallModelChange: (checked: boolean) => void;
}

/** Renders independent default-model and lightweight-task assignment controls. */
export const LocalProviderModelAssignmentControls = ({
  scope,
  setAsDefault,
  setAsSmallModel,
  disabled,
  saved,
  onSetAsDefaultChange,
  onSetAsSmallModelChange,
}: LocalProviderModelAssignmentControlsProps): JSX.Element => {
  const scopeLabel = scope === 'global' ? 'global' : 'project';

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 text-xs text-[var(--color-text-secondary)]">
        <Checkbox
          id="runtime-local-provider-project-default"
          className="mt-0.5"
          checked={setAsDefault}
          disabled={disabled}
          onCheckedChange={(checked) => onSetAsDefaultChange(checked === true)}
        />
        <Label htmlFor="runtime-local-provider-project-default" className="font-normal">
          <span className="block text-[var(--color-text)]">
            {scope === 'global'
              ? 'Use as global default model'
              : 'Use as default model for this project'}
          </span>
          {!saved ? (
            <span className="mt-0.5 block text-[11px] text-[var(--color-text-muted)]">
              {setAsDefault
                ? `This replaces the current ${scopeLabel} default model. All other settings are preserved.`
                : `The current ${scopeLabel} default model is kept unchanged.`}
            </span>
          ) : null}
        </Label>
      </div>

      <div className="flex items-start gap-2 text-xs text-[var(--color-text-secondary)]">
        <Checkbox
          id="runtime-local-provider-small-model"
          className="mt-0.5"
          checked={setAsSmallModel}
          disabled={disabled}
          onCheckedChange={(checked) => onSetAsSmallModelChange(checked === true)}
        />
        <Label htmlFor="runtime-local-provider-small-model" className="font-normal">
          <span className="block text-[var(--color-text)]">
            Use for lightweight background tasks
          </span>
          {!saved ? (
            <span className="mt-0.5 block text-[11px] text-[var(--color-text-muted)]">
              {setAsSmallModel
                ? 'OpenCode routes summaries and other small tasks (small_model) to this model.'
                : 'The current lightweight-task model (small_model) is kept unchanged.'}
            </span>
          ) : null}
        </Label>
      </div>
    </div>
  );
};
