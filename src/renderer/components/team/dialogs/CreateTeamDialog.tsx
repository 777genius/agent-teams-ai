import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  reconcileAnthropicRuntimeSelections,
  resolveAnthropicFastMode,
  resolveAnthropicRuntimeSelection,
} from '@features/anthropic-runtime-profile/renderer';
import {
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
import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useChipDraftPersistence } from '@renderer/hooks/useChipDraftPersistence';
import { useCreateTeamDraft } from '@renderer/hooks/useCreateTeamDraft';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useTaskSuggestions } from '@renderer/hooks/useTaskSuggestions';
import { useTeamSuggestions } from '@renderer/hooks/useTeamSuggestions';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import {
  applyStoredCreateTeamMemberRuntimePreferences,
  getStoredCreateTeamEffort,
  getStoredCreateTeamFastMode as getStoredTeamFastMode,
  getStoredCreateTeamLimitContext,
  getStoredCreateTeamMemberRuntimePreferences,
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
  getTeamModelSelectionError,
  isTeamProviderRuntimeStatusLoading,
  normalizeExplicitTeamModelForUi,
} from '@renderer/utils/teamModelAvailability';
import { getTeamProviderLabel as getCatalogTeamProviderLabel } from '@renderer/utils/teamModelCatalog';
import { isEphemeralProjectPath } from '@shared/utils/ephemeralProjectPath';
import { DEFAULT_PROVIDER_MODEL_SELECTION } from '@shared/utils/providerModelSelection';
import { resolveTeamLeadColorName } from '@shared/utils/teamMemberColors';
import { isTeamProviderId, normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { AdvancedCliSection } from './AdvancedCliSection';
import { AnthropicFastModeSelector } from './AnthropicFastModeSelector';
import { CodexFastModeSelector } from './CodexFastModeSelector';
import { CodexReconnectPrompt, shouldShowCodexReconnectPrompt } from './CodexReconnectPrompt';
import {
  clearInheritedMemberModelsUnavailableForProvider,
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
import { getProvisioningModelIssue } from './provisioningModelIssues';
import { ProvisioningProviderRuntimeSettingsDialog } from './ProvisioningProviderRuntimeSettingsDialog';
import {
  deriveEffectiveProvisioningPrepareState,
  getPrimaryProvisioningFailureDetail,
  getProvisioningFailureHint,
  getProvisioningProviderBackendSummary,
  getProvisioningProviderProgressMessage,
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
import {
  getWorktreeGitBlockingMessage,
  getWorktreeGitControlDisabledReason,
  useWorktreeGitReadiness,
  WorktreeGitReadinessBanner,
} from './WorktreeGitReadinessBanner';

import type { MemberDraft } from '@renderer/components/team/members/MembersEditorSection';
import type {
  CliProviderId,
  EffortLevel,
  TeamCreateRequest,
  TeamFastMode,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
} from '@shared/types';

const TEAM_COLOR_NAMES = [
  'blue',
  'green',
  'red',
  'yellow',
  'purple',
  'cyan',
  'orange',
  'pink',
] as const;

const APP_TEAM_RUNTIME_DISALLOWED_TOOLS = 'TeamDelete,TodoWrite,TaskCreate,TaskUpdate';

function getProviderLabel(providerId: TeamProviderId): string {
  return getCatalogTeamProviderLabel(providerId) ?? 'Anthropic';
}

function alignProvisioningChecks(
  existingChecks: ProvisioningProviderCheck[],
  providerIds: TeamProviderId[]
): ProvisioningProviderCheck[] {
  const existingByProviderId = new Map(
    existingChecks.map((check) => [check.providerId, check] as const)
  );
  return providerIds.map(
    (providerId) =>
      existingByProviderId.get(providerId) ?? {
        providerId,
        status: 'pending',
        backendSummary: null,
        details: [],
      }
  );
}

export interface TeamCopyData extends Pick<
  TeamCreateRequest,
  | 'description'
  | 'color'
  | 'prompt'
  | 'providerId'
  | 'model'
  | 'effort'
  | 'fastMode'
  | 'limitContext'
  | 'skipPermissions'
  | 'members'
> {
  teamName: string;
  cwd?: string;
}

export interface ActiveTeamRef {
  teamName: string;
  displayName: string;
  projectPath: string;
}

interface CreateTeamDialogProps {
  open: boolean;
  canCreate: boolean;
  provisioningErrorsByTeam: Record<string, string | null>;
  clearProvisioningError?: (teamName?: string) => void;
  existingTeamNames: string[];
  /** Team names currently in active provisioning (launching) — used to prevent name conflicts. */
  provisioningTeamNames?: string[];
  activeTeams?: ActiveTeamRef[];
  initialData?: TeamCopyData;
  defaultProjectPath?: string | null;
  onClose: () => void;
  onCreate: (request: TeamCreateRequest) => Promise<void>;
  onOpenTeam: (teamName: string, projectPath?: string) => void;
}

interface ValidationResult {
  valid: boolean;
  errors?: {
    teamName?: string;
    members?: string;
    cwd?: string;
  };
}

import { CUSTOM_ROLE, PRESET_ROLES } from '@renderer/constants/teamRoles';

const DEFAULT_MEMBERS: { name: string; roleSelection: string; workflow?: string }[] = [
  {
    name: 'alice',
    roleSelection: 'reviewer',
    workflow:
      'Review every completed task in the project. Read the code changes, check for correctness, style, and potential issues. Approve the task or request changes with clear feedback.',
  },
  {
    name: 'tom',
    roleSelection: 'developer',
  },
  { name: 'bob', roleSelection: 'developer' },
  { name: 'jack', roleSelection: 'developer' },
];

/** Mirrors Claude CLI's `zuA()` sanitization: non-alphanumeric → `-`, then lowercase. */
function sanitizeTeamName(name: string): string {
  let result = name
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-{2,}/g, '-')
    .toLowerCase();
  // Trim leading/trailing dashes without backtracking-vulnerable regex
  while (result.startsWith('-')) result = result.slice(1);
  while (result.endsWith('-')) result = result.slice(0, -1);
  return result;
}

function validateTeamNameInline(
  name: string,
  t: ReturnType<typeof useAppTranslation>['t']
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const sanitized = sanitizeTeamName(trimmed);
  if (!sanitized) {
    return t('create.validation.nameMustContainLetterOrDigit');
  }
  if (sanitized.length > 128) {
    return t('create.validation.nameTooLong');
  }
  return null;
}

function buildDefaultTeamDescription(teamName: string): string {
  const trimmedName = teamName.trim();
  return trimmedName.length > 0
    ? `${trimmedName} team for provisioning flow`
    : 'Team for provisioning flow';
}

function validateRequest(
  request: TeamCreateRequest,
  t: ReturnType<typeof useAppTranslation>['t'],
  options?: { requireCwd?: boolean }
): ValidationResult {
  const requireCwd = options?.requireCwd ?? true;
  const sanitized = sanitizeTeamName(request.teamName);
  if (!sanitized) {
    return {
      valid: false,
      errors: {
        teamName: t('create.validation.nameMustContainLetterOrDigit'),
      },
    };
  }
  if (sanitized.length > 128) {
    return {
      valid: false,
      errors: {
        teamName: t('create.validation.nameTooLong'),
      },
    };
  }
  if (requireCwd && !request.cwd.trim()) {
    return {
      valid: false,
      errors: {
        cwd: t('create.validation.selectWorkingDirectory'),
      },
    };
  }
  if (request.members.some((member) => !member.name.trim())) {
    return {
      valid: false,
      errors: {
        members: t('create.validation.memberNameRequired'),
      },
    };
  }
  if (request.members.some((member) => validateMemberNameInline(member.name.trim()) !== null)) {
    return {
      valid: false,
      errors: {
        members: t('create.validation.memberNameInvalid'),
      },
    };
  }
  const uniqueNames = new Set(request.members.map((member) => member.name.trim().toLowerCase()));
  if (uniqueNames.size !== request.members.length) {
    return {
      valid: false,
      errors: {
        members: t('create.validation.memberNamesUnique'),
      },
    };
  }
  return { valid: true };
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

interface ScheduledIdleHandle {
  kind: 'idle' | 'timeout';
  id: number;
}

function scheduleIdle(cb: () => void): ScheduledIdleHandle {
  const idleWindow = window as IdleWindow;
  if (typeof idleWindow.requestIdleCallback === 'function') {
    return { kind: 'idle', id: idleWindow.requestIdleCallback(cb, { timeout: 2000 }) };
  }
  return { kind: 'timeout', id: window.setTimeout(cb, 0) };
}

function cancelScheduledIdle(handle: ScheduledIdleHandle | null): void {
  if (!handle) return;
  if (handle.kind === 'idle') {
    const idleWindow = window as IdleWindow;
    if (typeof idleWindow.cancelIdleCallback === 'function') {
      idleWindow.cancelIdleCallback(handle.id);
    }
    return;
  }
  window.clearTimeout(handle.id);
}

function cancelScheduledIdleSet(handles: Set<ScheduledIdleHandle>): void {
  for (const handle of handles) {
    cancelScheduledIdle(handle);
  }
  handles.clear();
}

function isCurrentPrepareGeneration(ref: { current: number }, generation: number): boolean {
  return ref.current === generation;
}

export const CreateTeamDialog = ({
  open,
  canCreate,
  provisioningErrorsByTeam,
  clearProvisioningError,
  existingTeamNames,
  provisioningTeamNames = [],
  activeTeams,
  initialData,
  defaultProjectPath,
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
    codexAccount.loading &&
    Boolean(loadingCliStatus?.providers.some((provider) => provider.providerId === 'codex')) &&
    !codexAccount.snapshot;

  // ── Persisted draft state (survives tab navigation) ──────────────────
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

  const descriptionDraft = useDraftPersistence({ key: 'createTeam:description' });
  const promptDraft = useDraftPersistence({ key: 'createTeam:prompt' });
  const promptChipDraft = useChipDraftPersistence('createTeam:prompt:chips');

  // ── Transient UI state (NOT persisted) ───────────────────────────────
  const [projects, setProjects] = useState<ProjectPathProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [prepareState, setPrepareState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [prepareMessage, setPrepareMessage] = useState<string | null>(null);
  const [prepareWarnings, setPrepareWarnings] = useState<string[]>([]);
  const [prepareChecks, setPrepareChecks] = useState<ProvisioningProviderCheck[]>([]);
  const [prepareProviderInvalidationEpochById, setPrepareProviderInvalidationEpochById] = useState<
    Partial<Record<TeamProviderId, number>>
  >({});
  const [providerSettingsProviderId, setProviderSettingsProviderId] =
    useState<TeamProviderId | null>(null);
  const [workflowMentionSuggestionsEnabled, setWorkflowMentionSuggestionsEnabled] = useState(false);
  const prepareRequestSeqRef = useRef(0);
  const prepareIdleHandlesRef = useRef(new Set<ScheduledIdleHandle>());
  const prepareUnmountGenerationRef = useRef(0);
  const appliedDefaultProjectPathRef = useRef<string | null>(null);
  const lastAutoDescriptionRef = useRef<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    teamName?: string;
    members?: string;
    cwd?: string;
  }>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
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

  // Advanced CLI section state (use teamName-derived key for localStorage)
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

  // Re-read localStorage when advancedKey changes
  useEffect(() => {
    const storedEnabled =
      localStorage.getItem(`team:lastWorktreeEnabled:${advancedKey}`) === 'true';
    const storedName = localStorage.getItem(`team:lastWorktreeName:${advancedKey}`) ?? '';
    setWorktreeEnabledRaw(storedEnabled && Boolean(storedName));
    setWorktreeNameRaw(storedName);
    setCustomArgsRaw(localStorage.getItem(`team:lastCustomArgs:${advancedKey}`) ?? '');
  }, [advancedKey]);

  const setSelectedModel = useCallback(
    (value: string): void => {
      const normalizedValue = normalizeExplicitTeamModelForUi(selectedProviderId, value);
      setSelectedModelRaw(normalizedValue);
      setStoredCreateTeamModel(selectedProviderId, normalizedValue);
    },
    [selectedProviderId]
  );

  const setSelectedProviderId = useCallback(
    (value: TeamProviderId): void => {
      const normalizedValue = normalizeLeadProviderForMode(value, multimodelEnabled);
      setSelectedProviderIdRaw(normalizedValue);
      setStoredCreateTeamProvider(normalizedValue);
      setSelectedModelRaw(getStoredTeamModel(normalizedValue));
    },
    [multimodelEnabled]
  );

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
    setLocalError(null);
    setFieldErrors({});
    setIsSubmitting(false);
    setPrepareState('idle');
    setPrepareMessage(null);
    setPrepareWarnings([]);
    setPrepareChecks([]);
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
  const dialogTeamNameKey = sanitizeTeamName(teamName.trim());
  /** All taken names: existing teams + teams currently being provisioned. */
  const allTakenTeamNames = useMemo(
    () => [...new Set([...existingTeamNames, ...provisioningTeamNames])],
    [existingTeamNames, provisioningTeamNames]
  );
  const suggestedTeamName = useMemo(
    () => getNextSuggestedTeamName(allTakenTeamNames),
    [allTakenTeamNames]
  );

  // Clear stale provisioning error when dialog opens
  useEffect(() => {
    if (open && dialogTeamNameKey) {
      clearProvisioningError?.(dialogTeamNameKey);
    }
  }, [open, clearProvisioningError, dialogTeamNameKey]);

  const effectiveMemberDrafts = useMemo(
    () => (syncModelsWithLead ? members.map(clearMemberModelOverrides) : members),
    [members, syncModelsWithLead]
  );
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
  const hasSelectedAnthropicRuntime = selectedMemberProviders.includes('anthropic');
  const effectiveAnthropicRuntimeLimitContext = hasSelectedAnthropicRuntime ? limitContext : false;

  const runtimeBackendSummaryByProvider = useMemo(() => {
    const entries: (readonly [TeamProviderId, string | null])[] = (
      effectiveCliStatus?.providers ?? []
    ).map(
      (provider) =>
        [
          provider.providerId as TeamProviderId,
          getProvisioningProviderBackendSummary(provider),
        ] as const
    );
    return new Map<TeamProviderId, string | null>(entries);
  }, [effectiveCliStatus?.providers]);
  const runtimeProviderStatusById = useMemo(
    () =>
      new Map(
        (effectiveCliStatus?.providers ?? []).map(
          (provider) => [provider.providerId, provider] as const
        )
      ),
    [effectiveCliStatus?.providers]
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
              ),
            ] as const
        )
      ),
    [
      cliProviderStatusLoading,
      codexSnapshotPending,
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
    });
    if (sanitized.changed) {
      setMembers(sanitized.members);
    }
  }, [members, runtimeProviderStatusById, selectedProviderId, setMembers]);

  useEffect(() => {
    prepareChecksRef.current = prepareChecks;
  }, [prepareChecks]);

  useEffect(() => {
    prepareMessageRef.current = prepareMessage;
  }, [prepareMessage]);

  const invalidatePrepareProvider = useCallback((providerId: CliProviderId): void => {
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
    setPrepareProviderInvalidationEpochById((current) => ({
      ...current,
      [providerId]: (current[providerId] ?? 0) + 1,
    }));
  }, []);

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
      // React StrictMode replays effect cleanup/setup in development; defer
      // invalidation so the replay does not cancel the live prepare request.
      queueMicrotask(() => {
        if (!isCurrentPrepareGeneration(prepareUnmountGenerationRef, generation)) {
          return;
        }
        cancelScheduledIdleSet(idleHandles);
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

  const selectedModelChecksByProvider = useMemo(() => {
    const modelsByProvider = new Map<TeamProviderId, TeamProvisioningModelCheckRequest[]>();
    const leadEffort = (selectedEffortForCurrentSelection as EffortLevel | '') || undefined;
    const addModel = (
      providerId: TeamProviderId,
      model: string | undefined,
      effort?: EffortLevel
    ): void => {
      const trimmed = model?.trim() ?? '';
      if (!trimmed) {
        return;
      }
      const existing = modelsByProvider.get(providerId) ?? [];
      if (!existing.some((entry) => entry.model === trimmed && entry.effort === effort)) {
        modelsByProvider.set(providerId, [
          ...existing,
          {
            providerId,
            model: trimmed,
            ...(effort ? { effort } : {}),
          },
        ]);
      }
    };
    const addDefaultSelection = (providerId: TeamProviderId, effort?: EffortLevel): void => {
      if (
        providerId === 'codex' ||
        providerId === 'gemini' ||
        (providerId === 'anthropic' && selectedProviderId === 'anthropic')
      ) {
        addModel(providerId, DEFAULT_PROVIDER_MODEL_SELECTION, effort);
      }
    };

    const leadModel = computeEffectiveTeamModel(
      selectedModel,
      effectiveAnthropicRuntimeLimitContext,
      selectedProviderId
    );
    if (selectedModel.trim()) {
      addModel(selectedProviderId, leadModel, leadEffort);
    } else {
      addDefaultSelection(selectedProviderId, leadEffort);
    }
    for (const member of effectiveMemberDrafts) {
      if (member.removedAt) {
        continue;
      }
      const memberProviderId = normalizeOptionalTeamProviderId(member.providerId);
      const inheritsDefaultRuntime = !memberProviderId || memberProviderId === selectedProviderId;
      const explicitMemberModel = member.model?.trim() ?? '';
      const memberEffort =
        member.effort ?? (inheritsDefaultRuntime && !explicitMemberModel ? leadEffort : undefined);
      const scopedModel = resolveProviderScopedMemberModel({
        memberProviderId: member.providerId,
        memberModel: member.model,
        selectedProviderId,
        runtimeProviderStatusById,
      });
      if (scopedModel.model) {
        addModel(scopedModel.providerId, scopedModel.model, memberEffort);
      } else {
        addDefaultSelection(scopedModel.providerId, memberEffort);
      }
    }

    return modelsByProvider;
  }, [
    effectiveAnthropicRuntimeLimitContext,
    effectiveMemberDrafts,
    runtimeProviderStatusById,
    selectedEffortForCurrentSelection,
    selectedModel,
    selectedProviderId,
  ]);
  const selectedModelChecksByProviderSignature = useMemo(
    () => buildProviderPrepareModelChecksSignature(selectedModelChecksByProvider),
    [selectedModelChecksByProvider]
  );
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
        runtimeProviderStatusById
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
    prepareChecks,
    runtimeBackendSummaryByProvider,
    runtimeProviderStatusById,
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
      cancelScheduledIdleSet(prepareIdleHandlesRef.current);
      prepareRequestSeqRef.current += 1;
      lastPrepareProviderSignatureByIdRef.current.clear();
      pendingPrepareProviderSignatureByIdRef.current.clear();
      prepareProviderRequestSeqByIdRef.current.clear();
      prepareWarningsByProviderIdRef.current.clear();
      return;
    }

    if (typeof api.teams.prepareProvisioning !== 'function') {
      cancelScheduledIdleSet(prepareIdleHandlesRef.current);
      prepareRequestSeqRef.current += 1;
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
      cancelScheduledIdleSet(prepareIdleHandlesRef.current);
      prepareRequestSeqRef.current += 1;
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
      runtimeProviderLoadingById.get(providerId)
    );
    const readyProviderIds = selectedMemberProviders.filter(
      (providerId) => !runtimeProviderLoadingById.get(providerId)
    );
    const providerPlans = buildProviderPreparePlans({
      cwd: effectiveCwd,
      providerIds: readyProviderIds,
      selectedModelChecksByProvider,
      backendSummaryByProvider: runtimeBackendSummaryByProviderRef.current,
      limitContext: effectiveAnthropicRuntimeLimitContext,
      runtimeProviderStatusById,
      cachedModelResultsByCacheKey: prepareModelResultsCacheRef.current,
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

      const anyFailure = nextChecks.some((check) => check.status === 'failed');
      const anyNotes =
        selectedWarnings.length > 0 || nextChecks.some((check) => check.status === 'notes');
      const failureMessage =
        getPrimaryProvisioningFailureDetail(nextChecks) ??
        t('create.prepare.someProvidersNeedAttention');
      setPrepareState(anyFailure ? 'failed' : 'ready');
      setPrepareMessage(
        anyFailure
          ? failureMessage
          : anyNotes
            ? t('create.prepare.readyWithNotes')
            : t('create.prepare.ready')
      );
    };

    let checks = alignProvisioningChecks(prepareChecksRef.current, selectedMemberProviders);
    for (const providerId of loadingProviderIds) {
      lastPrepareProviderSignatureByIdRef.current.delete(providerId);
      pendingPrepareProviderSignatureByIdRef.current.delete(providerId);
      prepareProviderRequestSeqByIdRef.current.delete(providerId);
      prepareWarningsByProviderIdRef.current.delete(providerId);
      checks = updateProviderCheck(checks, providerId, {
        status: 'checking',
        backendSummary: runtimeBackendSummaryByProviderRef.current.get(providerId) ?? null,
        details: [
          `${getProviderLabel(providerId)} provider status is still loading. Model checks will start automatically.`,
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
      return;
    }

    for (const plan of changedPlans) {
      pendingPrepareProviderSignatureByIdRef.current.set(plan.providerId, plan.requestSignature);
    }

    const idleHandle = scheduleIdle(() => {
      prepareIdleHandlesRef.current.delete(idleHandle);
      const generation = prepareRequestSeqRef.current;
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
      })();
    });
    prepareIdleHandlesRef.current.add(idleHandle);
  }, [
    open,
    canCreate,
    launchTeam,
    effectiveCwd,
    effectiveMemberDrafts,
    effectiveAnthropicRuntimeLimitContext,
    prepareProviderInvalidationEpochById,
    runtimeProviderStatusById,
    runtimeProviderLoadingById,
    selectedModel,
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
        const nextProjects = await loadProjectPathProjects({ defaultProjectPath });
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
      setSyncModelsWithLead(nextSyncModelsWithLead, { persistStoredPreference: false });
      return;
    }

    if (members.length > 0) {
      return;
    }

    const nextDefaultMembers = DEFAULT_MEMBERS.map((member) =>
      createMemberDraft({
        name: member.name,
        roleSelection: member.roleSelection,
        workflow: member.workflow,
      })
    );
    setMembers(
      syncModelsWithLead
        ? nextDefaultMembers
        : applyStoredCreateTeamMemberRuntimePreferences(nextDefaultMembers)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialData is checked once on open/draftLoaded
  }, [open, draftLoaded]);

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
    const nextAutoDescription = buildDefaultTeamDescription(resolvedTeamName);
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
  }, [descriptionDraft, initialData, open, suggestedTeamName, teamName]);

  // Pre-select defaultProjectPath when projects loaded (only while dialog is open)
  useEffect(() => {
    if (!open) {
      appliedDefaultProjectPathRef.current = null;
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
  }, [open, cwdMode, projects, selectedProjectPath, defaultProjectPath, setSelectedProjectPath]);

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
              subtitle: 'Team Lead',
              color: resolveTeamLeadColorName(),
            },
          ]
        : buildMemberDraftSuggestions(members, memberColorMap),
    [memberColorMap, members, soloTeam]
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
  const isNameTakenByExistingTeam = existingTeamNames.includes(sanitizedTeamName);
  const isNameProvisioning =
    provisioningTeamNames.includes(sanitizedTeamName) && !isNameTakenByExistingTeam;

  const request = useMemo<TeamCreateRequest>(
    () => ({
      teamName: sanitizedTeamName,
      description: description.trim() || undefined,
      color: teamColor || undefined,
      members: soloTeam
        ? []
        : buildMembersFromDrafts(effectiveMemberDrafts, {
            inheritedProviderId: selectedProviderId,
          }),
      cwd: effectiveCwd,
      prompt: prompt.trim() || undefined,
      providerId: selectedProviderId,
      providerBackendId: selectedProviderBackendId ?? undefined,
      model: effectiveModel,
      effort: (selectedEffortForCurrentSelection as EffortLevel) || undefined,
      fastMode:
        selectedProviderId === 'anthropic' || selectedProviderId === 'codex'
          ? selectedFastMode
          : undefined,
      limitContext: effectiveAnthropicRuntimeLimitContext,
      skipPermissions,
      worktree: worktreeEnabled && worktreeName.trim() ? worktreeName.trim() : undefined,
      extraCliArgs: customArgs.trim() || undefined,
    }),
    [
      sanitizedTeamName,
      description,
      teamColor,
      soloTeam,
      effectiveMemberDrafts,
      effectiveCwd,
      prompt,
      selectedProviderId,
      selectedProviderBackendId,
      effectiveModel,
      selectedEffortForCurrentSelection,
      selectedFastMode,
      effectiveAnthropicRuntimeLimitContext,
      skipPermissions,
      worktreeEnabled,
      worktreeName,
      customArgs,
    ]
  );
  const requestValidation = useMemo(
    () => validateRequest(request, t, { requireCwd: launchTeam }),
    [request, launchTeam, t]
  );
  const modelValidationError = useMemo(() => {
    if (selectedProviderId === 'opencode') {
      if (!selectedModel.trim()) {
        return t('create.validation.openCodeLeadModelRequired');
      }
      const activeMemberCount = soloTeam
        ? 0
        : effectiveMemberDrafts.filter((member) => !member.removedAt && member.name.trim()).length;
      if (activeMemberCount === 0) {
        return t('create.validation.openCodeTeammateRequired');
      }
    }

    if (!runtimeProviderLoadingById.get(selectedProviderId)) {
      const leadError = getTeamModelSelectionError(
        selectedProviderId,
        selectedModel,
        runtimeProviderStatusById.get(selectedProviderId)
      );
      if (leadError) {
        return leadError;
      }
    }

    for (const member of effectiveMemberDrafts) {
      if (member.removedAt) {
        continue;
      }

      const providerId = normalizeOptionalTeamProviderId(member.providerId) ?? selectedProviderId;
      if (runtimeProviderLoadingById.get(providerId)) {
        continue;
      }
      const memberError = getTeamModelSelectionError(
        providerId,
        member.model,
        runtimeProviderStatusById.get(providerId)
      );
      if (!memberError) {
        continue;
      }

      const memberName = member.name.trim();
      return memberName ? `${memberName}: ${memberError}` : memberError;
    }

    return null;
  }, [
    effectiveMemberDrafts,
    runtimeProviderStatusById,
    runtimeProviderLoadingById,
    selectedModel,
    selectedProviderId,
    soloTeam,
    t,
  ]);
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
    if (prompt.trim()) summary.push('Lead prompt');
    if (skipPermissions) summary.push('Auto-approve tools');
    if (selectedProviderId === 'anthropic' || selectedProviderId === 'codex') {
      if (selectedFastMode === 'on') summary.push('Fast mode');
      else if (selectedFastMode === 'off') summary.push('Fast disabled');
      else if (selectedProviderId === 'anthropic' && anthropicProviderFastModeDefault) {
        summary.push('Fast default');
      }
    }
    if (effectiveAnthropicRuntimeLimitContext) {
      summary.push('Anthropic limited to 200K context');
    }
    if (worktreeEnabled && worktreeName.trim()) summary.push(`Worktree: ${worktreeName.trim()}`);
    if (customArgs.trim()) summary.push('Custom CLI args');
    return summary;
  }, [
    anthropicProviderFastModeDefault,
    customArgs,
    effectiveAnthropicRuntimeLimitContext,
    prompt,
    selectedFastMode,
    selectedProviderId,
    skipPermissions,
    worktreeEnabled,
    worktreeName,
  ]);

  const teamDetailsSummary = useMemo(() => {
    const summary: string[] = [];
    if (description.trim()) summary.push('Description');
    if (teamColor) summary.push(`Color: ${teamColor}`);
    return summary;
  }, [description, teamColor]);

  const handleSyncModelsWithLeadChange = useCallback(
    (checked: boolean): void => {
      setSyncModelsWithLead(checked);
      if (checked) {
        persistCurrentMemberRuntimePreferences(members);
        setMembers(members.map(clearMemberModelOverrides));
        return;
      }

      if (getStoredCreateTeamMemberRuntimePreferences().length === 0) {
        return;
      }

      const nextMembers = applyStoredCreateTeamMemberRuntimePreferences(members);
      const hasRuntimeChanges = nextMembers.some((member, index) => {
        const previousMember = members[index];
        return (
          member.providerId !== previousMember?.providerId ||
          member.model !== previousMember?.model ||
          member.effort !== previousMember?.effort
        );
      });
      if (hasRuntimeChanges) {
        setMembers(nextMembers);
      }
    },
    [members, persistCurrentMemberRuntimePreferences, setMembers, setSyncModelsWithLead]
  );

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

  const conflictingTeam = useMemo(() => {
    if (!launchTeam) return null;
    if (!activeTeams?.length || !effectiveCwd) return null;
    const norm = normalizePath(effectiveCwd);
    return activeTeams.find((t) => normalizePath(t.projectPath) === norm) ?? null;
  }, [activeTeams, effectiveCwd, launchTeam]);

  // Reset dismiss when conflict target changes
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
    setIsSubmitting(true);

    if (!launchTeam) {
      void (async () => {
        try {
          if (!syncModelsWithLead) {
            persistCurrentMemberRuntimePreferences(members);
          }
          await api.teams.createConfig({
            teamName: request.teamName,
            displayName: request.displayName,
            description: request.description,
            color: request.color,
            members: request.members,
            cwd: effectiveCwd || undefined,
            prompt: request.prompt,
            providerId: request.providerId,
            providerBackendId: request.providerBackendId,
            model: request.model,
            effort: request.effort,
            fastMode: request.fastMode,
            limitContext: request.limitContext,
            skipPermissions: request.skipPermissions,
            worktree: request.worktree,
            extraCliArgs: request.extraCliArgs,
          });
          onOpenTeam(request.teamName, effectiveCwd || undefined);
          resetFormState();
          onClose();
        } catch (error) {
          setLocalError(
            error instanceof Error ? error.message : t('create.errors.createConfigFailed')
          );
        } finally {
          setIsSubmitting(false);
        }
      })();
      return;
    }

    void (async () => {
      try {
        if (!syncModelsWithLead) {
          persistCurrentMemberRuntimePreferences(members);
        }
        await onCreate(request);
        onOpenTeam(request.teamName, effectiveCwd || undefined);
        resetFormState();
        onClose();
      } catch {
        // error is shown via provisioningError prop
      } finally {
        setIsSubmitting(false);
      }
    })();
  };

  const handleTeamNameChange = (value: string): void => {
    setTeamName(value);
    setFieldErrors((prev) => {
      if (!prev.teamName) return prev;
      // eslint-disable-next-line sonarjs/no-unused-vars -- destructured to omit teamName from rest
      const { teamName: _teamName, ...rest } = prev;
      const remaining = Object.values(rest).filter(Boolean);
      if (remaining.length === 0) {
        setLocalError(null);
      } else {
        setLocalError(remaining.join(' · '));
      }
      return rest;
    });
  };

  const rosterHeaderTop = useMemo(
    () => (
      <div className="flex items-center gap-2">
        <Checkbox
          id="solo-team"
          checked={soloTeam}
          onCheckedChange={(checked) => setSoloTeam(checked === true)}
        />
        <Label
          htmlFor="solo-team"
          className="cursor-pointer text-xs font-normal text-text-secondary"
        >
          {t('create.solo.label')}
        </Label>
      </div>
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
      teammateRuntimeCompatibility,
      t,
      worktreeGitReadiness,
    ]
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
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
                  {t('create.conflict.title', { team: conflictingTeam.displayName })}
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
              modelLockReason="This teammate is synced with the lead model. Turn off sync to set a custom provider, model, or effort."
              hideMembersContent={soloTeam}
              providerId={selectedProviderId}
              model={selectedModel}
              effort={(selectedEffortForCurrentSelection as EffortLevel) || undefined}
              limitContext={effectiveAnthropicRuntimeLimitContext}
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

        <DialogFooter className="pt-4 sm:justify-between">
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
                label="Selected providers"
                layout="stacked"
                showReadyProviders={
                  effectivePrepare.state === 'idle' || effectivePrepare.state === 'loading'
                }
                readyStatusText="Ready"
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

          <div className="flex shrink-0 items-center gap-2">
            {canOpenExistingTeam ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
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
              disabled={!canCreate || !draftLoaded || isSubmitting || hasCreateFormErrors}
              onClick={handleSubmit}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  {t('create.actions.creating')}
                </>
              ) : launchTeam &&
                (effectivePrepare.state === 'idle' || effectivePrepare.state === 'loading') ? (
                t('create.actions.skipPreflightAndCreate')
              ) : (
                t('create.actions.create')
              )}
            </Button>
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
