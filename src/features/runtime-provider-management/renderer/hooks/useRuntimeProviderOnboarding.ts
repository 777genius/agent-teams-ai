import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';

import {
  completeRuntimeProviderOnboardingPlan,
  createRuntimeProviderOnboardingProgress,
  findRuntimeProviderOnboardingPlanByProviderId,
  getRuntimeProviderOnboardingPlan,
  isRuntimeProviderOnboardingPlanRoutable,
  RUNTIME_PROVIDER_ONBOARDING_PLANS,
  selectRecommendedRuntimeProviderModel,
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
  const initializedSessionRef = useRef<string | null>(null);
  const connectStartedPlanRef = useRef<RuntimeProviderOnboardingPlanId | null>(null);
  const activePlanRef = useRef<RuntimeProviderOnboardingPlanId | null>(null);
  const probeSequenceRef = useRef(0);

  const [management, managementActions] = useRuntimeProviderManagement({
    runtimeId: 'opencode',
    enabled,
    directoryPageSize: 100,
    loadViewOnEnable: false,
    searchDirectoryOnQueryChange: false,
    projectPath,
    initialProviderId: null,
    initialProviderAction: null,
    onProviderChanged,
  });

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
    setRuntimePreparing(false);
    connectStartedPlanRef.current = null;
    activePlanRef.current = null;
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

  useEffect(() => {
    if (runtimeGate === 'ready' && runtimePreparing) {
      setRuntimePreparing(false);
      void managementActions.refreshDirectory();
      return;
    }
    if (runtimeGate === 'error' && runtimePreparing) {
      setRuntimePreparing(false);
    }
  }, [managementActions, runtimeGate, runtimePreparing]);

  const activePlan = useMemo(() => {
    if (mode === 'provider') {
      return directPlan;
    }
    return progress?.currentPlanId
      ? getRuntimeProviderOnboardingPlan(progress.currentPlanId)
      : null;
  }, [directPlan, mode, progress?.currentPlanId]);

  useEffect(() => {
    const nextActivePlanId = activePlan?.id ?? null;
    if (activePlanRef.current === nextActivePlanId) {
      return;
    }
    activePlanRef.current = nextActivePlanId;
    connectStartedPlanRef.current = null;
    probeSequenceRef.current += 1;
    setStage(activePlan ? 'connect' : wizardStarted ? 'ready' : 'connect');
    setStageError(null);
    setRecommendedModel(null);
    setVerifiedModelId(null);
  }, [activePlan, wizardStarted]);

  const verifyModel = useCallback(
    async (modelId: string): Promise<void> => {
      if (!activePlan) {
        return;
      }
      const model = management.models.find((entry) => entry.modelId === modelId) ?? null;
      if (!model) {
        setStage('error');
        setStageError('The selected model is no longer available in the live OpenCode catalog.');
        return;
      }
      const probeSequence = probeSequenceRef.current + 1;
      probeSequenceRef.current = probeSequence;
      setRecommendedModel(model);
      setVerifiedModelId(null);
      setStage('verifying');
      setStageError(null);
      managementActions.selectModel(model.modelId);
      const result = await managementActions.testModel(activePlan.providerId, model.modelId);
      if (probeSequenceRef.current !== probeSequence) {
        return;
      }
      if (!result.ok || result.availability !== 'available') {
        setStage('error');
        setStageError(result.message || 'The model could not complete a verification request.');
        return;
      }
      setVerifiedModelId(model.modelId);
      setStage('choose-model');
    },
    [activePlan, management.models, managementActions]
  );

  useEffect(() => {
    if (!enabled || !activePlan || runtimeGate !== 'ready' || runtimeUpdateRequired) {
      return;
    }
    if (!management.directoryLoaded || management.directoryLoading) {
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
    const candidate = selectRecommendedRuntimeProviderModel(activePlan, management.models);
    if (!candidate) {
      setStage('error');
      setStageError('No usable model was reported for this connected provider.');
      return;
    }
    void verifyModel(candidate.modelId);
  }, [
    activePlan,
    enabled,
    management,
    managementActions,
    recommendedModel,
    runtimeGate,
    runtimeUpdateRequired,
    verifiedModelId,
    verifyModel,
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
    setRuntimePreparing(true);
    setStageError(null);
    try {
      await onInstallOrUpdateRuntime();
    } catch (error) {
      setRuntimePreparing(false);
      setStage('error');
      setStageError(error instanceof Error ? error.message : 'Failed to prepare OpenCode.');
    }
  }, [onInstallOrUpdateRuntime]);

  const startWizard = useCallback(async (): Promise<void> => {
    if (selectedPlanIds.length === 0) {
      setStageError('Select at least one subscription plan.');
      return;
    }
    const nextProgress = createRuntimeProviderOnboardingProgress(selectedPlanIds);
    setProgress(nextProgress);
    setWizardStarted(true);
    setResumable(false);
    setStageError(null);
    repositoryRef.current?.save(nextProgress);
    if (runtimeGate !== 'ready' || runtimeUpdateRequired) {
      await installOrUpdateRuntime();
    }
  }, [installOrUpdateRuntime, runtimeGate, runtimeUpdateRequired, selectedPlanIds]);

  const restartWizard = useCallback((): void => {
    repositoryRef.current?.clear();
    setProgress(null);
    setWizardStarted(false);
    setResumable(false);
    setSelectedPlanIds(DEFAULT_WIZARD_PLAN_IDS);
    setStage('connect');
    setStageError(null);
    setRecommendedModel(null);
    setVerifiedModelId(null);
    managementActions.cancelConnect();
  }, [managementActions]);

  const beginConnect = useCallback((): void => {
    if (!activePlan) {
      return;
    }
    connectStartedPlanRef.current = activePlan.id;
    setStage('connect');
    setStageError(null);
    managementActions.startConnect(activePlan.providerId);
  }, [activePlan, managementActions]);

  const submitConnect = useCallback(async (): Promise<boolean> => {
    if (!activePlan) {
      return false;
    }
    const connected = await managementActions.submitConnect(activePlan.providerId);
    if (connected) {
      setStage('verifying');
      setStageError(null);
    }
    return connected;
  }, [activePlan, managementActions]);

  const acceptVerifiedModel = useCallback((): void => {
    if (!activePlan || !verifiedModelId) {
      return;
    }
    managementActions.useModelForNewTeams(verifiedModelId);
    if (mode === 'provider') {
      setStage('ready');
      return;
    }
    setProgress((current) =>
      current
        ? completeRuntimeProviderOnboardingPlan(current, activePlan.id, verifiedModelId)
        : current
    );
  }, [activePlan, managementActions, mode, verifiedModelId]);

  const openCredentialPage = useCallback(async (): Promise<void> => {
    if (!activePlan?.credentialUrl) {
      return;
    }
    await api.openExternal(activePlan.credentialUrl);
  }, [activePlan]);

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
      submitConnect,
      verifyModel,
      acceptVerifiedModel,
      openCredentialPage,
      clearCompletedWizard,
    },
  ] as const;
}
