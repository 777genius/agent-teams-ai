import { useEffect, useRef, useState } from 'react';

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

const OPENROUTER_PAID_RETRY_MODEL = 'openrouter/openai/gpt-oss-20b';

export const ModelRow = ({
  provider,
  model,
  selected,
  disabled,
  hasProjectContext,
  testing,
  cancelled = false,
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
  readonly cancelled?: boolean;
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
  const canRetryPaid =
    provider.providerId === 'openrouter' &&
    (model.free || model.modelId.endsWith(':free') || model.modelId === OPENROUTER_FREE_MODEL_ID);
  const [paidRetry, setPaidRetry] = useState<{
    testing: boolean;
    result?: RuntimeProviderModelTestResultDto;
  } | null>(null);
  const retryScope = useRef({
    active: true,
    busy: false,
    attempt: null as { cancelRequested: boolean; stopConfirmed: boolean } | null,
  });
  useEffect(() => {
    const scope = {
      active: true,
      busy: false,
      attempt: null as { cancelRequested: boolean; stopConfirmed: boolean } | null,
    };
    retryScope.current = scope;
    setPaidRetry(null);
    return () => {
      scope.active = false;
    };
  }, [provider.providerId, model.modelId, intendedProjectPath]);
  useEffect(() => {
    if (cancelled && retryScope.current.attempt) retryScope.current.attempt.cancelRequested = true;
  }, [cancelled]);
  const testSelectedModel = async (): Promise<void> => {
    const scope = retryScope.current;
    if (scope.busy || !scope.active) return;
    scope.busy = true;
    const attempt = { cancelRequested: false, stopConfirmed: false };
    scope.attempt = attempt;
    setPaidRetry(null);
    try {
      const tested = await actions.testModel(provider.providerId, model.modelId);
      if (
        !canRetryPaid ||
        !scope.active ||
        attempt.cancelRequested ||
        tested.ok ||
        !tested.diagnostics.includes('provider_free_quota_exhausted')
      )
        return;
      setPaidRetry({ testing: true });
      const retried = await actions.testModel(provider.providerId, OPENROUTER_PAID_RETRY_MODEL);
      if (scope.active && !attempt.stopConfirmed) setPaidRetry({ testing: false, result: retried });
    } finally {
      scope.busy = false;
      if (scope.active)
        setPaidRetry((current) => (current ? { ...current, testing: false } : null));
    }
  };

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
            disabled={disabled || paidRetry?.testing === true}
            testing={testing || paidRetry?.testing === true}
            onTest={() => {
              void testSelectedModel().catch(() => undefined);
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
      {canRetryPaid ? (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          {t('runtimeProvider.models.paidRetryNotice')}
        </p>
      ) : null}
      {paidRetry ? (
        <div className="mt-2" role="status">
          <p className="text-xs text-[var(--color-text-muted)]">
            {t(
              paidRetry.testing
                ? 'runtimeProvider.models.paidRetryRunning'
                : 'runtimeProvider.models.paidRetryResult'
            )}
          </p>
          <RuntimeProviderModelTestResult result={paidRetry.result} formatMessage={formatMessage} />
          {paidRetry.testing && actions.stopModelTest ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-1 h-7"
              disabled={stopping}
              onClick={() => {
                const scope = retryScope.current;
                const attempt = scope.attempt;
                if (attempt) attempt.cancelRequested = true;
                setStopping(true);
                void actions
                  .stopModelTest?.(provider.providerId, OPENROUTER_PAID_RETRY_MODEL)
                  .then((stopped) => {
                    if (!stopped || !scope.active || !attempt) return;
                    attempt.stopConfirmed = true;
                    setPaidRetry({
                      testing: false,
                      result: {
                        providerId: provider.providerId,
                        modelId: OPENROUTER_PAID_RETRY_MODEL,
                        ok: false,
                        availability: 'unknown',
                        message: t('runtimeProvider.models.testCancelled'),
                        diagnostics: [],
                      },
                    });
                  })
                  .catch(() => undefined)
                  .finally(() => setStopping(false));
              }}
            >
              {t('runtimeProvider.models.stopTest')}
            </Button>
          ) : null}
        </div>
      ) : null}
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
                if (retryScope.current.attempt) retryScope.current.attempt.cancelRequested = true;
                setStopping(true);
                void actions
                  .stopModelTest?.(provider.providerId, model.modelId)
                  .catch(() => undefined)
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
        <RuntimeProviderModelTestResult
          result={
            result && canRetryPaid && result.diagnostics.includes('provider_free_quota_exhausted')
              ? { ...result, message: t('runtimeProvider.models.freeQuotaReached') }
              : result
          }
          formatMessage={formatMessage}
        />
      )}
    </div>
  );
};
