import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  classifyAnalyticsError,
  elapsedMsSince,
  recordProviderOnboardingStepEnd,
} from '@renderer/analytics/productAnalytics';
import { api } from '@renderer/api';

import {
  completeRuntimeProviderOnboardingPlan,
  createRuntimeProviderOnboardingProgress,
  findRuntimeProviderOnboardingPlanByProviderId,
  getRuntimeProviderOnboardingPlan,
  isRuntimeProviderOnboardingPlanRoutable,
  rankRecommendedRuntimeProviderModels,
  RUNTIME_PROVIDER_ONBOARDING_PLANS,
} from '../../core/domain';
import {
  createRuntimeProviderOnboardingProgressRepository,
  type RuntimeProviderOnboardingProgressRepository,
} from '../adapters/runtimeProviderOnboardingProgressRepository';

import {
  type RuntimeProviderManagementActions,
  type RuntimeProviderManagementState,
  useRuntimeProviderManagement,
} from './useRuntimeProviderManagement';

import type { RuntimeProviderDirectoryEntryDto, RuntimeProviderModelDto } from '../../contracts';
import type {
  RuntimeProviderOnboardingPlan,
  RuntimeProviderOnboardingPlanId,
  RuntimeProviderOnboardingProgress,
  RuntimeProviderOnboardingStage,
  RuntimeProviderQuickConnectGate,
} from '../../core/domain';
import type {
  AnalyticsOnboardingStep,
  AnalyticsOnboardingStepOutcome,
} from '@renderer/analytics/productAnalytics';

export type RuntimeProviderOnboardingMode = 'provider' | 'wizard';

export interface RuntimeProviderOnboardingPlanStatus {
  readonly plan: RuntimeProviderOnboardingPlan;
  readonly state: 'pending' | 'connected' | 'active' | 'ready';
}

export interface RuntimeProviderOnboardingState {
  readonly mode: RuntimeProviderOnboardingMode;
  readonly plans: readonly RuntimeProviderOnboardingPlan[];
  readonly selectedPlanIds: readonly RuntimeProviderOnboardingPlanId[];
  readonly wizardStarted: boolean;
  readonly resumable: boolean;
  readonly progress: RuntimeProviderOnboardingProgress | null;
  readonly activePlan: RuntimeProviderOnboardingPlan | null;
  readonly planStatuses: readonly RuntimeProviderOnboardingPlanStatus[];
  readonly stage: RuntimeProviderOnboardingStage;
  readonly stageError: string | null;
  readonly recommendedModel: RuntimeProviderModelDto | null;
  readonly verifiedModelId: string | null;
  readonly runtimeGate: RuntimeProviderQuickConnectGate;
  readonly runtimeUpdateRequired: boolean;
  readonly runtimePreparing: boolean;
  readonly management: RuntimeProviderManagementState;
}

export interface RuntimeProviderOnboardingActions {
  readonly management: RuntimeProviderManagementActions;
  togglePlan(planId: RuntimeProviderOnboardingPlanId): void;
  startWizard(): Promise<void>;
  restartWizard(): void;
  installOrUpdateRuntime(): Promise<void>;
  beginConnect(): void;
  beginVerification(): void;
  submitConnect(): Promise<boolean>;
  verifyModel(modelId: string): Promise<void>;
  acceptVerifiedModel(): void;
  openCredentialPage(): Promise<void>;
  clearCompletedWizard(): void;
}

interface UseRuntimeProviderOnboardingOptions {
  readonly enabled: boolean;
  readonly mode: RuntimeProviderOnboardingMode;
  readonly providerId?: string | null;
  readonly projectPath?: string | null;
  readonly runtimeGate: RuntimeProviderQuickConnectGate;
  readonly runtimeUpdateRequired?: boolean;
  readonly onInstallOrUpdateRuntime: () => Promise<void> | void;
  readonly onProviderChanged?: () => Promise<void> | void;
  readonly progressRepository?: RuntimeProviderOnboardingProgressRepository;
}

const DEFAULT_WIZARD_PLAN_IDS: readonly RuntimeProviderOnboardingPlanId[] = [
  'supergrok',
  'zai-coding-plan',
  'minimax-token-plan',
  'github-copilot',
  'kimi-code-membership',
];

function getAutomaticModelProbeLimit(plan: RuntimeProviderOnboardingPlan): number {
  // Copilot catalogs models that an individual plan can still reject. Try one
  // fallback, but never burn through a user's quota by probing the full list.
  return plan.id === 'github-copilot' ? 2 : 1;
}

