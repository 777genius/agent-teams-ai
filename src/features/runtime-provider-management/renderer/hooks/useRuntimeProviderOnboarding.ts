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
  getRuntimeProviderOnboardingCredentialUrls,
  getRuntimeProviderOnboardingPlan,
  isRuntimeProviderOnboardingPlanRoutable,
  rankRecommendedRuntimeProviderModels,
  resolveRuntimeProviderOnboardingPlan,
  RUNTIME_PROVIDER_ONBOARDING_PLANS,
} from '../../core/domain';
import {
  createRuntimeProviderOnboardingProgressRepository,
  type RuntimeProviderOnboardingProgressRepository,
} from '../adapters/runtimeProviderOnboardingProgressRepository';

import {
  DEFAULT_WIZARD_PLAN_IDS,
  findDirectoryEntry,
  getAutomaticModelProbeLimit,
  getOnboardingPlanStatuses,
  getOnboardingRouteState,
  getOnboardingV2ConnectionMessage,
  getSupportedWizardPlanIds,
  getSupportedWizardProgress,
  isCopilotExplicitModelUnsupported,
  toggleSupportedWizardPlan,
} from './runtimeProviderOnboardingInternals';
import {
  type RuntimeProviderManagementActions,
  type RuntimeProviderManagementState,
  useRuntimeProviderManagement,
} from './useRuntimeProviderManagement';

import type { RuntimeProviderModelDto } from '../../contracts';
import type {
  OpenCodeGeneration,
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
  /** Opens the given key page of the active plan, or its primary page. */
  openCredentialPage(url?: string): Promise<void>;
  /** Picks the V2 integration for one console domain of the active plan. */
  chooseRoute(v2ProviderId: string): void;
  clearCompletedWizard(): void;
}

interface UseRuntimeProviderOnboardingOptions {
  readonly enabled: boolean;
  readonly mode: RuntimeProviderOnboardingMode;
  readonly providerId?: string | null;
  readonly projectPath?: string | null;
  readonly runtimeGate: RuntimeProviderQuickConnectGate;
  /** Plans with routes connect per route on V2; defaults to V1. */
  readonly openCodeGeneration?: OpenCodeGeneration;
  readonly runtimeUpdateRequired?: boolean;
  readonly onInstallOrUpdateRuntime: () => Promise<void> | void;
  readonly onProviderChanged?: () => Promise<void> | void;
  readonly progressRepository?: RuntimeProviderOnboardingProgressRepository;
}

