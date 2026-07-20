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
import { SkipPermissionsCheckbox } from '@renderer/components/team/dialogs/SkipPermissionsCheckbox';
import {
  buildMemberDraftColorMap,
  buildMemberDraftSuggestions,
  buildMembersFromDrafts,
  clearMemberModelOverrides,
  createMemberDraftsFromInputs,
  filterEditableMemberInputs,
  normalizeLeadProviderForMode,
  normalizeMemberDraftForProviderMode,
  normalizeProviderForMode,
  validateMemberNameInline,
} from '@renderer/components/team/members/MembersEditorSection';
import { TeamRosterEditorSection } from '@renderer/components/team/members/TeamRosterEditorSection';
import { Button } from '@renderer/components/ui/button';
import { Combobox } from '@renderer/components/ui/combobox';
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
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useChipDraftPersistence } from '@renderer/hooks/useChipDraftPersistence';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useEffectiveCliProviderStatus } from '@renderer/hooks/useEffectiveCliProviderStatus';
import { useFileListCacheWarmer } from '@renderer/hooks/useFileListCacheWarmer';
import { useOpenCodeCatalogPrefetch } from '@renderer/hooks/useOpenCodeCatalogPrefetch';
import { useTaskSuggestions } from '@renderer/hooks/useTaskSuggestions';
import { useTeamSuggestions } from '@renderer/hooks/useTeamSuggestions';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import {
  isTeamProvisioningActive,
  selectResolvedMembersForTeamName,
} from '@renderer/store/slices/teamSlice';
import {
  isGeminiUiFrozen,
  normalizeCreateLaunchProviderForUi,
} from '@renderer/utils/geminiUiFreeze';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { nameColorSet } from '@renderer/utils/projectColor';
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
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { DEFAULT_PROVIDER_MODEL_SELECTION } from '@shared/utils/providerModelSelection';
import { isTeamProviderId, normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Info,
  Loader2,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { CronScheduleInput } from '../schedule/CronScheduleInput';

import { AdvancedCliSection } from './AdvancedCliSection';
import { AnthropicFastModeSelector } from './AnthropicFastModeSelector';
import { CodexFastModeSelector } from './CodexFastModeSelector';
import { CodexReconnectPrompt, shouldShowCodexReconnectPrompt } from './CodexReconnectPrompt';
import { EffortLevelSelector } from './EffortLevelSelector';
import { resolveLaunchDialogPrefill } from './launchDialogPrefill';
import {
  clearInheritedMemberModelsUnavailableForProvider,
  resolveProviderScopedMemberModel,
} from './memberModelScope';
import { OptionalSettingsSection } from './OptionalSettingsSection';
import {
  isDeletedProjectPathSelection,
  isSelectableProjectPathProject,
} from './projectPathOptions';
import { loadProjectPathProjects, syntheticProjectFromPath } from './projectPathProjects';
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
  getProvisioningProviderReadyById,
  type ProvisioningProviderCheck,
  ProvisioningProviderStatusList,
  shouldHideProvisioningProviderStatusList,
  updateProviderCheck,
} from './ProvisioningProviderStatusList';
import {
  analyzeTeammateRuntimeCompatibility,
  useTmuxRuntimeReadiness,
} from './teammateRuntimeCompatibility';
import { TeammateRuntimeCompatibilityNotice } from './TeammateRuntimeCompatibilityNotice';
import {
  computeEffectiveTeamModel,
  formatTeamModelSummary,
  OPENCODE_ONE_SHOT_DISABLED_BADGE_LABEL,
  OPENCODE_ONE_SHOT_DISABLED_REASON,
  TeamModelSelector,
} from './TeamModelSelector';
import {
  getWorktreeGitBlockingMessage,
  getWorktreeGitControlDisabledReason,
  useWorktreeGitReadiness,
  WorktreeGitReadinessBanner,
} from './WorktreeGitReadinessBanner';

import type { ActiveTeamRef } from './CreateTeamDialog';
import type { ProjectPathProject } from './projectPathProjects';
import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type { MentionSuggestion } from '@renderer/types/mention';
import type {
  CliProviderId,
  CreateScheduleInput,
  EffortLevel,
  ResolvedTeamMember,
  Schedule,
  ScheduleLaunchConfig,
  TeamCreateRequest,
  TeamFastMode,
  TeamLaunchRequest,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  UpdateSchedulePatch,
} from '@shared/types';

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

// =============================================================================
// Props — discriminated union
// =============================================================================

interface LaunchDialogBase {
  open: boolean;
  teamName: string;
  onClose: () => void;
}

export type TeamLaunchDialogMode = 'launch' | 'relaunch';

interface LaunchDialogLaunchMode extends LaunchDialogBase {
  mode: 'launch';
  members: ResolvedTeamMember[];
  defaultProjectPath?: string;
  provisioningError: string | null;
  clearProvisioningError?: (teamName?: string) => void;
  activeTeams?: ActiveTeamRef[];
  onLaunch: (request: TeamLaunchRequest) => Promise<void>;
}

interface LaunchDialogRelaunchMode extends LaunchDialogBase {
  mode: 'relaunch';
  members: ResolvedTeamMember[];
  defaultProjectPath?: string;
  provisioningError: string | null;
  clearProvisioningError?: (teamName?: string) => void;
  activeTeams?: ActiveTeamRef[];
  onRelaunch: (request: TeamLaunchRequest, members: TeamCreateRequest['members']) => Promise<void>;
}

interface LaunchDialogScheduleMode {
  mode: 'schedule';
  open: boolean;
  /** Team name — optional when creating from standalone schedules page */
  teamName?: string;
  onClose: () => void;
  /** When provided → edit mode; null/undefined → create mode */
  schedule?: Schedule | null;
}

export type LaunchTeamDialogProps =
  | LaunchDialogLaunchMode
  | LaunchDialogRelaunchMode
  | LaunchDialogScheduleMode;

const APP_TEAM_RUNTIME_DISALLOWED_TOOLS = 'TeamDelete,TodoWrite,TaskCreate,TaskUpdate';
const ANTHROPIC_AGENT_SDK_CREDIT_ARTICLE_URL =
  'https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan';

// =============================================================================
// Helpers
// =============================================================================

function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

function getStoredTeamProvider(): TeamProviderId {
  const stored = localStorage.getItem('team:lastSelectedProvider');
  return normalizeCreateLaunchProviderForUi(normalizeOptionalTeamProviderId(stored), true);
}

function normalizeOneShotProviderForMode(
  providerId: TeamProviderId | undefined,
  multimodelEnabled: boolean
): TeamProviderId {
  const normalizedProviderId = normalizeProviderForMode(providerId, multimodelEnabled);
  return normalizedProviderId === 'opencode' ? 'anthropic' : normalizedProviderId;
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

function getProviderLabel(providerId: TeamProviderId): string {
  return getCatalogTeamProviderLabel(providerId) ?? 'Anthropic';
}

function resolveMemberDraftRuntime(
  member: Pick<MemberDraft, 'providerId' | 'model' | 'effort'>,
  inheritedProviderId: TeamProviderId,
  inheritedModel: string,
  inheritedEffort: EffortLevel | undefined
): { providerId: TeamProviderId; model: string; effort: EffortLevel | undefined } {
  return {
    providerId: member.providerId ?? inheritedProviderId,
    model: member.model?.trim() || inheritedModel,
    effort: member.effort ?? inheritedEffort,
  };
}

function resolveResolvedMemberRuntime(
  member: Pick<ResolvedTeamMember, 'providerId' | 'model' | 'effort'>,
  inheritedProviderId: TeamProviderId,
  inheritedModel: string,
  inheritedEffort: EffortLevel | undefined
): { providerId: TeamProviderId; model: string; effort: EffortLevel | undefined } {
  return {
    providerId: normalizeOptionalTeamProviderId(member.providerId) ?? inheritedProviderId,
    model: member.model?.trim() || inheritedModel,
    effort: member.effort ?? inheritedEffort,
  };
}

function deriveTeammateWorktreeDefault(
  members: readonly {
    name: string;
    isolation?: 'worktree';
    removedAt?: number | string | null;
  }[]
): boolean {
  const activeTeammates = members.filter(
    (member) => !member.removedAt && member.name.trim().toLowerCase() !== 'team-lead'
  );
  return (
    activeTeammates.length > 0 && activeTeammates.every((member) => member.isolation === 'worktree')
  );
}

function buildWorktreePathByMemberName(
  members: readonly {
    name: string;
    isolation?: 'worktree';
    cwd?: string;
    removedAt?: number | string | null;
  }[]
): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const member of members) {
    const name = member.name.trim().toLowerCase();
    const cwd = member.cwd?.trim();
    if (!name || member.removedAt || member.isolation !== 'worktree' || !cwd) {
      continue;
    }
    paths[name] = cwd;
  }
  return paths;
}

// =============================================================================
// Component
// =============================================================================

