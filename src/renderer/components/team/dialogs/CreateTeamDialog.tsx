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
import { api } from '@renderer/api';
import {
  buildMemberDraftColorMap,
  buildMemberDraftSuggestions,
  buildMembersFromDrafts,
  clearMemberModelOverrides,
  createMemberDraft,
  normalizeMemberDraftForProviderMode,
  normalizeProviderForMode,
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
import { useFileListCacheWarmer } from '@renderer/hooks/useFileListCacheWarmer';
import { useTaskSuggestions } from '@renderer/hooks/useTaskSuggestions';
import { useTeamSuggestions } from '@renderer/hooks/useTeamSuggestions';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import {
  isGeminiUiFrozen,
  normalizeCreateLaunchProviderForUi,
} from '@renderer/utils/geminiUiFreeze';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { resolveUiOwnedProviderBackendId } from '@renderer/utils/providerBackendIdentity';
import { refreshCliStatusForCurrentMode } from '@renderer/utils/refreshCliStatus';
import {
  getTeamModelSelectionError,
  normalizeExplicitTeamModelForUi,
} from '@renderer/utils/teamModelAvailability';
import { getTeamProviderLabel as getCatalogTeamProviderLabel } from '@renderer/utils/teamModelCatalog';
import { DEFAULT_PROVIDER_MODEL_SELECTION } from '@shared/utils/providerModelSelection';
import { resolveTeamLeadColorName } from '@shared/utils/teamMemberColors';
import { isTeamProviderId, normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';

import { AdvancedCliSection } from './AdvancedCliSection';
import {
  clearInheritedMemberModelsUnavailableForProvider,
  resolveProviderScopedMemberModel,
} from './memberModelScope';
import { OptionalSettingsSection } from './OptionalSettingsSection';
import { ProjectPathSelector } from './ProjectPathSelector';
import { buildProviderPrepareModelCacheKey } from './providerPrepareCacheKey';
import {
  buildReusableProviderPrepareModelResults,
  getProviderPrepareCachedSnapshot,
  type ProviderPrepareDiagnosticsModelResult,
  runProviderPrepareDiagnostics,
} from './providerPrepareDiagnostics';
import {
  getShortLivedProviderPrepareModelResults,
  storeShortLivedProviderPrepareModelResults,
} from './providerPrepareShortLivedCache';
import {
  buildProviderPrepareMembersSignature,
  buildProviderPrepareRequestSignature,
  buildProviderPrepareRuntimeStatusSignature,
} from './providerPrepareRequestSignature';
import { getProvisioningModelIssue } from './provisioningModelIssues';
import {
  deriveEffectiveProvisioningPrepareState,
  failIncompleteProviderChecks,
  getPrimaryProvisioningFailureDetail,
  getProvisioningFailureHint,
  getProvisioningProviderBackendSummary,
  type ProvisioningProviderCheck,
  ProvisioningProviderStatusList,
  shouldHideProvisioningProviderStatusList,
  updateProviderCheck,
} from './ProvisioningProviderStatusList';
import { SkipPermissionsCheckbox } from './SkipPermissionsCheckbox';
import { computeEffectiveTeamModel } from './TeamModelSelector';
import { getNextSuggestedTeamName } from './teamNameSets';

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

import type {
  EffortLevel,
  Project,
  TeamCreateRequest,
  TeamFastMode,
  TeamProviderId,
  TeamProvisioningMemberInput,
} from '@shared/types';

function getStoredTeamProvider(): TeamProviderId {
  const stored = localStorage.getItem('team:lastSelectedProvider');
  // return stored === 'codex' || stored === 'gemini' ? stored : 'anthropic';
  return normalizeCreateLaunchProviderForUi(
    stored === 'codex' || stored === 'gemini' ? stored : 'anthropic',
    true
  );
}

function getStoredTeamModel(providerId: TeamProviderId): string {
  const stored = localStorage.getItem(`team:lastSelectedModel:${providerId}`);
  if (stored === null) {
    return providerId === 'anthropic' ? 'opus' : '';
  }
  return normalizeExplicitTeamModelForUi(providerId, stored === '__default__' ? '' : stored);
}

function getStoredTeamFastMode(): TeamFastMode {
  const stored = localStorage.getItem('team:lastSelectedFastMode');
  return stored === 'on' || stored === 'off' || stored === 'inherit' ? stored : 'inherit';
}

function isEphemeralRenderedProjectPath(projectPath: string | null | undefined): boolean {
  const normalized = normalizePath(projectPath ?? '').toLowerCase();
  return (
    normalized.includes('rendered_mcp_') ||
    normalized.includes('rendered_mcp_config') ||
    normalized.includes('/portable-mcp-live')
  );
}

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

export interface TeamCopyData {
  teamName: string;
  description?: string;
  color?: string;
  members: TeamProvisioningMemberInput[];
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

function validateTeamNameInline(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const sanitized = sanitizeTeamName(trimmed);
  if (!sanitized) {
    return 'Name must contain at least one letter or digit';
  }
  if (sanitized.length > 128) {
    return 'Name is too long (max 128 chars)';
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
  options?: { requireCwd?: boolean }
): ValidationResult {
  const requireCwd = options?.requireCwd ?? true;
  const sanitized = sanitizeTeamName(request.teamName);
  if (!sanitized) {
    return {
      valid: false,
      errors: {
        teamName: 'Name must contain at least one letter or digit',
      },
    };
  }
  if (sanitized.length > 128) {
    return {
      valid: false,
      errors: {
        teamName: 'Name is too long (max 128 chars)',
      },
    };
  }
  if (requireCwd && !request.cwd.trim()) {
    return {
      valid: false,
      errors: {
        cwd: 'Select working directory (cwd)',
      },
    };
  }
  if (request.members.some((member) => !member.name.trim())) {
    return {
      valid: false,
      errors: {
        members: 'Member name cannot be empty',
      },
    };
  }
  if (request.members.some((member) => validateMemberNameInline(member.name.trim()) !== null)) {
    return {
      valid: false,
      errors: {
        members: 'Member name must start with alphanumeric, use only [a-zA-Z0-9._-], max 128 chars',
      },
    };
  }
  const uniqueNames = new Set(request.members.map((member) => member.name.trim().toLowerCase()));
  if (uniqueNames.size !== request.members.length) {
    return {
      valid: false,
      errors: {
        members: 'Member names must be unique',
      },
    };
  }
  return { valid: true };
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
  const multimodelEnabled = useStore((s) => s.appConfig?.general?.multimodelEnabled ?? true);
  const anthropicProviderFastModeDefault = useStore(
    (s) => s.appConfig?.providerConnections?.anthropic.fastModeDefault ?? false
  );
  const cliStatus = useStore((s) => s.cliStatus);
  const cliStatusLoading = useStore((s) => s.cliStatusLoading);
  const bootstrapCliStatus = useStore((s) => s.bootstrapCliStatus);
  const fetchCliStatus = useStore((s) => s.fetchCliStatus);
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
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [prepareState, setPrepareState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [prepareMessage, setPrepareMessage] = useState<string | null>(null);
  const [prepareWarnings, setPrepareWarnings] = useState<string[]>([]);
  const [prepareChecks, setPrepareChecks] = useState<ProvisioningProviderCheck[]>([]);
  const prepareRequestSeqRef = useRef(0);
  const lastAutoDescriptionRef = useRef<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    teamName?: string;
    members?: string;
    cwd?: string;
  }>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [conflictDismissed, setConflictDismissed] = useState(false);
  const [selectedProviderId, setSelectedProviderIdRaw] =
    useState<TeamProviderId>(getStoredTeamProvider);
  const [selectedModel, setSelectedModelRaw] = useState(() =>
    getStoredTeamModel(getStoredTeamProvider())
  );
  const [limitContext, setLimitContextRaw] = useState(
    () => localStorage.getItem('team:lastLimitContext') === 'true'
  );
  const [skipPermissions, setSkipPermissionsRaw] = useState(
    () => localStorage.getItem('team:lastSkipPermissions') !== 'false'
  );
  const [selectedEffort, setSelectedEffortRaw] = useState(() => {
    const stored = localStorage.getItem('team:lastSelectedEffort');
    return stored === null ? 'medium' : stored;
  });
  const [selectedFastMode, setSelectedFastModeRaw] = useState<TeamFastMode>(getStoredTeamFastMode);
  const [anthropicRuntimeNotice, setAnthropicRuntimeNotice] = useState<string | null>(null);

  // Advanced CLI section state (use teamName-derived key for localStorage)
  const advancedKey = sanitizeTeamName(teamName.trim()) || '_new_';
  const [worktreeEnabled, setWorktreeEnabledRaw] = useState(false);
  const [worktreeName, setWorktreeNameRaw] = useState('');
  const [customArgs, setCustomArgsRaw] = useState('');

  useEffect(() => {
    const legacyTeamModel = localStorage.getItem('team:lastSelectedModel');
    if (
      legacyTeamModel != null &&
      localStorage.getItem('team:lastSelectedModel:anthropic') == null
    ) {
      localStorage.setItem('team:lastSelectedModel:anthropic', legacyTeamModel);
    }
    localStorage.removeItem('team:lastSelectedModel');
  }, []);

  // Re-read localStorage when advancedKey changes
  useEffect(() => {
    const storedEnabled =
      localStorage.getItem(`team:lastWorktreeEnabled:${advancedKey}`) === 'true';
    const storedName = localStorage.getItem(`team:lastWorktreeName:${advancedKey}`) ?? '';
    setWorktreeEnabledRaw(storedEnabled && Boolean(storedName));
    setWorktreeNameRaw(storedName);
    setCustomArgsRaw(localStorage.getItem(`team:lastCustomArgs:${advancedKey}`) ?? '');
  }, [advancedKey]);

  const setSelectedModel = (value: string): void => {
    const normalizedValue = normalizeExplicitTeamModelForUi(selectedProviderId, value);
    setSelectedModelRaw(normalizedValue);
    localStorage.setItem(`team:lastSelectedModel:${selectedProviderId}`, normalizedValue);
  };

  const setSelectedProviderId = (value: TeamProviderId): void => {
    const normalizedValue = normalizeProviderForMode(value, multimodelEnabled);
    setSelectedProviderIdRaw(normalizedValue);
    localStorage.setItem('team:lastSelectedProvider', normalizedValue);
    if (normalizedValue !== 'anthropic') {
      setLimitContextRaw(false);
      localStorage.setItem('team:lastLimitContext', 'false');
    }
    setSelectedModelRaw(getStoredTeamModel(normalizedValue));
  };

  const setLimitContext = (value: boolean): void => {
    setLimitContextRaw(value);
    localStorage.setItem('team:lastLimitContext', String(value));
  };

  const setSkipPermissions = (value: boolean): void => {
    setSkipPermissionsRaw(value);
    localStorage.setItem('team:lastSkipPermissions', String(value));
  };

  const setSelectedEffort = (value: string): void => {
    setSelectedEffortRaw(value);
    localStorage.setItem('team:lastSelectedEffort', value);
  };

  const setSelectedFastMode = (value: TeamFastMode): void => {
    setSelectedFastModeRaw(value);
    localStorage.setItem('team:lastSelectedFastMode', value);
  };

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

  const effectiveCwd = cwdMode === 'project' ? selectedProjectPath.trim() : customCwd.trim();
  const dialogTeamNameKey = sanitizeTeamName(teamName.trim());
  /** All taken names: existing teams + teams currently being provisioned. */
  const allTakenTeamNames = useMemo(
    () => [...new Set([...existingTeamNames, ...provisioningTeamNames])],
    [existingTeamNames, provisioningTeamNames]
  );
  const suggestedTeamName = getNextSuggestedTeamName(allTakenTeamNames);

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
  const runtimeBackendSummaryByProviderRef = useRef(runtimeBackendSummaryByProvider);
  const prepareChecksRef = useRef<ProvisioningProviderCheck[]>([]);
  const prepareModelResultsCacheRef = useRef(
    new Map<string, Record<string, ProviderPrepareDiagnosticsModelResult>>()
  );
  const lastPrepareRequestSignatureRef = useRef<string | null>(null);

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
    if (!open) {
      lastPrepareRequestSignatureRef.current = null;
    }
  }, [open]);

  const prepareRuntimeStatusSignature = useMemo(
    () =>
      buildProviderPrepareRuntimeStatusSignature(
        selectedMemberProviders,
        runtimeProviderStatusById
      ),
    [runtimeProviderStatusById, selectedMemberProviders]
  );
  const prepareMembersSignature = useMemo(
    () => buildProviderPrepareMembersSignature(effectiveMemberDrafts),
    [effectiveMemberDrafts]
  );
  const prepareRequestSignature = useMemo(
    () =>
      buildProviderPrepareRequestSignature({
        cwd: effectiveCwd,
        selectedProviderId,
        selectedModel,
        selectedMemberProviders,
        limitContext,
        runtimeStatusSignature: prepareRuntimeStatusSignature,
        membersSignature: prepareMembersSignature,
      }),
    [
      effectiveCwd,
      limitContext,
      prepareMembersSignature,
      prepareRuntimeStatusSignature,
      selectedMemberProviders,
      selectedModel,
      selectedProviderId,
    ]
  );

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

  useEffect(() => {
    if (!open || !canCreate || !launchTeam) {
      prepareRequestSeqRef.current += 1;
      lastPrepareRequestSignatureRef.current = null;
      return;
    }

    if (typeof api.teams.prepareProvisioning !== 'function') {
      prepareRequestSeqRef.current += 1;
      lastPrepareRequestSignatureRef.current = null;
      setPrepareState('failed');
      setPrepareWarnings([]);
      setPrepareChecks([]);
      setPrepareMessage(
        'Current preload version does not support team:prepareProvisioning. Restart the dev app.'
      );
      return;
    }

    if (!effectiveCwd) {
      prepareRequestSeqRef.current += 1;
      lastPrepareRequestSignatureRef.current = null;
      setPrepareState('idle');
      setPrepareWarnings([]);
      setPrepareChecks([]);
      setPrepareMessage('Select a working directory to validate the launch environment.');
      return;
    }

    if (lastPrepareRequestSignatureRef.current === prepareRequestSignature) {
      return;
    }
    lastPrepareRequestSignatureRef.current = prepareRequestSignature;

    const requestSeq = ++prepareRequestSeqRef.current;
    const initialChecks = alignProvisioningChecks(
      prepareChecksRef.current,
      selectedMemberProviders
    );
    setPrepareState('loading');
    setPrepareMessage('Checking selected providers in parallel...');
    setPrepareWarnings([]);
    setPrepareChecks(initialChecks);

    void (async () => {
      await Promise.resolve();
      let checks = initialChecks;
      const providerPlans = selectedMemberProviders.map((providerId) => {
        const selectedModelChecks = (() => {
          const next = new Set<string>();
          let hasDefaultSelection = false;
          const supportsProviderDefaultCheck =
            providerId === 'codex' ||
            providerId === 'gemini' ||
            (providerId === 'anthropic' && selectedProviderId === 'anthropic');
          const leadModel = computeEffectiveTeamModel(
            selectedModel,
            limitContext,
            selectedProviderId
          );
          if (selectedProviderId === providerId && selectedModel.trim()) {
            if (leadModel?.trim()) {
              next.add(leadModel.trim());
            }
          } else if (selectedProviderId === providerId && supportsProviderDefaultCheck) {
            hasDefaultSelection = true;
          }
          for (const member of effectiveMemberDrafts) {
            if (member.removedAt) {
              continue;
            }
            const scopedModel = resolveProviderScopedMemberModel({
              memberProviderId: member.providerId,
              memberModel: member.model,
              selectedProviderId,
              runtimeProviderStatusById,
            });
            if (scopedModel.providerId !== providerId) {
              continue;
            }
            if (scopedModel.model) {
              next.add(scopedModel.model);
            } else if (supportsProviderDefaultCheck) {
              hasDefaultSelection = true;
            }
          }
          if (supportsProviderDefaultCheck && hasDefaultSelection) {
            next.add(DEFAULT_PROVIDER_MODEL_SELECTION);
          }
          return Array.from(next);
        })();
        const backendSummary = runtimeBackendSummaryByProviderRef.current.get(providerId) ?? null;
        const cacheKey = buildProviderPrepareModelCacheKey({
          cwd: effectiveCwd,
          providerId,
          backendSummary,
          limitContext,
          runtimeStatusSignature: prepareRuntimeStatusSignature,
        });
        const cachedModelResultsById = {
          ...getShortLivedProviderPrepareModelResults({
            providerId,
            cacheKey,
          }),
          ...(prepareModelResultsCacheRef.current.get(cacheKey) ?? {}),
        };
        const cachedSnapshot = getProviderPrepareCachedSnapshot({
          providerId,
          selectedModelIds: selectedModelChecks,
          cachedModelResultsById,
        });
        return {
          providerId,
          selectedModelChecks,
          backendSummary,
          cacheKey,
          cachedModelResultsById,
          cachedSnapshot,
        };
      });

      try {
        for (const plan of providerPlans) {
          checks = updateProviderCheck(checks, plan.providerId, {
            status: plan.selectedModelChecks.length > 0 ? plan.cachedSnapshot.status : 'checking',
            backendSummary: plan.backendSummary,
            details: plan.cachedSnapshot.details,
          });
        }
        if (prepareRequestSeqRef.current === requestSeq) {
          setPrepareChecks(checks);
        }
        const providerResults = await Promise.all(
          providerPlans.map(async (plan) => {
            const prepResult = await runProviderPrepareDiagnostics({
              cwd: effectiveCwd,
              providerId: plan.providerId,
              selectedModelIds: plan.selectedModelChecks,
              prepareProvisioning: api.teams.prepareProvisioning,
              limitContext,
              cachedModelResultsById: plan.cachedModelResultsById,
              onModelProgress: ({ status, details }) => {
                checks = updateProviderCheck(checks, plan.providerId, {
                  status,
                  backendSummary: plan.backendSummary,
                  details,
                });
                if (prepareRequestSeqRef.current === requestSeq) {
                  setPrepareChecks(checks);
                }
              },
            });
            return { ...plan, prepResult };
          })
        );
        let anyFailure = false;
        let anyNotes = false;
        const collectedWarnings: string[] = [];
        for (const plan of providerResults) {
          if (plan.prepResult.warnings.length > 0) {
            anyNotes = true;
            collectedWarnings.push(
              ...plan.prepResult.warnings.map(
                (warning) => `${getProviderLabel(plan.providerId)}: ${warning}`
              )
            );
          }
          if (plan.prepResult.status === 'failed') {
            anyFailure = true;
          } else if (plan.prepResult.status === 'notes') {
            anyNotes = true;
          }
          if (prepareRequestSeqRef.current === requestSeq) {
            const reusableModelResults = buildReusableProviderPrepareModelResults(
              plan.prepResult.modelResultsById
            );
            prepareModelResultsCacheRef.current.set(plan.cacheKey, reusableModelResults);
            storeShortLivedProviderPrepareModelResults({
              providerId: plan.providerId,
              cacheKey: plan.cacheKey,
              modelResultsById: plan.prepResult.modelResultsById,
            });
          }
          checks = updateProviderCheck(checks, plan.providerId, {
            status: plan.prepResult.status,
            backendSummary: plan.backendSummary,
            details: plan.prepResult.details,
          });
        }
        if (prepareRequestSeqRef.current === requestSeq) {
          setPrepareChecks(checks);
        }
        if (prepareRequestSeqRef.current !== requestSeq) return;
        const failureMessage =
          getPrimaryProvisioningFailureDetail(checks) ?? 'Some selected providers need attention.';
        setPrepareState(anyFailure ? 'failed' : 'ready');
        setPrepareMessage(
          anyFailure
            ? failureMessage
            : anyNotes
              ? 'Selected providers are ready with notes.'
              : 'Selected providers are ready.'
        );
        setPrepareWarnings(collectedWarnings);
      } catch (error) {
        if (prepareRequestSeqRef.current !== requestSeq) return;
        const failureMessage =
          error instanceof Error ? error.message : 'Failed to warm up Claude CLI environment';
        setPrepareState('failed');
        setPrepareWarnings([]);
        setPrepareChecks(failIncompleteProviderChecks(checks, failureMessage));
        setPrepareMessage(failureMessage);
      }
    })();
  }, [
    open,
    canCreate,
    launchTeam,
    effectiveCwd,
    effectiveMemberDrafts,
    limitContext,
    prepareRequestSignature,
    runtimeProviderStatusById,
    selectedModel,
    selectedProviderId,
    selectedMemberProviders,
  ]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setProjectsLoading(true);
    setProjectsError(null);

    let cancelled = false;
    void (async () => {
      try {
        const nextProjects = await api.getProjects();
        if (cancelled) {
          return;
        }

        // If defaultProjectPath is set but not in the fetched list (e.g. new project
        // without Claude sessions), add it as a synthetic entry so the Combobox can
        // display and select it.
        if (
          defaultProjectPath &&
          !isEphemeralRenderedProjectPath(defaultProjectPath) &&
          !nextProjects.some((p) => normalizePath(p.path) === defaultProjectPath)
        ) {
          const folderName =
            defaultProjectPath.split(/[/\\]/).filter(Boolean).pop() ?? defaultProjectPath;
          nextProjects.unshift({
            id: defaultProjectPath.replace(/[/\\]/g, '-'),
            path: defaultProjectPath,
            name: folderName,
            sessions: [],
            createdAt: Date.now(),
          });
        }

        setProjects(nextProjects);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setProjectsError(error instanceof Error ? error.message : 'Failed to load projects');
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
  }, [open, defaultProjectPath]);

  useEffect(() => {
    if (!open || !draftLoaded) {
      return;
    }

    if (initialData) {
      setTeamName(initialData.teamName);
      descriptionDraft.setValue(initialData.description ?? '');
      setTeamColor(initialData.color ?? '');
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
              model: m.model ?? '',
              effort: m.effort,
            }),
            multimodelEnabled
          );
        })
      );
      setTeammateWorktreeDefault(
        initialData.members.length > 0 &&
          initialData.members.every((member) => member.isolation === 'worktree')
      );
      setSyncModelsWithLead(
        !initialData.members.some((member) => member.providerId || member.model || member.effort)
      );
      return;
    }

    if (members.length > 0) {
      return;
    }

    setMembers(
      DEFAULT_MEMBERS.map((member) =>
        createMemberDraft({
          name: member.name,
          roleSelection: member.roleSelection,
          workflow: member.workflow,
        })
      )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialData is checked once on open/draftLoaded
  }, [open, draftLoaded]);

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
    if (!open) return;
    if (cwdMode !== 'project') {
      return;
    }
    if (selectedProjectPath || projects.length === 0) {
      return;
    }
    if (defaultProjectPath && !isEphemeralRenderedProjectPath(defaultProjectPath)) {
      const match = projects.find((p) => normalizePath(p.path) === defaultProjectPath);
      if (match) {
        setSelectedProjectPath(match.path);
        return;
      }
    }
    setSelectedProjectPath(projects[0].path);
  }, [open, cwdMode, projects, selectedProjectPath, defaultProjectPath]);

  useEffect(() => {
    if (!open || cwdMode !== 'project' || !selectedProjectPath) {
      return;
    }
    if (!isEphemeralRenderedProjectPath(selectedProjectPath)) {
      return;
    }
    setSelectedProjectPath('');
  }, [open, cwdMode, selectedProjectPath, setSelectedProjectPath]);

  useFileListCacheWarmer(effectiveCwd || null);

  const { suggestions: taskSuggestions } = useTaskSuggestions(null);
  const { suggestions: teamMentionSuggestions } = useTeamSuggestions(null);

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
        limitContext,
        selectedProviderId,
        runtimeProviderStatusById.get(selectedProviderId)
      ),
    [limitContext, runtimeProviderStatusById, selectedModel, selectedProviderId]
  );
  const anthropicRuntimeSelection = useMemo(
    () =>
      selectedProviderId === 'anthropic'
        ? resolveAnthropicRuntimeSelection({
            source: {
              modelCatalog: runtimeProviderStatusById.get('anthropic')?.modelCatalog,
              runtimeCapabilities: runtimeProviderStatusById.get('anthropic')?.runtimeCapabilities,
            },
            selectedModel,
            limitContext,
          })
        : null,
    [limitContext, runtimeProviderStatusById, selectedModel, selectedProviderId]
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
                limitContext,
              }),
            selectedEffort,
            selectedFastMode,
            providerFastModeDefault: anthropicProviderFastModeDefault,
          })
        : {
            nextEffort: selectedEffort,
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
    if (reconciliation.nextEffort !== selectedEffort) {
      setSelectedEffortRaw(reconciliation.nextEffort);
      localStorage.setItem('team:lastSelectedEffort', reconciliation.nextEffort);
      if (reconciliation.effortResetReason) {
        notices.push(reconciliation.effortResetReason);
      }
    }
    if (reconciliation.nextFastMode !== selectedFastMode) {
      setSelectedFastModeRaw(reconciliation.nextFastMode);
      localStorage.setItem('team:lastSelectedFastMode', reconciliation.nextFastMode);
      if (reconciliation.fastModeResetReason) {
        notices.push(reconciliation.fastModeResetReason);
      }
    }
    setAnthropicRuntimeNotice(notices.length > 0 ? notices.join(' ') : null);
  }, [
    anthropicProviderFastModeDefault,
    anthropicRuntimeSelection,
    codexRuntimeSelection,
    limitContext,
    runtimeProviderStatusById,
    selectedEffort,
    selectedFastMode,
    selectedModel,
    selectedProviderId,
  ]);

  const sanitizedTeamName = sanitizeTeamName(teamName.trim());
  const teamNameInlineError = validateTeamNameInline(teamName);
  const isNameTakenByExistingTeam = existingTeamNames.includes(sanitizedTeamName);
  const isNameProvisioning =
    provisioningTeamNames.includes(sanitizedTeamName) && !isNameTakenByExistingTeam;

  const request = useMemo<TeamCreateRequest>(
    () => ({
      teamName: sanitizedTeamName,
      description: description.trim() || undefined,
      color: teamColor || undefined,
      members: soloTeam ? [] : buildMembersFromDrafts(effectiveMemberDrafts),
      cwd: effectiveCwd,
      prompt: prompt.trim() || undefined,
      providerId: selectedProviderId,
      providerBackendId:
        resolveUiOwnedProviderBackendId(
          selectedProviderId,
          runtimeProviderStatusById.get(selectedProviderId)
        ) ?? undefined,
      model: effectiveModel,
      effort: (selectedEffort as EffortLevel) || undefined,
      fastMode:
        selectedProviderId === 'anthropic' || selectedProviderId === 'codex'
          ? selectedFastMode
          : undefined,
      limitContext,
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
      runtimeProviderStatusById,
      effectiveModel,
      selectedEffort,
      selectedFastMode,
      limitContext,
      skipPermissions,
      worktreeEnabled,
      worktreeName,
      customArgs,
    ]
  );
  const requestValidation = useMemo(
    () => validateRequest(request, { requireCwd: launchTeam }),
    [request, launchTeam]
  );
  const modelValidationError = useMemo(() => {
    const leadError = getTeamModelSelectionError(
      selectedProviderId,
      selectedModel,
      runtimeProviderStatusById.get(selectedProviderId)
    );
    if (leadError) {
      return leadError;
    }

    for (const member of effectiveMemberDrafts) {
      if (member.removedAt) {
        continue;
      }

      const providerId = normalizeOptionalTeamProviderId(member.providerId) ?? selectedProviderId;
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
  }, [effectiveMemberDrafts, runtimeProviderStatusById, selectedModel, selectedProviderId]);
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
    !!modelValidationError;

  const internalArgs = useMemo(() => {
    const args: string[] = [];
    args.push('--input-format', 'stream-json', '--output-format', 'stream-json');
    args.push('--verbose', '--setting-sources', 'user,project,local');
    args.push('--mcp-config', '<auto>', '--disallowedTools', APP_TEAM_RUNTIME_DISALLOWED_TOOLS);
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    if (effectiveModel) args.push('--model', effectiveModel);
    const effectiveEffort =
      selectedProviderId === 'anthropic'
        ? selectedEffort || anthropicRuntimeSelection?.defaultEffort || ''
        : selectedEffort;
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
    selectedEffort,
    selectedProviderId,
    skipPermissions,
  ]);

  const launchOptionalSummary = useMemo(() => {
    const summary: string[] = [];
    if (prompt.trim()) summary.push('Lead prompt');
    if (skipPermissions) summary.push('Auto-approve tools');
    if (selectedProviderId === 'anthropic') {
      if (selectedFastMode === 'on') summary.push('Fast mode');
      else if (selectedFastMode === 'off') summary.push('Fast disabled');
      else if (anthropicProviderFastModeDefault) summary.push('Fast default');
    }
    if (worktreeEnabled && worktreeName.trim()) summary.push(`Worktree: ${worktreeName.trim()}`);
    if (customArgs.trim()) summary.push('Custom CLI args');
    return summary;
  }, [
    anthropicProviderFastModeDefault,
    customArgs,
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
        setMembers(members.map(clearMemberModelOverrides));
      }
    },
    [members, setMembers, setSyncModelsWithLead]
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
      }),
    [prepareChecks, prepareMessage, prepareState, prepareWarnings]
  );
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
      const msg = isNameProvisioning ? 'Team is currently launching' : 'Team name already exists';
      setFieldErrors({ teamName: msg });
      setLocalError(msg);
      return;
    }
    const validation = validateRequest(request, { requireCwd: launchTeam });
    if (!validation.valid) {
      const errors = validation.errors ?? {};
      setFieldErrors(errors);
      const messages = Object.values(errors).filter(Boolean);
      setLocalError(messages.join(' · ') || 'Check form fields');
      return;
    }
    if (modelValidationError) {
      setLocalError(modelValidationError);
      return;
    }
    setFieldErrors({});
    setLocalError(null);
    setIsSubmitting(true);

    if (!launchTeam) {
      void (async () => {
        try {
          await api.teams.createConfig({
            teamName: request.teamName,
            displayName: request.displayName,
            description: request.description,
            color: request.color,
            members: request.members,
            cwd: effectiveCwd || undefined,
            providerBackendId: request.providerBackendId,
            fastMode: request.fastMode,
          });
          onOpenTeam(request.teamName, effectiveCwd || undefined);
          resetFormState();
          onClose();
        } catch (error) {
          setLocalError(error instanceof Error ? error.message : 'Failed to create team config');
        } finally {
          setIsSubmitting(false);
        }
      })();
      return;
    }

    void (async () => {
      try {
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
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-sm">{initialData ? 'Copy Team' : 'Create Team'}</DialogTitle>
          <DialogDescription className="text-xs">
            {initialData
              ? 'Create a new team based on an existing one.'
              : 'Team provisioning via local Claude CLI.'}
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
                  Another team &ldquo;{conflictingTeam.displayName}&rdquo; is already running for
                  this working directory
                </p>
                <p className="opacity-80">
                  Running two teams in the same directory is risky — they may conflict editing the
                  same files. Consider using a different directory or a git worktree for isolation.
                </p>
                <p className="text-[11px] opacity-70">
                  Working directory: <span className="font-mono">{effectiveCwd}</span>
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
            Available only in local Electron mode.
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="team-name">Team name</Label>
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
                Team name already exists
              </p>
            ) : teamNameInlineError ? (
              <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
                {teamNameInlineError}
              </p>
            ) : isNameProvisioning ? (
              <p className="text-[11px]" style={{ color: 'var(--warning-text)' }}>
                A team with this name is currently launching
              </p>
            ) : fieldErrors.teamName ? (
              <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
                {fieldErrors.teamName}
              </p>
            ) : null}
            {sanitizedTeamName && sanitizedTeamName !== teamName.trim() ? (
              <p className="text-[11px] text-[var(--color-text-muted)]">
                On disk: <span className="font-mono">{sanitizedTeamName}</span>
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
              defaultProviderId={selectedProviderId}
              inheritedProviderId={selectedProviderId}
              inheritedModel={selectedModel}
              inheritedEffort={(selectedEffort as EffortLevel) || undefined}
              inheritModelSettingsByDefault
              lockProviderModel={syncModelsWithLead}
              forceInheritedModelSettings={syncModelsWithLead}
              modelLockReason="This teammate is synced with the lead model. Turn off sync to set a custom provider, model, or effort."
              hideMembersContent={soloTeam}
              providerId={selectedProviderId}
              model={selectedModel}
              effort={(selectedEffort as EffortLevel) || undefined}
              limitContext={limitContext}
              onProviderChange={setSelectedProviderId}
              onModelChange={setSelectedModel}
              onEffortChange={setSelectedEffort}
              fastMode={selectedFastMode}
              providerFastModeDefault={anthropicProviderFastModeDefault}
              onFastModeChange={setSelectedFastMode}
              onLimitContextChange={setLimitContext}
              syncModelsWithTeammates={syncModelsWithLead}
              onSyncModelsWithTeammatesChange={handleSyncModelsWithLeadChange}
              showWorktreeIsolationControls={!soloTeam}
              teammateWorktreeDefault={teammateWorktreeDefault}
              onTeammateWorktreeDefaultChange={setTeammateWorktreeDefault}
              disableGeminiOption={isGeminiUiFrozen()}
              leadModelIssueText={leadModelIssueText}
              leadFastModeNotice={anthropicRuntimeNotice}
              memberModelIssueById={memberModelIssueById}
              headerTop={
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
                    Solo team
                  </Label>
                </div>
              }
              headerBottom={
                soloTeam ? (
                  <div className="flex items-start gap-2 rounded-md border border-sky-500/20 bg-sky-500/5 px-3 py-2">
                    <Info className="mt-0.5 size-3.5 shrink-0 text-sky-400" />
                    <p className="text-[11px] leading-relaxed text-sky-300">
                      Only the team lead (main process) will be started &mdash; no teammates will be
                      spawned. Works like a regular Claude session but with access to the task board
                      for planning. Saves tokens by avoiding teammate coordination overhead. You can
                      add members later from the team settings.
                    </p>
                  </div>
                ) : null
              }
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
                  Run command after create
                </Label>
                <p
                  className="text-xs"
                  style={{
                    color: isLight
                      ? 'color-mix(in srgb, var(--color-text-muted) 54%, var(--color-text) 46%)'
                      : 'var(--color-text-muted)',
                  }}
                >
                  Start the team immediately via local Claude CLI.
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
                  title="Optional launch settings"
                  description="Prompt, safety, and CLI overrides live here when you need them."
                  summary={launchOptionalSummary}
                >
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="team-prompt" className="label-optional">
                        Prompt for team lead (optional)
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
                        placeholder="Instructions for the team lead during provisioning..."
                        footerRight={
                          promptDraft.isSaved ? (
                            <span className="text-[10px] text-[var(--color-text-muted)]">
                              Saved
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
              title="Optional team details"
              description="Keep the default flow compact and only open this when you want extra context or a custom color."
              summary={teamDetailsSummary}
            >
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="team-description" className="label-optional">
                    Description (optional)
                  </Label>
                  <AutoResizeTextarea
                    id="team-description"
                    className="text-xs"
                    minRows={2}
                    maxRows={8}
                    value={description}
                    onChange={(event) => descriptionDraft.setValue(event.target.value)}
                    placeholder="Brief description of the team purpose"
                  />
                  {descriptionDraft.isSaved ? (
                    <span className="text-[10px] text-[var(--color-text-muted)]">Saved</span>
                  ) : null}
                </div>

                <div className="space-y-1.5">
                  <Label className="label-optional">Color (optional)</Label>
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
                          ? 'Warming up CLI environment...'
                          : 'Preparing environment...')}
                    </span>
                    <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)] opacity-70">
                      Pre-flight check to catch errors before launch
                    </p>
                  </div>
                </div>
                <ProvisioningProviderStatusList checks={prepareChecks} className="mt-2" />
              </>
            ) : null}

            {canCreate && launchTeam && effectivePrepare.state === 'ready' ? (
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                  <CheckCircle2 className="size-3.5 shrink-0" />
                  <span>
                    {prepareChecks.some((check) => check.status === 'notes') ||
                    prepareWarnings.length > 0
                      ? 'CLI environment ready (with notes)'
                      : 'CLI environment ready'}
                  </span>
                </div>
                {effectivePrepare.message ? (
                  <p className="mt-0.5 pl-5 text-[11px] text-[var(--color-text-muted)]">
                    {effectivePrepare.message}
                  </p>
                ) : null}
                <ProvisioningProviderStatusList checks={prepareChecks} className="mt-1" />
                {prepareWarnings.length > 0 && prepareChecks.length === 0 ? (
                  <div className="mt-0.5 space-y-0.5 pl-5">
                    {prepareWarnings.map((warning) => (
                      <p key={warning} className="text-[11px] text-sky-300">
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
                      CLI environment is not available - launch is blocked
                    </p>
                    <p className="mt-0.5 text-red-300/80">
                      {effectivePrepare.message ?? 'Failed to prepare environment'}
                    </p>
                    <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)] opacity-70">
                      Pre-flight check to catch errors before launch
                    </p>
                  </div>
                </div>
                {!shouldHideProvisioningProviderStatusList(prepareChecks, prepareMessage) ? (
                  <ProvisioningProviderStatusList
                    checks={prepareChecks}
                    className="mt-2"
                    suppressDetailsMatching={prepareMessage}
                  />
                ) : null}
                {prepareWarnings.length > 0 && prepareChecks.length === 0 ? (
                  <div className="mt-1 space-y-0.5 pl-6">
                    {prepareWarnings.map((warning) => (
                      <p
                        key={warning}
                        className="text-[11px]"
                        style={{ color: 'var(--warning-text)' }}
                      >
                        {warning}
                      </p>
                    ))}
                  </div>
                ) : null}
                <p className="mt-1 pl-6 text-[11px] text-[var(--color-text-muted)]">
                  {getProvisioningFailureHint(effectivePrepare.message, prepareChecks)}
                </p>
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
                Open Existing Team
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button
              size="sm"
              disabled={!canCreate || !draftLoaded || isSubmitting || hasCreateFormErrors}
              onClick={handleSubmit}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  Creating...
                </>
              ) : launchTeam &&
                (effectivePrepare.state === 'idle' || effectivePrepare.state === 'loading') ? (
                'Skip preflight and create'
              ) : (
                'Create'
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