export function useRuntimeProviderOnboarding({
  enabled,
  mode,
  providerId = null,
  projectPath = null,
  runtimeGate,
  openCodeGeneration = 'v1',
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
  const [routeProviderIds, setRouteProviderIds] = useState<
    Partial<Record<RuntimeProviderOnboardingPlanId, string>>
  >({});
  const [selectedPlanIds, setSelectedPlanIds] =
    useState<readonly RuntimeProviderOnboardingPlanId[]>(DEFAULT_WIZARD_PLAN_IDS);
  const [savedWizardProgress, setProgress] = useState<RuntimeProviderOnboardingProgress | null>(null);
  const progress = useMemo(
    () => getSupportedWizardProgress(savedWizardProgress, openCodeGeneration),
    [savedWizardProgress, openCodeGeneration]
  );
  const supportedSelectedPlanIds = useMemo(
    () => getSupportedWizardPlanIds(selectedPlanIds, openCodeGeneration),
    [selectedPlanIds, openCodeGeneration]
  );
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
    const savedProgress = getSupportedWizardProgress(
      repositoryRef.current?.load() ?? null, openCodeGeneration
    );
    if (savedProgress) {
      setProgress(savedProgress);
      setSelectedPlanIds(savedProgress.selectedPlanIds);
      setWizardStarted(true);
      setResumable(true);
      setStage(savedProgress.currentPlanId ? 'connect' : 'ready');
      return;
    }
    setProgress(null);
    setSelectedPlanIds(DEFAULT_WIZARD_PLAN_IDS);
    setWizardStarted(false);
    setResumable(false);
  }, [directPlan, enabled, mode, openCodeGeneration, providerId]);
  useEffect(() => {
    if (mode === 'wizard' && progress) repositoryRef.current?.save(progress);
  }, [mode, progress]);
  const basePlan = useMemo(() => {
    if (mode === 'provider') {
      return directPlan;
    }
    return progress?.currentPlanId
      ? getRuntimeProviderOnboardingPlan(progress.currentPlanId)
      : null;
  }, [directPlan, mode, progress?.currentPlanId]);
  const { routeGeneration, connectedRouteProviderId } = getOnboardingRouteState(
    basePlan,
    openCodeGeneration,
    management
  );
  const chosenRouteProviderId = basePlan ? (routeProviderIds[basePlan.id] ?? null) : null;
  const activePlan = useMemo(
    () =>
      basePlan
        ? resolveRuntimeProviderOnboardingPlan(
            basePlan,
            routeGeneration,
            chosenRouteProviderId ?? connectedRouteProviderId
          )
        : null,
    [basePlan, chosenRouteProviderId, connectedRouteProviderId, routeGeneration]
  );

  const v2ConnectionMessage = getOnboardingV2ConnectionMessage(activePlan, openCodeGeneration);
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
    if (
      !transientSetupError ||
      activePlan.routeChoices ||
      transientSetupRetryPlanRef.current === activePlan.id
    ) {
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
        if (activePlan.id !== 'github-copilot' || !isCopilotExplicitModelUnsupported(lastError)) {
          break;
        }
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
    if (v2ConnectionMessage) {
      setStage('error');
      setStageError(v2ConnectionMessage);
      return;
    }
    if (activePlan.routeChoices) {
      // Nothing can connect before the user picks the account region.
      setStage('connect');
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
    v2ConnectionMessage,
  ]);

  const togglePlan = useCallback((planId: RuntimeProviderOnboardingPlanId): void => {
    setSelectedPlanIds((current) => toggleSupportedWizardPlan(current, planId, openCodeGeneration));
  }, [openCodeGeneration]);

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
    if (supportedSelectedPlanIds.length === 0) {
      setStageError('Select at least one subscription plan.');
      return;
    }
    const firstSelectedProviderId =
      RUNTIME_PROVIDER_ONBOARDING_PLANS.find((plan) => plan.id === supportedSelectedPlanIds[0])
        ?.providerId ?? null;
    const nextProgress = createRuntimeProviderOnboardingProgress(supportedSelectedPlanIds);
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
    supportedSelectedPlanIds,
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
    if (!activePlan || activePlan.routeChoices) {
      return;
    }
    if (v2ConnectionMessage) return;
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
    v2ConnectionMessage,
  ]);

  const beginVerification = useCallback((): void => {
    const startedAtMs = Date.now();
    if (!activePlan) {
      return;
    }
    if (v2ConnectionMessage) return;
    setReconnectRequestedPlanId(null);
    setVerificationRequestedPlanId(activePlan.id);
    setStage('verifying');
    setStageError(null);
    recordOnboardingStep('verification_start', true, startedAtMs, null, activePlan.providerId);
  }, [activePlan, recordOnboardingStep, v2ConnectionMessage]);

  const submitConnect = useCallback(async (): Promise<boolean> => {
    const startedAtMs = Date.now();
    if (!activePlan) {
      return false;
    }
    if (v2ConnectionMessage) return false;
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
  }, [activePlan, managementActions, recordOnboardingStep, v2ConnectionMessage]);

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
        ? completeRuntimeProviderOnboardingPlan(
            getSupportedWizardProgress(current, openCodeGeneration) ?? current,
            activePlan.id, verifiedModelId
          )
        : current
    );
  }, [activePlan, managementActions, mode, openCodeGeneration, recordOnboardingStep, verifiedModelId]);

  const openCredentialPage = useCallback(
    async (url?: string): Promise<void> => {
      const startedAtMs = Date.now();
      const credentialUrls = activePlan
        ? getRuntimeProviderOnboardingCredentialUrls(activePlan)
        : [];
      // Only the plan's own pages may be opened.
      const credentialUrl =
        url === undefined ? credentialUrls[0] : credentialUrls.find((item) => item === url);
      if (!activePlan || !credentialUrl) {
        return;
      }
      // On V2, the key page the user opens picks the integration for that account region.
      const route = activePlan.routeChoices?.find((item) => item.credentialUrl === credentialUrl);
      if (route) {
        setRouteProviderIds((current) => ({ ...current, [activePlan.id]: route.v2ProviderId }));
      }
      try {
        await api.openExternal(credentialUrl);
        recordOnboardingStep('credential_open', true, startedAtMs, null, activePlan.providerId);
      } catch (error) {
        recordOnboardingStep('credential_open', false, startedAtMs, error, activePlan.providerId);
        throw error;
      }
    },
    [activePlan, recordOnboardingStep]
  );

  const chooseRoute = useCallback(
    (v2ProviderId: string): void => {
      if (!activePlan || (!activePlan.routeChoices && !activePlan.route)) return;
      if (!activePlan.routes?.some((route) => route.v2ProviderId === v2ProviderId)) return;
      if (activePlan.providerId === v2ProviderId) return;
      // A form open for the previous route belongs to another integration.
      if (management.activeFormProviderId === activePlan.providerId) {
        managementActions.cancelConnect();
      }
      connectStartedPlanRef.current = null;
      setRouteProviderIds((current) => ({ ...current, [activePlan.id]: v2ProviderId }));
    },
    [activePlan, management.activeFormProviderId, managementActions]
  );

  const clearCompletedWizard = useCallback((): void => {
    repositoryRef.current?.clear();
    setResumable(false);
  }, []);

  const planStatuses = getOnboardingPlanStatuses(
    activePlan, progress, wizardStarted && progress !== null, openCodeGeneration, management
  );

  return [
    {
      mode,
      plans: RUNTIME_PROVIDER_ONBOARDING_PLANS,
      selectedPlanIds: supportedSelectedPlanIds,
      wizardStarted: wizardStarted && (mode !== 'wizard' || progress !== null),
      resumable: resumable && progress !== null,
      progress,
      openCodeGeneration,
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
      chooseRoute,
      clearCompletedWizard,
    },
  ] as const;
}