export const LaunchTeamDialog = (props: LaunchTeamDialogProps): React.JSX.Element => {
  const { open, onClose } = props;
  const { isLight } = useTheme();
  const { t } = useAppTranslation('team');
  const multimodelEnabled = useStore((s) => s.appConfig?.general?.multimodelEnabled ?? true);
  const anthropicProviderFastModeDefault = useStore(
    (s) => s.appConfig?.providerConnections?.anthropic.fastModeDefault ?? false
  );
  const cliStatus = useStore((s) => s.cliStatus);
  const cliStatusLoading = useStore((s) => s.cliStatusLoading);
  const cliProviderStatusLoading = useStore((s) => s.cliProviderStatusLoading);
  const bootstrapCliStatus = useStore((s) => s.bootstrapCliStatus);
  const fetchCliStatus = useStore((s) => s.fetchCliStatus);
  const isLaunchMode = props.mode === 'launch' || props.mode === 'relaunch';
  const isRelaunch = props.mode === 'relaunch';
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
  const globalRuntimeProviderStatusById = useMemo(
    () =>
      new Map(
        (effectiveCliStatus?.providers ?? []).map(
          (provider) => [provider.providerId, provider] as const
        )
      ),
    [effectiveCliStatus?.providers]
  );
  const isSchedule = props.mode === 'schedule';
  const schedule = isSchedule ? (props.schedule ?? null) : null;
  const isEditing = isSchedule && !!schedule;

  // Team name: always present for launch mode, may be absent in schedule mode (standalone page)
  const propsTeamName = props.teamName ?? '';
  const [selectedTeamName, setSelectedTeamName] = useState('');
  const { teamByName, openDashboard } = useStore(
    useShallow((s) => ({
      teamByName: s.teamByName,
      openDashboard: s.openDashboard,
    }))
  );
  const openTeamTab = useStore((s) => s.openTeamTab);
  const teamOptions = useMemo(
    () =>
      Object.values(teamByName)
        .sort((a, b) => a.teamName.localeCompare(b.teamName))
        .map((team) => ({
          value: team.teamName,
          label: team.displayName || team.teamName,
          description: team.description || undefined,
          meta: { color: team.color },
        })),
    [teamByName]
  );

  // Effective team name: from props if provided, otherwise from local selection
  const effectiveTeamName = propsTeamName || selectedTeamName;
  const needsTeamSelector = isSchedule && !propsTeamName;

  // ---------------------------------------------------------------------------
  // Shared form state
  // ---------------------------------------------------------------------------

  const [cwdMode, setCwdMode] = useState<'project' | 'custom'>('project');
  const [selectedProjectPath, setSelectedProjectPath] = useState('');
  const [customCwd, setCustomCwd] = useState('');
  const promptDraft = useDraftPersistence({
    key: `launchTeam:${effectiveTeamName || 'standalone'}:${props.mode}:prompt`,
  });
  const chipDraft = useChipDraftPersistence(
    `launchTeam:${effectiveTeamName || 'standalone'}:${props.mode}:chips`
  );
  const [projects, setProjects] = useState<ProjectPathProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectsLoadRequested, setProjectsLoadRequested] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [selectedProviderId, setSelectedProviderIdRaw] = useState<TeamProviderId>(() =>
    isLaunchMode
      ? normalizeLeadProviderForMode(getStoredTeamProvider(), multimodelEnabled)
      : normalizeOneShotProviderForMode(getStoredTeamProvider(), multimodelEnabled)
  );
  const [selectedModel, setSelectedModelRaw] = useState(() =>
    getStoredTeamModel(
      isLaunchMode
        ? normalizeLeadProviderForMode(getStoredTeamProvider(), multimodelEnabled)
        : normalizeOneShotProviderForMode(getStoredTeamProvider(), multimodelEnabled)
    )
  );
  const [membersDrafts, setMembersDrafts] = useState<MemberDraft[]>([]);
  const [teammateWorktreeDefault, setTeammateWorktreeDefault] = useState(false);
  const [syncModelsWithLead, setSyncModelsWithLead] = useState(false);
  const [skipPermissions, setSkipPermissionsRaw] = useState(
    () => localStorage.getItem('team:lastSkipPermissions') !== 'false'
  );
  const [selectedEffort, setSelectedEffortRaw] = useState(() => {
    const stored = localStorage.getItem('team:lastSelectedEffort');
    return stored === null ? '' : stored;
  });
  const [selectedFastMode, setSelectedFastModeRaw] = useState<TeamFastMode>(getStoredTeamFastMode);
  const [anthropicRuntimeNotice, setAnthropicRuntimeNotice] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Launch-only state
  // ---------------------------------------------------------------------------

  const [limitContext, setLimitContextRaw] = useState(
    () => localStorage.getItem('team:lastLimitContext') === 'true'
  );
  const [conflictDismissed, setConflictDismissed] = useState(false);
  const [prepareState, setPrepareState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [prepareMessage, setPrepareMessage] = useState<string | null>(null);
  const [prepareWarnings, setPrepareWarnings] = useState<string[]>([]);
  const [prepareChecks, setPrepareChecks] = useState<ProvisioningProviderCheck[]>([]);
  const providerReadyById = useMemo(
    () => getProvisioningProviderReadyById(prepareChecks),
    [prepareChecks]
  );
  const [prepareProviderInvalidationEpochById, setPrepareProviderInvalidationEpochById] = useState<
    Partial<Record<TeamProviderId, number>>
  >({});
  const [providerSettingsProviderId, setProviderSettingsProviderId] =
    useState<TeamProviderId | null>(null);
  const prepareRequestSeqRef = useRef(0);
  const appliedDefaultProjectPathRef = useRef<string | null>(null);
  const storeMembers = useStore((s) => selectResolvedMembersForTeamName(s, s.selectedTeamName));
  const previousLaunchParams = useStore((s) =>
    effectiveTeamName ? s.launchParamsByTeam[effectiveTeamName] : undefined
  );
  const members = isLaunchMode ? props.members : storeMembers;
  const [savedLaunchProviderId, setSavedLaunchProviderId] = useState<TeamProviderId | null>(null);
  const [savedLaunchProviderBackendId, setSavedLaunchProviderBackendId] = useState<string | null>(
    null
  );

  useEffect(() => {
    if (!open) {
      setProviderSettingsProviderId(null);
    }
  }, [open]);

  // Advanced CLI section state (with localStorage persistence)
  const [worktreeEnabled, setWorktreeEnabledRaw] = useState(
    () =>
      localStorage.getItem(`team:lastWorktreeEnabled:${effectiveTeamName}`) === 'true' &&
      Boolean(localStorage.getItem(`team:lastWorktreeName:${effectiveTeamName}`))
  );
  const [worktreeName, setWorktreeNameRaw] = useState(
    () => localStorage.getItem(`team:lastWorktreeName:${effectiveTeamName}`) ?? ''
  );
  const [customArgs, setCustomArgsRaw] = useState(
    () => localStorage.getItem(`team:lastCustomArgs:${effectiveTeamName}`) ?? ''
  );

  // ---------------------------------------------------------------------------
  // Schedule-only state
  // ---------------------------------------------------------------------------

  const [schedLabel, setSchedLabel] = useState('');
  const [schedExpanded, setSchedExpanded] = useState(true);
  const [cronExpression, setCronExpression] = useState('0 9 * * 1-5');
  const [timezone, setTimezone] = useState(getLocalTimezone);
  const [warmUpMinutes, setWarmUpMinutes] = useState(15);
  const [maxTurns, setMaxTurns] = useState(50);
  const [maxBudgetUsd, setMaxBudgetUsd] = useState('');
  const [scheduleHydrationKey, setScheduleHydrationKey] = useState<string | null>(null);
  const [worktreePathByMemberName, setWorktreePathByMemberName] = useState<Record<string, string>>(
    {}
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
  const { cliStatus: projectScopedCliStatus, providerStatus: projectScopedOpenCodeStatus } =
    useEffectiveCliProviderStatus('opencode', {
      projectPath: effectiveCwd || null,
    });
  const runtimeProviderStatusById = useMemo(() => {
    const statuses = new Map(globalRuntimeProviderStatusById);
    if (effectiveCwd && projectScopedOpenCodeStatus) {
      statuses.set('opencode', projectScopedOpenCodeStatus);
    }
    return statuses;
  }, [effectiveCwd, globalRuntimeProviderStatusById, projectScopedOpenCodeStatus]);
  const effectiveMemberDrafts = useMemo(() => {
    const scopedMembers = syncModelsWithLead
      ? membersDrafts.map(clearMemberModelOverrides)
      : membersDrafts;
    return clearInheritedMemberModelsUnavailableForProvider({
      members: scopedMembers,
      selectedProviderId,
      runtimeProviderStatusById,
    }).members;
  }, [membersDrafts, runtimeProviderStatusById, selectedProviderId, syncModelsWithLead]);
  const tmuxRuntime = useTmuxRuntimeReadiness(open && isLaunchMode);
  const selectedMemberProviders = useMemo<TeamProviderId[]>(
    () =>
      !multimodelEnabled
        ? ['anthropic']
        : Array.from(
            new Set([
              selectedProviderId,
              ...effectiveMemberDrafts.flatMap((member) =>
                !member.removedAt && isTeamProviderId(member.providerId) ? [member.providerId] : []
              ),
            ])
          ),
    [effectiveMemberDrafts, multimodelEnabled, selectedProviderId]
  );
  const { requiredCatalogPending: openCodeCatalogPending } = useOpenCodeCatalogPrefetch({
    enabled: open && multimodelEnabled,
    projectPath: effectiveCwd || null,
    priority: selectedMemberProviders.includes('opencode') ? 'required' : 'background',
    deferBackground: prepareState === 'loading' || isSubmitting,
  });
  const hasSelectedAnthropicRuntime = isLaunchMode && selectedMemberProviders.includes('anthropic');
  const effectiveAnthropicRuntimeLimitContext =
    hasSelectedAnthropicRuntime && !isSchedule ? limitContext : false;

  const runtimeBackendSummaryByProvider = useMemo(() => {
    const entries: (readonly [TeamProviderId, string | null])[] = (
      projectScopedCliStatus?.providers ?? []
    ).map(
      (provider) =>
        [
          provider.providerId as TeamProviderId,
          getProvisioningProviderBackendSummary(provider),
        ] as const
    );
    return new Map<TeamProviderId, string | null>(entries);
  }, [projectScopedCliStatus?.providers]);
  const runtimeBackendSummaryByProviderRef = useRef(runtimeBackendSummaryByProvider);
  const prepareChecksRef = useRef<ProvisioningProviderCheck[]>([]);
  const prepareMessageRef = useRef<string | null>(null);
  const prepareModelResultsCacheRef = useRef(
    new Map<string, Record<string, ProviderPrepareDiagnosticsModelResult>>()
  );
  const lastPrepareProviderSignatureByIdRef = useRef(new Map<TeamProviderId, string>());
  const prepareProviderRequestSeqByIdRef = useRef(new Map<TeamProviderId, number>());
  const prepareWarningsByProviderIdRef = useRef(new Map<TeamProviderId, string[]>());

  useEffect(() => {
    runtimeBackendSummaryByProviderRef.current = runtimeBackendSummaryByProvider;
  }, [runtimeBackendSummaryByProvider]);
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
      prepareProviderRequestSeqByIdRef.current.clear();
      prepareWarningsByProviderIdRef.current.clear();
    }
  }, [open]);
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

  useEffect(() => {
    if (!open) {
      return;
    }

    setMembersDrafts((prev) => {
      const sanitized = clearInheritedMemberModelsUnavailableForProvider({
        members: prev,
        selectedProviderId,
        runtimeProviderStatusById,
      });
      return sanitized.changed ? sanitized.members : prev;
    });
  }, [membersDrafts, open, runtimeProviderStatusById, selectedProviderId]);

  useEffect(() => {
    if (multimodelEnabled) {
      return;
    }
    if (selectedProviderId !== 'anthropic') {
      setSelectedProviderIdRaw('anthropic');
      setSelectedModelRaw(getStoredTeamModel('anthropic'));
    }
    setMembersDrafts((prev) => {
      let changed = false;
      const next = prev.map((member) => {
        const normalized = normalizeMemberDraftForProviderMode(member, false);
        if (normalized !== member) changed = true;
        return normalized;
      });
      return changed ? next : prev;
    });
  }, [multimodelEnabled, selectedProviderId]);

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

  const handleCodexReconnect = React.useCallback(
    (mode: 'browser' | 'device_code' = 'browser') => {
      void (async () => {
        await codexAccount.startChatgptLogin(mode);
      })();
    },
    [codexAccount]
  );

  // Schedule store actions
  const createSchedule = useStore((s) => s.createSchedule);
  const updateSchedule = useStore((s) => s.updateSchedule);

  // ---------------------------------------------------------------------------
  // localStorage persistence wrappers
  // ---------------------------------------------------------------------------

  const setWorktreeEnabled = (value: boolean): void => {
    setWorktreeEnabledRaw(value);
    localStorage.setItem(`team:lastWorktreeEnabled:${effectiveTeamName}`, String(value));
    if (!value) {
      setWorktreeNameRaw('');
      localStorage.setItem(`team:lastWorktreeName:${effectiveTeamName}`, '');
    }
  };
  const setWorktreeName = (value: string): void => {
    setWorktreeNameRaw(value);
    localStorage.setItem(`team:lastWorktreeName:${effectiveTeamName}`, value);
  };
  const setCustomArgs = (value: string): void => {
    setCustomArgsRaw(value);
    localStorage.setItem(`team:lastCustomArgs:${effectiveTeamName}`, value);
  };

  const setSelectedProviderId = (value: TeamProviderId): void => {
    const normalizedValue = isLaunchMode
      ? normalizeLeadProviderForMode(value, multimodelEnabled)
      : normalizeOneShotProviderForMode(value, multimodelEnabled);
    const nextModel = getStoredTeamModel(normalizedValue);
    const nextEffort = getAvailableTeamEffortValue({
      providerId: normalizedValue,
      model: nextModel,
      limitContext: normalizedValue === 'anthropic' ? limitContext : false,
      providerStatus: runtimeProviderStatusById.get(normalizedValue),
      value: selectedEffort,
    });
    setSelectedProviderIdRaw(normalizedValue);
    localStorage.setItem('team:lastSelectedProvider', normalizedValue);
    setSelectedModelRaw(nextModel);
    if (nextEffort !== selectedEffort) {
      setSelectedEffortRaw(nextEffort);
      localStorage.setItem('team:lastSelectedEffort', nextEffort);
    }
  };

  const setSelectedModel = (value: string): void => {
    const normalizedValue = normalizeExplicitTeamModelForUi(selectedProviderId, value);
    const nextEffort = getAvailableTeamEffortValue({
      providerId: selectedProviderId,
      model: normalizedValue,
      limitContext: effectiveAnthropicRuntimeLimitContext,
      providerStatus: runtimeProviderStatusById.get(selectedProviderId),
      value: selectedEffort,
    });
    setSelectedModelRaw(normalizedValue);
    localStorage.setItem(`team:lastSelectedModel:${selectedProviderId}`, normalizedValue);
    if (nextEffort !== selectedEffort) {
      setSelectedEffortRaw(nextEffort);
      localStorage.setItem('team:lastSelectedEffort', nextEffort);
    }
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

  // ---------------------------------------------------------------------------
  // localStorage migration: schedule → team namespace (one-time)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const legacyTeamModel = localStorage.getItem('team:lastSelectedModel');
    if (
      legacyTeamModel != null &&
      localStorage.getItem('team:lastSelectedModel:anthropic') == null
    ) {
      localStorage.setItem('team:lastSelectedModel:anthropic', legacyTeamModel);
    }
    localStorage.removeItem('team:lastSelectedModel');

    for (const suffix of ['lastSelectedModel', 'lastSelectedEffort']) {
      const schedKey = `schedule:${suffix}`;
      const teamKey =
        suffix === 'lastSelectedModel' ? 'team:lastSelectedModel:anthropic' : `team:${suffix}`;
      const schedVal = localStorage.getItem(schedKey);
      if (schedVal != null && localStorage.getItem(teamKey) == null) {
        localStorage.setItem(teamKey, schedVal);
      }
      localStorage.removeItem(schedKey);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Form reset / populate
  // ---------------------------------------------------------------------------

  const resetFormState = (): void => {
    setLocalError(null);
    setIsSubmitting(false);
    setPrepareState('idle');
    setPrepareMessage(null);
    setPrepareWarnings([]);
    setPrepareChecks([]);
    setCwdMode('project');
    setSelectedProjectPath('');
    setCustomCwd('');
    setConflictDismissed(false);
    setMembersDrafts([]);
    setSyncModelsWithLead(false);
    chipDraft.clearChipDraft();
    // Schedule fields
    setSelectedTeamName('');
    setSchedLabel('');
    setCronExpression('0 9 * * 1-5');
    setTimezone(getLocalTimezone());
    setWarmUpMinutes(15);
    setMaxTurns(50);
    setMaxBudgetUsd('');
  };

  const closeDialog = (): void => {
    if (isLaunchMode) {
      resetFormState();
    }
    onClose();
  };

  // Populate form in schedule edit mode
  useEffect(() => {
    if (!open || !isSchedule) return;

    if (schedule) {
      // Edit mode — populate from existing schedule
      setSchedLabel(schedule.label ?? '');
      setCronExpression(schedule.cronExpression);
      setTimezone(schedule.timezone);
      setWarmUpMinutes(schedule.warmUpMinutes);
      setMaxTurns(schedule.maxTurns);
      setMaxBudgetUsd(schedule.maxBudgetUsd != null ? String(schedule.maxBudgetUsd) : '');
      promptDraft.setValue(schedule.launchConfig.prompt);
      setCustomCwd(schedule.launchConfig.cwd);
      setCwdMode('custom');
      const scheduleProviderId = normalizeOneShotProviderForMode(
        schedule.launchConfig.providerId,
        multimodelEnabled
      );
      const scheduleSourceProviderId = normalizeOptionalTeamProviderId(
        schedule.launchConfig.providerId
      );
      setSelectedProviderIdRaw(scheduleProviderId);
      setSelectedModelRaw(
        scheduleSourceProviderId !== 'gemini' &&
          scheduleSourceProviderId !== 'opencode' &&
          scheduleProviderId ===
            normalizeOneShotProviderForMode(schedule.launchConfig.providerId, true)
          ? (schedule.launchConfig.model ?? '')
          : getStoredTeamModel('anthropic')
      );
      setSkipPermissionsRaw(schedule.launchConfig.skipPermissions !== false);
      setSelectedEffortRaw(schedule.launchConfig.effort ?? '');
      setSelectedFastModeRaw(schedule.launchConfig.fastMode ?? getStoredTeamFastMode());
      setSavedLaunchProviderBackendId(schedule.launchConfig.providerBackendId ?? null);
      setScheduleHydrationKey(`${schedule.id}:${schedule.updatedAt ?? ''}`);
    } else {
      // Create mode — reset to defaults
      setSchedLabel('');
      setCronExpression('0 9 * * 1-5');
      setTimezone(getLocalTimezone());
      setWarmUpMinutes(15);
      setMaxTurns(50);
      setMaxBudgetUsd('');
      promptDraft.setValue('');
      setCwdMode('project');
      setSelectedProjectPath('');
      setCustomCwd('');
      const storedProviderId = normalizeOneShotProviderForMode(
        getStoredTeamProvider(),
        multimodelEnabled
      );
      setSelectedProviderIdRaw(storedProviderId);
      setSelectedModelRaw(getStoredTeamModel(storedProviderId));
      setSelectedEffortRaw('');
      setSelectedFastModeRaw(getStoredTeamFastMode());
      setSavedLaunchProviderBackendId(null);
      setScheduleHydrationKey(null);
    }

    setLocalError(null);
    setIsSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isSchedule, schedule?.id]);

  useEffect(() => {
    if (!open || !isLaunchMode) return;

    const immediateEditableMembers = filterEditableMemberInputs(members);
    if (immediateEditableMembers.length > 0) {
      setMembersDrafts(
        createMemberDraftsFromInputs(immediateEditableMembers).map((member) =>
          normalizeMemberDraftForProviderMode(member, multimodelEnabled)
        )
      );
      setWorktreePathByMemberName(buildWorktreePathByMemberName(immediateEditableMembers));
      setTeammateWorktreeDefault(deriveTeammateWorktreeDefault(immediateEditableMembers));
      setSyncModelsWithLead(
        !immediateEditableMembers.some(
          (member) => member.providerId || member.model || member.effort
        )
      );
    }

    let cancelled = false;
    void (async () => {
      let savedRequest = null;
      try {
        savedRequest = effectiveTeamName
          ? await api.teams.getSavedRequest(effectiveTeamName)
          : null;
      } catch {
        savedRequest = null;
      }
      if (cancelled) return;

      const editableMembersSource =
        members.length > 0
          ? filterEditableMemberInputs(members)
          : savedRequest?.members && savedRequest.members.length > 0
            ? filterEditableMemberInputs(savedRequest.members)
            : [];
      const storedEffort = localStorage.getItem('team:lastSelectedEffort');
      const savedProviderId = normalizeOptionalTeamProviderId(savedRequest?.providerId) ?? null;
      const savedProviderBackendId =
        typeof savedRequest?.providerBackendId === 'string' &&
        savedRequest.providerBackendId.trim().length > 0
          ? savedRequest.providerBackendId.trim()
          : null;
      const storedProviderId = normalizeLeadProviderForMode(
        getStoredTeamProvider(),
        multimodelEnabled
      );
      const launchPrefill = resolveLaunchDialogPrefill({
        members,
        savedRequest,
        previousLaunchParams,
        multimodelEnabled,
        storedProviderId,
        storedEffort: storedEffort === null ? '' : storedEffort,
        storedFastMode: getStoredTeamFastMode(),
        storedLimitContext: localStorage.getItem('team:lastLimitContext') === 'true',
        getStoredModel: getStoredTeamModel,
      });
      setSavedLaunchProviderId(savedProviderId);
      setSavedLaunchProviderBackendId(
        launchPrefill.providerBackendId ?? savedProviderBackendId ?? null
      );

      setMembersDrafts(
        createMemberDraftsFromInputs(editableMembersSource).map((member) =>
          normalizeMemberDraftForProviderMode(member, multimodelEnabled)
        )
      );
      setWorktreePathByMemberName(buildWorktreePathByMemberName(editableMembersSource));
      setTeammateWorktreeDefault(deriveTeammateWorktreeDefault(editableMembersSource));
      setSyncModelsWithLead(
        !editableMembersSource.some((member) => member.providerId || member.model || member.effort)
      );
      const leadProviderId = normalizeLeadProviderForMode(
        launchPrefill.providerId,
        multimodelEnabled
      );
      setSelectedProviderIdRaw(leadProviderId);
      setSelectedModelRaw(leadProviderId === launchPrefill.providerId ? launchPrefill.model : '');
      setSelectedEffortRaw(launchPrefill.effort);
      setSelectedFastModeRaw(launchPrefill.fastMode);
      setLimitContextRaw(launchPrefill.limitContext);
      setSkipPermissionsRaw(
        savedRequest?.skipPermissions ??
          localStorage.getItem('team:lastSkipPermissions') !== 'false'
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [open, isLaunchMode, effectiveTeamName, members, multimodelEnabled, previousLaunchParams]);

  const previousProviderId = useMemo<TeamProviderId | null>(() => {
    if (!isLaunchMode) {
      return null;
    }
    return (
      normalizeOptionalTeamProviderId(previousLaunchParams?.providerId) ?? savedLaunchProviderId
    );
  }, [isLaunchMode, previousLaunchParams?.providerId, savedLaunchProviderId]);

  const providerChangeForcesFreshLeadContext = useMemo(() => {
    if (!isLaunchMode || !previousProviderId) {
      return false;
    }
    return previousProviderId !== selectedProviderId;
  }, [isLaunchMode, previousProviderId, selectedProviderId]);

  const effectiveLeadRuntimeModel = useMemo(
    () =>
      computeEffectiveTeamModel(
        selectedModel,
        effectiveAnthropicRuntimeLimitContext,
        selectedProviderId,
        runtimeProviderStatusById.get(selectedProviderId)
      ) ?? '',
    [
      effectiveAnthropicRuntimeLimitContext,
      runtimeProviderStatusById,
      selectedModel,
      selectedProviderId,
    ]
  );
  const selectedProviderBackendId = useMemo(
    () =>
      resolveUiOwnedProviderBackendId(
        selectedProviderId,
        runtimeProviderStatusById.get(selectedProviderId)
      ) ??
      migrateProviderBackendId(
        selectedProviderId,
        previousLaunchParams?.providerBackendId ?? savedLaunchProviderBackendId
      ) ??
      undefined,
    [
      previousLaunchParams?.providerBackendId,
      runtimeProviderStatusById,
      savedLaunchProviderBackendId,
      selectedProviderId,
    ]
  );
  const teammateRuntimeCompatibility = useMemo(
    () =>
      analyzeTeammateRuntimeCompatibility({
        leadProviderId: selectedProviderId,
        leadProviderBackendId: selectedProviderBackendId,
        members: isLaunchMode ? effectiveMemberDrafts : [],
        extraCliArgs: isLaunchMode ? customArgs : undefined,
        tmuxStatus: tmuxRuntime.status,
        tmuxStatusLoading: tmuxRuntime.loading,
        tmuxStatusError: tmuxRuntime.error,
      }),
    [
      customArgs,
      effectiveMemberDrafts,
      isLaunchMode,
      selectedProviderBackendId,
      selectedProviderId,
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
              closeDialog();
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
              providerBackendId:
                resolveUiOwnedProviderBackendId('codex', runtimeProviderStatusById.get('codex')) ??
                migrateProviderBackendId(
                  'codex',
                  previousLaunchParams?.providerBackendId ?? savedLaunchProviderBackendId
                ) ??
                undefined,
            },
            selectedModel,
          })
        : null,
    [
      previousLaunchParams?.providerBackendId,
      runtimeProviderStatusById,
      savedLaunchProviderBackendId,
      selectedModel,
      selectedProviderId,
    ]
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

  useEffect(() => {
    if (isSchedule && schedule) {
      const nextHydrationKey = `${schedule.id}:${schedule.updatedAt ?? ''}`;
      if (scheduleHydrationKey !== nextHydrationKey) {
        return;
      }
    }

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
                    providerBackendId:
                      resolveUiOwnedProviderBackendId(
                        'codex',
                        runtimeProviderStatusById.get('codex')
                      ) ??
                      migrateProviderBackendId(
                        'codex',
                        previousLaunchParams?.providerBackendId ?? savedLaunchProviderBackendId
                      ) ??
                      undefined,
                  },
                  selectedModel,
                }),
              selectedFastMode,
            }),
          };

    const notices: string[] = [];
    if (selectedEffortForCurrentSelection !== selectedEffort) {
      setSelectedEffortRaw(selectedEffortForCurrentSelection);
      localStorage.setItem('team:lastSelectedEffort', selectedEffortForCurrentSelection);
    }
    if (reconciliation.nextEffort !== selectedEffortForCurrentSelection) {
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
    effectiveAnthropicRuntimeLimitContext,
    previousLaunchParams?.providerBackendId,
    runtimeProviderStatusById,
    savedLaunchProviderBackendId,
    selectedEffort,
    selectedEffortForCurrentSelection,
    selectedFastMode,
    selectedModel,
    selectedProviderId,
    schedule,
    scheduleHydrationKey,
    isSchedule,
  ]);

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

    if (selectedModel.trim()) {
      addModel(selectedProviderId, effectiveLeadRuntimeModel, leadEffort);
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
    effectiveLeadRuntimeModel,
    effectiveMemberDrafts,
    runtimeProviderStatusById,
    selectedEffortForCurrentSelection,
    selectedModel,
    selectedProviderId,
  ]);

  const runtimeChangeNotes = useMemo(() => {
    if (!isLaunchMode) {
      return [] as { key: string; memberName: string; message: string }[];
    }

    const notes: { key: string; memberName: string; message: string }[] = [];
    const previousLeadModel = previousLaunchParams?.model?.trim() || '';
    const previousLeadEffort = previousLaunchParams?.effort;
    const currentLeadDisplayModel = selectedModel.trim() || effectiveLeadRuntimeModel;

    if (
      previousProviderId &&
      (previousProviderId !== selectedProviderId ||
        previousLeadModel !== currentLeadDisplayModel ||
        (previousLeadEffort ?? '') !==
          ((selectedEffortForCurrentSelection as EffortLevel | '') || ''))
    ) {
      notes.push({
        key: 'lead',
        memberName: 'lead',
        message: `${formatTeamModelSummary(
          selectedProviderId,
          currentLeadDisplayModel,
          (selectedEffortForCurrentSelection as EffortLevel) || undefined
        )} instead of ${formatTeamModelSummary(
          previousProviderId,
          previousLeadModel,
          previousLeadEffort
        )}`,
      });
    }

    const previousMembersByName = new Map(
      members.map((member) => [member.name.trim().toLowerCase(), member] as const)
    );

    for (const member of effectiveMemberDrafts) {
      if (member.removedAt) {
        continue;
      }

      const name = member.name.trim();
      if (!name) {
        continue;
      }

      const previousMember = previousMembersByName.get(name.toLowerCase());
      if (!previousMember) {
        continue;
      }

      const {
        providerId: currentProviderId,
        model: currentModel,
        effort: currentEffort,
      } = resolveMemberDraftRuntime(
        member,
        selectedProviderId,
        currentLeadDisplayModel,
        (selectedEffortForCurrentSelection as EffortLevel) || undefined
      );

      const {
        providerId: previousProvider,
        model: previousModel,
        effort: previousEffort,
      } = resolveResolvedMemberRuntime(
        previousMember,
        previousProviderId ?? 'anthropic',
        previousLeadModel,
        previousLeadEffort
      );

      if (
        previousProvider === currentProviderId &&
        previousModel === currentModel &&
        (previousEffort ?? '') === (currentEffort ?? '') &&
        (previousMember.isolation ?? '') === (member.isolation ?? '')
      ) {
        continue;
      }

      const runtimeMessage =
        previousProvider !== currentProviderId ||
        previousModel !== currentModel ||
        (previousEffort ?? '') !== (currentEffort ?? '')
          ? `${formatTeamModelSummary(
              currentProviderId,
              currentModel,
              currentEffort
            )} instead of ${formatTeamModelSummary(previousProvider, previousModel, previousEffort)}`
          : null;
      const isolationMessage =
        previousMember.isolation !== member.isolation
          ? `${member.isolation === 'worktree' ? 'separate worktree' : 'shared workspace'} instead of ${
              previousMember.isolation === 'worktree' ? 'separate worktree' : 'shared workspace'
            }`
          : null;

      notes.push({
        key: `member:${name.toLowerCase()}`,
        memberName: name,
        message: [runtimeMessage, isolationMessage]
          .filter((part): part is string => Boolean(part))
          .join('; '),
      });
    }

    return notes;
  }, [
    isLaunchMode,
    previousLaunchParams?.effort,
    previousLaunchParams?.model,
    previousProviderId,
    selectedProviderId,
    selectedModel,
    effectiveLeadRuntimeModel,
    selectedEffortForCurrentSelection,
    members,
    effectiveMemberDrafts,
  ]);

  const runtimeChangeNoteByKey = useMemo(
    () => new Map(runtimeChangeNotes.map((note) => [note.key, note.message] as const)),
    [runtimeChangeNotes]
  );

  const leadRuntimeWarningText = useMemo(() => {
    const parts: string[] = [];
    if (providerChangeForcesFreshLeadContext && previousProviderId) {
      parts.push(
        `Provider changed from ${getProviderLabel(previousProviderId)} to ${getProviderLabel(selectedProviderId)}. The previous lead session will not be resumed and lead will start with a fresh context.`
      );
    }
    const runtimeChange = runtimeChangeNoteByKey.get('lead');
    if (runtimeChange) {
      parts.push(`Next launch will use ${runtimeChange}.`);
    }
    return parts.length > 0 ? parts.join(' ') : null;
  }, [
    providerChangeForcesFreshLeadContext,
    previousProviderId,
    selectedProviderId,
    runtimeChangeNoteByKey,
  ]);

  const memberRuntimeWarningById = useMemo(() => {
    const warnings: Record<string, string> = {};
    for (const member of effectiveMemberDrafts) {
      const name = member.name.trim();
      if (!name || member.removedAt) {
        continue;
      }
      const note = runtimeChangeNoteByKey.get(`member:${name.toLowerCase()}`);
      if (note) {
        warnings[member.id] = `Next launch will use ${note}.`;
      }
    }
    return warnings;
  }, [effectiveMemberDrafts, runtimeChangeNoteByKey]);
  const combinedMemberRuntimeWarningById = useMemo(() => {
    const warnings: Record<string, string> = { ...memberRuntimeWarningById };
    for (const [memberId, warning] of Object.entries(
      teammateRuntimeCompatibility.memberWarningById
    )) {
      warnings[memberId] = warnings[memberId] ? `${warnings[memberId]} ${warning}` : warning;
    }
    return warnings;
  }, [memberRuntimeWarningById, teammateRuntimeCompatibility.memberWarningById]);

  const memberWorktreeContinuationInfoById = useMemo(() => {
    if (!isLaunchMode) {
      return {};
    }

    const info: Record<string, string> = {};
    for (const member of effectiveMemberDrafts) {
      if (member.removedAt || member.isolation !== 'worktree') {
        continue;
      }
      const lookupName = (member.originalName?.trim() || member.name.trim()).toLowerCase();
      if (!lookupName) {
        continue;
      }
      const previousWorktreePath = worktreePathByMemberName[lookupName];
      if (!previousWorktreePath) {
        continue;
      }
      info[member.id] =
        `This teammate will continue from its existing worktree: ${previousWorktreePath}`;
    }

    return info;
  }, [effectiveMemberDrafts, isLaunchMode, worktreePathByMemberName]);

  // ---------------------------------------------------------------------------
  // Launch-only effects
  // ---------------------------------------------------------------------------

  const hasSelectedWorktreeIsolation =
    isLaunchMode &&
    effectiveMemberDrafts.some((member) => !member.removedAt && member.isolation === 'worktree');
  const worktreeGitReadiness = useWorktreeGitReadiness(
    effectiveCwd || null,
    open && hasSelectedWorktreeIsolation
  );
  const worktreeIsolationDisabledReason = isLaunchMode
    ? getWorktreeGitControlDisabledReason(worktreeGitReadiness)
    : null;
  const worktreeGitBlockingMessage = getWorktreeGitBlockingMessage(
    worktreeGitReadiness,
    hasSelectedWorktreeIsolation
  );
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

    if (!isLaunchMode) {
      return {
        modelAdvisoryReasonByProvider,
        modelIssueReasonByProvider,
        modelUnavailableReasonByProvider,
      };
    }

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
    isLaunchMode,
    prepareChecks,
    runtimeBackendSummaryByProvider,
    runtimeProviderStatusById,
    selectedModelChecksByProvider,
    selectedModelChecksByProviderSignature,
    selectedMemberProviders,
  ]);

  // Clear stale provisioning error when dialog opens
  useEffect(() => {
    if (!open || !isLaunchMode) return;
    props.clearProvisioningError?.(effectiveTeamName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isLaunchMode, effectiveTeamName]);

  // Warm up CLI for the currently selected working directory (launch mode only).
  useEffect(() => {
    if (!open || !isLaunchMode) {
      prepareRequestSeqRef.current += 1;
      lastPrepareProviderSignatureByIdRef.current.clear();
      prepareProviderRequestSeqByIdRef.current.clear();
      prepareWarningsByProviderIdRef.current.clear();
      return;
    }

    if (typeof api.teams.prepareProvisioning !== 'function') {
      prepareRequestSeqRef.current += 1;
      lastPrepareProviderSignatureByIdRef.current.clear();
      prepareProviderRequestSeqByIdRef.current.clear();
      prepareWarningsByProviderIdRef.current.clear();
      setPrepareState('failed');
      setPrepareWarnings([]);
      setPrepareChecks([]);
      setPrepareMessage(t('launch.prepare.unsupportedPreload'));
      return;
    }

    if (!effectiveCwd) {
      prepareRequestSeqRef.current += 1;
      lastPrepareProviderSignatureByIdRef.current.clear();
      prepareProviderRequestSeqByIdRef.current.clear();
      prepareWarningsByProviderIdRef.current.clear();
      setPrepareState('idle');
      setPrepareWarnings([]);
      setPrepareChecks([]);
      setPrepareMessage(t('launch.prepare.selectWorkingDirectory'));
      return;
    }

    const selectedProviderIdSet = new Set(selectedMemberProviders);
    for (const providerId of Array.from(lastPrepareProviderSignatureByIdRef.current.keys())) {
      if (!selectedProviderIdSet.has(providerId)) {
        lastPrepareProviderSignatureByIdRef.current.delete(providerId);
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
    const changedPlans = providerPlans.filter(
      (plan) =>
        lastPrepareProviderSignatureByIdRef.current.get(plan.providerId) !== plan.requestSignature
    );
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
        t('launch.prepare.someProvidersNeedAttention');
      setPrepareState(anyFailure ? 'failed' : 'ready');
      setPrepareMessage(
        anyFailure
          ? failureMessage
          : anyNotes
            ? t('launch.prepare.readyWithNotes')
            : t('launch.prepare.ready')
      );
    };

    let checks = alignProvisioningChecks(prepareChecksRef.current, selectedMemberProviders);
    for (const providerId of loadingProviderIds) {
      lastPrepareProviderSignatureByIdRef.current.delete(providerId);
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

    const generation = prepareRequestSeqRef.current;
    const runningPlans = changedPlans.map((plan) => {
      const requestSeq = (prepareProviderRequestSeqByIdRef.current.get(plan.providerId) ?? 0) + 1;
      prepareProviderRequestSeqByIdRef.current.set(plan.providerId, requestSeq);
      lastPrepareProviderSignatureByIdRef.current.set(plan.providerId, plan.requestSignature);
      return { ...plan, requestSeq };
    });
    const isPlanCurrent = (plan: ProviderPreparePlan & { requestSeq: number }): boolean =>
      prepareRequestSeqRef.current === generation &&
      lastPrepareProviderSignatureByIdRef.current.get(plan.providerId) === plan.requestSignature &&
      prepareProviderRequestSeqByIdRef.current.get(plan.providerId) === plan.requestSeq;

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
                const nextChecks = updateProviderCheck(prepareChecksRef.current, plan.providerId, {
                  status,
                  backendSummary: plan.backendSummary,
                  details,
                  supportDiagnostics: undefined,
                });
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
              error instanceof Error ? error.message : t('launch.prepare.failed');
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
  }, [
    open,
    isLaunchMode,
    effectiveCwd,
    effectiveAnthropicRuntimeLimitContext,
    prepareProviderInvalidationEpochById,
    runtimeProviderLoadingById,
    runtimeProviderStatusById,
    selectedMemberProviders,
    selectedModelChecksByProvider,
    selectedModelChecksByProviderSignature,
    t,
  ]);

  // ---------------------------------------------------------------------------
  // Shared effects: projects
  // ---------------------------------------------------------------------------

  const repositoryGroups = useStore(useShallow((s) => s.repositoryGroups));
  const defaultProjectPath = isLaunchMode ? props.defaultProjectPath : undefined;
  const shouldDeferProjectListLoad =
    isLaunchMode &&
    !projectsLoadRequested &&
    typeof defaultProjectPath === 'string' &&
    defaultProjectPath.length > 0 &&
    !isEphemeralProjectPath(defaultProjectPath);
  const requestProjectListLoad = useCallback(() => {
    setProjectsLoadRequested(true);
  }, []);

  useEffect(() => {
    if (!open) {
      setProjectsLoadRequested(false);
      return;
    }

    if (shouldDeferProjectListLoad && defaultProjectPath) {
      setProjects([syntheticProjectFromPath(defaultProjectPath)]);
      setProjectsLoading(false);
      setProjectsError(null);
      return;
    }

    setProjectsLoading(true);
    setProjectsError(null);

    let cancelled = false;
    void (async () => {
      try {
        const nextProjects = await loadProjectPathProjects({
          defaultProjectPath,
          repositoryGroups,
        });
        if (cancelled) return;

        setProjects(nextProjects);
      } catch (error) {
        if (cancelled) return;
        setProjectsError(
          error instanceof Error ? error.message : t('launch.errors.loadProjectsFailed')
        );
        setProjects([]);
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, repositoryGroups, defaultProjectPath, shouldDeferProjectListLoad, t]);

  // Pre-select defaultProjectPath (launch mode) or first project

  useEffect(() => {
    if (!open) {
      appliedDefaultProjectPathRef.current = null;
      return;
    }
    if (cwdMode !== 'project') return;
    const selectableProjects = projects.filter(isSelectableProjectPathProject);
    if (selectableProjects.length === 0) return;
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
    if (selectedProjectPath) return;
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

  // Pre-warm file list cache so @-mention file search is instant
  useFileListCacheWarmer(effectiveCwd || null);

  // ---------------------------------------------------------------------------
  // Launch-only: conflict detection
  // ---------------------------------------------------------------------------

  const activeTeams = isLaunchMode ? props.activeTeams : undefined;

  const conflictingTeam = useMemo(() => {
    if (!isLaunchMode || !activeTeams?.length || !effectiveCwd) return null;
    const norm = normalizePath(effectiveCwd);
    return (
      activeTeams.find(
        (t) => t.teamName !== effectiveTeamName && normalizePath(t.projectPath) === norm
      ) ?? null
    );
  }, [isLaunchMode, activeTeams, effectiveCwd, effectiveTeamName]);

  useEffect(() => {
    setConflictDismissed(false);
  }, [conflictingTeam?.teamName, effectiveCwd]);

  // ---------------------------------------------------------------------------
  // Mention suggestions (shared — from props in launch, from store in schedule)
  // ---------------------------------------------------------------------------

  const { suggestions: taskSuggestions } = useTaskSuggestions(null);
  const { suggestions: teamMentionSuggestions } = useTeamSuggestions(null);
  const memberColorMap = useMemo(
    () => buildMemberDraftColorMap(membersDrafts, members),
    [membersDrafts, members]
  );
  const mentionSuggestions = useMemo<MentionSuggestion[]>(
    () => buildMemberDraftSuggestions(membersDrafts, memberColorMap),
    [memberColorMap, membersDrafts]
  );

  // ---------------------------------------------------------------------------
  // Launch-only: internal args preview
  // ---------------------------------------------------------------------------

  const internalArgs = useMemo(() => {
    if (!isLaunchMode) return [];
    const args: string[] = [];
    args.push('--input-format', 'stream-json', '--output-format', 'stream-json');
    args.push('--verbose', '--setting-sources', 'user,project,local');
    args.push('--mcp-config', '<auto>', '--disallowedTools', APP_TEAM_RUNTIME_DISALLOWED_TOOLS);
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    const model = computeEffectiveTeamModel(
      selectedModel,
      effectiveAnthropicRuntimeLimitContext,
      selectedProviderId,
      runtimeProviderStatusById.get(selectedProviderId)
    );
    if (model) args.push('--model', model);
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
    isLaunchMode,
    skipPermissions,
    selectedModel,
    effectiveAnthropicRuntimeLimitContext,
    selectedEffortForCurrentSelection,
    selectedProviderId,
    runtimeProviderStatusById,
  ]);

  const launchOptionalSummary = useMemo(() => {
    if (!isLaunchMode) return [];

    const summary: string[] = [];
    if (promptDraft.value.trim()) summary.push('Lead prompt');
    const worktreeMemberCount = effectiveMemberDrafts.filter(
      (member) => !member.removedAt && member.isolation === 'worktree'
    ).length;
    if (worktreeMemberCount > 0) {
      summary.push(
        `${worktreeMemberCount} teammate worktree${worktreeMemberCount === 1 ? '' : 's'}`
      );
    }
    summary.push(`Provider: ${getProviderLabel(selectedProviderId)}`);
    if (selectedModel) summary.push(`Model: ${selectedModel}`);
    if (selectedEffortForCurrentSelection) {
      summary.push(`Effort: ${selectedEffortForCurrentSelection}`);
    }
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
    if (skipPermissions) summary.push('Auto-approve tools');
    summary.push('Fresh lead session');
    if (worktreeEnabled && worktreeName.trim()) summary.push(`Worktree: ${worktreeName.trim()}`);
    if (customArgs.trim()) summary.push('Custom CLI args');
    return summary;
  }, [
    isLaunchMode,
    effectiveMemberDrafts,
    promptDraft.value,
    selectedModel,
    selectedProviderId,
    selectedEffortForCurrentSelection,
    selectedFastMode,
    anthropicProviderFastModeDefault,
    effectiveAnthropicRuntimeLimitContext,
    skipPermissions,
    worktreeEnabled,
    worktreeName,
    customArgs,
  ]);

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (selectedProjectPathDeleted) {
      errors.push('Project folder no longer exists');
    } else if (!effectiveCwd) {
      errors.push('Working directory is required');
    }
    if (worktreeGitBlockingMessage) errors.push(worktreeGitBlockingMessage);
    if (isSchedule) {
      if (!effectiveTeamName) errors.push('Team is required');
      if (!promptDraft.value.trim()) errors.push('Prompt is required');
      if (!cronExpression.trim()) errors.push('Cron expression is required');
    }
    return errors;
  }, [
    effectiveCwd,
    selectedProjectPathDeleted,
    worktreeGitBlockingMessage,
    isSchedule,
    effectiveTeamName,
    promptDraft.value,
    cronExpression,
  ]);
  const modelValidationError = useMemo(() => {
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

    if (!isLaunchMode) {
      return null;
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
    isLaunchMode,
    runtimeProviderLoadingById,
    runtimeProviderStatusById,
    selectedModel,
    selectedProviderId,
  ]);
  const leadModelIssueText = useMemo(() => {
    const issue = getProvisioningModelIssue(
      prepareChecks,
      selectedProviderId,
      effectiveLeadRuntimeModel || selectedModel
    );
    return issue?.reason ?? issue?.detail ?? null;
  }, [effectiveLeadRuntimeModel, prepareChecks, selectedModel, selectedProviderId]);
  const memberModelIssueById = useMemo(() => {
    const next: Record<string, string> = {};
    if (!isLaunchMode) {
      return next;
    }
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
    isLaunchMode,
    leadModelIssueText,
    prepareChecks,
    selectedProviderId,
    syncModelsWithLead,
  ]);
  const hasInvalidLaunchMemberNames = useMemo(
    () =>
      isLaunchMode &&
      membersDrafts.some(
        (member) => !member.name.trim() || validateMemberNameInline(member.name.trim()) !== null
      ),
    [isLaunchMode, membersDrafts]
  );
  const hasDuplicateLaunchMemberNames = useMemo(() => {
    if (!isLaunchMode) return false;
    const activeNames = membersDrafts
      .map((member) => member.name.trim().toLowerCase())
      .filter(Boolean);
    return new Set(activeNames).size !== activeNames.length;
  }, [isLaunchMode, membersDrafts]);

  // ---------------------------------------------------------------------------
  // Error
  // ---------------------------------------------------------------------------

  const provisioningError = isLaunchMode ? props.provisioningError : null;
  const activeError = localError ?? modelValidationError ?? provisioningError;
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
  const prepareBlocksLaunch = isLaunchMode && effectivePrepare.state === 'failed';
  const showCodexReconnectPrompt = shouldShowCodexReconnectPrompt({
    effectiveCliStatus,
    selectedProviderIds: selectedMemberProviders,
    prepareMessage: effectivePrepare.message,
    prepareChecks,
  });
  const launchInFlight = useStore((s) =>
    isLaunchMode && effectiveTeamName ? isTeamProvisioningActive(s, effectiveTeamName) : false
  );

  useEffect(() => {
    if (!open || !isLaunchMode || !effectiveTeamName || !launchInFlight) {
      return;
    }

    openTeamTab(effectiveTeamName, effectiveCwd || defaultProjectPath);
    closeDialog();
  }, [
    closeDialog,
    defaultProjectPath,
    effectiveCwd,
    effectiveTeamName,
    isLaunchMode,
    launchInFlight,
    open,
    openTeamTab,
  ]);

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  const handleSubmit = (): void => {
    if (validationErrors.length > 0) {
      setLocalError(validationErrors[0]);
      return;
    }
    if (modelValidationError) {
      setLocalError(modelValidationError);
      return;
    }
    if (prepareBlocksLaunch) {
      setLocalError(effectivePrepare.message ?? t('launch.prepare.failed'));
      return;
    }
    if (isLaunchMode && teammateRuntimeCompatibility.blocksSubmission) {
      setLocalError(teammateRuntimeCompatibility.message);
      return;
    }
    if (isLaunchMode && !effectiveCwd) {
      setLocalError(t('launch.validation.selectWorkingDirectory'));
      return;
    }
    if (
      isLaunchMode &&
      membersDrafts.some(
        (member) => !member.name.trim() || validateMemberNameInline(member.name.trim()) !== null
      )
    ) {
      setLocalError(t('launch.validation.fixMemberNames'));
      return;
    }
    if (isLaunchMode) {
      const activeNames = membersDrafts
        .map((member) => member.name.trim().toLowerCase())
        .filter(Boolean);
      if (new Set(activeNames).size !== activeNames.length) {
        setLocalError(t('launch.validation.memberNamesUnique'));
        return;
      }
    }
    setLocalError(null);
    setIsSubmitting(true);

    void (async () => {
      try {
        if (isLaunchMode) {
          const nextMembers = buildMembersFromDrafts(effectiveMemberDrafts, {
            inheritedProviderId: selectedProviderId,
          });
          const launchRequest: TeamLaunchRequest = {
            teamName: effectiveTeamName,
            cwd: effectiveCwd,
            prompt: promptDraft.value.trim() || undefined,
            providerId: selectedProviderId,
            providerBackendId:
              resolveUiOwnedProviderBackendId(
                selectedProviderId,
                runtimeProviderStatusById.get(selectedProviderId)
              ) ??
              selectedProviderBackendId ??
              undefined,
            model: computeEffectiveTeamModel(
              selectedModel,
              effectiveAnthropicRuntimeLimitContext,
              selectedProviderId,
              runtimeProviderStatusById.get(selectedProviderId)
            ),
            effort: (selectedEffortForCurrentSelection as EffortLevel) || undefined,
            fastMode:
              selectedProviderId === 'anthropic' || selectedProviderId === 'codex'
                ? selectedFastMode
                : undefined,
            limitContext: effectiveAnthropicRuntimeLimitContext,
            skipPermissions,
            worktree: worktreeEnabled && worktreeName.trim() ? worktreeName.trim() : undefined,
            extraCliArgs: customArgs.trim() || undefined,
          };
          if (isRelaunch) {
            await props.onRelaunch(launchRequest, nextMembers);
          } else {
            await api.teams.replaceMembers(effectiveTeamName, {
              members: nextMembers,
            });
            await props.onLaunch(launchRequest);
          }
          openTeamTab(effectiveTeamName, effectiveCwd || defaultProjectPath);
          closeDialog();
        } else {
          // Schedule mode: create or update
          const parsedBudget = maxBudgetUsd ? parseFloat(maxBudgetUsd) : undefined;
          const scheduleProviderBackendId =
            resolveUiOwnedProviderBackendId(
              selectedProviderId,
              runtimeProviderStatusById.get(selectedProviderId)
            ) ??
            selectedProviderBackendId ??
            undefined;
          const scheduleModel = computeEffectiveTeamModel(
            selectedModel,
            false,
            selectedProviderId,
            runtimeProviderStatusById.get(selectedProviderId)
          );
          const explicitScheduleEffort = selectedEffortForCurrentSelection
            ? (selectedEffortForCurrentSelection as EffortLevel)
            : undefined;
          const scheduleEffort =
            selectedProviderId === 'anthropic'
              ? (explicitScheduleEffort ?? anthropicRuntimeSelection?.defaultEffort ?? undefined)
              : explicitScheduleEffort;
          const launchConfig: ScheduleLaunchConfig = {
            cwd: effectiveCwd,
            prompt: promptDraft.value.trim(),
            providerId: selectedProviderId,
            providerBackendId: scheduleProviderBackendId,
            model: scheduleModel,
            effort: scheduleEffort,
            fastMode:
              selectedProviderId === 'anthropic' || selectedProviderId === 'codex'
                ? selectedFastMode
                : undefined,
            resolvedFastMode:
              selectedProviderId === 'anthropic'
                ? (anthropicFastModeResolution?.resolvedFastMode ?? false)
                : selectedProviderId === 'codex'
                  ? (codexFastModeResolution?.resolvedFastMode ?? false)
                  : undefined,
            skipPermissions,
          };

          if (isEditing && schedule) {
            const patch: UpdateSchedulePatch = {
              label: schedLabel.trim() || undefined,
              cronExpression: cronExpression.trim(),
              timezone,
              warmUpMinutes,
              maxTurns,
              maxBudgetUsd: parsedBudget,
              launchConfig,
            };
            await updateSchedule(schedule.id, patch);
          } else {
            const input: CreateScheduleInput = {
              teamName: effectiveTeamName,
              label: schedLabel.trim() || undefined,
              cronExpression: cronExpression.trim(),
              timezone,
              warmUpMinutes,
              maxTurns,
              maxBudgetUsd: parsedBudget,
              launchConfig,
            };
            await createSchedule(input);
          }
          closeDialog();
        }
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : isSchedule
              ? t('launch.errors.saveScheduleFailed')
              : isRelaunch
                ? t('launch.errors.relaunchFailed')
                : t('launch.errors.launchFailed');
        setLocalError(message);
        if (isLaunchMode) {
          console.error(
            isRelaunch
              ? 'Failed to relaunch team from dialog:'
              : 'Failed to launch team from dialog:',
            err
          );
        }
      } finally {
        setIsSubmitting(false);
      }
    })();
  };

  // ---------------------------------------------------------------------------
  // Disabled state
  // ---------------------------------------------------------------------------

  const isDisabled = isLaunchMode
    ? isSubmitting ||
      launchInFlight ||
      validationErrors.length > 0 ||
      !!modelValidationError ||
      hasInvalidLaunchMemberNames ||
      hasDuplicateLaunchMemberNames ||
      prepareBlocksLaunch ||
      teammateRuntimeCompatibility.blocksSubmission
    : isSubmitting || validationErrors.length > 0 || !!modelValidationError;

  // ---------------------------------------------------------------------------
  // Dynamic labels
  // ---------------------------------------------------------------------------

  const dialogTitle = isLaunchMode
    ? isRelaunch
      ? t('launch.title.relaunch')
      : t('launch.title.launch')
    : isEditing
      ? t('launch.title.editSchedule')
      : t('launch.title.createSchedule');

  const dialogDescription = isLaunchMode ? (
    isRelaunch ? (
      <>
        {t('launch.description.relaunchPrefix')}{' '}
        <span className="font-mono font-medium">{effectiveTeamName}</span>{' '}
        {t('launch.description.relaunchSuffix')}
      </>
    ) : (
      <>
        {t('launch.description.launchPrefix')}{' '}
        <span className="font-mono font-medium">{effectiveTeamName}</span>{' '}
        {t('launch.description.launchSuffix')}
      </>
    )
  ) : isEditing ? (
    t('launch.description.editSchedule', { team: effectiveTeamName })
  ) : effectiveTeamName ? (
    t('launch.description.createScheduleForTeam', { team: effectiveTeamName })
  ) : (
    t('launch.description.createSchedule')
  );

  const submitLabel = isLaunchMode
    ? isRelaunch
      ? t('launch.actions.relaunchTeam')
      : t('launch.actions.launchTeam')
    : isEditing
      ? t('launch.actions.saveChanges')
      : t('launch.actions.createSchedule');

  const submittingLabel = isLaunchMode
    ? isRelaunch
      ? t('launch.actions.relaunching')
      : t('launch.actions.launching')
    : isEditing
      ? t('launch.actions.saving')
      : t('launch.actions.creating');

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          closeDialog();
        }
      }}
    >
      <DialogContent
        className={isSchedule ? 'max-h-[90vh] max-w-[52rem] overflow-y-auto' : 'max-w-[52rem]'}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">{dialogTitle}</DialogTitle>
          <DialogDescription className="text-xs">{dialogDescription}</DialogDescription>
        </DialogHeader>

        {isRelaunch ? (
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
                <p className="font-medium">{t('launch.relaunchWarning.title')}</p>
                <p className="opacity-80">{t('launch.relaunchWarning.description')}</p>
              </div>
            </div>
          </div>
        ) : null}

        {/* Launch-only: Conflict warning */}
        {isLaunchMode && conflictingTeam && !conflictDismissed ? (
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
                  {t('launch.conflict.title', { team: conflictingTeam.displayName })}
                </p>
                <p className="opacity-80">{t('launch.conflict.description')}</p>
                <p className="text-[11px] opacity-70">
                  {t('launch.conflict.workingDirectory')}{' '}
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

        <div className="space-y-4">
          {/* ═══════════════════════════════════════════════════════════════════
              Schedule-only: Team selector (standalone mode)
              ═══════════════════════════════════════════════════════════════════ */}
          {needsTeamSelector ? (
            <div className="space-y-1.5">
              <Label className="text-xs">{t('launch.schedule.team')}</Label>
              <Combobox
                options={teamOptions}
                value={selectedTeamName}
                onValueChange={setSelectedTeamName}
                placeholder={t('launch.schedule.selectTeam')}
                searchPlaceholder={t('launch.schedule.searchTeams')}
                emptyMessage={
                  teamOptions.length === 0
                    ? t('launch.schedule.noTeams')
                    : t('launch.schedule.noMatches')
                }
                disabled={teamOptions.length === 0}
                renderOption={(option, isSelected) => {
                  const colorName = option.meta?.color as string | undefined;
                  const colorSet = colorName
                    ? getTeamColorSet(colorName)
                    : nameColorSet(option.label);
                  return (
                    <>
                      {isSelected ? (
                        <Check className="mr-2 size-3.5 shrink-0 text-[var(--color-text)]" />
                      ) : (
                        <span
                          className="mr-2 size-3.5 shrink-0 rounded-full"
                          style={{ backgroundColor: colorSet.text }}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          {isSelected ? (
                            <span
                              className="size-2 shrink-0 rounded-full"
                              style={{ backgroundColor: colorSet.text }}
                            />
                          ) : null}
                          <p className="truncate font-medium text-[var(--color-text)]">
                            {option.label}
                          </p>
                        </div>
                        {option.description ? (
                          <p className="truncate text-[var(--color-text-muted)]">
                            {option.description}
                          </p>
                        ) : null}
                      </div>
                    </>
                  );
                }}
              />
            </div>
          ) : null}

          {/* ═══════════════════════════════════════════════════════════════════
              Schedule-only: Schedule configuration section
              ═══════════════════════════════════════════════════════════════════ */}
          {isSchedule ? (
            <div
              className="rounded-lg border border-[var(--color-border-emphasis)] shadow-sm"
              style={{
                backgroundColor: isLight
                  ? 'color-mix(in srgb, var(--color-surface-overlay) 24%, white 76%)'
                  : 'var(--color-surface-overlay)',
              }}
            >
              <button
                type="button"
                className="flex w-full items-center gap-1.5 px-3 py-2 text-left"
                onClick={() => setSchedExpanded((v) => !v)}
              >
                {schedExpanded ? (
                  <ChevronDown className="size-3.5 shrink-0 text-[var(--color-text-muted)]" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-[var(--color-text-muted)]" />
                )}
                <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                  {t('launch.schedule.title')}
                </span>
                {!schedExpanded && (schedLabel || cronExpression) ? (
                  <span className="ml-auto truncate text-[11px] text-[var(--color-text-muted)] opacity-70">
                    {schedLabel || cronExpression}
                  </span>
                ) : null}
              </button>

              {schedExpanded ? (
                <div className="space-y-3 border-t border-[var(--color-border)] px-3 pb-3 pt-2">
                  {/* Label */}
                  <div className="space-y-1.5">
                    <Label htmlFor="schedule-label" className="label-optional">
                      {t('launch.schedule.labelOptional')}
                    </Label>
                    <Input
                      id="schedule-label"
                      className="h-8 text-xs"
                      value={schedLabel}
                      onChange={(e) => setSchedLabel(e.target.value)}
                      placeholder={t('launch.schedule.labelPlaceholder')}
                    />
                  </div>

                  {/* Cron + Timezone + Warmup */}
                  <CronScheduleInput
                    cronExpression={cronExpression}
                    onCronExpressionChange={setCronExpression}
                    timezone={timezone}
                    onTimezoneChange={setTimezone}
                    warmUpMinutes={warmUpMinutes}
                    onWarmUpMinutesChange={setWarmUpMinutes}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {/* ═══════════════════════════════════════════════════════════════════
              Shared: Working directory
              ═══════════════════════════════════════════════════════════════════ */}
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
            onProjectsDropdownOpen={requestProjectListLoad}
          />

          {/* ═══════════════════════════════════════════════════════════════════
              Launch: optional settings
              Schedule: prompt + execution defaults
              ═══════════════════════════════════════════════════════════════════ */}
          {isLaunchMode ? (
            <OptionalSettingsSection
              title={
                isRelaunch
                  ? t('launch.optionalSettings.relaunchTitle')
                  : t('launch.optionalSettings.title')
              }
              description={
                isRelaunch
                  ? t('launch.optionalSettings.relaunchDescription')
                  : t('launch.optionalSettings.description')
              }
              summary={launchOptionalSummary}
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
                      id="launch-fast-mode"
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
                        ) ??
                        migrateProviderBackendId(
                          'codex',
                          previousLaunchParams?.providerBackendId ?? savedLaunchProviderBackendId
                        ) ??
                        undefined
                      }
                      id="launch-fast-mode"
                    />
                    {anthropicRuntimeNotice ? (
                      <div className="bg-amber-500/8 flex items-start gap-2 rounded-md border border-amber-500/25 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
                        <Info className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
                        <p>{anthropicRuntimeNotice}</p>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <TeamRosterEditorSection
                  members={membersDrafts}
                  onMembersChange={setMembersDrafts}
                  validateMemberName={validateMemberNameInline}
                  showWorkflow
                  showJsonEditor
                  draftKeyPrefix={`launchTeam:${effectiveTeamName}`}
                  projectPath={effectiveCwd || null}
                  taskSuggestions={taskSuggestions}
                  teamSuggestions={teamMentionSuggestions}
                  existingMembers={members}
                  defaultProviderId={selectedProviderId}
                  inheritedProviderId={selectedProviderId}
                  inheritedModel={selectedModel}
                  inheritedEffort={(selectedEffortForCurrentSelection as EffortLevel) || undefined}
                  inheritModelSettingsByDefault
                  lockProviderModel={syncModelsWithLead}
                  forceInheritedModelSettings={syncModelsWithLead}
                  modelLockReason="This teammate is synced with the lead model. Turn off sync to set a custom provider, model, or effort."
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
                  onSyncModelsWithTeammatesChange={setSyncModelsWithLead}
                  showWorktreeIsolationControls
                  teammateWorktreeDefault={teammateWorktreeDefault}
                  worktreeIsolationDisabledReason={worktreeIsolationDisabledReason}
                  onTeammateWorktreeDefaultChange={setTeammateWorktreeDefault}
                  leadWarningText={leadRuntimeWarningText}
                  memberWarningById={combinedMemberRuntimeWarningById}
                  memberInfoById={memberWorktreeContinuationInfoById}
                  leadModelIssueText={leadModelIssueText}
                  memberModelIssueById={memberModelIssueById}
                  modelAdvisoryReasonByProvider={
                    shortLivedModelIssueReasons.modelAdvisoryReasonByProvider
                  }
                  modelIssueReasonByProvider={
                    shortLivedModelIssueReasons.modelIssueReasonByProvider
                  }
                  modelUnavailableReasonByProvider={
                    shortLivedModelIssueReasons.modelUnavailableReasonByProvider
                  }
                  softDeleteMembers
                  disableGeminiOption={isGeminiUiFrozen()}
                  headerBottom={
                    showRosterTeammateRuntimeCompatibility || hasSelectedWorktreeIsolation ? (
                      <div className="space-y-2">
                        {showRosterTeammateRuntimeCompatibility ? (
                          <TeammateRuntimeCompatibilityNotice
                            analysis={teammateRuntimeCompatibility}
                            onOpenDashboard={() => {
                              closeDialog();
                              openDashboard();
                            }}
                          />
                        ) : null}
                        {hasSelectedWorktreeIsolation ? (
                          <WorktreeGitReadinessBanner state={worktreeGitReadiness} />
                        ) : null}
                      </div>
                    ) : null
                  }
                />

                <div className="space-y-1.5">
                  <Label htmlFor="dialog-prompt" className="label-optional">
                    {t('launch.prompt.teamLeadOptional')}
                  </Label>
                  <MentionableTextarea
                    id="dialog-prompt"
                    className="min-h-[100px] text-xs"
                    minRows={4}
                    maxRows={12}
                    value={promptDraft.value}
                    onValueChange={promptDraft.setValue}
                    suggestions={mentionSuggestions}
                    projectPath={effectiveCwd || null}
                    chips={chipDraft.chips}
                    onChipRemove={chipDraft.removeChip}
                    onFileChipInsert={chipDraft.addChip}
                    placeholder={t('launch.prompt.teamLeadPlaceholder')}
                    footerRight={
                      promptDraft.isSaved ? (
                        <span className="text-[10px] text-[var(--color-text-muted)]">
                          {t('launch.prompt.saved')}
                        </span>
                      ) : null
                    }
                  />
                </div>

                <div>
                  <SkipPermissionsCheckbox
                    id="dialog-skip-permissions"
                    checked={skipPermissions}
                    onCheckedChange={setSkipPermissions}
                  />
                </div>

                <div className="space-y-2">
                  {providerChangeForcesFreshLeadContext ? (
                    <div
                      className="rounded-md border px-3 py-2 text-xs"
                      style={{
                        backgroundColor: 'var(--warning-bg)',
                        borderColor: 'var(--warning-border)',
                        color: 'var(--warning-text)',
                      }}
                    >
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        <p>
                          {t('launch.providerChanged', {
                            from: getProviderLabel(previousProviderId!),
                            to: getProviderLabel(selectedProviderId),
                          })}
                        </p>
                      </div>
                    </div>
                  ) : null}
                  <div
                    className="rounded-md border px-3 py-2 text-xs"
                    style={{
                      backgroundColor: 'var(--warning-bg)',
                      borderColor: 'var(--warning-border)',
                      color: 'var(--warning-text)',
                    }}
                  >
                    <div className="flex items-start gap-2">
                      <Info className="mt-0.5 size-3.5 shrink-0" />
                      <p>{t('launch.relaunchFreshSession')}</p>
                    </div>
                  </div>
                </div>

                <AdvancedCliSection
                  teamName={effectiveTeamName}
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
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="dialog-prompt">{t('launch.prompt.label')}</Label>
                <MentionableTextarea
                  id="dialog-prompt"
                  className="min-h-[100px] text-xs"
                  minRows={4}
                  maxRows={12}
                  value={promptDraft.value}
                  onValueChange={promptDraft.setValue}
                  suggestions={mentionSuggestions}
                  projectPath={effectiveCwd || null}
                  chips={chipDraft.chips}
                  onChipRemove={chipDraft.removeChip}
                  onFileChipInsert={chipDraft.addChip}
                  placeholder={t('launch.prompt.schedulePlaceholder')}
                  footerRight={
                    promptDraft.isSaved ? (
                      <span className="text-[10px] text-[var(--color-text-muted)]">
                        {t('launch.prompt.saved')}
                      </span>
                    ) : null
                  }
                />
                <p className="text-[11px] text-[var(--color-text-muted)]">
                  {t('launch.prompt.oneShotPrefix')} <code className="font-mono">claude -p</code>{' '}
                  {t('launch.prompt.oneShotSuffix')}
                </p>
                {selectedProviderId === 'anthropic' ? (
                  <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] leading-relaxed text-amber-100">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <p>
                      {t('launch.billing.prefix')} <code>claude -p</code>{' '}
                      {t('launch.billing.suffix')}{' '}
                      <a
                        href={ANTHROPIC_AGENT_SDK_CREDIT_ARTICLE_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:text-white"
                      >
                        {t('launch.billing.readArticle')}
                        <ExternalLink className="size-3" />
                      </a>
                      .
                    </p>
                  </div>
                ) : null}
              </div>

              <div>
                <TeamModelSelector
                  providerId={selectedProviderId}
                  onProviderChange={setSelectedProviderId}
                  value={selectedModel}
                  onValueChange={setSelectedModel}
                  projectPath={effectiveCwd || null}
                  id="dialog-model"
                  disableGeminiOption={isGeminiUiFrozen()}
                  providerDisabledReasonById={{
                    opencode: OPENCODE_ONE_SHOT_DISABLED_REASON,
                  }}
                  providerDisabledBadgeLabelById={{
                    opencode: OPENCODE_ONE_SHOT_DISABLED_BADGE_LABEL,
                  }}
                />
                <EffortLevelSelector
                  value={selectedEffortForCurrentSelection}
                  onValueChange={setSelectedEffort}
                  id="dialog-effort"
                  providerId={selectedProviderId}
                  model={selectedModel}
                  limitContext={effectiveAnthropicRuntimeLimitContext}
                />
                {selectedProviderId === 'anthropic' ? (
                  <div className="mt-2">
                    <AnthropicFastModeSelector
                      value={selectedFastMode}
                      onValueChange={setSelectedFastMode}
                      providerFastModeDefault={anthropicProviderFastModeDefault}
                      model={selectedModel}
                      limitContext={effectiveAnthropicRuntimeLimitContext}
                      id="dialog-fast-mode"
                    />
                    {anthropicRuntimeNotice ? (
                      <div className="bg-amber-500/8 mt-2 rounded-md border border-amber-500/25 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
                        {anthropicRuntimeNotice}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {selectedProviderId === 'codex' ? (
                  <div className="mt-2">
                    <CodexFastModeSelector
                      value={selectedFastMode}
                      onValueChange={setSelectedFastMode}
                      model={selectedModel}
                      providerBackendId={
                        resolveUiOwnedProviderBackendId(
                          'codex',
                          runtimeProviderStatusById.get('codex')
                        ) ??
                        migrateProviderBackendId(
                          'codex',
                          previousLaunchParams?.providerBackendId ?? savedLaunchProviderBackendId
                        ) ??
                        undefined
                      }
                      id="dialog-fast-mode"
                    />
                    {anthropicRuntimeNotice ? (
                      <div className="bg-amber-500/8 mt-2 rounded-md border border-amber-500/25 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
                        {anthropicRuntimeNotice}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <SkipPermissionsCheckbox
                  id="dialog-skip-permissions"
                  checked={skipPermissions}
                  onCheckedChange={setSkipPermissions}
                />
              </div>
            </>
          )}

          {/* ═══════════════════════════════════════════════════════════════════
              Schedule-only: Execution limits
              ═══════════════════════════════════════════════════════════════════ */}
          {isSchedule ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label
                  htmlFor="schedule-max-turns"
                  className="text-[11px] text-[var(--color-text-muted)]"
                >
                  {t('launch.schedule.maxTurns')}
                </Label>
                <Input
                  id="schedule-max-turns"
                  type="number"
                  min={1}
                  max={500}
                  className="h-8 text-xs"
                  value={maxTurns}
                  onChange={(e) => setMaxTurns(Math.max(1, parseInt(e.target.value) || 50))}
                />
              </div>

              <div className="space-y-1">
                <Label
                  htmlFor="schedule-max-budget"
                  className="text-[11px] text-[var(--color-text-muted)]"
                >
                  {t('launch.schedule.maxBudgetUsd')}
                </Label>
                <Input
                  id="schedule-max-budget"
                  type="number"
                  min={0}
                  step={0.5}
                  className="h-8 text-xs"
                  value={maxBudgetUsd}
                  onChange={(e) => setMaxBudgetUsd(e.target.value)}
                  placeholder={t('launch.schedule.noLimit')}
                />
              </div>
            </div>
          ) : null}
        </div>

        {/* Error display */}
        {activeError ? (
          <div className="flex items-start gap-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{activeError}</span>
          </div>
        ) : null}

        <DialogFooter className={isLaunchMode ? 'pt-4 sm:justify-between' : 'pt-4'}>
          {/* Launch-only: CLI warm-up status */}
          {isLaunchMode ? (
            <div className="min-w-0">
              <ProviderActivityStatusStrip
                cliStatus={effectiveCliStatus}
                sourceCliStatus={loadingCliStatus}
                cliStatusLoading={cliStatusLoading}
                cliProviderStatusLoading={cliProviderStatusLoading}
                multimodelEnabled={multimodelEnabled}
                codexSnapshotPending={codexSnapshotPending}
                providerIds={selectedMemberProviders}
                label="Selected providers"
                layout="stacked"
                showReadyProviders={
                  effectivePrepare.state === 'idle' || effectivePrepare.state === 'loading'
                }
                readyStatusText="Ready"
                className="mb-2"
              />
              {effectivePrepare.state === 'idle' || effectivePrepare.state === 'loading' ? (
                <>
                  <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                    <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    <div>
                      <span>
                        {effectivePrepare.message ??
                          (effectivePrepare.state === 'idle'
                            ? t('launch.prepare.checkingProviders')
                            : t('launch.prepare.preparingEnvironment'))}
                      </span>
                      <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)] opacity-70">
                        <span>
                          {t('launch.prepare.preflight', {
                            action: isRelaunch
                              ? t('launch.prepare.action.relaunch')
                              : t('launch.prepare.action.launch'),
                          })}
                        </span>
                      </p>
                    </div>
                  </div>
                  <ProvisioningProviderStatusList
                    checks={prepareChecks}
                    className="mt-2"
                    onOpenProviderSettings={(providerId) =>
                      setProviderSettingsProviderId(providerId)
                    }
                  />
                </>
              ) : null}

              {effectivePrepare.state === 'ready' ? (
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                    <CheckCircle2 className="size-3.5 shrink-0" />
                    <span>
                      {prepareChecks.some((check) => check.status === 'notes') ||
                      prepareWarnings.length > 0
                        ? t('launch.prepare.readyWithNotes')
                        : t('launch.prepare.ready')}
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
                    onOpenProviderSettings={(providerId) =>
                      setProviderSettingsProviderId(providerId)
                    }
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

              {effectivePrepare.state === 'failed' ? (
                <div className="text-xs">
                  <div className="flex items-start gap-2 text-red-300">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium">
                        {t('launch.prepare.blocked', {
                          action: isRelaunch
                            ? t('launch.prepare.action.relaunch')
                            : t('launch.prepare.action.launch'),
                        })}
                      </p>
                      <p className="mt-0.5 text-red-300/80">
                        {effectivePrepare.message ?? t('launch.prepare.failed')}
                      </p>
                      <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)] opacity-70">
                        {t('launch.prepare.preflight', {
                          action: isRelaunch
                            ? t('launch.prepare.action.relaunch')
                            : t('launch.prepare.action.launch'),
                        })}
                      </p>
                    </div>
                  </div>
                  {!shouldHideProvisioningProviderStatusList(
                    prepareChecks,
                    effectivePrepare.message
                  ) ? (
                    <ProvisioningProviderStatusList
                      checks={prepareChecks}
                      className="mt-2"
                      suppressDetailsMatching={effectivePrepare.message}
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
                  <div className="mt-1 flex items-center gap-2 pl-6">
                    <p className="text-[11px] text-[var(--color-text-muted)]">
                      {getProvisioningFailureHint(effectivePrepare.message, prepareChecks, t)}
                    </p>
                    {(effectivePrepare.message ?? '').toLowerCase().includes('spawn ') ||
                    prepareChecks.some((check) =>
                      check.details.some((detail) => detail.toLowerCase().includes('spawn '))
                    ) ? (
                      <button
                        type="button"
                        className="shrink-0 rounded bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-500"
                        onClick={() => {
                          closeDialog();
                          openDashboard();
                        }}
                      >
                        {t('launch.actions.goToDashboard')}
                      </button>
                    ) : null}
                  </div>
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
          ) : null}

          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={isDisabled}
              onClick={handleSubmit}
            >
              {isSubmitting || launchInFlight ? (
                <>
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  {submittingLabel}
                </>
              ) : (
                submitLabel
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
        disabled={isSubmitting || launchInFlight}
        onProviderRuntimeChanged={invalidatePrepareProvider}
      />
    </Dialog>
  );
};
