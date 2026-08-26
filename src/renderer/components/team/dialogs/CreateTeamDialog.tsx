import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  reconcileAnthropicRuntimeSelections,
  resolveAnthropicFastMode,
  resolveAnthropicRuntimeSelection,
} from '@features/anthropic-runtime-profile/renderer';
import {
  isCodexAccountSnapshotPending,
  mergeCodexCliStatusWithSnapshot,
  useCodexAccountSnapshot,
} from '@features/codex-account/renderer';
import {
  buildCodexFastModeArgs,
  reconcileCodexRuntimeSelections,
  resolveCodexFastMode,
  resolveCodexRuntimeSelection,
} from '@features/codex-runtime-profile/renderer';
import { useAppTranslation } from '@features/localization/renderer';
import {
  useWorkspaceTrustStatus,
  WorkspaceTrustLaunchNotice,
} from '@features/workspace-trust/renderer';
import { api } from '@renderer/api';
import { ProviderActivityStatusStrip } from '@renderer/components/common/ProviderActivityStatusStrip';
import {
  buildMemberDraftColorMap,
  buildMemberDraftSuggestions,
  buildMembersFromDrafts,
  clearMemberModelOverrides,
  createMemberDraft,
  normalizeLeadProviderForMode,
  normalizeMemberDraftForProviderMode,
  validateMemberNameInline,
} from '@renderer/components/team/members/MembersEditorSection';
import { TeamRosterEditorSection } from '@renderer/components/team/members/TeamRosterEditorSection';
import { AutoResizeTextarea } from '@renderer/components/ui/auto-resize-textarea';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { CUSTOM_ROLE, PRESET_ROLES } from '@renderer/constants/teamRoles';
import { useChipDraftPersistence } from '@renderer/hooks/useChipDraftPersistence';
import { useCreateTeamDraft } from '@renderer/hooks/useCreateTeamDraft';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import {
  useEffectiveCliProviderStatus,
  useExactProjectProviderLaunchProof,
} from '@renderer/hooks/useEffectiveCliProviderStatus';
import { useOpenCodeCatalogPrefetch } from '@renderer/hooks/useOpenCodeCatalogPrefetch';
import { useTaskSuggestions } from '@renderer/hooks/useTaskSuggestions';
import { useTeamSuggestions } from '@renderer/hooks/useTeamSuggestions';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import {
  applyStoredCreateTeamMemberRuntimePreferences,
  getStoredCreateTeamEffort,
  getStoredCreateTeamFastMode as getStoredTeamFastMode,
  getStoredCreateTeamLimitContext,
  getStoredCreateTeamModel as getStoredTeamModel,
  getStoredCreateTeamProvider as getStoredTeamProvider,
  getStoredCreateTeamSkipPermissions,
  migrateLegacyCreateTeamPreferences,
  setStoredCreateTeamEffort,
  setStoredCreateTeamFastMode,
  setStoredCreateTeamLimitContext,
  setStoredCreateTeamMemberRuntimePreferences,
  setStoredCreateTeamModel,
  setStoredCreateTeamProvider,
  setStoredCreateTeamSkipPermissions,
} from '@renderer/services/createTeamPreferences';
import { useStore } from '@renderer/store';
import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import { isGeminiUiFrozen } from '@renderer/utils/geminiUiFreeze';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { resolveUiOwnedProviderBackendId } from '@renderer/utils/providerBackendIdentity';
import { refreshCliStatusForCurrentMode } from '@renderer/utils/refreshCliStatus';
import { getAvailableTeamEffortValue } from '@renderer/utils/teamEffortOptions';
import {
  isTeamProviderRuntimeStatusLoading,
  normalizeExplicitTeamModelForUi,
} from '@renderer/utils/teamModelAvailability';
import { isEphemeralProjectPath } from '@shared/utils/ephemeralProjectPath';
import { resolveTeamLeadColorName } from '@shared/utils/teamMemberColors';
import { isTeamProviderId, normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { AdvancedCliSection } from './AdvancedCliSection';
import { AnthropicFastModeSelector } from './AnthropicFastModeSelector';
import {
  buildAuthoritativeModelChecks,
  materializeConcreteLaunchRoster,
  resolveConcreteProviderBackend,
} from './authoritativeLaunchIdentity';
import { CodexFastModeSelector } from './CodexFastModeSelector';
import { CodexReconnectPrompt, shouldShowCodexReconnectPrompt } from './CodexReconnectPrompt';
import {
  buildDefaultCreateTeamDescription as buildDefaultTeamDescription,
  DEFAULT_CREATE_TEAM_MEMBERS as DEFAULT_MEMBERS,
  isCurrentCreateTeamPrepareGeneration as isCurrentPrepareGeneration,
  sanitizeCreateTeamName as sanitizeTeamName,
  TEAM_COLOR_NAMES,
  validateCreateTeamNameInline as validateTeamNameInline,
  validateCreateTeamRequest as validateRequest,
} from './createTeamDialogPolicy';
import { createTeamDraftPayload } from './createTeamDraftPayload';
import { clearCreateTeamNameFieldError, type CreateTeamFieldErrors } from './createTeamFieldErrors';
import {
  getOrganizationPlacementUnitKindKey,
  getOrganizationPlacementUnitOptions,
  getOrganizationUnitLabel,
} from './createTeamOrganizationPlacement';
import { CreateTeamRosterHeaderTop } from './CreateTeamRosterHeaderTop';
import { ExperimentalLocalModelOverrideCheckbox } from './ExperimentalLocalModelOverride';
import { resolveExperimentalLocalModelOverride } from './experimentalLocalModelOverrideState';
import { APP_TEAM_RUNTIME_DISALLOWED_TOOLS, getProviderLabel } from './launchTeamDialogHelpers';
import {
  clearInheritedMemberModelsUnavailableForProvider,
  getDialogTeamModelValidationError,
  resolveProviderScopedMemberModel,
} from './memberModelScope';
import { OptionalSettingsSection } from './OptionalSettingsSection';
import {
  isDeletedProjectPathSelection,
  isSelectableProjectPathProject,
} from './projectPathOptions';
import { loadProjectPathProjects, type ProjectPathProject } from './projectPathProjects';
import { ProjectPathSelector } from './ProjectPathSelector';
import { buildProviderPrepareModelCacheKey } from './providerPrepareCacheKey';
import {
  mergeReusableProviderPrepareModelResults,
  type ProviderPrepareDiagnosticsModelResult,
  runProviderPrepareDiagnostics,
} from './providerPrepareDiagnostics';
import { buildProviderPreparePlans, type ProviderPreparePlan } from './providerPreparePlans';
import {
  buildProviderPrepareModelChecksSignature,
  buildProviderPrepareRuntimeStatusSignature,
} from './providerPrepareRequestSignature';
import {
  getShortLivedProviderPrepareModelIssueReasons,
  storeShortLivedProviderPrepareModelResults,
} from './providerPrepareShortLivedCache';
import {
  areProviderLaunchStatusesAuthoritative,
  cancelScheduledProviderPrepareIdle,
  executeAuthorizedProvisioningLaunch,
  isCreateTeamLaunchAuthorized,
  isProvisioningPreparationAuthorizationCandidate,
  type ProviderPrepareIdleScheduler,
  resolveProvisioningLaunchPreparationState as resolveLaunchPrepareState,
  resolveProvisioningPreparationAuthorizationState as resolvePrepareState,
  type ScheduledProviderPrepareIdleHandle,
  scheduleGuardedProviderPrepareIdle,
} from './provisioningLaunchAuthorization';
import { getProvisioningModelIssue } from './provisioningModelIssues';
import { alignProvisioningProviderChecks as alignProvisioningChecks } from './provisioningProviderCheckPolicy';
import { ProvisioningProviderRuntimeSettingsDialog } from './ProvisioningProviderRuntimeSettingsDialog';
import {
  deriveEffectiveProvisioningPrepareState,
  getPrimaryProvisioningFailureDetail,
  getProvisioningFailureHint,
  getProvisioningProviderBackendSummary,
  getProvisioningProviderProgressMessage,
  getProvisioningProviderReadyById,
  type ProvisioningProviderCheck,
  ProvisioningProviderStatusList,
  shouldHideProvisioningProviderStatusList,
  updateProviderCheck,
} from './ProvisioningProviderStatusList';
import { SkipPermissionsCheckbox } from './SkipPermissionsCheckbox';
import {
  analyzeTeammateRuntimeCompatibility,
  useTmuxRuntimeReadiness,
} from './teammateRuntimeCompatibility';
import { TeammateRuntimeCompatibilityNotice } from './TeammateRuntimeCompatibilityNotice';
import { computeEffectiveTeamModel } from './TeamModelSelector';
import { getNextSuggestedTeamName } from './teamNameSets';
import { useAuthoritativePrepareCandidate } from './useAuthoritativePrepareCandidate';
import { useMemoizedCommittedLaunchAuthorization } from './useCommittedLaunchAuthorizationRef';
import { useCreateTeamModelSync } from './useCreateTeamModelSync';
import { useDialogSubmissionGeneration } from './useDialogSubmissionGeneration';
import { useExecutionProofRefresh } from './useExecutionProofRefresh';
import { useOpenCodeLocalModelScope } from './useOpenCodeLocalModelScope';
import {
  getWorktreeGitBlockingMessage,
  getWorktreeGitControlDisabledReason,
  useWorktreeGitReadiness,
  WorktreeGitReadinessBanner,
} from './WorktreeGitReadinessBanner';

import type { CreateTeamDialogProps } from './teamDialogProps';
import type {
  OrganizationPlacementSelection,
  OrganizationStructurePayload,
} from '@features/organizations/contracts';
import type { MemberDraft } from '@renderer/components/team/members/MembersEditorSection';
import type {
  CliProviderId,
  EffortLevel,
  TeamCreateRequest,
  TeamFastMode,
  TeamProviderId,
} from '@shared/types';
export * from './createTeamDialogContracts';
export type { ActiveTeamRef, TeamCopyData } from './createTeamDialogPolicy';
export const CreateTeamDialog = ({
  open,
  canCreate,
  provisioningErrorsByTeam,
  clearProvisioningError,
  existingTeamNames,
  provisioningTeamNames = [],
  activeTeams,
  initialData,
  initialOrganizationPlacement,
  defaultProjectPath,
  forceDefaultProjectSelection = false,
  onClose,
  onCreate,
  onOpenTeam,
}: CreateTeamDialogProps): React.JSX.Element => {
  const { isLight } = useTheme();
  const { t } = useAppTranslation('team');
  const multimodelEnabled = useStore((s) => s.appConfig?.general?.multimodelEnabled ?? true);
  const anthropicProviderFastModeDefault = useStore(
    (s) => s.appConfig?.providerConnections?.anthropic.fastModeDefault ?? false
  );
  const { cliStatus, cliStatusLoading, cliProviderStatusLoading } = useStore(
    useShallow((s) => ({
      cliStatus: s.cliStatus,
      cliStatusLoading: s.cliStatusLoading,
      cliProviderStatusLoading: s.cliProviderStatusLoading,
    }))
  );
  const bootstrapCliStatus = useStore((s) => s.bootstrapCliStatus);
  const fetchCliStatus = useStore((s) => s.fetchCliStatus);
  const openDashboard = useStore((s) => s.openDashboard);
  const loadingCliStatus = useMemo(
    () =>
      !cliStatus && cliStatusLoading && multimodelEnabled
        ? createLoadingMultimodelCliStatus()
        : cliStatus,
    [cliStatus, cliStatusLoading, multimodelEnabled]
  );
  const codexAccount = useCodexAccountSnapshot({
    enabled:
      multimodelEnabled &&
      loadingCliStatus?.flavor === 'agent_teams_orchestrator' &&
      Boolean(loadingCliStatus?.providers.some((provider) => provider.providerId === 'codex')),
  });
  const effectiveCliStatus = useMemo(
    () => mergeCodexCliStatusWithSnapshot(loadingCliStatus, codexAccount.snapshot),
    [loadingCliStatus, codexAccount.snapshot]
  );
  const codexSnapshotPending =
    isCodexAccountSnapshotPending(
      codexAccount.loading,
      codexAccount.snapshot,
      codexAccount.error
    ) && Boolean(loadingCliStatus?.providers.some((provider) => provider.providerId === 'codex'));
  const globalRuntimeProviderStatusById = useMemo(
    () =>
      new Map(
        (effectiveCliStatus?.providers ?? []).map(
          (provider) => [provider.providerId, provider] as const
        )
      ),
    [effectiveCliStatus?.providers]
  );

  const {
    teamName,
    setTeamName,
    members,
    setMembers,
    syncModelsWithLead,
    setSyncModelsWithLead,
    teammateWorktreeDefault,
    setTeammateWorktreeDefault,
    cwdMode,
    setCwdMode,
    selectedProjectPath,
    setSelectedProjectPath,
    customCwd,
    setCustomCwd,
    soloTeam,
    setSoloTeam,
    launchTeam,
    setLaunchTeam,
    teamColor,
    setTeamColor,
    isLoaded: draftLoaded,
    clearDraft,
  } = useCreateTeamDraft();
  const descriptionDraft = useDraftPersistence({
    key: 'createTeam:description',
  });
  const promptDraft = useDraftPersistence({ key: 'createTeam:prompt' });
  const promptChipDraft = useChipDraftPersistence('createTeam:prompt:chips');

  const [projects, setProjects] = useState<ProjectPathProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [prepareState, setPrepareState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [prepareMessage, setPrepareMessage] = useState<string | null>(null);
  const [prepareWarnings, setPrepareWarnings] = useState<string[]>([]);
  const [prepareChecks, setPrepareChecks] = useState<ProvisioningProviderCheck[]>([]);
  const authorityCandidate = useAuthoritativePrepareCandidate();
  const authorizedPreparation = authorityCandidate.candidate;
  const [allowExperimentalLocalModels, setAllowExperimentalLocalModels] = useState(false);
  const {
    available: experimentalLocalModelOverrideAvailable,
    enabled: experimentalLocalModelOverrideEnabled,
  } = resolveExperimentalLocalModelOverride({
    checks: prepareChecks,
    checked: allowExperimentalLocalModels,
  });
  const providerReadyById = useMemo(
    () => getProvisioningProviderReadyById(prepareChecks),
    [prepareChecks]
  );
  const [prepareProviderInvalidationEpochById, setPrepareProviderInvalidationEpochById] = useState<
    Partial<Record<TeamProviderId, number>>
  >({});
  const [providerSettingsProviderId, setProviderSettingsProviderId] =
    useState<TeamProviderId | null>(null);
  const [workflowMentionSuggestionsEnabled, setWorkflowMentionSuggestionsEnabled] = useState(false);
  const prepareRequestSeqRef = useRef(0);
  const lastCreatePrepareRequestSignatureRef = useRef<string | null>(null);
  const prepareIdleHandlesRef = useRef(new Set<ScheduledProviderPrepareIdleHandle>());
  const prepareUnmountGenerationRef = useRef(0);
  const appliedDefaultProjectPathRef = useRef<string | null>(null);
  const forcedDefaultProjectModePathRef = useRef<string | null>(null);
  const lastAutoDescriptionRef = useRef<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<CreateTeamFieldErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittedTeamNameRef = useRef<string | null>(null);
  const [organizationStructure, setOrganizationStructure] =
    useState<OrganizationStructurePayload | null>(null);
  const [organizationStructureLoading, setOrganizationStructureLoading] = useState(false);
  const [organizationPlacementEnabled, setOrganizationPlacementEnabled] = useState(false);
  const [organizationPlacementOrganizationId, setOrganizationPlacementOrganizationId] =
    useState('');
  const [organizationPlacementParentId, setOrganizationPlacementParentId] = useState('');
  const [organizationPlacementError, setOrganizationPlacementError] = useState<string | null>(null);
  const [conflictDismissed, setConflictDismissed] = useState(false);
  const [selectedProviderId, setSelectedProviderIdRaw] = useState<TeamProviderId>(() =>
    normalizeLeadProviderForMode(getStoredTeamProvider(), multimodelEnabled)
  );
  const [selectedModel, setSelectedModelRaw] = useState(() =>
    getStoredTeamModel(normalizeLeadProviderForMode(getStoredTeamProvider(), multimodelEnabled))
  );
  const [limitContext, setLimitContextRaw] = useState(getStoredCreateTeamLimitContext);
  const [skipPermissions, setSkipPermissionsRaw] = useState(getStoredCreateTeamSkipPermissions);
  const [selectedEffort, setSelectedEffortRaw] = useState(getStoredCreateTeamEffort);
  const [selectedFastMode, setSelectedFastModeRaw] = useState<TeamFastMode>(getStoredTeamFastMode);
  const [anthropicRuntimeNotice, setAnthropicRuntimeNotice] = useState<string | null>(null);

  const advancedKey = useMemo(() => sanitizeTeamName(teamName.trim()) || '_new_', [teamName]);
  const [worktreeEnabled, setWorktreeEnabledRaw] = useState(false);
  const [worktreeName, setWorktreeNameRaw] = useState('');
  const [customArgs, setCustomArgsRaw] = useState('');

  useEffect(() => {
    migrateLegacyCreateTeamPreferences();
  }, []);

  useEffect(() => {
    if (!open) {
      setProviderSettingsProviderId(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      setOrganizationPlacementEnabled(false);
      setOrganizationPlacementError(null);
      return undefined;
    }

    let cancelled = false;
    const preferredPlacement = initialOrganizationPlacement ?? null;
    setOrganizationStructureLoading(true);
    void api.organizations
      .getOrganizationStructure()
      .then((payload) => {
        if (cancelled) return;
        setOrganizationStructure(payload);
        const organization =
          (preferredPlacement
            ? payload.organizations.find(
                (candidate) => candidate.id === preferredPlacement.organizationId
              )
            : undefined) ??
          payload.organizations[0] ??
          null;
        setOrganizationPlacementEnabled(Boolean(preferredPlacement));
        setOrganizationPlacementOrganizationId(organization?.id ?? '');
        setOrganizationPlacementParentId(
          preferredPlacement?.parentUnitId ?? organization?.rootNodeId ?? ''
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setOrganizationPlacementError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setOrganizationStructureLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [initialOrganizationPlacement, open]);

  useEffect(() => {
    const storedEnabled =
      localStorage.getItem(`team:lastWorktreeEnabled:${advancedKey}`) === 'true';
    const storedName = localStorage.getItem(`team:lastWorktreeName:${advancedKey}`) ?? '';
    setWorktreeEnabledRaw(storedEnabled && Boolean(storedName));
    setWorktreeNameRaw(storedName);
    setCustomArgsRaw(localStorage.getItem(`team:lastCustomArgs:${advancedKey}`) ?? '');
  }, [advancedKey]);

  const setLimitContext = useCallback((value: boolean): void => {
    setLimitContextRaw(value);
    setStoredCreateTeamLimitContext(value);
  }, []);

  const setSkipPermissions = useCallback((value: boolean): void => {
    setSkipPermissionsRaw(value);
    setStoredCreateTeamSkipPermissions(value);
  }, []);

  const setSelectedEffort = useCallback((value: string): void => {
    setSelectedEffortRaw(value);
    setStoredCreateTeamEffort(value);
  }, []);

  const setSelectedFastMode = useCallback((value: TeamFastMode): void => {
    setSelectedFastModeRaw(value);
    setStoredCreateTeamFastMode(value);
  }, []);
  const enableWorkflowMentionSuggestions = useCallback((): void => {
    setWorkflowMentionSuggestionsEnabled(true);
  }, []);

  const setWorktreeEnabled = (value: boolean): void => {
    setWorktreeEnabledRaw(value);
    localStorage.setItem(`team:lastWorktreeEnabled:${advancedKey}`, String(value));
    if (!value) {
      setWorktreeNameRaw('');
      localStorage.setItem(`team:lastWorktreeName:${advancedKey}`, '');
    }
  };
  const setWorktreeName = (value: string): void => {
    setWorktreeNameRaw(value);
    localStorage.setItem(`team:lastWorktreeName:${advancedKey}`, value);
  };
  const setCustomArgs = (value: string): void => {
    setCustomArgsRaw(value);
    localStorage.setItem(`team:lastCustomArgs:${advancedKey}`, value);
  };
  const resetUIState = (): void => {
    submittedTeamNameRef.current = null;
    setLocalError(null);
    setFieldErrors({});
    setIsSubmitting(false);
    setPrepareState('idle');
    setPrepareMessage(null);
    setPrepareWarnings([]);
    setPrepareChecks([]);
    setAllowExperimentalLocalModels(false);
    setConflictDismissed(false);
  };

  const resetFormState = (): void => {
    clearDraft();
    lastAutoDescriptionRef.current = null;
    descriptionDraft.clearDraft();
    promptDraft.clearDraft();
    promptChipDraft.clearChipDraft();
    resetUIState();
  };

  const persistCurrentMemberRuntimePreferences = useCallback(
    (nextMembers: readonly MemberDraft[] = members): void => {
      setStoredCreateTeamMemberRuntimePreferences(nextMembers);
    },
    [members]
  );

  const selectedProjectPathDeleted = useMemo(
    () =>
      cwdMode === 'project' &&
      selectedProjectPath.length > 0 &&
      isDeletedProjectPathSelection(projects, selectedProjectPath),
    [cwdMode, projects, selectedProjectPath]
  );
  const selectedProjectCwd =
    isEphemeralProjectPath(selectedProjectPath) || selectedProjectPathDeleted
      ? ''
      : selectedProjectPath.trim();
  const effectiveCwd = cwdMode === 'project' ? selectedProjectCwd : customCwd.trim();
  const { providerStatus: projectScopedOpenCodeStatus } = useEffectiveCliProviderStatus(
    'opencode',
    {
      projectPath: effectiveCwd || null,
    }
  );
  const runtimeProviderStatusById = useMemo(() => {
    const statuses = new Map(globalRuntimeProviderStatusById);
    if (effectiveCwd && projectScopedOpenCodeStatus) {
      statuses.set('opencode', projectScopedOpenCodeStatus);
    }
    return statuses;
  }, [effectiveCwd, globalRuntimeProviderStatusById, projectScopedOpenCodeStatus]);
  const openCodeLocalModelScope = useOpenCodeLocalModelScope({
    enabled: open,
    projectPath: effectiveCwd,
    selectedProviderId,
    members,
  });
  const memberModelNormalizationDeferredProviderIds = useMemo<ReadonlySet<TeamProviderId>>(
    () => (codexSnapshotPending ? new Set<TeamProviderId>(['codex']) : new Set()),
    [codexSnapshotPending]
  );
  const dialogTeamNameKey = sanitizeTeamName(teamName.trim());
  const submissionFence = useDialogSubmissionGeneration({
    open,
    identity: `${initialData?.teamName ?? ''}:${dialogTeamNameKey}`,
    roster: members,
    run: provisioningErrorsByTeam[dialogTeamNameKey] ?? null,
  });
  const allTakenTeamNames = useMemo(
    () => [...new Set([...existingTeamNames, ...provisioningTeamNames])],
    [existingTeamNames, provisioningTeamNames]
  );
  const suggestedTeamName = useMemo(
    () => getNextSuggestedTeamName(allTakenTeamNames),
    [allTakenTeamNames]
  );

  useEffect(() => {
    if (open && dialogTeamNameKey) {
      clearProvisioningError?.(dialogTeamNameKey);
    }
  }, [open, clearProvisioningError, dialogTeamNameKey]);

  const effectiveMemberDrafts = useMemo(() => {
    const scopedMembers = syncModelsWithLead ? members.map(clearMemberModelOverrides) : members;
    return clearInheritedMemberModelsUnavailableForProvider({
      members: scopedMembers,
      selectedProviderId,
      runtimeProviderStatusById,
      deferredProviderIds: memberModelNormalizationDeferredProviderIds,
      ...openCodeLocalModelScope,
    }).members;
  }, [
    memberModelNormalizationDeferredProviderIds,
    members,
    openCodeLocalModelScope,
    runtimeProviderStatusById,
    selectedProviderId,
    syncModelsWithLead,
  ]);
  const hasSelectedWorktreeIsolation =
    !soloTeam &&
    effectiveMemberDrafts.some((member) => !member.removedAt && member.isolation === 'worktree');
  const worktreeGitReadiness = useWorktreeGitReadiness(
    effectiveCwd || null,
    open && canCreate && hasSelectedWorktreeIsolation
  );
  const worktreeIsolationDisabledReason =
    !soloTeam && canCreate ? getWorktreeGitControlDisabledReason(worktreeGitReadiness) : null;
  const worktreeGitBlockingMessage = getWorktreeGitBlockingMessage(
    worktreeGitReadiness,
    hasSelectedWorktreeIsolation
  );
  const worktreeGitBlocksSubmission = Boolean(worktreeGitBlockingMessage);
  const tmuxRuntime = useTmuxRuntimeReadiness(open && canCreate);

  const selectedMemberProviders = useMemo<TeamProviderId[]>(() => {
    if (!multimodelEnabled) {
      return ['anthropic'];
    }
    if (soloTeam || syncModelsWithLead) {
      return [selectedProviderId];
    }
    return Array.from(
      new Set([
        selectedProviderId,
        ...members.flatMap((member) =>
          !member.removedAt && isTeamProviderId(member.providerId) ? [member.providerId] : []
        ),
      ])
    );
  }, [members, multimodelEnabled, selectedProviderId, soloTeam, syncModelsWithLead]);
  const {
    providerStatusById: launchProofProviderStatusById,
    providerLoadingById: launchProofProviderLoadingById,
    providerGenerationById: launchProofProviderGenerationById,
    providerProofExpiresAtMs: launchProofExpiresAtMs,
  } = useExactProjectProviderLaunchProof(
    selectedMemberProviders,
    effectiveCwd,
    open && canCreate && launchTeam
  );
  useExecutionProofRefresh({
    generation: authorizedPreparation?.generation ?? null,
    providerIds: selectedMemberProviders,
    clearAuthorization: authorityCandidate.clear,
    invalidate: setPrepareProviderInvalidationEpochById,
  });
  const workspaceTrustStatus = useWorkspaceTrustStatus({
    enabled: open && canCreate && launchTeam && selectedMemberProviders.includes('anthropic'),
    projectPath: effectiveCwd || null,
  });
  const { requiredCatalogPending: openCodeCatalogPending } = useOpenCodeCatalogPrefetch({
    enabled: open && multimodelEnabled,
    projectPath: effectiveCwd || null,
    priority: selectedMemberProviders.includes('opencode') ? 'required' : 'background',
    deferBackground: prepareState === 'loading' || isSubmitting,
  });
  const hasSelectedAnthropicRuntime = selectedMemberProviders.includes('anthropic');
  const effectiveAnthropicRuntimeLimitContext = hasSelectedAnthropicRuntime ? limitContext : false;

  const runtimeBackendSummaryByProvider = useMemo(() => {
    const entries: (readonly [TeamProviderId, string | null])[] = selectedMemberProviders.map(
      (providerId) =>
        [
          providerId,
          getProvisioningProviderBackendSummary(launchProofProviderStatusById.get(providerId)),
        ] as const
    );
    return new Map<TeamProviderId, string | null>(entries);
  }, [launchProofProviderStatusById, selectedMemberProviders]);
  const setSelectedModel = useCallback(
    (value: string): void => {
      const normalizedValue = normalizeExplicitTeamModelForUi(selectedProviderId, value);
      const nextEffort = getAvailableTeamEffortValue({
        providerId: selectedProviderId,
        model: normalizedValue,
        limitContext: effectiveAnthropicRuntimeLimitContext,
        providerStatus: runtimeProviderStatusById.get(selectedProviderId),
        value: selectedEffort,
      });
      setSelectedModelRaw(normalizedValue);
      setStoredCreateTeamModel(selectedProviderId, normalizedValue);
      if (nextEffort !== selectedEffort) {
        setSelectedEffortRaw(nextEffort);
        setStoredCreateTeamEffort(nextEffort);
      }
    },
    [
      effectiveAnthropicRuntimeLimitContext,
      runtimeProviderStatusById,
      selectedEffort,
      selectedProviderId,
    ]
  );

  const setSelectedProviderId = useCallback(
    (value: TeamProviderId): void => {
      const normalizedValue = normalizeLeadProviderForMode(value, multimodelEnabled);
      const nextModel = getStoredTeamModel(normalizedValue);
      const nextEffort = getAvailableTeamEffortValue({
        providerId: normalizedValue,
        model: nextModel,
        limitContext: normalizedValue === 'anthropic' ? limitContext : false,
        providerStatus: runtimeProviderStatusById.get(normalizedValue),
        value: selectedEffort,
      });
      setSelectedProviderIdRaw(normalizedValue);
      setStoredCreateTeamProvider(normalizedValue);
      setSelectedModelRaw(nextModel);
      if (nextEffort !== selectedEffort) {
        setSelectedEffortRaw(nextEffort);
        setStoredCreateTeamEffort(nextEffort);
      }
    },
    [limitContext, multimodelEnabled, runtimeProviderStatusById, selectedEffort]
  );

  const runtimeProviderLoadingById = useMemo(
    () =>
      new Map(
        selectedMemberProviders.map(
          (providerId) =>
            [
              providerId,
              isTeamProviderRuntimeStatusLoading(
                providerId,
                runtimeProviderStatusById.get(providerId),
                cliProviderStatusLoading[providerId] === true ||
                  (providerId === 'codex' && codexSnapshotPending)
              ) ||
                (providerId === 'opencode' && openCodeCatalogPending),
            ] as const
        )
      ),
    [
      cliProviderStatusLoading,
      codexSnapshotPending,
      openCodeCatalogPending,
      runtimeProviderStatusById,
      selectedMemberProviders,
    ]
  );
  const selectedProviderBackendId = useMemo(
    () =>
      resolveUiOwnedProviderBackendId(
        selectedProviderId,
        runtimeProviderStatusById.get(selectedProviderId)
      ),
    [runtimeProviderStatusById, selectedProviderId]
  );
  const runtimeBackendSummaryByProviderRef = useRef(runtimeBackendSummaryByProvider);
  const prepareChecksRef = useRef<ProvisioningProviderCheck[]>([]);
  const prepareMessageRef = useRef<string | null>(null);
  const prepareModelResultsCacheRef = useRef(
    new Map<string, Record<string, ProviderPrepareDiagnosticsModelResult>>()
  );
  const lastPrepareProviderSignatureByIdRef = useRef(new Map<TeamProviderId, string>());
  const pendingPrepareProviderSignatureByIdRef = useRef(new Map<TeamProviderId, string>());
  const prepareProviderRequestSeqByIdRef = useRef(new Map<TeamProviderId, number>());
  const prepareWarningsByProviderIdRef = useRef(new Map<TeamProviderId, string[]>());
  useEffect(() => {
    runtimeBackendSummaryByProviderRef.current = runtimeBackendSummaryByProvider;
  }, [runtimeBackendSummaryByProvider]);
  useEffect(() => {
    const sanitized = clearInheritedMemberModelsUnavailableForProvider({
      members,
      selectedProviderId,
      runtimeProviderStatusById,
      deferredProviderIds: memberModelNormalizationDeferredProviderIds,
      ...openCodeLocalModelScope,
    });
    if (sanitized.changed) {
      setMembers(sanitized.members);
    }
  }, [
    memberModelNormalizationDeferredProviderIds,
    members,
    openCodeLocalModelScope,
    runtimeProviderStatusById,
    selectedProviderId,
    setMembers,
  ]);
  useEffect(() => {
    prepareChecksRef.current = prepareChecks;
  }, [prepareChecks]);
  useEffect(() => {
    prepareMessageRef.current = prepareMessage;
  }, [prepareMessage]);

  const invalidatePrepareProvider = useCallback(
    (providerId: CliProviderId): void => {
      if (!isTeamProviderId(providerId)) {
        return;
      }
      lastPrepareProviderSignatureByIdRef.current.delete(providerId);
      pendingPrepareProviderSignatureByIdRef.current.delete(providerId);
      prepareProviderRequestSeqByIdRef.current.set(
        providerId,
        (prepareProviderRequestSeqByIdRef.current.get(providerId) ?? 0) + 1
      );
      prepareWarningsByProviderIdRef.current.delete(providerId);
      authorityCandidate.clear();
      setPrepareProviderInvalidationEpochById((current) => ({
        ...current,
        [providerId]: (current[providerId] ?? 0) + 1,
      }));
    },
    [authorityCandidate]
  );
  useEffect(() => {
    if (!open) {
      lastPrepareProviderSignatureByIdRef.current.clear();
      pendingPrepareProviderSignatureByIdRef.current.clear();
      prepareProviderRequestSeqByIdRef.current.clear();
      prepareWarningsByProviderIdRef.current.clear();
    }
  }, [open]);
  useEffect(() => {
    const generation = ++prepareUnmountGenerationRef.current;
    const idleHandles = prepareIdleHandlesRef.current;
    const lastProviderSignatures = lastPrepareProviderSignatureByIdRef.current;
    const pendingProviderSignatures = pendingPrepareProviderSignatureByIdRef.current;
    const providerRequestSeqs = prepareProviderRequestSeqByIdRef.current;
    const warningsByProviderId = prepareWarningsByProviderIdRef.current;
    return () => {
      queueMicrotask(() => {
        if (!isCurrentPrepareGeneration(prepareUnmountGenerationRef, generation)) {
          return;
        }
        cancelScheduledProviderPrepareIdle(
          window as unknown as ProviderPrepareIdleScheduler,
          idleHandles
        );
        prepareRequestSeqRef.current += 1;
        lastProviderSignatures.clear();
        pendingProviderSignatures.clear();
        providerRequestSeqs.clear();
        warningsByProviderId.clear();
      });
    };
  }, []);
  const selectedEffortForCurrentSelection = useMemo(
    () =>
      getAvailableTeamEffortValue({
        providerId: selectedProviderId,
        model: selectedModel,
        limitContext: effectiveAnthropicRuntimeLimitContext,
        providerStatus: runtimeProviderStatusById.get(selectedProviderId),
        value: selectedEffort,
      }),
    [
      effectiveAnthropicRuntimeLimitContext,
      runtimeProviderStatusById,
      selectedEffort,
      selectedModel,
      selectedProviderId,
    ]
  );
  const effectiveLeadEffort = (selectedEffortForCurrentSelection as EffortLevel | '') || undefined;
  const selectedModelChecksByProvider = useMemo(() => {
    const leadModel = computeEffectiveTeamModel(
      selectedModel,
      effectiveAnthropicRuntimeLimitContext,
      selectedProviderId,
      runtimeProviderStatusById.get(selectedProviderId)
    );
    return buildAuthoritativeModelChecks({
      leadProviderId: selectedProviderId,
      leadModel,
      leadModelIsDefault: !selectedModel.trim(),
      leadEffort: effectiveLeadEffort,
      leadBackendId: selectedProviderBackendId,
      leadBackendIsDefault: true,
      limitContext: effectiveAnthropicRuntimeLimitContext,
      providerStatusById: runtimeProviderStatusById,
      members: effectiveMemberDrafts,
      resolveMember: (member) =>
        resolveProviderScopedMemberModel({
          memberProviderId: normalizeOptionalTeamProviderId(member.providerId),
          memberModel: member.model,
          selectedProviderId,
          runtimeProviderStatusById,
          ...openCodeLocalModelScope,
        }),
    });
  }, [
    effectiveAnthropicRuntimeLimitContext,
    effectiveMemberDrafts,
    openCodeLocalModelScope,
    runtimeProviderStatusById,
    effectiveLeadEffort,
    selectedModel,
    selectedProviderId,
    selectedProviderBackendId,
  ]);
  const selectedModelChecksByProviderSignature = useMemo(
    () => buildProviderPrepareModelChecksSignature(selectedModelChecksByProvider),
    [selectedModelChecksByProvider]
  );
  const runtimeRosterRevision = selectedModelChecksByProvider.runtimeRosterRevision;
  const selectedRuntimeStatusSignature = useMemo(
    () =>
      buildProviderPrepareRuntimeStatusSignature(
        selectedMemberProviders,
        launchProofProviderStatusById,
        launchProofProviderLoadingById,
        launchProofProviderGenerationById
      ),
    [
      launchProofProviderGenerationById,
      launchProofProviderLoadingById,
      launchProofProviderStatusById,
      selectedMemberProviders,
    ]
  );
  const createPrepareRequestSignature = useMemo(
    () =>
      JSON.stringify({
        projectPath: effectiveCwd,
        teamName: dialogTeamNameKey,
        selectedProviderId,
        selectedProviderBackendId,
        selectedModel,
        runtimeRosterRevision,
        providers: selectedMemberProviders,
        members: effectiveMemberDrafts,
        modelChecks: selectedModelChecksByProviderSignature,
        runtimeStatus: selectedRuntimeStatusSignature,
        providerInvalidationEpochs: prepareProviderInvalidationEpochById,
        config: {
          limitContext: effectiveAnthropicRuntimeLimitContext,
          skipPermissions,
          selectedEffort: selectedEffortForCurrentSelection,
          selectedFastMode,
          syncModelsWithLead,
          soloTeam,
          worktreeEnabled,
          worktreeName,
          customArgs,
          allowExperimentalLocalModels: experimentalLocalModelOverrideEnabled,
        },
      }),
    [
      customArgs,
      experimentalLocalModelOverrideEnabled,
      dialogTeamNameKey,
      effectiveAnthropicRuntimeLimitContext,
      effectiveCwd,
      effectiveMemberDrafts,
      prepareProviderInvalidationEpochById,
      selectedEffortForCurrentSelection,
      selectedFastMode,
      selectedMemberProviders,
      selectedModel,
      selectedModelChecksByProviderSignature,
      runtimeRosterRevision,
      selectedProviderBackendId,
      selectedProviderId,
      selectedRuntimeStatusSignature,
      skipPermissions,
      soloTeam,
      syncModelsWithLead,
      worktreeEnabled,
      worktreeName,
    ]
  );
  useEffect(() => {
    setAllowExperimentalLocalModels(false);
  }, [effectiveCwd, selectedModelChecksByProviderSignature]);
  const shortLivedModelIssueReasons = useMemo(() => {
    void prepareChecks;
    void selectedModelChecksByProviderSignature;
    const modelAdvisoryReasonByProvider: Partial<Record<TeamProviderId, Record<string, string>>> =
      {};
    const modelIssueReasonByProvider: Partial<Record<TeamProviderId, Record<string, string>>> = {};
    const modelUnavailableReasonByProvider: Partial<
      Record<TeamProviderId, Record<string, string>>
    > = {};
    for (const providerId of selectedMemberProviders) {
      const backendSummary = runtimeBackendSummaryByProvider.get(providerId) ?? null;
      const providerRuntimeStatusSignature = buildProviderPrepareRuntimeStatusSignature(
        [providerId],
        launchProofProviderStatusById,
        undefined,
        launchProofProviderGenerationById
      );
      const providerModelChecksSignature = buildProviderPrepareModelChecksSignature(
        new Map([[providerId, selectedModelChecksByProvider.get(providerId) ?? []]])
      );
      const cacheKey = buildProviderPrepareModelCacheKey({
        cwd: effectiveCwd,
        providerId,
        backendSummary,
        limitContext: effectiveAnthropicRuntimeLimitContext,
        runtimeStatusSignature: providerRuntimeStatusSignature,
        modelChecksSignature: providerModelChecksSignature,
      });
      const issueReasons = getShortLivedProviderPrepareModelIssueReasons({
        providerId,
        cacheKey,
      });
      if (Object.keys(issueReasons.modelAdvisoryReasonByValue).length > 0) {
        modelAdvisoryReasonByProvider[providerId] = issueReasons.modelAdvisoryReasonByValue;
      }
      if (Object.keys(issueReasons.modelIssueReasonByValue).length > 0) {
        modelIssueReasonByProvider[providerId] = issueReasons.modelIssueReasonByValue;
      }
      if (Object.keys(issueReasons.modelUnavailableReasonByValue).length > 0) {
        modelUnavailableReasonByProvider[providerId] = issueReasons.modelUnavailableReasonByValue;
      }
    }
    return {
      modelAdvisoryReasonByProvider,
      modelIssueReasonByProvider,
      modelUnavailableReasonByProvider,
    };
  }, [
    effectiveAnthropicRuntimeLimitContext,
    effectiveCwd,
    launchProofProviderGenerationById,
    prepareChecks,
    runtimeBackendSummaryByProvider,
    launchProofProviderStatusById,
    selectedModelChecksByProvider,
    selectedModelChecksByProviderSignature,
    selectedMemberProviders,
  ]);
  useEffect(() => {
    if (multimodelEnabled) {
      return;
    }
    if (selectedProviderId !== 'anthropic') {
      setSelectedProviderIdRaw('anthropic');
      setSelectedModelRaw(getStoredTeamModel('anthropic'));
    }
    const nextMembers = members.map((member) => normalizeMemberDraftForProviderMode(member, false));
    const changed = nextMembers.some((member, index) => member !== members[index]);
    if (changed) {
      setMembers(nextMembers);
    }
  }, [members, multimodelEnabled, selectedProviderId, setMembers]);
  useEffect(() => {
    if (!open || cliStatus || cliStatusLoading) {
      return;
    }
    void refreshCliStatusForCurrentMode({
      multimodelEnabled,
      bootstrapCliStatus,
      fetchCliStatus,
    });
  }, [bootstrapCliStatus, cliStatus, cliStatusLoading, fetchCliStatus, multimodelEnabled, open]);
  const handleCodexReconnect = useCallback(
    (mode: 'browser' | 'device_code' = 'browser') => {
      void (async () => {
        await codexAccount.startChatgptLogin(mode);
      })();
    },
    [codexAccount]
  );
  useEffect(() => {
    if (!open || !canCreate || !launchTeam) {
      cancelScheduledProviderPrepareIdle(
        window as unknown as ProviderPrepareIdleScheduler,
        prepareIdleHandlesRef.current
      );
      prepareRequestSeqRef.current += 1;
      lastCreatePrepareRequestSignatureRef.current = null;
      authorityCandidate.clear();
      lastPrepareProviderSignatureByIdRef.current.clear();
      pendingPrepareProviderSignatureByIdRef.current.clear();
      prepareProviderRequestSeqByIdRef.current.clear();
      prepareWarningsByProviderIdRef.current.clear();
      return;
    }
    if (typeof api.teams.prepareProvisioning !== 'function') {
      cancelScheduledProviderPrepareIdle(
        window as unknown as ProviderPrepareIdleScheduler,
        prepareIdleHandlesRef.current
      );
      prepareRequestSeqRef.current += 1;
      lastCreatePrepareRequestSignatureRef.current = null;
      authorityCandidate.clear();
      lastPrepareProviderSignatureByIdRef.current.clear();
      pendingPrepareProviderSignatureByIdRef.current.clear();
      prepareProviderRequestSeqByIdRef.current.clear();
      prepareWarningsByProviderIdRef.current.clear();
      setPrepareState('failed');
      setPrepareWarnings([]);
      setPrepareChecks([]);
      setPrepareMessage(t('create.prepare.unsupportedPreload'));
      return;
    }
    if (!effectiveCwd) {
      cancelScheduledProviderPrepareIdle(
        window as unknown as ProviderPrepareIdleScheduler,
        prepareIdleHandlesRef.current
      );
      prepareRequestSeqRef.current += 1;
      lastCreatePrepareRequestSignatureRef.current = null;
      authorityCandidate.clear();
      lastPrepareProviderSignatureByIdRef.current.clear();
      pendingPrepareProviderSignatureByIdRef.current.clear();
      prepareProviderRequestSeqByIdRef.current.clear();
      prepareWarningsByProviderIdRef.current.clear();
      setPrepareState('idle');
      setPrepareWarnings([]);
      setPrepareChecks([]);
      setPrepareMessage(t('create.prepare.selectWorkingDirectory'));
      return;
    }

    const createRequestChanged =
      lastCreatePrepareRequestSignatureRef.current !== createPrepareRequestSignature;
    if (createRequestChanged) {
      lastCreatePrepareRequestSignatureRef.current = createPrepareRequestSignature;
      authorityCandidate.clear();
    }

    const selectedProviderIdSet = new Set(selectedMemberProviders);
    for (const providerId of Array.from(lastPrepareProviderSignatureByIdRef.current.keys())) {
      if (!selectedProviderIdSet.has(providerId)) {
        lastPrepareProviderSignatureByIdRef.current.delete(providerId);
        pendingPrepareProviderSignatureByIdRef.current.delete(providerId);
        prepareProviderRequestSeqByIdRef.current.delete(providerId);
        prepareWarningsByProviderIdRef.current.delete(providerId);
      }
    }

    const loadingProviderIds = selectedMemberProviders.filter((providerId) =>
      launchProofProviderLoadingById.get(providerId)
    );
    const readyProviderIds = selectedMemberProviders.filter(
      (providerId) => !launchProofProviderLoadingById.get(providerId)
    );
    const providerPlans = buildProviderPreparePlans({
      cwd: effectiveCwd,
      providerIds: readyProviderIds,
      selectedModelChecksByProvider,
      backendSummaryByProvider: runtimeBackendSummaryByProviderRef.current,
      limitContext: effectiveAnthropicRuntimeLimitContext,
      runtimeProviderStatusById: launchProofProviderStatusById,
      runtimeProviderGenerationById: launchProofProviderGenerationById,
      cachedModelResultsByCacheKey: prepareModelResultsCacheRef.current,
      allowExperimentalLocalModels: experimentalLocalModelOverrideEnabled,
    });
    const changedPlans = providerPlans.filter((plan) => {
      const lastSignature = lastPrepareProviderSignatureByIdRef.current.get(plan.providerId);
      const pendingSignature = pendingPrepareProviderSignatureByIdRef.current.get(plan.providerId);
      return lastSignature !== plan.requestSignature && pendingSignature !== plan.requestSignature;
    });
    const loadingMessage = getProvisioningProviderProgressMessage(
      [...loadingProviderIds, ...changedPlans.map((plan) => plan.providerId)],
      selectedMemberProviders.length,
      t
    );
    const getSelectedWarnings = (): string[] =>
      selectedMemberProviders.flatMap(
        (providerId) => prepareWarningsByProviderIdRef.current.get(providerId) ?? []
      );
    const failAuthoritativeCommit = (error: unknown): void => {
      setPrepareState('failed');
      setPrepareMessage(error instanceof Error ? error.message : t('create.prepare.failed'));
    };
    const commitChecks = (nextChecks: ProvisioningProviderCheck[]): void => {
      prepareChecksRef.current = nextChecks;
      setPrepareChecks(nextChecks);
    };
    const applyPrepareOutcome = (
      nextChecks: ProvisioningProviderCheck[],
      pendingMessage: string | null
    ): void => {
      const selectedWarnings = getSelectedWarnings();
      setPrepareWarnings(selectedWarnings);

      if (nextChecks.some((check) => check.status === 'pending' || check.status === 'checking')) {
        setPrepareState('loading');
        setPrepareMessage(pendingMessage);
        return;
      }

      const nextState = resolvePrepareState(nextChecks, selectedWarnings);
      const failureMessage =
        getPrimaryProvisioningFailureDetail(nextChecks) ??
        t('create.prepare.someProvidersNeedAttention');
      setPrepareState(nextState);
      setPrepareMessage(nextState === 'ready' ? t('create.prepare.ready') : failureMessage);
    };

    let checks = alignProvisioningChecks(prepareChecksRef.current, selectedMemberProviders);
    for (const providerId of loadingProviderIds) {
      checks = updateProviderCheck(checks, providerId, {
        status: 'checking',
        backendSummary: runtimeBackendSummaryByProviderRef.current.get(providerId) ?? null,
        details: [
          t('create.prepare.providerStatusLoading', {
            provider: getProviderLabel(providerId),
          }),
        ],
        supportDiagnostics: undefined,
      });
    }
    for (const plan of changedPlans) {
      checks = updateProviderCheck(checks, plan.providerId, {
        status: plan.selectedModelIds.length > 0 ? plan.cachedSnapshot.status : 'checking',
        backendSummary: plan.backendSummary,
        details: plan.cachedSnapshot.details,
        supportDiagnostics: undefined,
      });
      prepareWarningsByProviderIdRef.current.delete(plan.providerId);
    }
    commitChecks(checks);
    applyPrepareOutcome(
      checks,
      changedPlans.length > 0
        ? loadingMessage
        : (prepareMessageRef.current ??
            getProvisioningProviderProgressMessage([], selectedMemberProviders.length, t))
    );

    if (changedPlans.length === 0) {
      const finalChecks = prepareChecksRef.current;
      const allSelectedPlansCurrent =
        loadingProviderIds.length === 0 &&
        providerPlans.length === selectedMemberProviders.length &&
        providerPlans.every(
          (plan) =>
            lastPrepareProviderSignatureByIdRef.current.get(plan.providerId) ===
              plan.requestSignature &&
            !pendingPrepareProviderSignatureByIdRef.current.has(plan.providerId)
        );
      const allSelectedChecksReady =
        finalChecks.length === selectedMemberProviders.length &&
        isProvisioningPreparationAuthorizationCandidate(finalChecks, getSelectedWarnings());
      if (!allSelectedPlansCurrent || !allSelectedChecksReady) {
        authorityCandidate.clear();
        return;
      }
      const requestSignature = lastCreatePrepareRequestSignatureRef.current;
      const generation = prepareRequestSeqRef.current;
      if (requestSignature && runtimeRosterRevision) {
        authorityCandidate.publishOnce({
          requestSignature,
          generation,
          cwd: effectiveCwd,
          leadProviderId: selectedProviderId,
          providerIds: selectedMemberProviders,
          checksByProvider: selectedModelChecksByProvider,
          limitContext: effectiveAnthropicRuntimeLimitContext,
          allowExperimentalLocalModels: experimentalLocalModelOverrideEnabled,
          runtimeRosterRevision,
          prepareProvisioning: api.teams.prepareProvisioning,
          isCurrent: () =>
            prepareRequestSeqRef.current === generation &&
            lastCreatePrepareRequestSignatureRef.current === requestSignature,
          onFailure: failAuthoritativeCommit,
        });
      }
      return;
    }

    authorityCandidate.clear();
    for (const plan of changedPlans) {
      pendingPrepareProviderSignatureByIdRef.current.set(plan.providerId, plan.requestSignature);
    }

    const scheduledGeneration = prepareRequestSeqRef.current;
    const scheduledRequestSignature = JSON.stringify(
      changedPlans.map((plan) => [plan.providerId, plan.requestSignature])
    );
    const runScheduledPrepare = (): void => {
      const generation = scheduledGeneration;
      const runningPlans = changedPlans.flatMap((plan) => {
        if (
          pendingPrepareProviderSignatureByIdRef.current.get(plan.providerId) !==
          plan.requestSignature
        ) {
          return [];
        }
        pendingPrepareProviderSignatureByIdRef.current.delete(plan.providerId);
        const requestSeq = (prepareProviderRequestSeqByIdRef.current.get(plan.providerId) ?? 0) + 1;
        prepareProviderRequestSeqByIdRef.current.set(plan.providerId, requestSeq);
        lastPrepareProviderSignatureByIdRef.current.set(plan.providerId, plan.requestSignature);
        return [{ ...plan, requestSeq }];
      });
      if (runningPlans.length === 0) {
        return;
      }
      const isPlanCurrent = (plan: ProviderPreparePlan & { requestSeq: number }): boolean =>
        prepareRequestSeqRef.current === generation &&
        lastPrepareProviderSignatureByIdRef.current.get(plan.providerId) ===
          plan.requestSignature &&
        prepareProviderRequestSeqByIdRef.current.get(plan.providerId) === plan.requestSeq &&
        !pendingPrepareProviderSignatureByIdRef.current.has(plan.providerId);
      void (async () => {
        await Promise.all(
          runningPlans.map(async (plan) => {
            try {
              const prepResult = await runProviderPrepareDiagnostics({
                cwd: effectiveCwd,
                providerId: plan.providerId,
                selectedModelIds: plan.selectedModelIds,
                selectedModelChecks: plan.selectedModelChecks,
                prepareProvisioning: api.teams.prepareProvisioning,
                limitContext: effectiveAnthropicRuntimeLimitContext,
                cachedModelResultsById: plan.cachedModelResultsById,
                onModelProgress: ({ status, details }) => {
                  if (!isPlanCurrent(plan)) {
                    return;
                  }
                  const nextChecks = updateProviderCheck(
                    prepareChecksRef.current,
                    plan.providerId,
                    {
                      status,
                      backendSummary: plan.backendSummary,
                      details,
                      supportDiagnostics: undefined,
                    }
                  );
                  commitChecks(nextChecks);
                  applyPrepareOutcome(nextChecks, loadingMessage);
                },
              });
              if (!isPlanCurrent(plan)) {
                return;
              }
              prepareWarningsByProviderIdRef.current.set(
                plan.providerId,
                prepResult.warnings.map(
                  (warning) => `${getProviderLabel(plan.providerId)}: ${warning}`
                )
              );
              prepareModelResultsCacheRef.current.set(
                plan.cacheKey,
                mergeReusableProviderPrepareModelResults(
                  prepareModelResultsCacheRef.current.get(plan.cacheKey),
                  prepResult.modelResultsById
                )
              );
              storeShortLivedProviderPrepareModelResults({
                providerId: plan.providerId,
                cacheKey: plan.cacheKey,
                modelResultsById: prepResult.modelResultsById,
              });
              const nextChecks = updateProviderCheck(prepareChecksRef.current, plan.providerId, {
                status: prepResult.status,
                backendSummary: plan.backendSummary,
                details: prepResult.details,
                experimentalOverrideAvailable: prepResult.experimentalOverrideAvailable === true,
                supportDiagnostics: prepResult.supportDiagnostics,
              });
              commitChecks(nextChecks);
              applyPrepareOutcome(nextChecks, loadingMessage);
            } catch (error) {
              if (!isPlanCurrent(plan)) {
                return;
              }
              const failureMessage =
                error instanceof Error ? error.message : t('create.prepare.failed');
              const nextChecks = updateProviderCheck(prepareChecksRef.current, plan.providerId, {
                status: 'failed',
                backendSummary: plan.backendSummary,
                details: [failureMessage],
                supportDiagnostics: undefined,
              });
              prepareWarningsByProviderIdRef.current.delete(plan.providerId);
              commitChecks(nextChecks);
              applyPrepareOutcome(nextChecks, failureMessage);
            }
          })
        );
        if (
          runningPlans.every(isPlanCurrent) &&
          prepareRequestSeqRef.current === generation &&
          lastCreatePrepareRequestSignatureRef.current !== null
        ) {
          const finalChecks = prepareChecksRef.current;
          const allSelectedChecksReady =
            finalChecks.length === selectedMemberProviders.length &&
            isProvisioningPreparationAuthorizationCandidate(finalChecks, getSelectedWarnings());
          if (allSelectedChecksReady && runtimeRosterRevision) {
            await authorityCandidate.publish({
              requestSignature: lastCreatePrepareRequestSignatureRef.current,
              generation,
              cwd: effectiveCwd,
              leadProviderId: selectedProviderId,
              providerIds: selectedMemberProviders,
              checksByProvider: selectedModelChecksByProvider,
              limitContext: effectiveAnthropicRuntimeLimitContext,
              allowExperimentalLocalModels: experimentalLocalModelOverrideEnabled,
              runtimeRosterRevision,
              prepareProvisioning: api.teams.prepareProvisioning,
              isCurrent: () => runningPlans.every(isPlanCurrent),
              onFailure: failAuthoritativeCommit,
            });
          }
        }
      })();
    };
    scheduleGuardedProviderPrepareIdle({
      scheduler: window as unknown as ProviderPrepareIdleScheduler,
      handles: prepareIdleHandlesRef.current,
      generation: scheduledGeneration,
      requestSignature: scheduledRequestSignature,
      getCurrentGeneration: () => prepareRequestSeqRef.current,
      getCurrentRequestSignature: () =>
        JSON.stringify(
          changedPlans.map((plan) => [
            plan.providerId,
            pendingPrepareProviderSignatureByIdRef.current.get(plan.providerId) ??
              lastPrepareProviderSignatureByIdRef.current.get(plan.providerId),
          ])
        ),
      run: runScheduledPrepare,
    });
  }, [
    authorityCandidate,
    open,
    canCreate,
    createPrepareRequestSignature,
    launchTeam,
    effectiveCwd,
    effectiveMemberDrafts,
    effectiveAnthropicRuntimeLimitContext,
    experimentalLocalModelOverrideEnabled,
    prepareProviderInvalidationEpochById,
    launchProofProviderGenerationById,
    launchProofProviderStatusById,
    launchProofProviderLoadingById,
    selectedModel,
    runtimeRosterRevision,
    selectedModelChecksByProvider,
    selectedModelChecksByProviderSignature,
    selectedProviderId,
    selectedMemberProviders,
    t,
  ]);

  useEffect(() => {
    if (!open) {
      setWorkflowMentionSuggestionsEnabled(false);
      return;
    }

    setProjectsLoading(true);
    setProjectsError(null);

    let cancelled = false;
    void (async () => {
      try {
        const nextProjects = await loadProjectPathProjects({
          defaultProjectPath,
        });
        if (cancelled) {
          return;
        }

        setProjects(nextProjects);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setProjectsError(
          error instanceof Error ? error.message : t('create.errors.loadProjectsFailed')
        );
        setProjects([]);
      } finally {
        if (!cancelled) {
          setProjectsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, defaultProjectPath, t]);

  useEffect(() => {
    if (!open || !draftLoaded) {
      return;
    }

    if (initialData) {
      const nextSyncModelsWithLead = !initialData.members.some(
        (member) =>
          member.providerId ||
          member.providerBackendId ||
          member.model ||
          member.effort ||
          member.fastMode
      );
      const copiedProviderId =
        initialData.providerId == null
          ? selectedProviderId
          : normalizeLeadProviderForMode(initialData.providerId, multimodelEnabled);
      setTeamName(initialData.teamName);
      descriptionDraft.setValue(initialData.description ?? '');
      promptDraft.setValue(initialData.prompt ?? '');
      setTeamColor(initialData.color ?? '');
      if (Object.hasOwn(initialData, 'providerId')) {
        setSelectedProviderIdRaw(copiedProviderId);
      }
      if (Object.hasOwn(initialData, 'model')) {
        setSelectedModelRaw(normalizeExplicitTeamModelForUi(copiedProviderId, initialData.model));
      }
      if (Object.hasOwn(initialData, 'effort')) {
        setSelectedEffortRaw(initialData.effort ?? '');
      }
      if (Object.hasOwn(initialData, 'fastMode')) {
        setSelectedFastModeRaw(initialData.fastMode ?? 'inherit');
      }
      if (Object.hasOwn(initialData, 'limitContext')) {
        setLimitContextRaw(initialData.limitContext === true);
      }
      if (Object.hasOwn(initialData, 'skipPermissions')) {
        setSkipPermissionsRaw(initialData.skipPermissions !== false);
      }
      setMembers(
        initialData.members.map((m) => {
          const presetRoles: readonly string[] = PRESET_ROLES;
          const isPreset = m.role != null && presetRoles.includes(m.role);
          const isCustom = m.role != null && m.role.length > 0 && !isPreset;
          return normalizeMemberDraftForProviderMode(
            createMemberDraft({
              name: m.name,
              roleSelection: isCustom ? CUSTOM_ROLE : (m.role ?? ''),
              customRole: isCustom ? m.role : '',
              workflow: m.workflow,
              isolation: m.isolation === 'worktree' ? 'worktree' : undefined,
              providerId: normalizeOptionalTeamProviderId(m.providerId),
              providerBackendId: m.providerBackendId,
              model: m.model ?? '',
              effort: m.effort,
              fastMode: m.fastMode,
              mcpPolicy: m.mcpPolicy,
            }),
            multimodelEnabled
          );
        })
      );
      setTeammateWorktreeDefault(
        initialData.members.length > 0 &&
          initialData.members.every((member) => member.isolation === 'worktree')
      );
      setSyncModelsWithLead(nextSyncModelsWithLead, {
        persistStoredPreference: false,
      });
      return;
    }

    if (members.length > 0) {
      return;
    }

    const nextDefaultMembers = DEFAULT_MEMBERS.map((member) =>
      createMemberDraft({
        name: member.name,
        roleSelection: member.roleSelection,
        workflow:
          member.workflowKind === 'reviewer' ? t('create.defaultWorkflows.reviewer') : undefined,
      })
    );
    setMembers(
      syncModelsWithLead
        ? nextDefaultMembers
        : applyStoredCreateTeamMemberRuntimePreferences(nextDefaultMembers)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialData is checked once on open/draftLoaded
  }, [open, draftLoaded, t]);

  useEffect(() => {
    if (!open || !draftLoaded || initialData || syncModelsWithLead || members.length === 0) {
      return;
    }
    persistCurrentMemberRuntimePreferences(members);
  }, [
    draftLoaded,
    initialData,
    members,
    open,
    persistCurrentMemberRuntimePreferences,
    syncModelsWithLead,
  ]);

  useEffect(() => {
    if (!open || initialData || !draftLoaded) {
      return;
    }
    if (teamName.trim().length === 0) {
      setTeamName(suggestedTeamName);
    }
  }, [initialData, open, suggestedTeamName, draftLoaded]); // eslint-disable-line react-hooks/exhaustive-deps -- teamName read once

  useEffect(() => {
    if (!open || initialData) {
      return;
    }
    const resolvedTeamName = teamName.trim() || suggestedTeamName;
    const nextAutoDescription = buildDefaultTeamDescription(resolvedTeamName, t);
    const currentDescription = descriptionDraft.value.trim();
    const previousAutoDescription = lastAutoDescriptionRef.current?.trim() ?? '';
    const shouldSyncDescription =
      currentDescription.length === 0 || currentDescription === previousAutoDescription;

    if (shouldSyncDescription && descriptionDraft.value !== nextAutoDescription) {
      lastAutoDescriptionRef.current = nextAutoDescription;
      descriptionDraft.setValue(nextAutoDescription);
      return;
    }

    if (currentDescription === nextAutoDescription) {
      lastAutoDescriptionRef.current = nextAutoDescription;
    }
  }, [descriptionDraft, initialData, open, suggestedTeamName, t, teamName]);

  useEffect(() => {
    if (!open || !forceDefaultProjectSelection) {
      forcedDefaultProjectModePathRef.current = null;
      return;
    }
    if (!draftLoaded) {
      return;
    }
    if (!defaultProjectPath || isEphemeralProjectPath(defaultProjectPath)) {
      forcedDefaultProjectModePathRef.current = null;
      return;
    }

    const normalizedDefaultProjectPath = normalizePath(defaultProjectPath);
    if (forcedDefaultProjectModePathRef.current === normalizedDefaultProjectPath) {
      return;
    }

    forcedDefaultProjectModePathRef.current = normalizedDefaultProjectPath;
    if (cwdMode !== 'project') {
      setCwdMode('project');
    }
  }, [cwdMode, defaultProjectPath, draftLoaded, forceDefaultProjectSelection, open, setCwdMode]);

  useEffect(() => {
    if (!open) {
      appliedDefaultProjectPathRef.current = null;
      return;
    }
    if (!draftLoaded) {
      return;
    }
    if (cwdMode !== 'project') {
      return;
    }
    const selectableProjects = projects.filter(isSelectableProjectPathProject);
    if (selectableProjects.length === 0) {
      return;
    }
    if (defaultProjectPath && !isEphemeralProjectPath(defaultProjectPath)) {
      const normalizedDefaultProjectPath = normalizePath(defaultProjectPath);
      const defaultAlreadyApplied =
        appliedDefaultProjectPathRef.current === normalizedDefaultProjectPath;
      const match = selectableProjects.find(
        (p) => normalizePath(p.path) === normalizedDefaultProjectPath
      );
      if (match && !defaultAlreadyApplied) {
        appliedDefaultProjectPathRef.current = normalizedDefaultProjectPath;
        if (normalizePath(selectedProjectPath) !== normalizedDefaultProjectPath) {
          setSelectedProjectPath(match.path);
        }
        return;
      }
    }
    if (selectedProjectPath) {
      return;
    }
    if (defaultProjectPath && !isEphemeralProjectPath(defaultProjectPath)) {
      const normalizedDefaultProjectPath = normalizePath(defaultProjectPath);
      const match = selectableProjects.find(
        (p) => normalizePath(p.path) === normalizedDefaultProjectPath
      );
      if (match) {
        setSelectedProjectPath(match.path);
        return;
      }
    }
    setSelectedProjectPath(selectableProjects[0].path);
  }, [
    open,
    draftLoaded,
    cwdMode,
    projects,
    selectedProjectPath,
    defaultProjectPath,
    setSelectedProjectPath,
  ]);

  useEffect(() => {
    if (!open || cwdMode !== 'project' || !selectedProjectPath) {
      return;
    }
    if (
      !isEphemeralProjectPath(selectedProjectPath) &&
      !isDeletedProjectPathSelection(projects, selectedProjectPath)
    ) {
      return;
    }
    setSelectedProjectPath('');
  }, [open, cwdMode, projects, selectedProjectPath, setSelectedProjectPath]);

  const { suggestions: taskSuggestions } = useTaskSuggestions(null, {
    enabled: workflowMentionSuggestionsEnabled,
  });
  const { suggestions: teamMentionSuggestions } = useTeamSuggestions(null, {
    enabled: workflowMentionSuggestionsEnabled,
  });

  const description = descriptionDraft.value;
  const prompt = promptDraft.value;
  const memberColorMap = useMemo(() => buildMemberDraftColorMap(members), [members]);

  const mentionSuggestions = useMemo(
    () =>
      soloTeam
        ? [
            {
              id: 'team-lead',
              name: 'team-lead',
              subtitle: t('editTeam.teamLead.role'),
              color: resolveTeamLeadColorName(),
            },
          ]
        : buildMemberDraftSuggestions(members, memberColorMap),
    [memberColorMap, members, soloTeam, t]
  );

  const effectiveModel = useMemo(
    () =>
      computeEffectiveTeamModel(
        selectedModel,
        effectiveAnthropicRuntimeLimitContext,
        selectedProviderId,
        runtimeProviderStatusById.get(selectedProviderId)
      ),
    [
      effectiveAnthropicRuntimeLimitContext,
      runtimeProviderStatusById,
      selectedModel,
      selectedProviderId,
    ]
  );
  const teammateRuntimeCompatibility = useMemo(
    () =>
      analyzeTeammateRuntimeCompatibility({
        leadProviderId: selectedProviderId,
        leadProviderBackendId: selectedProviderBackendId,
        members: effectiveMemberDrafts,
        soloTeam: soloTeam || !canCreate,
        extraCliArgs: launchTeam ? customArgs : undefined,
        tmuxStatus: tmuxRuntime.status,
        tmuxStatusLoading: tmuxRuntime.loading,
        tmuxStatusError: tmuxRuntime.error,
      }),
    [
      customArgs,
      effectiveMemberDrafts,
      launchTeam,
      canCreate,
      selectedProviderBackendId,
      selectedProviderId,
      soloTeam,
      tmuxRuntime.error,
      tmuxRuntime.loading,
      tmuxRuntime.status,
    ]
  );
  const teammateRuntimeProviderNoticeById:
    | Partial<Record<TeamProviderId, React.ReactNode>>
    | undefined = teammateRuntimeCompatibility.providerNoticeProviderId
    ? {
        [teammateRuntimeCompatibility.providerNoticeProviderId]: (
          <TeammateRuntimeCompatibilityNotice
            analysis={teammateRuntimeCompatibility}
            onOpenDashboard={() => {
              submissionFence.invalidate();
              onClose();
              openDashboard();
            }}
          />
        ),
      }
    : undefined;
  const showRosterTeammateRuntimeCompatibility =
    teammateRuntimeCompatibility.visible && !teammateRuntimeCompatibility.providerNoticeProviderId;
  const anthropicRuntimeSelection = useMemo(
    () =>
      selectedProviderId === 'anthropic'
        ? resolveAnthropicRuntimeSelection({
            source: {
              modelCatalog: runtimeProviderStatusById.get('anthropic')?.modelCatalog,
              runtimeCapabilities: runtimeProviderStatusById.get('anthropic')?.runtimeCapabilities,
            },
            selectedModel,
            limitContext: effectiveAnthropicRuntimeLimitContext,
          })
        : null,
    [
      effectiveAnthropicRuntimeLimitContext,
      runtimeProviderStatusById,
      selectedModel,
      selectedProviderId,
    ]
  );
  const anthropicFastModeResolution = useMemo(
    () =>
      selectedProviderId === 'anthropic' && anthropicRuntimeSelection
        ? resolveAnthropicFastMode({
            selection: anthropicRuntimeSelection,
            selectedFastMode,
            providerFastModeDefault: anthropicProviderFastModeDefault,
          })
        : null,
    [
      anthropicProviderFastModeDefault,
      anthropicRuntimeSelection,
      selectedFastMode,
      selectedProviderId,
    ]
  );
  const codexRuntimeSelection = useMemo(
    () =>
      selectedProviderId === 'codex'
        ? resolveCodexRuntimeSelection({
            source: {
              providerStatus: runtimeProviderStatusById.get('codex'),
              providerBackendId: resolveUiOwnedProviderBackendId(
                'codex',
                runtimeProviderStatusById.get('codex')
              ),
            },
            selectedModel,
          })
        : null,
    [runtimeProviderStatusById, selectedModel, selectedProviderId]
  );
  const codexFastModeResolution = useMemo(
    () =>
      selectedProviderId === 'codex' && codexRuntimeSelection
        ? resolveCodexFastMode({
            selection: codexRuntimeSelection,
            selectedFastMode,
          })
        : null,
    [codexRuntimeSelection, selectedFastMode, selectedProviderId]
  );

  useEffect(() => {
    if (selectedProviderId !== 'anthropic' && selectedProviderId !== 'codex') {
      setAnthropicRuntimeNotice(null);
      return;
    }
    if (selectedProviderId === 'codex' && codexSnapshotPending) {
      setAnthropicRuntimeNotice(null);
      return;
    }

    const reconciliation =
      selectedProviderId === 'anthropic'
        ? reconcileAnthropicRuntimeSelections({
            selection:
              anthropicRuntimeSelection ??
              resolveAnthropicRuntimeSelection({
                source: {
                  modelCatalog: null,
                  runtimeCapabilities: null,
                },
                selectedModel,
                limitContext: effectiveAnthropicRuntimeLimitContext,
              }),
            selectedEffort: selectedEffortForCurrentSelection,
            selectedFastMode,
            providerFastModeDefault: anthropicProviderFastModeDefault,
            runtimeCapabilities: runtimeProviderStatusById.get('anthropic')?.runtimeCapabilities,
          })
        : {
            nextEffort: selectedEffortForCurrentSelection,
            effortResetReason: null,
            ...reconcileCodexRuntimeSelections({
              selection:
                codexRuntimeSelection ??
                resolveCodexRuntimeSelection({
                  source: {
                    providerStatus: runtimeProviderStatusById.get('codex'),
                    providerBackendId: resolveUiOwnedProviderBackendId(
                      'codex',
                      runtimeProviderStatusById.get('codex')
                    ),
                  },
                  selectedModel,
                }),
              selectedFastMode,
            }),
          };

    const notices: string[] = [];
    if (selectedEffortForCurrentSelection !== selectedEffort) {
      setSelectedEffortRaw(selectedEffortForCurrentSelection);
      setStoredCreateTeamEffort(selectedEffortForCurrentSelection);
    }
    if (reconciliation.nextEffort !== selectedEffortForCurrentSelection) {
      setSelectedEffortRaw(reconciliation.nextEffort);
      setStoredCreateTeamEffort(reconciliation.nextEffort);
      if (reconciliation.effortResetReason) {
        notices.push(reconciliation.effortResetReason);
      }
    }
    if (reconciliation.nextFastMode !== selectedFastMode) {
      setSelectedFastModeRaw(reconciliation.nextFastMode);
      setStoredCreateTeamFastMode(reconciliation.nextFastMode);
      if (reconciliation.fastModeResetReason) {
        notices.push(reconciliation.fastModeResetReason);
      }
    }
    setAnthropicRuntimeNotice(notices.length > 0 ? notices.join(' ') : null);
  }, [
    anthropicProviderFastModeDefault,
    anthropicRuntimeSelection,
    codexRuntimeSelection,
    codexSnapshotPending,
    effectiveAnthropicRuntimeLimitContext,
    runtimeProviderStatusById,
    selectedEffort,
    selectedEffortForCurrentSelection,
    selectedFastMode,
    selectedModel,
    selectedProviderId,
  ]);

  const sanitizedTeamName = sanitizeTeamName(teamName.trim());
  const teamNameInlineError = validateTeamNameInline(teamName, t);
  const isSubmittedTeamName = submittedTeamNameRef.current === sanitizedTeamName;
  const isNameTakenByExistingTeam =
    !isSubmittedTeamName && existingTeamNames.includes(sanitizedTeamName);
  const isNameProvisioning =
    !isSubmittedTeamName &&
    provisioningTeamNames.includes(sanitizedTeamName) &&
    !isNameTakenByExistingTeam;
  const request = useMemo<TeamCreateRequest>(
    () => ({
      teamName: sanitizedTeamName,
      description: description.trim() || undefined,
      color: teamColor || undefined,
      members: soloTeam
        ? []
        : (() => {
            const draftMembers = buildMembersFromDrafts(effectiveMemberDrafts, {
              inheritedProviderId: selectedProviderId,
            });
            return (
              materializeConcreteLaunchRoster({
                members: draftMembers,
                leadProviderId: selectedProviderId,
                leadModel: effectiveModel,
                leadEffort: effectiveLeadEffort,
                leadBackendId: selectedProviderBackendId,
                limitContext: effectiveAnthropicRuntimeLimitContext,
                providerStatusById: runtimeProviderStatusById,
              }) ?? draftMembers
            );
          })(),
      cwd: effectiveCwd,
      prompt: prompt.trim() || undefined,
      providerId: selectedProviderId,
      leadRuntimeSelectionProvenance: selectedModelChecksByProvider.leadRuntimeSelectionProvenance,
      providerBackendId:
        resolveConcreteProviderBackend({
          providerId: selectedProviderId,
          providerStatus: runtimeProviderStatusById.get(selectedProviderId),
          selectedBackendId: selectedProviderBackendId,
        }) ?? undefined,
      model: effectiveModel,
      effort: effectiveLeadEffort,
      fastMode:
        selectedProviderId === 'anthropic' || selectedProviderId === 'codex'
          ? selectedFastMode
          : undefined,
      limitContext: effectiveAnthropicRuntimeLimitContext,
      skipPermissions,
      allowExperimentalLocalModels: experimentalLocalModelOverrideEnabled || undefined,
      worktree: worktreeEnabled && worktreeName.trim() ? worktreeName.trim() : undefined,
      extraCliArgs: customArgs.trim() || undefined,
    }),
    [
      sanitizedTeamName,
      description,
      teamColor,
      soloTeam,
      effectiveMemberDrafts,
      runtimeProviderStatusById,
      effectiveCwd,
      prompt,
      selectedProviderId,
      selectedProviderBackendId,
      effectiveModel,
      selectedModelChecksByProvider.leadRuntimeSelectionProvenance,
      effectiveLeadEffort,
      selectedFastMode,
      effectiveAnthropicRuntimeLimitContext,
      skipPermissions,
      experimentalLocalModelOverrideEnabled,
      worktreeEnabled,
      worktreeName,
      customArgs,
    ]
  );
  const requestValidation = useMemo(
    () => validateRequest(request, t, { requireCwd: launchTeam }),
    [request, launchTeam, t]
  );
  const modelValidationError = useMemo(
    () =>
      getDialogTeamModelValidationError({
        selectedProviderId,
        selectedModel,
        members: effectiveMemberDrafts,
        validateMembers: true,
        runtimeProviderStatusById,
        runtimeProviderLoadingById,
        ...openCodeLocalModelScope,
      }),
    [
      effectiveMemberDrafts,
      openCodeLocalModelScope,
      runtimeProviderLoadingById,
      runtimeProviderStatusById,
      selectedModel,
      selectedProviderId,
    ]
  );
  const leadModelIssueText = useMemo(() => {
    const issue = getProvisioningModelIssue(
      prepareChecks,
      selectedProviderId,
      effectiveModel ?? selectedModel
    );
    return issue?.reason ?? issue?.detail ?? null;
  }, [effectiveModel, prepareChecks, selectedModel, selectedProviderId]);
  const memberModelIssueById = useMemo(() => {
    const next: Record<string, string> = {};
    for (const member of effectiveMemberDrafts) {
      if (member.removedAt) {
        continue;
      }
      if (syncModelsWithLead && leadModelIssueText) {
        next[member.id] = leadModelIssueText;
        continue;
      }
      const providerId = normalizeOptionalTeamProviderId(member.providerId) ?? selectedProviderId;
      const issue = getProvisioningModelIssue(prepareChecks, providerId, member.model);
      const issueText = issue?.reason ?? issue?.detail ?? null;
      if (issueText) {
        next[member.id] = issueText;
      }
    }
    return next;
  }, [
    effectiveMemberDrafts,
    leadModelIssueText,
    prepareChecks,
    selectedProviderId,
    syncModelsWithLead,
  ]);
  const hasCreateFormErrors =
    !!teamNameInlineError ||
    isNameTakenByExistingTeam ||
    isNameProvisioning ||
    !requestValidation.valid ||
    !!modelValidationError ||
    teammateRuntimeCompatibility.blocksSubmission ||
    worktreeGitBlocksSubmission;

  const internalArgs = useMemo(() => {
    const args: string[] = [];
    args.push('--input-format', 'stream-json', '--output-format', 'stream-json');
    args.push('--verbose', '--setting-sources', 'user,project,local');
    args.push('--mcp-config', '<auto>', '--disallowedTools', APP_TEAM_RUNTIME_DISALLOWED_TOOLS);
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    if (effectiveModel) args.push('--model', effectiveModel);
    const effectiveEffort =
      selectedProviderId === 'anthropic'
        ? selectedEffortForCurrentSelection || anthropicRuntimeSelection?.defaultEffort || ''
        : selectedEffortForCurrentSelection;
    if (effectiveEffort) args.push('--effort', effectiveEffort);
    if (selectedProviderId === 'anthropic') {
      const fastSettings = anthropicFastModeResolution?.resolvedFastMode
        ? { fastMode: true, fastModePerSessionOptIn: false }
        : { fastMode: false };
      args.push('--settings', JSON.stringify(fastSettings));
    } else if (selectedProviderId === 'codex') {
      args.push(...buildCodexFastModeArgs(codexFastModeResolution?.resolvedFastMode));
    }
    return args;
  }, [
    anthropicFastModeResolution?.resolvedFastMode,
    anthropicRuntimeSelection?.defaultEffort,
    codexFastModeResolution?.resolvedFastMode,
    effectiveModel,
    selectedEffortForCurrentSelection,
    selectedProviderId,
    skipPermissions,
  ]);

  const launchOptionalSummary = useMemo(() => {
    const summary: string[] = [];
    if (prompt.trim()) summary.push(t('create.optional.summary.leadPrompt'));
    if (skipPermissions) summary.push(t('create.optional.summary.autoApproveTools'));
    if (selectedProviderId === 'anthropic' || selectedProviderId === 'codex') {
      if (selectedFastMode === 'on') summary.push(t('create.optional.summary.fastMode'));
      else if (selectedFastMode === 'off') summary.push(t('create.optional.summary.fastDisabled'));
      else if (selectedProviderId === 'anthropic' && anthropicProviderFastModeDefault) {
        summary.push(t('create.optional.summary.fastDefault'));
      }
    }
    if (effectiveAnthropicRuntimeLimitContext) {
      summary.push(t('create.optional.summary.anthropicLimitedContext'));
    }
    if (worktreeEnabled && worktreeName.trim()) {
      summary.push(t('create.optional.summary.worktree', { name: worktreeName.trim() }));
    }
    if (customArgs.trim()) summary.push(t('create.optional.summary.customCliArgs'));
    return summary;
  }, [
    anthropicProviderFastModeDefault,
    customArgs,
    effectiveAnthropicRuntimeLimitContext,
    prompt,
    selectedFastMode,
    selectedProviderId,
    skipPermissions,
    t,
    worktreeEnabled,
    worktreeName,
  ]);

  const teamDetailsSummary = useMemo(() => {
    const summary: string[] = [];
    if (description.trim()) summary.push(t('create.optional.summary.description'));
    if (teamColor) summary.push(t('create.optional.summary.color', { color: teamColor }));
    return summary;
  }, [description, t, teamColor]);

  const handleSyncModelsWithLeadChange = useCreateTeamModelSync({
    members,
    persistCurrentMemberRuntimePreferences,
    setMembers,
    setSyncModelsWithLead,
  });

  const activeError =
    localError ?? modelValidationError ?? provisioningErrorsByTeam[request.teamName] ?? null;
  const effectivePrepare = useMemo(
    () =>
      deriveEffectiveProvisioningPrepareState({
        state: prepareState,
        message: prepareMessage,
        warnings: prepareWarnings,
        checks: prepareChecks,
        t,
      }),
    [prepareChecks, prepareMessage, prepareState, prepareWarnings, t]
  );
  const showCodexReconnectPrompt = shouldShowCodexReconnectPrompt({
    effectiveCliStatus,
    selectedProviderIds: selectedMemberProviders,
    prepareMessage: effectivePrepare.message,
    prepareChecks,
  });
  const canOpenExistingTeam =
    activeError?.includes('Team already exists') === true && request.teamName.length > 0;
  const [createLaunchAuthorization, createLaunchAuthorizationRef] =
    useMemoizedCommittedLaunchAuthorization({
      prepareState: resolveLaunchPrepareState(
        prepareState,
        prepareChecks,
        prepareWarnings,
        experimentalLocalModelOverrideEnabled
      ),
      providerStatusesAuthoritative: areProviderLaunchStatusesAuthoritative(
        selectedMemberProviders,
        launchProofProviderStatusById,
        launchProofProviderLoadingById,
        selectedModelChecksByProvider
      ),
      providerProofExpiresAtMs: launchProofExpiresAtMs,
      executionProof: authorizedPreparation?.executionProof ?? null,
      preparedRequestSignature: authorizedPreparation?.requestSignature ?? null,
      currentRequestSignature: createPrepareRequestSignature,
      preparedGeneration: authorizedPreparation?.generation ?? null,
      currentGeneration: prepareRequestSeqRef.current,
    });
  const prepareBlocksCreate =
    launchTeam && !isCreateTeamLaunchAuthorized(createLaunchAuthorization);

  const organizationPlacementOrganizations = organizationStructure?.organizations ?? [];
  const activePlacementOrganization =
    organizationPlacementOrganizations.find(
      (organization) => organization.id === organizationPlacementOrganizationId
    ) ??
    organizationPlacementOrganizations[0] ??
    null;
  const organizationPlacementParentOptions = useMemo(
    () =>
      getOrganizationPlacementUnitOptions(
        organizationStructure,
        activePlacementOrganization?.id ?? ''
      ),
    [activePlacementOrganization?.id, organizationStructure]
  );
  const activePlacementParent =
    organizationPlacementParentOptions.find(
      (option) => option.unit.id === organizationPlacementParentId
    )?.unit ??
    organizationPlacementParentOptions[0]?.unit ??
    null;
  const selectedOrganizationPlacement = useMemo<OrganizationPlacementSelection | null>(() => {
    if (!organizationPlacementEnabled || !activePlacementOrganization || !activePlacementParent) {
      return null;
    }
    return {
      organizationId: activePlacementOrganization.id,
      parentUnitId: activePlacementParent.id,
    };
  }, [activePlacementOrganization, activePlacementParent, organizationPlacementEnabled]);
  const organizationPlacementSummary = selectedOrganizationPlacement
    ? [
        activePlacementOrganization?.name ?? selectedOrganizationPlacement.organizationId,
        activePlacementParent ? getOrganizationUnitLabel(activePlacementParent) : '',
      ].filter(Boolean)
    : [];

  const conflictingTeam = useMemo(() => {
    if (!launchTeam) return null;
    if (!activeTeams?.length || !effectiveCwd) return null;
    const norm = normalizePath(effectiveCwd);
    return activeTeams.find((t) => normalizePath(t.projectPath) === norm) ?? null;
  }, [activeTeams, effectiveCwd, launchTeam]);

  useEffect(() => {
    setConflictDismissed(false);
  }, [conflictingTeam?.teamName, effectiveCwd]);

  const handleSubmit = (): void => {
    if (allTakenTeamNames.includes(sanitizedTeamName)) {
      const msg = isNameProvisioning
        ? t('create.validation.teamLaunching')
        : t('create.validation.teamNameExists');
      setFieldErrors({ teamName: msg });
      setLocalError(msg);
      return;
    }
    const validation = validateRequest(request, t, { requireCwd: launchTeam });
    if (!validation.valid) {
      const errors = validation.errors ?? {};
      setFieldErrors(errors);
      const messages = Object.values(errors).filter(Boolean);
      setLocalError(messages.join(' · ') || t('create.validation.checkFormFields'));
      return;
    }
    if (modelValidationError) {
      setLocalError(modelValidationError);
      return;
    }
    if (prepareBlocksCreate) {
      setLocalError(effectivePrepare.message ?? t('launch.prepare.failed'));
      return;
    }
    if (teammateRuntimeCompatibility.blocksSubmission) {
      setLocalError(teammateRuntimeCompatibility.message);
      return;
    }
    if (worktreeGitBlockingMessage) {
      setLocalError(worktreeGitBlockingMessage);
      return;
    }
    setFieldErrors({});
    setLocalError(null);
    submittedTeamNameRef.current = request.teamName;
    setIsSubmitting(true);
    const submissionGeneration = submissionFence.begin(),
      isActiveSubmission = (): boolean => submissionFence.isCurrent(submissionGeneration);

    if (!launchTeam) {
      void (async () => {
        try {
          if (!syncModelsWithLead) {
            persistCurrentMemberRuntimePreferences(members);
          }
          await api.teams.createConfig(createTeamDraftPayload(request, effectiveCwd));
          if (!isActiveSubmission()) return;
          if (selectedOrganizationPlacement) {
            try {
              await api.organizations.assignTeamToUnit({
                ...selectedOrganizationPlacement,
                teamName: request.teamName,
                label: request.displayName || request.teamName,
              });
              if (!isActiveSubmission()) return;
            } catch (error) {
              if (!isActiveSubmission()) return;
              console.warn('[Organizations] Failed to place created team in organization', error);
            }
          }
          if (!isActiveSubmission()) return;
          onOpenTeam(request.teamName, effectiveCwd || undefined);
          resetFormState();
          if (!isActiveSubmission()) return;
          submissionFence.invalidate();
          onClose();
        } catch (error) {
          if (!isActiveSubmission()) return;
          setLocalError(
            error instanceof Error ? error.message : t('create.errors.createConfigFailed')
          );
        } finally {
          if (isActiveSubmission()) {
            submittedTeamNameRef.current = null;
            setIsSubmitting(false);
          }
        }
      })();
      return;
    }

    void (async () => {
      try {
        if (!syncModelsWithLead) {
          persistCurrentMemberRuntimePreferences(members);
        }
        const submitted = await executeAuthorizedProvisioningLaunch(
          createLaunchAuthorizationRef.current,
          (executionProof) =>
            onCreate({ ...request, executionProof }, selectedOrganizationPlacement ?? undefined)
        );
        if (!isActiveSubmission()) return;
        if (!submitted) {
          setLocalError(effectivePrepare.message ?? t('launch.prepare.failed'));
          return;
        }
        if (!isActiveSubmission()) return;
        onOpenTeam(request.teamName, effectiveCwd || undefined);
        resetFormState();
        if (!isActiveSubmission()) return;
        submissionFence.invalidate();
        onClose();
      } catch (error) {
        if (!isActiveSubmission()) return;
        if (error instanceof Error) {
          setLocalError(error.message);
        }
      } finally {
        if (isActiveSubmission()) {
          submittedTeamNameRef.current = null;
          setIsSubmitting(false);
        }
      }
    })();
  };

  const handleTeamNameChange = (value: string): void => {
    setTeamName(value);
    setFieldErrors((prev) => {
      if (!prev.teamName) return prev;
      const next = clearCreateTeamNameFieldError(prev);
      setLocalError(next.localError);
      return next.errors;
    });
  };

  const rosterHeaderTop = useMemo(
    () => (
      <CreateTeamRosterHeaderTop
        checked={soloTeam}
        label={t('create.solo.label')}
        onCheckedChange={setSoloTeam}
      />
    ),
    [setSoloTeam, soloTeam, t]
  );

  const rosterHeaderBottom = useMemo(
    () =>
      showRosterTeammateRuntimeCompatibility ||
      soloTeam ||
      (canCreate && hasSelectedWorktreeIsolation) ? (
        <div className="space-y-2">
          {showRosterTeammateRuntimeCompatibility ? (
            <TeammateRuntimeCompatibilityNotice
              analysis={teammateRuntimeCompatibility}
              onOpenDashboard={() => {
                submissionFence.invalidate();
                onClose();
                openDashboard();
              }}
            />
          ) : null}
          {soloTeam ? (
            <div className="flex items-start gap-2 rounded-md border border-sky-500/20 bg-sky-500/5 px-3 py-2">
              <Info className="mt-0.5 size-3.5 shrink-0 text-sky-400" />
              <p className="text-[11px] leading-relaxed text-sky-300">
                {t('create.solo.description')}
              </p>
            </div>
          ) : null}
          {canCreate && hasSelectedWorktreeIsolation ? (
            <WorktreeGitReadinessBanner state={worktreeGitReadiness} />
          ) : null}
        </div>
      ) : null,
    [
      canCreate,
      hasSelectedWorktreeIsolation,
      onClose,
      openDashboard,
      showRosterTeammateRuntimeCompatibility,
      soloTeam,
      submissionFence,
      teammateRuntimeCompatibility,
      t,
      worktreeGitReadiness,
    ]
  );
  const createActionLabel = isSubmitting
    ? t('create.actions.creating')
    : launchTeam && (effectivePrepare.state === 'idle' || effectivePrepare.state === 'loading')
      ? t('create.actions.skipPreflightAndCreate')
      : t('create.actions.create');
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          submissionFence.invalidate();
          resetUIState();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-[52rem]">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {initialData ? t('create.title.copy') : t('create.title.create')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {initialData ? t('create.description.copy') : t('create.description.create')}
          </DialogDescription>
        </DialogHeader>

        {conflictingTeam && !conflictDismissed ? (
          <div
            className="rounded-md border p-3 text-xs"
            style={{
              backgroundColor: 'var(--warning-bg)',
              borderColor: 'var(--warning-border)',
              color: 'var(--warning-text)',
            }}
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="font-medium">
                  {t('create.conflict.title', {
                    team: conflictingTeam.displayName,
                  })}
                </p>
                <p className="opacity-80">{t('create.conflict.description')}</p>
                <p className="text-[11px] opacity-70">
                  {t('create.conflict.workingDirectory')}{' '}
                  <span className="font-mono">{effectiveCwd}</span>
                </p>
              </div>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 opacity-60 transition-colors hover:opacity-100"
                onClick={() => setConflictDismissed(true)}
              >
                <X className="size-3.5" />
              </button>
            </div>
          </div>
        ) : null}

        {!canCreate ? (
          <p
            className="rounded border p-2 text-xs"
            style={{
              backgroundColor: 'var(--warning-bg)',
              borderColor: 'var(--warning-border)',
              color: 'var(--warning-text)',
            }}
          >
            {t('create.localOnly')}
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="team-name">{t('create.fields.teamName')}</Label>
            <Input
              id="team-name"
              className={cn(
                'h-8 text-xs',
                (fieldErrors.teamName || teamNameInlineError || isNameTakenByExistingTeam) &&
                  'border-[var(--field-error-border)] bg-[var(--field-error-bg)] focus-visible:ring-[var(--field-error-border)]'
              )}
              value={teamName}
              onChange={(event) => handleTeamNameChange(event.target.value)}
              placeholder={suggestedTeamName}
            />
            {isNameTakenByExistingTeam ? (
              <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
                {t('create.errors.nameExists')}
              </p>
            ) : teamNameInlineError ? (
              <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
                {teamNameInlineError}
              </p>
            ) : isNameProvisioning ? (
              <p className="text-[11px]" style={{ color: 'var(--warning-text)' }}>
                {t('create.errors.nameLaunching')}
              </p>
            ) : fieldErrors.teamName ? (
              <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
                {fieldErrors.teamName}
              </p>
            ) : null}
            {sanitizedTeamName && sanitizedTeamName !== teamName.trim() ? (
              <p className="text-[11px] text-[var(--color-text-muted)]">
                {t('create.onDisk')} <span className="font-mono">{sanitizedTeamName}</span>
              </p>
            ) : null}
          </div>

          <div className="md:col-span-2">
            <TeamRosterEditorSection
              members={members}
              onMembersChange={setMembers}
              fieldError={fieldErrors.members}
              validateMemberName={validateMemberNameInline}
              showWorkflow
              showJsonEditor
              draftKeyPrefix="createTeam"
              projectPath={effectiveCwd || null}
              taskSuggestions={taskSuggestions}
              teamSuggestions={teamMentionSuggestions}
              onWorkflowSuggestionsNeeded={enableWorkflowMentionSuggestions}
              defaultProviderId={selectedProviderId}
              inheritedProviderId={selectedProviderId}
              inheritedModel={selectedModel}
              inheritedEffort={(selectedEffortForCurrentSelection as EffortLevel) || undefined}
              inheritModelSettingsByDefault
              lockProviderModel={syncModelsWithLead}
              forceInheritedModelSettings={syncModelsWithLead}
              modelLockReason={t('create.memberModelLockReason')}
              hideMembersContent={soloTeam}
              providerId={selectedProviderId}
              model={selectedModel}
              effort={(selectedEffortForCurrentSelection as EffortLevel) || undefined}
              limitContext={effectiveAnthropicRuntimeLimitContext}
              runtimeProviderStatusById={runtimeProviderStatusById}
              providerReadyById={providerReadyById}
              leadProviderNoticeById={teammateRuntimeProviderNoticeById}
              onProviderChange={setSelectedProviderId}
              onModelChange={setSelectedModel}
              onEffortChange={setSelectedEffort}
              onLimitContextChange={setLimitContext}
              syncModelsWithTeammates={syncModelsWithLead}
              onSyncModelsWithTeammatesChange={handleSyncModelsWithLeadChange}
              showWorktreeIsolationControls={!soloTeam}
              teammateWorktreeDefault={teammateWorktreeDefault}
              worktreeIsolationDisabledReason={worktreeIsolationDisabledReason}
              onTeammateWorktreeDefaultChange={setTeammateWorktreeDefault}
              disableGeminiOption={isGeminiUiFrozen()}
              leadModelIssueText={leadModelIssueText}
              memberWarningById={teammateRuntimeCompatibility.memberWarningById}
              memberModelIssueById={memberModelIssueById}
              modelAdvisoryReasonByProvider={
                shortLivedModelIssueReasons.modelAdvisoryReasonByProvider
              }
              modelIssueReasonByProvider={shortLivedModelIssueReasons.modelIssueReasonByProvider}
              modelUnavailableReasonByProvider={
                shortLivedModelIssueReasons.modelUnavailableReasonByProvider
              }
              headerTop={rosterHeaderTop}
              headerBottom={rosterHeaderBottom}
            />
          </div>

          <div
            className="rounded-lg border border-[var(--color-border-emphasis)] p-4 shadow-sm md:col-span-2"
            style={{
              backgroundColor: isLight
                ? 'color-mix(in srgb, var(--color-surface-overlay) 24%, white 76%)'
                : 'var(--color-surface-overlay)',
            }}
          >
            <div className="flex items-start gap-3">
              <Checkbox
                id="launch-team"
                className="mt-1 shrink-0"
                checked={launchTeam}
                onCheckedChange={(checked) => setLaunchTeam(checked === true)}
              />
              <div className="space-y-1">
                <Label htmlFor="launch-team" className="cursor-pointer text-sm font-semibold">
                  {t('create.launchAfterCreate.label')}
                </Label>
                <p
                  className="text-xs"
                  style={{
                    color: isLight
                      ? 'color-mix(in srgb, var(--color-text-muted) 54%, var(--color-text) 46%)'
                      : 'var(--color-text-muted)',
                  }}
                >
                  {t('create.launchAfterCreate.description')}
                </p>
              </div>
            </div>

            {launchTeam ? (
              <div className="mt-4 space-y-4">
                <ProjectPathSelector
                  cwdMode={cwdMode}
                  onCwdModeChange={setCwdMode}
                  selectedProjectPath={selectedProjectPath}
                  onSelectedProjectPathChange={setSelectedProjectPath}
                  customCwd={customCwd}
                  onCustomCwdChange={setCustomCwd}
                  projects={projects}
                  projectsLoading={projectsLoading}
                  projectsError={projectsError}
                  fieldError={fieldErrors.cwd}
                />

                <OptionalSettingsSection
                  title={t('create.optional.launchSettingsTitle')}
                  description={t('create.optional.launchSettingsDescription')}
                  summary={launchOptionalSummary}
                  onOpenChange={(isOpen) => {
                    if (isOpen) {
                      enableWorkflowMentionSuggestions();
                    }
                  }}
                >
                  <div className="space-y-4">
                    {selectedProviderId === 'anthropic' ? (
                      <div className="space-y-2">
                        <AnthropicFastModeSelector
                          value={selectedFastMode}
                          onValueChange={setSelectedFastMode}
                          providerFastModeDefault={anthropicProviderFastModeDefault}
                          model={selectedModel}
                          limitContext={effectiveAnthropicRuntimeLimitContext}
                          id="create-fast-mode"
                        />
                        {anthropicRuntimeNotice ? (
                          <div className="bg-amber-500/8 flex items-start gap-2 rounded-md border border-amber-500/25 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
                            <Info className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
                            <p>{anthropicRuntimeNotice}</p>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {selectedProviderId === 'codex' ? (
                      <div className="space-y-2">
                        <CodexFastModeSelector
                          value={selectedFastMode}
                          onValueChange={setSelectedFastMode}
                          model={selectedModel}
                          providerBackendId={
                            resolveUiOwnedProviderBackendId(
                              'codex',
                              runtimeProviderStatusById.get('codex')
                            ) ?? undefined
                          }
                          id="create-fast-mode"
                        />
                        {anthropicRuntimeNotice ? (
                          <div className="bg-amber-500/8 flex items-start gap-2 rounded-md border border-amber-500/25 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
                            <Info className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
                            <p>{anthropicRuntimeNotice}</p>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="space-y-1.5">
                      <Label htmlFor="team-prompt" className="label-optional">
                        {t('create.fields.prompt')}
                      </Label>
                      <MentionableTextarea
                        id="team-prompt"
                        className="text-xs"
                        minRows={3}
                        maxRows={12}
                        value={prompt}
                        onValueChange={promptDraft.setValue}
                        suggestions={soloTeam ? [] : mentionSuggestions}
                        teamSuggestions={teamMentionSuggestions}
                        taskSuggestions={taskSuggestions}
                        projectPath={effectiveCwd || null}
                        chips={promptChipDraft.chips}
                        onChipRemove={promptChipDraft.removeChip}
                        onFileChipInsert={promptChipDraft.addChip}
                        placeholder={t('create.placeholders.prompt')}
                        footerRight={
                          promptDraft.isSaved ? (
                            <span className="text-[10px] text-[var(--color-text-muted)]">
                              {t('create.saved')}
                            </span>
                          ) : null
                        }
                      />
                    </div>

                    <SkipPermissionsCheckbox
                      id="create-skip-permissions"
                      checked={skipPermissions}
                      onCheckedChange={setSkipPermissions}
                    />

                    <AdvancedCliSection
                      teamName={advancedKey}
                      internalArgs={internalArgs}
                      worktreeEnabled={worktreeEnabled}
                      onWorktreeEnabledChange={setWorktreeEnabled}
                      worktreeName={worktreeName}
                      onWorktreeNameChange={setWorktreeName}
                      customArgs={customArgs}
                      onCustomArgsChange={setCustomArgs}
                    />
                  </div>
                </OptionalSettingsSection>
              </div>
            ) : null}
          </div>

          <div className="md:col-span-2">
            <OptionalSettingsSection
              title={t('create.organizationPlacement.title')}
              description={t('create.organizationPlacement.description')}
              summary={organizationPlacementSummary}
            >
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="organization-placement-enabled"
                    className="mt-1 shrink-0"
                    checked={organizationPlacementEnabled}
                    disabled={
                      organizationStructureLoading ||
                      organizationPlacementOrganizations.length === 0
                    }
                    onCheckedChange={(checked) => setOrganizationPlacementEnabled(checked === true)}
                  />
                  <div className="min-w-0 space-y-1">
                    <Label
                      htmlFor="organization-placement-enabled"
                      className="cursor-pointer text-sm font-semibold"
                    >
                      {t('create.organizationPlacement.addToOrganization')}
                    </Label>
                    {organizationPlacementError ? (
                      <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
                        {organizationPlacementError}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <div className="space-y-0.5">
                      <Label className="text-xs">
                        {t('create.organizationPlacement.organizationLabel')}
                      </Label>
                      <p className="text-[11px] text-[var(--color-text-muted)]">
                        {t('create.organizationPlacement.organizationHelp')}
                      </p>
                    </div>
                    <Select
                      value={activePlacementOrganization?.id ?? ''}
                      disabled={
                        !organizationPlacementEnabled ||
                        organizationPlacementOrganizations.length === 0
                      }
                      onValueChange={(value) => {
                        setOrganizationPlacementOrganizationId(value);
                        const organization = organizationPlacementOrganizations.find(
                          (candidate) => candidate.id === value
                        );
                        setOrganizationPlacementParentId(organization?.rootNodeId ?? '');
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue
                          placeholder={t('create.organizationPlacement.organizationPlaceholder')}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {organizationPlacementOrganizations.map((organization) => (
                          <SelectItem key={organization.id} value={organization.id}>
                            {organization.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <div className="space-y-0.5">
                      <Label className="text-xs">
                        {t('create.organizationPlacement.groupOrRootLabel')}
                      </Label>
                      <p className="text-[11px] text-[var(--color-text-muted)]">
                        {t('create.organizationPlacement.groupOrRootHelp')}
                      </p>
                    </div>
                    <Select
                      value={activePlacementParent?.id ?? ''}
                      disabled={
                        !organizationPlacementEnabled ||
                        organizationPlacementParentOptions.length === 0
                      }
                      onValueChange={setOrganizationPlacementParentId}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue
                          placeholder={t('create.organizationPlacement.groupOrRootPlaceholder')}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {organizationPlacementParentOptions.map((option) => (
                          <SelectItem key={option.unit.id} value={option.unit.id}>
                            <span
                              className="flex min-w-0 items-center gap-2"
                              style={{
                                paddingLeft: `${Math.min(option.depth, 6) * 12}px`,
                              }}
                            >
                              <span className="truncate">
                                {getOrganizationUnitLabel(option.unit)}
                              </span>
                              <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                                {t(getOrganizationPlacementUnitKindKey(option.unit))}
                              </span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </OptionalSettingsSection>
          </div>

          <div className="md:col-span-2">
            <OptionalSettingsSection
              title={t('create.optional.teamDetailsTitle')}
              description={t('create.optional.teamDetailsDescription')}
              summary={teamDetailsSummary}
            >
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="team-description" className="label-optional">
                    {t('create.fields.description')}
                  </Label>
                  <AutoResizeTextarea
                    id="team-description"
                    className="text-xs"
                    minRows={2}
                    maxRows={8}
                    value={description}
                    onChange={(event) => descriptionDraft.setValue(event.target.value)}
                    placeholder={t('create.placeholders.description')}
                  />
                  {descriptionDraft.isSaved ? (
                    <span className="text-[10px] text-[var(--color-text-muted)]">
                      {t('create.saved')}
                    </span>
                  ) : null}
                </div>

                <div className="space-y-1.5">
                  <Label className="label-optional">{t('create.fields.color')}</Label>
                  <div className="flex flex-wrap gap-2">
                    {TEAM_COLOR_NAMES.map((colorName) => {
                      const colorSet = getTeamColorSet(colorName);
                      const isSelected = teamColor === colorName;
                      return (
                        <button
                          key={colorName}
                          type="button"
                          className={cn(
                            'flex size-7 items-center justify-center rounded-full border-2 transition-all',
                            isSelected ? 'scale-110' : 'opacity-70 hover:opacity-100'
                          )}
                          style={{
                            backgroundColor: getThemedBadge(colorSet, isLight),
                            borderColor: isSelected ? colorSet.border : 'transparent',
                          }}
                          title={colorName}
                          onClick={() => setTeamColor(isSelected ? '' : colorName)}
                        >
                          <span
                            className="size-3.5 rounded-full"
                            style={{ backgroundColor: colorSet.border }}
                          />
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </OptionalSettingsSection>
          </div>
        </div>
        {activeError ? (
          <p
            className="rounded border p-2 text-xs"
            style={{
              color: 'var(--field-error-text)',
              borderColor: 'var(--field-error-border)',
              backgroundColor: 'var(--field-error-bg)',
            }}
          >
            {activeError}
          </p>
        ) : null}
        <DialogFooter className="-mx-6 -mb-6 -mt-4 border-t border-[var(--color-border)] bg-[var(--color-surface-sidebar)] px-6 pb-5 pt-4 sm:justify-between">
          <div className="min-w-0">
            {canCreate && launchTeam ? (
              <ProviderActivityStatusStrip
                cliStatus={effectiveCliStatus}
                sourceCliStatus={loadingCliStatus}
                cliStatusLoading={cliStatusLoading}
                cliProviderStatusLoading={cliProviderStatusLoading}
                multimodelEnabled={multimodelEnabled}
                codexSnapshotPending={codexSnapshotPending}
                providerIds={selectedMemberProviders}
                className="mb-2"
                label={t('create.prepare.selectedProvidersLabel')}
                layout="stacked"
                showReadyProviders={
                  effectivePrepare.state === 'idle' || effectivePrepare.state === 'loading'
                }
                readyStatusText={t('create.prepare.readyStatus')}
              />
            ) : null}
            {canCreate &&
            launchTeam &&
            (effectivePrepare.state === 'idle' || effectivePrepare.state === 'loading') ? (
              <>
                <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                  <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  <div>
                    <span>
                      {effectivePrepare.message ??
                        (effectivePrepare.state === 'idle'
                          ? t('create.prepare.checkingProviders')
                          : t('create.prepare.preparingEnvironment'))}
                    </span>
                    <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)] opacity-70">
                      {t('launch.prepare.preflight', {
                        action: t('launch.prepare.action.launch'),
                      })}
                    </p>
                  </div>
                </div>
                <ProvisioningProviderStatusList
                  checks={prepareChecks}
                  className="mt-2"
                  onOpenProviderSettings={(providerId) => setProviderSettingsProviderId(providerId)}
                />
              </>
            ) : null}
            {canCreate && launchTeam && effectivePrepare.state === 'ready' ? (
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                  <CheckCircle2 className="size-3.5 shrink-0" />
                  <span>
                    {prepareChecks.some((check) => check.status === 'notes') ||
                    prepareWarnings.length > 0
                      ? t('create.prepare.selectedProvidersReadyWithNotes')
                      : t('create.prepare.selectedProvidersReady')}
                  </span>
                </div>
                {effectivePrepare.message ? (
                  <p className="mt-0.5 pl-5 text-[11px] text-[var(--color-text-muted)]">
                    {effectivePrepare.message}
                  </p>
                ) : null}
                <ProvisioningProviderStatusList
                  checks={prepareChecks}
                  className="mt-1"
                  onOpenProviderSettings={(providerId) => setProviderSettingsProviderId(providerId)}
                />
                {prepareWarnings.length > 0 && prepareChecks.length === 0 ? (
                  <div className="mt-0.5 space-y-0.5 pl-5">
                    {prepareWarnings.map((warning, index) => (
                      <p key={`${index}:${warning}`} className="text-[11px] text-sky-300">
                        {warning}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {canCreate && launchTeam && effectivePrepare.state === 'failed' ? (
              <div className="text-xs">
                <div className="flex items-start gap-2 text-red-300">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium">
                      {t('launch.prepare.blocked', {
                        action: t('launch.prepare.action.launch'),
                      })}
                    </p>
                    <p className="mt-0.5 text-red-300/80">
                      {effectivePrepare.message ?? t('launch.prepare.failed')}
                    </p>
                    <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)] opacity-70">
                      {t('launch.prepare.preflight', {
                        action: t('launch.prepare.action.launch'),
                      })}
                    </p>
                  </div>
                </div>
                {!shouldHideProvisioningProviderStatusList(prepareChecks, prepareMessage) ? (
                  <ProvisioningProviderStatusList
                    checks={prepareChecks}
                    className="mt-2"
                    suppressDetailsMatching={prepareMessage}
                    onOpenProviderSettings={(providerId) =>
                      setProviderSettingsProviderId(providerId)
                    }
                  />
                ) : null}
                {prepareWarnings.length > 0 && prepareChecks.length === 0 ? (
                  <div className="mt-1 space-y-0.5 pl-6">
                    {prepareWarnings.map((warning, index) => (
                      <p
                        key={`${index}:${warning}`}
                        className="text-[11px]"
                        style={{ color: 'var(--warning-text)' }}
                      >
                        {warning}
                      </p>
                    ))}
                  </div>
                ) : null}
                <p className="mt-1 pl-6 text-[11px] text-[var(--color-text-muted)]">
                  {getProvisioningFailureHint(effectivePrepare.message, prepareChecks, t)}
                </p>
                {experimentalLocalModelOverrideAvailable ? (
                  <ExperimentalLocalModelOverrideCheckbox
                    id="create-experimental-local-model"
                    checked={allowExperimentalLocalModels}
                    onCheckedChange={setAllowExperimentalLocalModels}
                    label={t('launch.prepare.experimentalLocalModelOverride')}
                    hint={t('launch.prepare.experimentalLocalModelOverrideHint')}
                  />
                ) : null}
                {showCodexReconnectPrompt ? (
                  <div className="pl-6">
                    <CodexReconnectPrompt
                      authUrl={codexAccount.snapshot?.login.authUrl ?? null}
                      userCode={codexAccount.snapshot?.login.userCode ?? null}
                      reconnectBusy={codexAccount.loading}
                      onReconnect={() => handleCodexReconnect('browser')}
                      onDeviceCodeReconnect={() => handleCodexReconnect('device_code')}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <WorkspaceTrustLaunchNotice status={workspaceTrustStatus} />
            <div className="flex items-center gap-2">
              {canOpenExistingTeam ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    submissionFence.invalidate();
                    onOpenTeam(request.teamName);
                    onClose();
                  }}
                >
                  {t('create.actions.openExisting')}
                </Button>
              ) : null}
              <Button
                size="lg"
                className="min-w-32 text-sm"
                disabled={
                  !canCreate ||
                  !draftLoaded ||
                  isSubmitting ||
                  hasCreateFormErrors ||
                  prepareBlocksCreate
                }
                onClick={handleSubmit}
              >
                {isSubmitting ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                {createActionLabel}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
      <ProvisioningProviderRuntimeSettingsDialog
        openProviderId={providerSettingsProviderId}
        onOpenProviderIdChange={(providerId) => setProviderSettingsProviderId(providerId)}
        providers={effectiveCliStatus?.providers ?? []}
        projectPath={effectiveCwd || null}
        disabled={isSubmitting}
        onProviderRuntimeChanged={invalidatePrepareProvider}
      />
    </Dialog>
  );
};