function findDirectoryEntry(
  state: RuntimeProviderManagementState,
  providerId: string
): RuntimeProviderDirectoryEntryDto | null {
  return (
    state.directoryEntries.find(
      (entry) => entry.providerId.toLowerCase() === providerId.toLowerCase()
    ) ?? null
  );
}

export function useRuntimeProviderOnboarding({
  enabled,
  mode,
  providerId = null,
  projectPath = null,
  runtimeGate,
  runtimeUpdateRequired = false,
  onInstallOrUpdateRuntime,
  onProviderChanged,
  progressRepository,
}: UseRuntimeProviderOnboardingOptions): readonly [
  RuntimeProviderOnboardingState,
  RuntimeProviderOnboardingActions,
] {
  const repositoryRef = useRef<RuntimeProviderOnboardingProgressRepository | null>(null);
  if (!repositoryRef.current) {
    repositoryRef.current =
      progressRepository ?? createRuntimeProviderOnboardingProgressRepository();
  }

  const directPlan = useMemo(
    () => (providerId ? findRuntimeProviderOnboardingPlanByProviderId(providerId) : null),
    [providerId]
  );
  const [selectedPlanIds, setSelectedPlanIds] =
    useState<readonly RuntimeProviderOnboardingPlanId[]>(DEFAULT_WIZARD_PLAN_IDS);
  const [progress, setProgress] = useState<RuntimeProviderOnboardingProgress | null>(null);
  const [wizardStarted, setWizardStarted] = useState(false);
  const [resumable, setResumable] = useState(false);
  const [stage, setStage] = useState<RuntimeProviderOnboardingStage>('connect');
  const [stageError, setStageError] = useState<string | null>(null);
  const [recommendedModel, setRecommendedModel] = useState<RuntimeProviderModelDto | null>(null);
  const [verifiedModelId, setVerifiedModelId] = useState<string | null>(null);
  const [runtimePreparing, setRuntimePreparing] = useState(false);
  const [pendingConnectionPlanId, setPendingConnectionPlanId] =
    useState<RuntimeProviderOnboardingPlanId | null>(null);
  const [acceptedConnectionProof, setAcceptedConnectionProof] = useState<{
    readonly planId: RuntimeProviderOnboardingPlanId;
    readonly modelId: string;
  } | null>(null);
  const [verificationRequestedPlanId, setVerificationRequestedPlanId] =
    useState<RuntimeProviderOnboardingPlanId | null>(null);
  const [reconnectRequestedPlanId, setReconnectRequestedPlanId] =
    useState<RuntimeProviderOnboardingPlanId | null>(null);
  const initializedSessionRef = useRef<string | null>(null);
  const connectStartedPlanRef = useRef<RuntimeProviderOnboardingPlanId | null>(null);
  const transientSetupRetryPlanRef = useRef<RuntimeProviderOnboardingPlanId | null>(null);
  const activePlanRef = useRef<RuntimeProviderOnboardingPlanId | null>(null);
  const runtimePrepareStartedAtRef = useRef<number | null>(null);
  const probeSequenceRef = useRef(0);

  const [management, managementActions] = useRuntimeProviderManagement({
    runtimeId: 'opencode',
    enabled,
    directoryPageSize: 100,
    directorySummaryOnEnable: true,
    loadViewOnEnable: false,
    searchDirectoryOnQueryChange: false,
    projectPath,
    initialProviderId: null,
    initialProviderAction: null,
    onProviderChanged,
  });

  const retryCancelConnect = managementActions.cancelConnect;
  const retryStartConnect = managementActions.startConnect;

  useEffect(() => {
    if (!enabled) {
      initializedSessionRef.current = null;
      return;
    }
    const sessionKey = `${mode}:${providerId ?? ''}`;
    if (initializedSessionRef.current === sessionKey) {
      return;
    }
    initializedSessionRef.current = sessionKey;
    setStage('connect');
    setStageError(null);
    setRecommendedModel(null);
    setVerifiedModelId(null);
    setVerificationRequestedPlanId(null);
    setReconnectRequestedPlanId(null);
    setRuntimePreparing(false);
    setPendingConnectionPlanId(null);
    setAcceptedConnectionProof(null);
    connectStartedPlanRef.current = null;
    transientSetupRetryPlanRef.current = null;
    activePlanRef.current = null;
    runtimePrepareStartedAtRef.current = null;
    probeSequenceRef.current += 1;

    if (mode === 'provider') {
      setProgress(null);
      setWizardStarted(false);
      setResumable(false);
      setSelectedPlanIds(directPlan ? [directPlan.id] : []);
      if (!directPlan) {
        setStage('error');
        setStageError('This provider is only available in Advanced settings.');
      }
      return;
    }

    const storedProgress = repositoryRef.current?.load() ?? null;
    if (storedProgress) {
      setProgress(storedProgress);
      setSelectedPlanIds(storedProgress.selectedPlanIds);
      setWizardStarted(true);
      setResumable(true);
      setStage(storedProgress.currentPlanId ? 'connect' : 'ready');
      return;
    }
    setProgress(null);
    setSelectedPlanIds(DEFAULT_WIZARD_PLAN_IDS);
    setWizardStarted(false);
    setResumable(false);
  }, [directPlan, enabled, mode, providerId]);

  useEffect(() => {
    if (mode === 'wizard' && progress) {
      repositoryRef.current?.save(progress);
    }
  }, [mode, progress]);

  const activePlan = useMemo(() => {
    if (mode === 'provider') {
      return directPlan;
    }
    return progress?.currentPlanId
      ? getRuntimeProviderOnboardingPlan(progress.currentPlanId)
      : null;
  }, [directPlan, mode, progress?.currentPlanId]);

  const recordOnboardingStep = useCallback(
    (
      step: AnalyticsOnboardingStep,
      success: boolean,
      startedAtMs: number,
      error: unknown = null,
      providerOverride: string | null = null,
      outcomeOverride?: AnalyticsOnboardingStepOutcome
    ): void => {
      const outcome = outcomeOverride ?? (success ? 'completed' : 'failed');
      recordProviderOnboardingStepEnd({
        provider:
          providerOverride ?? activePlan?.providerId ?? directPlan?.providerId ?? providerId,
        step,
        outcome,
        durationMs: elapsedMsSince(startedAtMs),
        errorClass: outcome === 'failed' ? classifyAnalyticsError(error) : 'none',
      });
    },
    [activePlan?.providerId, directPlan?.providerId, providerId]
  );

  useEffect(() => {
    if (!runtimePreparing) {
      return;
    }

    if (runtimeGate === 'ready') {
      const startedAtMs = runtimePrepareStartedAtRef.current ?? Date.now();
      runtimePrepareStartedAtRef.current = null;
      recordOnboardingStep('runtime_prepare', true, startedAtMs);
      setRuntimePreparing(false);
      void managementActions.refreshDirectory();
      return;
    }

    if (runtimeGate === 'error') {
      const startedAtMs = runtimePrepareStartedAtRef.current ?? Date.now();
      runtimePrepareStartedAtRef.current = null;
      recordOnboardingStep(
        'runtime_prepare',
        false,
        startedAtMs,
        new Error(stageError ?? 'OpenCode runtime is not ready')
      );
      setRuntimePreparing(false);
    }
  }, [managementActions, recordOnboardingStep, runtimeGate, runtimePreparing, stageError]);

  useEffect(() => {
    const nextActivePlanId = activePlan?.id ?? null;
    if (activePlanRef.current === nextActivePlanId) {
      return;
    }
    activePlanRef.current = nextActivePlanId;
    connectStartedPlanRef.current = null;
    transientSetupRetryPlanRef.current = null;
    setPendingConnectionPlanId(null);
    setAcceptedConnectionProof(null);
    setVerificationRequestedPlanId(null);
    setReconnectRequestedPlanId(null);
    probeSequenceRef.current += 1;
    setStage(activePlan ? 'connect' : wizardStarted ? 'ready' : 'connect');
    setStageError(null);
    setRecommendedModel(null);
    setVerifiedModelId(null);
  }, [activePlan, wizardStarted]);

  useEffect(() => {
    const setupErrorCode = management.setupFormErrorDiagnostics?.errorCode ?? null;
    const transientSetupError =
      enabled &&
      activePlan &&
      runtimeGate === 'ready' &&
      !runtimeUpdateRequired &&
      management.activeFormProviderId === activePlan.providerId &&
      Boolean(management.setupFormError) &&
      (setupErrorCode === 'runtime-missing' || setupErrorCode === 'runtime-unhealthy') &&
      management.savingProviderId !== activePlan.providerId;
    if (!transientSetupError || transientSetupRetryPlanRef.current === activePlan.id) {
      return;
    }

    const retryTimer = window.setTimeout(() => {
      transientSetupRetryPlanRef.current = activePlan.id;
      retryCancelConnect();
      connectStartedPlanRef.current = activePlan.id;
      retryStartConnect(activePlan.providerId);
    }, 750);
    return () => window.clearTimeout(retryTimer);
  }, [
    activePlan,
    enabled,
    management.activeFormProviderId,
    management.savingProviderId,
    management.setupFormError,
    management.setupFormErrorDiagnostics?.errorCode,
    retryCancelConnect,
    retryStartConnect,
    runtimeGate,
    runtimeUpdateRequired,
  ]);

  const verifyModelCandidates = useCallback(
    async (modelIds: readonly string[]): Promise<void> => {
      if (!activePlan) {
        return;
      }
      const models = modelIds
        .map((modelId) => management.models.find((entry) => entry.modelId === modelId) ?? null)
        .filter((model): model is RuntimeProviderModelDto => model !== null);
      if (models.length === 0) {
        setStage('error');
        setStageError('The selected model is no longer available in the live OpenCode catalog.');
        return;
      }
      const probeSequence = probeSequenceRef.current + 1;
      probeSequenceRef.current = probeSequence;
      setVerifiedModelId(null);
      setStage('verifying');
      setStageError(null);
      let lastError = 'The model could not complete a verification request.';
      for (const model of models) {
        if (probeSequenceRef.current !== probeSequence) {
          return;
        }
        setRecommendedModel(model);
        managementActions.selectModel(model.modelId);
        const result = await managementActions.testModel(activePlan.providerId, model.modelId);
        if (probeSequenceRef.current !== probeSequence) {
          return;
        }
        if (result.ok && result.availability === 'available') {
          setVerifiedModelId(model.modelId);
          setStage('choose-model');
          return;
        }
        lastError = result.message || lastError;
      }
      setStage('error');
      setStageError(lastError);
    },
    [activePlan, management.models, managementActions]
  );

  const verifyModel = useCallback(
    async (modelId: string): Promise<void> => verifyModelCandidates([modelId]),
    [verifyModelCandidates]
  );

  useEffect(() => {
    if (!enabled || !activePlan || runtimeGate !== 'ready' || runtimeUpdateRequired) {
      return;
    }
    if (!management.directoryLoaded) {
      if (management.directoryError && !management.directoryLoading) {
        setStage('error');
        setStageError(management.directoryError);
      }
      return;
    }
    const entry = findDirectoryEntry(management, activePlan.providerId);
    const routable = isRuntimeProviderOnboardingPlanRoutable(activePlan, entry);
    if (!routable) {
      setStage('connect');
      setRecommendedModel(null);
      setVerifiedModelId(null);
      if (
        connectStartedPlanRef.current !== activePlan.id &&
        management.activeFormProviderId !== activePlan.providerId &&
        management.savingProviderId !== activePlan.providerId
      ) {
        connectStartedPlanRef.current = activePlan.id;
        managementActions.startConnect(activePlan.providerId);
      }
      return;
    }

    if (pendingConnectionPlanId === activePlan.id) {
      setStage('verifying');
      return;
    }
    if (
      reconnectRequestedPlanId === activePlan.id &&
      management.activeFormProviderId === activePlan.providerId
    ) {
      setStage('connect');
      setStageError(null);
      return;
    }
    if (verificationRequestedPlanId !== activePlan.id) {
      if (
        management.activeFormProviderId === activePlan.providerId &&
        management.savingProviderId !== activePlan.providerId
      ) {
        managementActions.cancelConnect();
      }
      setStage('connect');
      setStageError(null);
      return;
    }

    if (management.modelPickerProviderId !== activePlan.providerId) {
      setStage('verifying');
      managementActions.openModelPicker(activePlan.providerId, 'use');
      return;
    }
    if (management.modelsLoading) {
      setStage('verifying');
      return;
    }
    if (management.modelsError) {
      setStage('error');
      setStageError(management.modelsError);
      return;
    }
    if (recommendedModel || verifiedModelId) {
      return;
    }
    const candidates = rankRecommendedRuntimeProviderModels(activePlan, management.models);
    if (candidates.length === 0) {
      setStage('error');
      setStageError('No usable model was reported for this connected provider.');
      return;
    }
    if (acceptedConnectionProof?.planId === activePlan.id) {
      const provenModel = candidates.find(
        (candidate) => candidate.modelId === acceptedConnectionProof.modelId
      );
      setAcceptedConnectionProof(null);
      if (provenModel) {
        setRecommendedModel(provenModel);
        setVerifiedModelId(provenModel.modelId);
        managementActions.selectModel(provenModel.modelId);
        setStage('choose-model');
        return;
      }
    }
    void verifyModelCandidates(
      candidates
        .slice(0, getAutomaticModelProbeLimit(activePlan))
        .map((candidate) => candidate.modelId)
    );
  }, [
    activePlan,
    acceptedConnectionProof,
    enabled,
    management,
    managementActions,
    pendingConnectionPlanId,
    reconnectRequestedPlanId,
    recommendedModel,
    runtimeGate,
    runtimeUpdateRequired,
    verifiedModelId,
    verificationRequestedPlanId,
    verifyModelCandidates,
  ]);

  const togglePlan = useCallback((planId: RuntimeProviderOnboardingPlanId): void => {
    setSelectedPlanIds((current) =>
      current.includes(planId)
        ? current.filter((candidate) => candidate !== planId)
        : RUNTIME_PROVIDER_ONBOARDING_PLANS.filter(
            (plan) => current.includes(plan.id) || plan.id === planId
          ).map((plan) => plan.id)
    );
  }, []);

  const installOrUpdateRuntime = useCallback(async (): Promise<void> => {
    const startedAtMs = Date.now();
    runtimePrepareStartedAtRef.current = startedAtMs;
    setRuntimePreparing(true);
    setStageError(null);
    try {
      await onInstallOrUpdateRuntime();
    } catch (error) {
      runtimePrepareStartedAtRef.current = null;
      recordOnboardingStep('runtime_prepare', false, startedAtMs, error);
      setRuntimePreparing(false);
      setStage('error');
      setStageError(error instanceof Error ? error.message : 'Failed to prepare OpenCode.');
    }
  }, [onInstallOrUpdateRuntime, recordOnboardingStep]);

  const startWizard = useCallback(async (): Promise<void> => {
    const startedAtMs = Date.now();
    if (selectedPlanIds.length === 0) {
      setStageError('Select at least one subscription plan.');
      return;
    }
    const firstSelectedProviderId =
      RUNTIME_PROVIDER_ONBOARDING_PLANS.find((plan) => plan.id === selectedPlanIds[0])
        ?.providerId ?? null;
    const nextProgress = createRuntimeProviderOnboardingProgress(selectedPlanIds);
    setProgress(nextProgress);
    setWizardStarted(true);
    setResumable(false);
    setStageError(null);
    repositoryRef.current?.save(nextProgress);
    recordOnboardingStep('wizard_start', true, startedAtMs, null, firstSelectedProviderId);
    if (runtimeGate !== 'ready' || runtimeUpdateRequired) {
      await installOrUpdateRuntime();
    }
  }, [
    installOrUpdateRuntime,
    recordOnboardingStep,
    runtimeGate,
    runtimeUpdateRequired,
    selectedPlanIds,
  ]);

  const restartWizard = useCallback((): void => {
    const startedAtMs = Date.now();
    repositoryRef.current?.clear();
    setProgress(null);
    setWizardStarted(false);
    setResumable(false);
    setSelectedPlanIds(DEFAULT_WIZARD_PLAN_IDS);
    setStage('connect');
    setStageError(null);
    setRecommendedModel(null);
    setVerifiedModelId(null);
    setVerificationRequestedPlanId(null);
    setReconnectRequestedPlanId(null);
    managementActions.cancelConnect();
    recordOnboardingStep('wizard_restart', true, startedAtMs);
  }, [managementActions, recordOnboardingStep]);

  const beginConnect = useCallback((): void => {
    const startedAtMs = Date.now();
    if (!activePlan) {
      return;
    }
    setStage('connect');
    setStageError(null);
    setReconnectRequestedPlanId(activePlan.id);
    setVerificationRequestedPlanId(null);
    if (management.directoryError && !management.directoryLoaded) {
      connectStartedPlanRef.current = null;
      void managementActions.refreshDirectory();
      return;
    }
    connectStartedPlanRef.current = activePlan.id;
    managementActions.startConnect(activePlan.providerId);
    recordOnboardingStep('connect_start', true, startedAtMs, null, activePlan.providerId);
  }, [
    activePlan,
    management.directoryError,
    management.directoryLoaded,
    managementActions,
    recordOnboardingStep,
  ]);

  const beginVerification = useCallback((): void => {
    const startedAtMs = Date.now();
    if (!activePlan) {
      return;
    }
    setReconnectRequestedPlanId(null);
    setVerificationRequestedPlanId(activePlan.id);
    setStage('verifying');
    setStageError(null);
    recordOnboardingStep('verification_start', true, startedAtMs, null, activePlan.providerId);
  }, [activePlan, recordOnboardingStep]);

  const submitConnect = useCallback(async (): Promise<boolean> => {
    const startedAtMs = Date.now();
    if (!activePlan) {
      return false;
    }
    setPendingConnectionPlanId(activePlan.id);
    setAcceptedConnectionProof(null);
    try {
      const outcome = await managementActions.submitConnect(activePlan.providerId);
      setPendingConnectionPlanId(null);
      const connected = outcome?.status === 'connected';
      const cancelled = outcome?.status === 'cancelled';
      recordOnboardingStep(
        'connection_submit',
        connected,
        startedAtMs,
        connected || cancelled ? null : new Error('Provider connection was not accepted'),
        activePlan.providerId,
        cancelled ? 'cancelled' : undefined
      );
      if (connected) {
        setReconnectRequestedPlanId(null);
        setVerificationRequestedPlanId(activePlan.id);
        if (outcome.verifiedModelId) {
          setAcceptedConnectionProof({ planId: activePlan.id, modelId: outcome.verifiedModelId });
        }
        setStage('verifying');
        setStageError(null);
      }
      return connected;
    } catch (error) {
      setPendingConnectionPlanId(null);
      recordOnboardingStep('connection_submit', false, startedAtMs, error, activePlan.providerId);
      throw error;
    }
  }, [activePlan, managementActions, recordOnboardingStep]);

  const acceptVerifiedModel = useCallback((): void => {
    const startedAtMs = Date.now();
    if (!activePlan || !verifiedModelId) {
      return;
    }
    managementActions.useModelForNewTeams(verifiedModelId);
    recordOnboardingStep('model_accept', true, startedAtMs, null, activePlan.providerId);
    if (mode === 'provider') {
      setStage('ready');
      return;
    }
    setProgress((current) =>
      current
        ? completeRuntimeProviderOnboardingPlan(current, activePlan.id, verifiedModelId)
        : current
    );
  }, [activePlan, managementActions, mode, recordOnboardingStep, verifiedModelId]);

  const openCredentialPage = useCallback(async (): Promise<void> => {
    const startedAtMs = Date.now();
    if (!activePlan?.credentialUrl) {
      return;
    }
    try {
      await api.openExternal(activePlan.credentialUrl);
      recordOnboardingStep('credential_open', true, startedAtMs, null, activePlan.providerId);
    } catch (error) {
      recordOnboardingStep('credential_open', false, startedAtMs, error, activePlan.providerId);
      throw error;
    }
  }, [activePlan, recordOnboardingStep]);

  const clearCompletedWizard = useCallback((): void => {
    repositoryRef.current?.clear();
    setResumable(false);
  }, []);

  const planStatuses = useMemo<readonly RuntimeProviderOnboardingPlanStatus[]>(
    () =>
      RUNTIME_PROVIDER_ONBOARDING_PLANS.map((plan) => {
        if (progress?.completedPlanIds.includes(plan.id)) {
          return { plan, state: 'ready' as const };
        }
        if (activePlan?.id === plan.id && wizardStarted) {
          return { plan, state: 'active' as const };
        }
        const entry = findDirectoryEntry(management, plan.providerId);
        if (isRuntimeProviderOnboardingPlanRoutable(plan, entry)) {
          return { plan, state: 'connected' as const };
        }
        return { plan, state: 'pending' as const };
      }),
    [activePlan?.id, management, progress?.completedPlanIds, wizardStarted]
  );

  return [
    {
      mode,
      plans: RUNTIME_PROVIDER_ONBOARDING_PLANS,
      selectedPlanIds,
      wizardStarted,
      resumable,
      progress,
      activePlan,
      planStatuses,
      stage,
      stageError,
      recommendedModel,
      verifiedModelId,
      runtimeGate,
      runtimeUpdateRequired,
      runtimePreparing,
      management,
    },
    {
      management: managementActions,
      togglePlan,
      startWizard,
      restartWizard,
      installOrUpdateRuntime,
      beginConnect,
      beginVerification,
      submitConnect,
      verifyModel,
      acceptVerifiedModel,
      openCredentialPage,
      clearCompletedWizard,
    },
  ] as const;
}
