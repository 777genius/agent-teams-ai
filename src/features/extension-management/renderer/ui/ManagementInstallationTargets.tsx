import { useAppTranslation } from '@features/localization/renderer';
import { Checkbox } from '@renderer/components/ui/checkbox';

import type { ManagedExtensionsModel } from '../hooks/useManagedExtensions';

interface Props {
  targets: ManagedExtensionsModel['installationTargets'];
  unavailableTargets: ManagedExtensionsModel['unavailableTargets'];
  disabled: boolean;
  onSelect: (targetId: string, selected: boolean) => void;
}

export const ManagementInstallationTargets = ({
  targets,
  unavailableTargets,
  disabled,
  onSelect,
}: Props) => {
  const { t } = useAppTranslation('extensions');
  return (
    <fieldset className="space-y-2 rounded-lg border border-border p-3" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">{t('uap.installTargets')}</legend>
      <p className="text-xs text-text-muted">{t('uap.installTargetsHelp')}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {targets.map((target) => (
          <label key={target.id} className="flex min-w-0 items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              aria-label={t('uap.installForAgent', { name: target.label })}
              data-testid="uap-install-target"
              data-target-id={target.id}
              checked={target.selected}
              disabled={disabled || !target.available}
              onCheckedChange={(checked) => onSelect(target.id, checked === true)}
            />
            <span className="min-w-0">
              <span className="block break-words">{target.label}</span>
              {!target.available && (
                <span className="block text-xs text-amber-400">
                  {target.reason || t('uap.runtimeUnavailable')}
                </span>
              )}
            </span>
          </label>
        ))}
        {unavailableTargets.map((target) => (
          <div
            key={`unavailable-${target.client}`}
            className="flex min-w-0 items-start gap-2 text-sm"
          >
            <Checkbox
              className="mt-0.5"
              aria-label={t('uap.installForAgent', { name: target.label })}
              data-testid="uap-unavailable-target"
              checked={false}
              disabled
            />
            <span className="min-w-0">
              <span className="block break-words">{target.label}</span>
              <span className="block text-xs text-amber-400">{target.reason}</span>
            </span>
          </div>
        ))}
      </div>
      {!targets.some((target) => target.selected) && (
        <p className="text-xs text-text-muted">{t('uap.selectInstallTarget')}</p>
      )}
    </fieldset>
  );
};
