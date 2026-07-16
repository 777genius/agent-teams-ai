import { useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Settings2,
} from 'lucide-react';

import {
  isRuntimeProviderOnboardingPlanRoutable,
  rankRecommendedRuntimeProviderModels,
} from '../../core/domain';

import { ProviderBrandIcon } from './providerBrandIcons';
import { ProviderSetupFormPanel } from './RuntimeProviderManagementPanelView';

import type { RuntimeProviderOnboardingStage } from '../../core/domain';
import type {
  RuntimeProviderOnboardingActions,
  RuntimeProviderOnboardingState,
} from '../hooks/useRuntimeProviderOnboarding';
import type { JSX } from 'react';

interface RuntimeProviderOnboardingViewProps {
  readonly state: RuntimeProviderOnboardingState;
  readonly actions: RuntimeProviderOnboardingActions;
  readonly disabled?: boolean;
  readonly onAdvancedSettings: () => void;
  readonly onDone: () => void;
}

const STEP_ORDER: readonly Exclude<RuntimeProviderOnboardingStage, 'error'>[] = [
  'connect',
  'verifying',
  'choose-model',
  'ready',
];

const STEP_LABELS: Readonly<Record<Exclude<RuntimeProviderOnboardingStage, 'error'>, string>> = {
  connect: 'Connect plan',
  verifying: 'Verify',
  'choose-model': 'Choose model',
  ready: 'Ready',
};

function stageOrder(stage: RuntimeProviderOnboardingStage): number {
  if (stage === 'error') {
    return 1;
  }
  return STEP_ORDER.indexOf(stage);
}

const OnboardingSteps = ({
  stage,
}: {
  readonly stage: RuntimeProviderOnboardingStage;
}): JSX.Element => {
  const activeIndex = stageOrder(stage);
  return (
    <ol className="grid grid-cols-4 gap-1" aria-label="Provider setup progress">
      {STEP_ORDER.map((step, index) => {
        const complete = index < activeIndex || stage === 'ready';
        const active = index === activeIndex && stage !== 'ready';
        return (
          <li key={step} className="min-w-0">
            <div
              aria-hidden="true"
              className="h-1 rounded-full"
              style={{
                backgroundColor: complete
                  ? '#4ade80'
                  : active
                    ? '#60a5fa'
                    : 'var(--color-border-subtle)',
              }}
            />
            <div
              aria-current={active ? 'step' : undefined}
              className="mt-1 text-center text-[9px] leading-tight min-[380px]:text-[10px]"
              style={{
                color:
                  complete || active ? 'var(--color-text-secondary)' : 'var(--color-text-muted)',
              }}
            >
              {STEP_LABELS[step]}
            </div>
          </li>
        );
      })}
    </ol>
  );
};

