import { useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Check, Loader2 } from 'lucide-react';

import { OPENROUTER_FREE_MODEL_ID } from '../view-models/openCodeDefaultModelInheritance';

import {
  canAttemptOpenCodeDefaultSelection,
  getOpenCodeRouteUnavailableTitle,
} from './runtimeProviderModelAccess';
import { RuntimeProviderModelTestButton } from './RuntimeProviderModelTestButton';
import { RuntimeProviderModelTestResult } from './RuntimeProviderModelTestResult';

import type { RuntimeProviderManagementActions } from '../hooks/useRuntimeProviderManagement';
import type {
  RuntimeProviderConnectionDto,
  RuntimeProviderDefaultScopeDto,
  RuntimeProviderModelDto,
  RuntimeProviderModelTestResultDto,
} from '@features/runtime-provider-management/contracts';
import type { JSX, ReactNode } from 'react';

export const ModelRow = ({
  provider,
  model,
  selected,
  disabled,
  hasProjectContext,
  testing,
  testStartedAt,
  result,
  defaultTarget,
  intendedProjectPath,
  savingDefault,
  defaultMutationBusy,
  badges,
  formatMessage,
  actions,
}: {
  readonly provider: RuntimeProviderConnectionDto;
  readonly model: RuntimeProviderModelDto;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly hasProjectContext: boolean;
  readonly testing: boolean;
  readonly testStartedAt?: number;
  readonly result: RuntimeProviderModelTestResultDto | undefined;
  readonly defaultTarget: RuntimeProviderDefaultScopeDto | null;
  readonly intendedProjectPath: string | null;
  readonly savingDefault: boolean;
  readonly defaultMutationBusy: boolean;
  readonly badges: ReactNode;
  readonly formatMessage: (message: string) => {
    readonly summary: string;
    readonly details: unknown | null;
  };
  readonly actions: RuntimeProviderManagementActions;
}): JSX.Element => {
  const { t } = useAppTranslation('settings');
  const modelDisabled =
    disabled ||
    (defaultTarget !== null && !canAttemptOpenCodeDefaultSelection(model, defaultTarget));
  const unavailableTitle = getOpenCodeRouteUnavailableTitle(model, t);
  const modelTarget = model.displayName || model.modelId;
  const [stopping, setStopping] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  useEffect(() => {
    if (testing) setCancelled(false);
  }, [testing, testStartedAt]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    const startedAt = testStartedAt ?? Date.now();
    setElapsedSeconds(testing ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0);
    if (!testing) return;
    const timer = window.setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000
    );
    return () => window.clearInterval(timer);
  }, [testing, testStartedAt]);
  const selectionLabel = t(
    selected ? 'runtimeProvider.defaults.selected' : 'runtimeProvider.defaults.select'
  );

  return (
    <div
      data-testid={`runtime-provider-model-row-${model.modelId}`}
      className="rounded-md border px-3 py-2.5"
      style={{
        borderColor: selected ? 'rgba(96, 165, 250, 0.45)' : 'var(--color-border-subtle)',
        backgroundColor: selected ? 'rgba(96, 165, 250, 0.06)' : 'rgba(255,255,255,0.02)',
      }}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div className="block w-full min-w-0 text-left">
          <div
            className="text-sm font-medium leading-5"
            style={{ color: 'var(--color-text)', overflowWrap: 'anywhere' }}
          >
            {model.displayName}
          </div>
          <div
            className="mt-1 text-[11px] leading-4"
            style={{ color: 'var(--color-text-muted)', overflowWrap: 'anywhere' }}
          >
            {model.modelId}
          </div>
          {badges}
          {model.modelId === OPENROUTER_FREE_MODEL_ID ? (
            <div className="mt-2 text-xs leading-5 text-amber-200">
              {t('runtimeProvider.defaults.freeRouterAdvisory')}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <RuntimeProviderModelTestButton
            modelId={model.modelId}
            modelTarget={modelTarget}
            disabled={disabled}
            hasProjectContext={hasProjectContext}
            testing={testing}
            onTest={() => {
              void actions.testModel(provider.providerId, model.modelId);
            }}
          />
          {defaultTarget ? (
            <Button
              type="button"
              size="sm"
              variant="default"
              className="h-8"
              disabled={
                modelDisabled ||
                defaultMutationBusy ||
                selected ||
                (defaultTarget === 'project' && !hasProjectContext)
              }
              aria-pressed={selected}
              aria-label={`${selectionLabel}: ${modelTarget}${unavailableTitle ? `: ${unavailableTitle}` : ''}`}
              onClick={(event) => {
                event.stopPropagation();
                void actions
                  .setDefaultModel(
                    provider.providerId,
                    model.modelId,
                    defaultTarget,
                    intendedProjectPath
                  )
                  .catch(() => undefined);
              }}
            >
              {savingDefault ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}
              {selected ? <Check className="mr-1 size-3.5" /> : null}
              {selectionLabel}
            </Button>
          ) : null}
        </div>
      </div>
      {unavailableTitle ? (
        <div className="mt-2 text-xs text-amber-200">{unavailableTitle}</div>
      ) : null}
      {testing ? (
        <div role="status" className="mt-2 text-xs text-[var(--color-text-muted)]">
          {t('runtimeProvider.models.testingElapsed', { seconds: elapsedSeconds })}
          {actions.stopModelTest ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="ml-2 h-7"
              disabled={stopping}
              onClick={(event) => {
                event.stopPropagation();
                setStopping(true);
                void actions
                  .stopModelTest?.(provider.providerId, model.modelId)
                  .then((stopped) => setCancelled(stopped))
                  .catch(() => setCancelled(false))
                  .finally(() => setStopping(false));
              }}
            >
              {t(
                stopping ? 'runtimeProvider.models.stoppingTest' : 'runtimeProvider.models.stopTest'
              )}
            </Button>
          ) : null}
        </div>
      ) : cancelled ? (
        <div role="status" className="mt-2 text-xs text-[var(--color-text-muted)]">
          {t('runtimeProvider.models.testCancelled')}
        </div>
      ) : (
        <RuntimeProviderModelTestResult result={result} formatMessage={formatMessage} />
      )}
    </div>
  );
};
