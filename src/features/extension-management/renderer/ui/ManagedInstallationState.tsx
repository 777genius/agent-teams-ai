import { useAppTranslation } from '@features/localization/renderer';

import type { ManagementEnvironment, ManagementSession } from '../../contracts';

type Entry = ManagementEnvironment['entries'][number];

// Collapse only known, non-actionable states. Unknown values remain visible.
const ordinaryReadiness: Record<string, readonly string[]> = {
  materialization: ['materialized'],
  activation: ['active', 'not_required'],
  authentication: ['authenticated', 'not_required', 'not_checked'],
  policy: ['allowed'],
  verification: ['package_validated', 'installation_verified', 'runtime_verified', 'not_run'],
};
const readable = (value: string) => value.replaceAll('_', ' ');

export const ManagedInstallationState = ({
  entry,
  targets,
}: {
  entry: Entry;
  targets?: ManagementSession['targets'];
}) => {
  const { t } = useAppTranslation('extensions');
  const targetLabel = (targetId: string, client: string) =>
    targets?.find((target) => target.id === targetId)?.label || client;
  return (
    <>
      {entry.bindings.map((binding) => (
        <div key={binding.targetId} className="space-y-1 text-xs">
          <p className={binding.status === 'installed' ? 'text-text-secondary' : 'text-amber-400'}>
            {targetLabel(binding.targetId, binding.client)} ·{' '}
            {binding.status === 'installed' ? t('uap.installed') : readable(binding.status)}
          </p>
          {Object.entries(binding.readiness ?? {})
            .filter(([name, value]) => !ordinaryReadiness[name]?.includes(value))
            .map(([name, value]) => (
              <p key={name} className="text-amber-400">
                {readable(name)}: {readable(value)}
              </p>
            ))}
        </div>
      ))}
      {(entry.updateStatus === 'available' ||
        entry.updateStatus === 'pinned' ||
        entry.updateStatus === 'blocked') && (
        <p className="text-xs text-text-secondary">{t(`uap.updateStatus.${entry.updateStatus}`)}</p>
      )}
      <details className="text-xs text-text-muted">
        <summary className="cursor-pointer">{t('uap.installationDetails')}</summary>
        <div className="mt-2 space-y-2">
          <p className="break-all">{entry.source}</p>
          <p>{t(`uap.updateStatus.${entry.updateStatus}`)}</p>
          {entry.bindings.map((binding) => (
            <div key={binding.targetId} className="space-y-1">
              <p>
                {targetLabel(binding.targetId, binding.client)}: {binding.status}
              </p>
              {binding.readiness && (
                <p>
                  {Object.entries(binding.readiness)
                    .map(([name, value]) => `${name}: ${value}`)
                    .join(' · ')}
                </p>
              )}
              {binding.managedPaths.map((path) => (
                <p key={path} className="break-all">
                  {path}
                </p>
              ))}
            </div>
          ))}
        </div>
      </details>
    </>
  );
};
