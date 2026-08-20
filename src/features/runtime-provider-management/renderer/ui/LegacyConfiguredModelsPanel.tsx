import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Loader2 } from 'lucide-react';

import {
  canUseOpenCodeModelRoute,
  needsOpenCodeModelExecutionProof,
} from './runtimeProviderModelAccess';

import type {
  RuntimeProviderManagementActions,
  RuntimeProviderManagementState,
} from '../hooks/useRuntimeProviderManagement';
import type { RuntimeProviderModelDto } from '@features/runtime-provider-management/contracts';
import type { JSX } from 'react';

interface LegacyConfiguredModelsPanelProps {
  readonly state: RuntimeProviderManagementState;
  readonly actions: RuntimeProviderManagementActions;
  readonly disabled: boolean;
  readonly hasProjectContext: boolean;
  readonly projectPath: string | null;
  readonly getUnavailableTitle: (model: RuntimeProviderModelDto) => string | undefined;
}

export const LegacyConfiguredModelsPanel = ({
  state,
  actions,
  disabled,
  hasProjectContext,
  projectPath,
  getUnavailableTitle,
}: LegacyConfiguredModelsPanelProps): JSX.Element => {
  const { t } = useAppTranslation('settings');
  const models = state.view?.configuredModels ?? [];
  const defaultActions = [
    {
      scope: 'project',
      label: t('runtimeProvider.defaults.setProjectDefault'),
      variant: 'outline',
    },
    {
      scope: 'all_projects',
      label: t('runtimeProvider.defaults.setAllProjectsDefault'),
      variant: 'default',
    },
  ] as const;

  if (models.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-white/10 p-4 text-sm text-[var(--color-text-muted)]">
        {t('runtimeProvider.models.noneReported')}
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="runtime-provider-legacy-models">
      {models.map((model) => {
        const unavailableTitle = getUnavailableTitle(model);
        const testing = state.testingModelIds.includes(model.modelId);
        const defaultDisabled =
          disabled ||
          Boolean(state.savingDefaultModelId) ||
          state.clearingProjectDefault ||
          (!canUseOpenCodeModelRoute(model) && !needsOpenCodeModelExecutionProof(model));

        return (
          <div
            key={model.modelId}
            className="rounded-md border px-3 py-2.5"
            style={{ borderColor: 'var(--color-border-subtle)' }}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="break-all text-sm font-medium text-[var(--color-text)]">
                  {model.displayName}
                </div>
                <div className="mt-1 break-all text-[11px] text-[var(--color-text-muted)]">
                  {model.modelId}
                </div>
                {unavailableTitle ? (
                  <div className="mt-1 text-xs text-amber-200">{unavailableTitle}</div>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || !hasProjectContext || testing}
                  onClick={() => void actions.testModel(model.providerId, model.modelId)}
                >
                  {testing ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}
                  {t('runtimeProvider.actions.test')}
                </Button>
                {defaultActions.map((action) => (
                  <Button
                    key={action.scope}
                    type="button"
                    size="sm"
                    variant={action.variant}
                    disabled={defaultDisabled || (action.scope === 'project' && !hasProjectContext)}
                    onClick={() =>
                      void (action.scope === 'project'
                        ? actions.setDefaultModel(
                            model.providerId,
                            model.modelId,
                            'project',
                            projectPath
                          )
                        : actions.setDefaultModel(model.providerId, model.modelId, 'all_projects'))
                    }
                  >
                    {action.scope === 'all_projects' &&
                    state.savingDefaultModelId === model.modelId ? (
                      <Loader2 className="mr-1 size-3.5 animate-spin" />
                    ) : null}
                    {action.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