const RuntimePrerequisite = ({
  state,
  actions,
}: {
  readonly state: RuntimeProviderOnboardingState;
  readonly actions: RuntimeProviderOnboardingActions;
}): JSX.Element | null => {
  const ready = state.runtimeGate === 'ready' && !state.runtimeUpdateRequired;
  if (ready) {
    return null;
  }
  const busy =
    state.runtimePreparing ||
    state.runtimeGate === 'checking' ||
    state.runtimeGate === 'installing';
  const installing = state.runtimeGate === 'installing';
  const update = state.runtimeUpdateRequired;
  const failed = state.runtimeGate === 'error' || Boolean(state.stageError);
  return (
    <div
      className="rounded-lg border p-4"
      role={failed ? 'alert' : 'status'}
      aria-live={failed ? 'assertive' : 'polite'}
      aria-busy={busy}
      style={{
        borderColor: failed ? 'rgba(248, 113, 113, 0.3)' : 'rgba(56, 189, 248, 0.28)',
        backgroundColor: failed ? 'rgba(248, 113, 113, 0.06)' : 'rgba(56, 189, 248, 0.06)',
      }}
    >
      <div className="flex items-start gap-3">
        {busy ? (
          <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-sky-300" />
        ) : failed ? (
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-red-300" />
        ) : (
          <Download className="mt-0.5 size-5 shrink-0 text-sky-300" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[var(--color-text)]">
            {failed
              ? 'OpenCode setup needs attention'
              : busy
                ? installing
                  ? 'Installing OpenCode'
                  : 'Preparing OpenCode'
                : update
                  ? 'Update OpenCode to continue'
                  : 'OpenCode is required'}
          </div>
          <div className="mt-1 text-xs text-[var(--color-text-muted)]">
            {failed
              ? (state.stageError ??
                'OpenCode could not be prepared. Retry or open Advanced settings for details.')
              : busy
                ? installing
                  ? 'Installing the managed OpenCode runtime. This window updates automatically.'
                  : 'Checking that OpenCode is installed and ready...'
                : update
                  ? 'The latest provider authentication bridge is needed for this plan.'
                  : 'Agent Teams will install and manage OpenCode for these subscription plans.'}
          </div>
        </div>
      </div>
      {!busy ? (
        <div className="mt-3 flex justify-end">
          <Button type="button" size="sm" onClick={() => void actions.installOrUpdateRuntime()}>
            {failed ? (
              <RefreshCw className="mr-1.5 size-3.5" />
            ) : (
              <Download className="mr-1.5 size-3.5" />
            )}
            {failed ? 'Retry OpenCode' : update ? 'Update OpenCode' : 'Install OpenCode'}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

const WizardPlanPicker = ({
  state,
  actions,
  disabled,
}: {
  readonly state: RuntimeProviderOnboardingState;
  readonly actions: RuntimeProviderOnboardingActions;
  readonly disabled: boolean;
}): JSX.Element => {
  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold text-[var(--color-text)]">Connect all my plans</div>
        <div className="mt-1 text-xs text-[var(--color-text-muted)]">
          Select the subscriptions you own. Already connected plans are detected automatically.
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {state.plans.map((plan) => {
          const selected = state.selectedPlanIds.includes(plan.id);
          const status = state.planStatuses.find((entry) => entry.plan.id === plan.id)?.state;
          return (
            <Label
              key={plan.id}
              htmlFor={`runtime-provider-wizard-${plan.id}`}
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal"
              style={{
                borderColor: selected ? 'rgba(96, 165, 250, 0.42)' : 'var(--color-border-subtle)',
                backgroundColor: selected ? 'rgba(96, 165, 250, 0.06)' : 'rgba(255,255,255,0.02)',
              }}
            >
              <Checkbox
                id={`runtime-provider-wizard-${plan.id}`}
                checked={selected}
                disabled={disabled}
                onCheckedChange={() => actions.togglePlan(plan.id)}
              />
              <ProviderBrandIcon
                provider={{ providerId: plan.providerId, displayName: plan.displayName }}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2 text-xs font-medium text-[var(--color-text)]">
                  <span className="truncate">{plan.displayName}</span>
                  {status === 'connected' ? (
                    <span className="shrink-0 text-[10px] text-emerald-300">Connected</span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-[10.5px] leading-4 text-[var(--color-text-muted)]">
                  {plan.description}
                </span>
              </span>
            </Label>
          );
        })}
      </div>
      {state.stageError ? (
        <div role="alert" className="text-xs text-red-300">
          {state.stageError}
        </div>
      ) : null}
      <div className="flex justify-end">
        <Button
          type="button"
          disabled={disabled || state.selectedPlanIds.length === 0}
          onClick={() => void actions.startWizard()}
        >
          Start setup
        </Button>
      </div>
    </div>
  );
};

const WizardProgress = ({
  state,
}: {
  readonly state: RuntimeProviderOnboardingState;
}): JSX.Element => {
  const selectedStatuses = state.planStatuses.filter((entry) =>
    state.selectedPlanIds.includes(entry.plan.id)
  );
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Selected plan progress">
      {selectedStatuses.map(({ plan, state: planState }) => (
        <span
          key={plan.id}
          className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px]"
          style={{
            borderColor:
              planState === 'ready'
                ? 'rgba(74, 222, 128, 0.32)'
                : planState === 'active'
                  ? 'rgba(96, 165, 250, 0.4)'
                  : 'var(--color-border-subtle)',
            color:
              planState === 'ready'
                ? '#86efac'
                : planState === 'active'
                  ? '#93c5fd'
                  : 'var(--color-text-muted)',
          }}
        >
          {planState === 'ready' ? <Check className="size-3" /> : null}
          {plan.displayName}
        </span>
      ))}
    </div>
  );
};

const ConnectedModelStep = ({
  state,
  actions,
  disabled,
}: {
  readonly state: RuntimeProviderOnboardingState;
  readonly actions: RuntimeProviderOnboardingActions;
  readonly disabled: boolean;
}): JSX.Element => {
  const verifiedModel = state.management.models.find(
    (model) => model.modelId === state.verifiedModelId
  );
  const selectableModels = useMemo(
    () =>
      state.activePlan
        ? rankRecommendedRuntimeProviderModels(state.activePlan, state.management.models)
        : [],
    [state.activePlan, state.management.models]
  );
  return (
    <div className="space-y-3">
      <div
        className="rounded-lg border p-4"
        style={{
          borderColor: 'rgba(74, 222, 128, 0.3)',
          backgroundColor: 'rgba(74, 222, 128, 0.06)',
        }}
      >
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-300" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--color-text)]">Connection verified</div>
            <div className="mt-1 text-xs text-[var(--color-text-muted)]">
              Your plan completed a real request. Choose the model Agent Teams should suggest.
            </div>
          </div>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Model for Agent Teams</Label>
        <Select
          value={verifiedModel?.modelId ?? state.recommendedModel?.modelId ?? ''}
          disabled={disabled}
          onValueChange={(modelId) => void actions.verifyModel(modelId)}
        >
          <SelectTrigger className="h-10 text-sm">
            <SelectValue placeholder="Choose a model" />
          </SelectTrigger>
          <SelectContent>
            {selectableModels.map((model) => (
              <SelectItem key={model.modelId} value={model.modelId}>
                {model.displayName} {model.default ? '(provider default)' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="text-[11px] text-[var(--color-text-muted)]">
          Changing the model runs one short verification request before it is selected.
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          disabled={disabled || !state.verifiedModelId}
          onClick={() => actions.acceptVerifiedModel()}
        >
          Use this model
        </Button>
      </div>
    </div>
  );
};

const ActivePlanFlow = ({
  state,
  actions,
  disabled,
  onCancel,
}: {
  readonly state: RuntimeProviderOnboardingState;
  readonly actions: RuntimeProviderOnboardingActions;
  readonly disabled: boolean;
  readonly onCancel: () => void;
}): JSX.Element => {
  const { t } = useAppTranslation('settings');
  const plan = state.activePlan;
  const setupActions = useMemo(
    () => ({
      ...actions.management,
      cancelConnect: () => {
        actions.management.cancelConnect();
        onCancel();
      },
      submitConnect: async () =>
        (await actions.submitConnect())
          ? { status: 'connected' as const, verifiedModelId: null }
          : null,
    }),
    [actions, onCancel]
  );
  if (!plan) {
    return (
      <div className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.06] p-5 text-center">
        <CheckCircle2 className="mx-auto size-8 text-emerald-300" />
        <div className="mt-3 text-base font-semibold text-[var(--color-text)]">
          All selected plans are ready
        </div>
        <div className="mt-1 text-xs text-[var(--color-text-muted)]">
          Credentials and verified models are available to Agent Teams.
        </div>
      </div>
    );
  }

  const provider = { providerId: plan.providerId, displayName: plan.displayName };
  const directoryEntry = state.management.directoryEntries.find(
    (entry) => entry.providerId.toLowerCase() === plan.providerId.toLowerCase()
  );
  const alreadyConnected = isRuntimeProviderOnboardingPlanRoutable(plan, directoryEntry ?? null);
  const preparingProviderSetup =
    state.stage === 'connect' &&
    state.management.activeFormProviderId !== plan.providerId &&
    state.management.modelPickerProviderId !== plan.providerId &&
    !state.management.setupForm &&
    !state.management.setupFormError;
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <ProviderBrandIcon provider={provider} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-[var(--color-text)]">{plan.displayName}</div>
          <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{plan.description}</div>
        </div>
      </div>
      <OnboardingSteps stage={state.stage} />

      {state.stage === 'connect' ? (
        <div>
          {alreadyConnected && state.management.activeFormProviderId !== plan.providerId ? (
            <div className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.06] p-4">
              <div className="flex items-start gap-2.5">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-300" />
                <div>
                  <div className="text-sm font-medium text-emerald-200">
                    This plan is already connected
                  </div>
                  <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                    Continue when you are ready. Verification sends one short model request.
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={actions.beginConnect}>
                  {t('runtimeProvider.actions.reconnect')}
                </Button>
                <Button type="button" size="sm" onClick={actions.beginVerification}>
                  Verify and choose model
                </Button>
              </div>
            </div>
          ) : null}
          {!alreadyConnected &&
          plan.credentialUrl &&
          !plan.providerId.startsWith('xiaomi-token-plan-') ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void actions.openCredentialPage()}
            >
              <ExternalLink className="mr-1.5 size-3.5" />
              Open subscription key page
            </Button>
          ) : null}
          {!alreadyConnected || state.management.activeFormProviderId === plan.providerId ? (
            <ProviderSetupFormPanel
              provider={provider}
              state={state.management}
              busy={state.management.savingProviderId === plan.providerId}
              disabled={disabled}
              preparing={preparingProviderSetup}
              actions={setupActions}
            />
          ) : null}
        </div>
      ) : null}

      {state.stage === 'verifying' ? (
        <div className="rounded-lg border border-sky-400/25 bg-sky-400/[0.05] p-5 text-center">
          <Loader2 className="mx-auto size-7 animate-spin text-sky-300" />
          <div className="mt-3 text-sm font-medium text-[var(--color-text)]">
            Verifying with a real model request
          </div>
          <div className="mt-1 text-xs text-[var(--color-text-muted)]">
            {state.recommendedModel?.displayName ?? 'Loading the recommended model...'}
          </div>
        </div>
      ) : null}

      {state.stage === 'choose-model' ? (
        <ConnectedModelStep state={state} actions={actions} disabled={disabled} />
      ) : null}

      {state.stage === 'error' ? (
        <div className="rounded-lg border border-red-400/25 bg-red-400/[0.06] p-4">
          <div className="flex items-start gap-2 text-sm text-red-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{state.stageError ?? 'Provider setup could not be completed.'}</span>
          </div>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {state.management.modelsError ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => actions.management.openModelPicker(plan.providerId, 'use')}
              >
                <RefreshCw className="mr-1.5 size-3.5" />
                Retry model catalog
              </Button>
            ) : state.management.directoryError && !state.management.directoryLoaded ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void actions.management.refreshDirectory()}
              >
                <RefreshCw className="mr-1.5 size-3.5" />
                Retry provider catalog
              </Button>
            ) : state.management.models.length > 0 ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => actions.beginConnect()}
                >
                  {t('runtimeProvider.actions.reconnect')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void actions.verifyModel(
                      state.recommendedModel?.modelId ?? state.management.models[0].modelId
                    )
                  }
                >
                  <RefreshCw className="mr-1.5 size-3.5" />
                  Retry verification
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => actions.beginConnect()}
              >
                <RefreshCw className="mr-1.5 size-3.5" />
                Retry connection
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {state.stage === 'ready' ? (
        <div className="rounded-lg border border-emerald-400/25 bg-emerald-400/[0.06] p-5 text-center">
          <CheckCircle2 className="mx-auto size-8 text-emerald-300" />
          <div className="mt-3 text-base font-semibold text-[var(--color-text)]">
            Ready for Agent Teams
          </div>
          <div className="mt-1 text-xs text-[var(--color-text-muted)]">
            The provider is verified and {state.verifiedModelId} is selected for new teams.
          </div>
        </div>
      ) : null}
    </div>
  );
};

export const RuntimeProviderOnboardingView = ({
  state,
  actions,
  disabled = false,
  onAdvancedSettings,
  onDone,
}: RuntimeProviderOnboardingViewProps): JSX.Element => {
  const runtimeReady = state.runtimeGate === 'ready' && !state.runtimeUpdateRequired;
  const wizardFinished =
    state.mode === 'wizard' && state.wizardStarted && state.activePlan === null;
  const providerFinished = state.mode === 'provider' && state.stage === 'ready';
  const unsupportedProvider = state.mode === 'provider' && state.activePlan === null;

  return (
    <div className="space-y-4" data-testid="runtime-provider-onboarding">
      {state.mode === 'wizard' && state.wizardStarted ? <WizardProgress state={state} /> : null}

      {state.mode === 'wizard' && !state.wizardStarted ? (
        <WizardPlanPicker state={state} actions={actions} disabled={disabled} />
      ) : unsupportedProvider ? (
        <div role="alert" className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-4">
          <div className="flex items-start gap-2 text-sm text-amber-100">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <div className="font-medium">Use Advanced settings for this provider</div>
              <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                {state.stageError ??
                  'This provider does not have a guided setup flow yet, but it can still be configured in the full OpenCode catalog.'}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <RuntimePrerequisite state={state} actions={actions} />
          {runtimeReady ? (
            <ActivePlanFlow state={state} actions={actions} disabled={disabled} onCancel={onDone} />
          ) : null}
        </>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || state.management.savingProviderId !== null}
          onClick={onAdvancedSettings}
        >
          <Settings2 className="mr-1.5 size-3.5" />
          Advanced settings
        </Button>
        <div className="flex gap-2">
          {state.mode === 'wizard' && state.wizardStarted && !wizardFinished ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => actions.restartWizard()}>
              Start over
            </Button>
          ) : null}
          {wizardFinished || providerFinished ? (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (wizardFinished) {
                  actions.clearCompletedWizard();
                }
                onDone();
              }}
            >
              Done
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
};
