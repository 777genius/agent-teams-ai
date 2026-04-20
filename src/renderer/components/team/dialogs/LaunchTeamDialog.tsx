import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  mergeCodexCliStatusWithSnapshot,
  useCodexAccountSnapshot,
} from '@features/codex-account/renderer';
import { api } from '@renderer/api';
import { SkipPermissionsCheckbox } from '@renderer/components/team/dialogs/SkipPermissionsCheckbox';
import {
  buildMemberDraftColorMap,
  buildMemberDraftSuggestions,
  buildMembersFromDrafts,
  clearMemberModelOverrides,
  createMemberDraftsFromInputs,
  filterEditableMemberInputs,
  normalizeMemberDraftForProviderMode,
  normalizeProviderForMode,
  validateMemberNameInline,
} from '@renderer/components/team/members/MembersEditorSection';
import { TeamRosterEditorSection } from '@renderer/components/team/members/TeamRosterEditorSection';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
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
import { useFileListCacheWarmer } from '@renderer/hooks/useFileListCacheWarmer';
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
import { resolveUiOwnedProviderBackendId } from '@renderer/utils/providerBackendIdentity';
import { refreshCliStatusForCurrentMode } from '@renderer/utils/refreshCliStatus';
import { nameColorSet } from '@renderer/utils/projectColor';
import {
  getTeamModelSelectionError,
  normalizeExplicitTeamModelForUi,
} from '@renderer/utils/teamModelAvailability';
import { getTeamProviderLabel as getCatalogTeamProviderLabel } from '@renderer/utils/teamModelCatalog';
import { DEFAULT_PROVIDER_MODEL_SELECTION } from '@shared/utils/providerModelSelection';
import { isTeamProviderId, normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  RotateCcw,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { CronScheduleInput } from '../schedule/CronScheduleInput';

import { AdvancedCliSection } from './AdvancedCliSection';
import { EffortLevelSelector } from './EffortLevelSelector';
import { resolveLaunchDialogPrefill } from './launchDialogPrefill';
import { OptionalSettingsSection } from './OptionalSettingsSection';
import { ProjectPathSelector } from './ProjectPathSelector';
import { buildProviderPrepareModelCacheKey } from './providerPrepareCacheKey';
import {
  buildReusableProviderPrepareModelResults,
  getProviderPrepareCachedSnapshot,
  type ProviderPrepareDiagnosticsModelResult,
  runProviderPrepareDiagnostics,
} from './providerPrepareDiagnostics';
import { getProvisioningModelIssue } from './provisioningModelIssues';
import {
  failIncompleteProviderChecks,
  getPrimaryProvisioningFailureDetail,
  getProvisioningFailureHint,
  getProvisioningProviderBackendSummary,
  type ProvisioningProviderCheck,
  ProvisioningProviderStatusList,
  shouldHideProvisioningProviderStatusList,
  updateProviderCheck,
} from './ProvisioningProviderStatusList';
import {
  computeEffectiveTeamModel,
  formatTeamModelSummary,
  TeamModelSelector,
} from './TeamModelSelector';

import type { ActiveTeamRef } from './CreateTeamDialog';
import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type { MentionSuggestion } from '@renderer/types/mention';
import type {
  CreateScheduleInput,
  EffortLevel,
  Project,
  ResolvedTeamMember,
  Schedule,
  ScheduleLaunchConfig,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProviderId,
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

// =============================================================================
// Component
// =============================================================================

export const LaunchTeamDialog = (props: LaunchTeamDialogProps): React.JSX.Element => {
  const { open, onClose } = props;
  const { isLight } = useTheme();
  const multimodelEnabled = useStore((s) => s.appConfig?.general?.multimodelEnabled ?? true);
  const cliStatus = useStore((s) => s.cliStatus);
  const cliStatusLoading = useStore((s) => s.cliStatusLoading);
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
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [selectedProviderId, setSelectedProviderIdRaw] =
    useState<TeamProviderId>(getStoredTeamProvider);
  const [selectedModel, setSelectedModelRaw] = useState(() =>
    getStoredTeamModel(getStoredTeamProvider())
  );
  const [membersDrafts, setMembersDrafts] = useState<MemberDraft[]>([]);
  const [syncModelsWithLead, setSyncModelsWithLead] = useState(false);
  const [skipPermissions, setSkipPermissionsRaw] = useState(
    () => localStorage.getItem('team:lastSkipPermissions') !== 'false'
  );
  const [selectedEffort, setSelectedEffortRaw] = useState(() => {
    const stored = localStorage.getItem('team:lastSelectedEffort');
    return stored === null ? 'medium' : stored;
  });

  // ---------------------------------------------------------------------------
  // Launch-only state
  // ---------------------------------------------------------------------------

  const [limitContext, setLimitContextRaw] = useState(
    () => localStorage.getItem('team:lastLimitContext') === 'true'
  );
  const [clearContext, setClearContext] = useState(false);
  const [conflictDismissed, setConflictDismissed] = useState(false);
  const [prepareState, setPrepareState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [prepareMessage, setPrepareMessage] = useState<string | null>(null);
  const [prepareWarnings, setPrepareWarnings] = useState<string[]>([]);
  const [prepareChecks, setPrepareChecks] = useState<ProvisioningProviderCheck[]>([]);
  const prepareRequestSeqRef = useRef(0);
  const storeMembers = useStore((s) => selectResolvedMembersForTeamName(s, s.selectedTeamName));
  const previousLaunchParams = useStore((s) =>
    effectiveTeamName ? s.launchParamsByTeam[effectiveTeamName] : undefined
  );
  const members = isLaunchMode ? props.members : storeMembers;
  const [savedLaunchProviderId, setSavedLaunchProviderId] = useState<TeamProviderId | null>(null);
  const [savedLaunchProviderBackendId, setSavedLaunchProviderBackendId] = useState<string | null>(
    null
  );

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
  const effectiveMemberDrafts = useMemo(
    () => (syncModelsWithLead ? membersDrafts.map(clearMemberModelOverrides) : membersDrafts),
    [membersDrafts, syncModelsWithLead]
  );
  const selectedMemberProviders = useMemo<TeamProviderId[]>(
    () =>
      !multimodelEnabled
        ? ['anthropic']
        : Array.from(
            new Set([
              selectedProviderId,
              ...effectiveMemberDrafts.flatMap((member) =>
                isTeamProviderId(member.providerId) ? [member.providerId] : []
              ),
            ])
          ),
    [effectiveMemberDrafts, multimodelEnabled, selectedProviderId]
  );

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
  const runtimeBackendSummaryByProviderRef = useRef(runtimeBackendSummaryByProvider);
  const prepareChecksRef = useRef<ProvisioningProviderCheck[]>([]);
  const prepareModelResultsCacheRef = useRef(
    new Map<string, Record<string, ProviderPrepareDiagnosticsModelResult>>()
  );

  useEffect(() => {
    runtimeBackendSummaryByProviderRef.current = runtimeBackendSummaryByProvider;
  }, [runtimeBackendSummaryByProvider]);
  useEffect(() => {
    prepareChecksRef.current = prepareChecks;
  }, [prepareChecks]);
  useEffect(() => {
    if (!open) {
      prepareModelResultsCacheRef.current.clear();
    }
  }, [open]);
  const runtimeProviderStatusById = useMemo(
    () =>
      new Map(
        (effectiveCliStatus?.providers ?? []).map(
          (provider) => [provider.providerId, provider] as const
        )
      ),
    [effectiveCliStatus?.providers]
  );

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
    const normalizedValue = normalizeProviderForMode(value, multimodelEnabled);
    setSelectedProviderIdRaw(normalizedValue);
    localStorage.setItem('team:lastSelectedProvider', normalizedValue);
    if (normalizedValue !== 'anthropic') {
      setLimitContextRaw(false);
      localStorage.setItem('team:lastLimitContext', 'false');
    }
    setSelectedModelRaw(getStoredTeamModel(normalizedValue));
  };

  const setSelectedModel = (value: string): void => {
    const normalizedValue = normalizeExplicitTeamModelForUi(selectedProviderId, value);
    setSelectedModelRaw(normalizedValue);
    localStorage.setItem(`team:lastSelectedModel:${selectedProviderId}`, normalizedValue);
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
    setClearContext(false);
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
      const scheduleProviderId = normalizeProviderForMode(
        schedule.launchConfig.providerId,
        multimodelEnabled
      );
      setSelectedProviderIdRaw(scheduleProviderId);
      setSelectedModelRaw(
        schedule.launchConfig.providerId !== 'gemini' &&
          scheduleProviderId === normalizeProviderForMode(schedule.launchConfig.providerId, true)
          ? (schedule.launchConfig.model ?? '')
          : getStoredTeamModel('anthropic')
      );
      setSkipPermissionsRaw(schedule.launchConfig.skipPermissions !== false);
      setSelectedEffortRaw(schedule.launchConfig.effort ?? '');
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
      const storedProviderId = normalizeProviderForMode(getStoredTeamProvider(), multimodelEnabled);
      setSelectedProviderIdRaw(storedProviderId);
      setSelectedModelRaw(getStoredTeamModel(storedProviderId));
      setSelectedEffortRaw('medium');
    }

    setLocalError(null);
    setIsSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isSchedule, schedule?.id]);

  useEffect(() => {
    if (!open || !isLaunchMode) return;

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

      const nextMembersSource =
        members.length > 0
          ? members
          : savedRequest?.members && savedRequest.members.length > 0
            ? savedRequest.members
            : [];
      const editableMembersSource = filterEditableMemberInputs(nextMembersSource);
      const storedEffort = localStorage.getItem('team:lastSelectedEffort');
      const savedProviderId =
        savedRequest?.providerId === 'codex' || savedRequest?.providerId === 'gemini'
          ? savedRequest.providerId
          : savedRequest?.providerId === 'anthropic'
            ? 'anthropic'
            : null;
      const savedProviderBackendId =
        typeof savedRequest?.providerBackendId === 'string' &&
        savedRequest.providerBackendId.trim().length > 0
          ? savedRequest.providerBackendId.trim()
          : null;
      const storedProviderId = normalizeProviderForMode(getStoredTeamProvider(), multimodelEnabled);
      const launchPrefill = resolveLaunchDialogPrefill({
        members,
        savedRequest,
        previousLaunchParams,
        multimodelEnabled,
        storedProviderId,
        storedEffort: storedEffort === null ? 'medium' : storedEffort,
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
      setSyncModelsWithLead(
        !editableMembersSource.some((member) => member.providerId || member.model || member.effort)
      );
      setSelectedProviderIdRaw(launchPrefill.providerId);
      setSelectedModelRaw(launchPrefill.model);
      setSelectedEffortRaw(launchPrefill.effort);
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
    const fromLaunchParams = previousLaunchParams?.providerId;
    if (
      fromLaunchParams === 'anthropic' ||
      fromLaunchParams === 'codex' ||
      fromLaunchParams === 'gemini'
    ) {
      return fromLaunchParams;
    }
    return savedLaunchProviderId;
  }, [isLaunchMode, previousLaunchParams?.providerId, savedLaunchProviderId]);

  const providerChangeForcesFreshLeadContext = useMemo(() => {
    if (!isLaunchMode || !previousProviderId) {
      return false;
    }
    return previousProviderId !== selectedProviderId;
  }, [isLaunchMode, previousProviderId, selectedProviderId]);

  const effectiveLeadRuntimeModel = useMemo(
    () => computeEffectiveTeamModel(selectedModel, limitContext, selectedProviderId) ?? '',
    [selectedModel, limitContext, selectedProviderId]
  );
  const selectedModelChecksByProvider = useMemo(() => {
    const modelsByProvider = new Map<TeamProviderId, string[]>();
    const defaultSelectionByProvider = new Map<TeamProviderId, boolean>();
    const addModel = (providerId: TeamProviderId, model: string | undefined): void => {
      const trimmed = model?.trim() ?? '';
      if (!trimmed) {
        return;
      }
      const existing = modelsByProvider.get(providerId) ?? [];
      if (!existing.includes(trimmed)) {
        modelsByProvider.set(providerId, [...existing, trimmed]);
      }
    };
    const addDefaultSelection = (providerId: TeamProviderId): void => {
      if (
        providerId === 'codex' ||
        providerId === 'gemini' ||
        (providerId === 'anthropic' && selectedProviderId === 'anthropic')
      ) {
        defaultSelectionByProvider.set(providerId, true);
      }
    };

    if (selectedModel.trim()) {
      addModel(selectedProviderId, effectiveLeadRuntimeModel);
    } else {
      addDefaultSelection(selectedProviderId);
    }
    for (const member of effectiveMemberDrafts) {
      if (member.removedAt) {
        continue;
      }
      const providerId = normalizeOptionalTeamProviderId(member.providerId) ?? selectedProviderId;
      if (member.model?.trim()) {
        addModel(providerId, member.model);
      } else {
        addDefaultSelection(providerId);
      }
    }
    for (const providerId of defaultSelectionByProvider.keys()) {
      addModel(providerId, DEFAULT_PROVIDER_MODEL_SELECTION);
    }

    return modelsByProvider;
  }, [effectiveLeadRuntimeModel, effectiveMemberDrafts, selectedModel, selectedProviderId]);

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
        (previousLeadEffort ?? '') !== ((selectedEffort as EffortLevel | '') || ''))
    ) {
      notes.push({
        key: 'lead',
        memberName: 'lead',
        message: `${formatTeamModelSummary(
          selectedProviderId,
          currentLeadDisplayModel,
          (selectedEffort as EffortLevel) || undefined
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
        (selectedEffort as EffortLevel) || undefined
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
        (previousEffort ?? '') === (currentEffort ?? '')
      ) {
        continue;
      }

      notes.push({
        key: `member:${name.toLowerCase()}`,
        memberName: name,
        message: `${formatTeamModelSummary(
          currentProviderId,
          currentModel,
          currentEffort
        )} instead of ${formatTeamModelSummary(previousProvider, previousModel, previousEffort)}`,
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
    selectedEffort,
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

  // ---------------------------------------------------------------------------
  // Launch-only effects
  // ---------------------------------------------------------------------------

  const effectiveCwd = cwdMode === 'project' ? selectedProjectPath.trim() : customCwd.trim();

  // Clear stale provisioning error when dialog opens
  useEffect(() => {
    if (!open || !isLaunchMode) return;
    props.clearProvisioningError?.(effectiveTeamName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isLaunchMode, effectiveTeamName]);

  // Warm up CLI for the currently selected working directory (launch mode only).
  useEffect(() => {
    if (!open || !isLaunchMode) return;

    if (typeof api.teams.prepareProvisioning !== 'function') {
      setPrepareState('failed');
      setPrepareWarnings([]);
      setPrepareChecks([]);
      setPrepareMessage(
        'Current preload version does not support team:prepareProvisioning. Restart the dev app.'
      );
      return;
    }

    if (!effectiveCwd) {
      setPrepareState('idle');
      setPrepareWarnings([]);
      setPrepareChecks([]);
      setPrepareMessage('Select a working directory to validate the launch environment.');
      return;
    }

    let cancelled = false;
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
      let checks = initialChecks;
      const providerPlans = selectedMemberProviders.map((providerId) => {
        const selectedModelChecks = selectedModelChecksByProvider.get(providerId) ?? [];
        const backendSummary = runtimeBackendSummaryByProviderRef.current.get(providerId) ?? null;
        const cacheKey = buildProviderPrepareModelCacheKey({
          cwd: effectiveCwd,
          providerId,
          backendSummary,
          limitContext,
        });
        const cachedModelResultsById = prepareModelResultsCacheRef.current.get(cacheKey) ?? {};
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
        if (!cancelled && prepareRequestSeqRef.current === requestSeq) {
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
              onModelProgress: ({ details }) => {
                checks = updateProviderCheck(checks, plan.providerId, {
                  status: 'checking',
                  backendSummary: plan.backendSummary,
                  details,
                });
                if (!cancelled && prepareRequestSeqRef.current === requestSeq) {
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
          prepareModelResultsCacheRef.current.set(
            plan.cacheKey,
            buildReusableProviderPrepareModelResults(plan.prepResult.modelResultsById)
          );
          checks = updateProviderCheck(checks, plan.providerId, {
            status: plan.prepResult.status,
            backendSummary: plan.backendSummary,
            details: plan.prepResult.details,
          });
        }
        if (!cancelled && prepareRequestSeqRef.current === requestSeq) {
          setPrepareChecks(checks);
        }
        if (cancelled || prepareRequestSeqRef.current !== requestSeq) return;
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
        if (cancelled || prepareRequestSeqRef.current !== requestSeq) return;
        const failureMessage =
          error instanceof Error ? error.message : 'Failed to warm up Claude CLI environment';
        setPrepareState('failed');
        setPrepareWarnings([]);
        setPrepareChecks(failIncompleteProviderChecks(checks, failureMessage));
        setPrepareMessage(failureMessage);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    open,
    isLaunchMode,
    effectiveCwd,
    selectedProviderId,
    selectedMemberProviders,
    selectedModelChecksByProvider,
  ]);

  // ---------------------------------------------------------------------------
  // Shared effects: projects
  // ---------------------------------------------------------------------------

  const repositoryGroups = useStore(useShallow((s) => s.repositoryGroups));

  useEffect(() => {
    if (!open) return;

    setProjectsLoading(true);
    setProjectsError(null);

    let cancelled = false;
    void (async () => {
      try {
        const apiProjects = await api.getProjects();
        if (cancelled) return;

        const pathSet = new Set(apiProjects.map((p) => p.path));
        const extras: Project[] = [];
        for (const repo of repositoryGroups) {
          for (const wt of repo.worktrees) {
            if (!pathSet.has(wt.path)) {
              pathSet.add(wt.path);
              extras.push({
                id: wt.id,
                path: wt.path,
                name: wt.name,
                sessions: [],
                totalSessions: 0,
                createdAt: wt.createdAt ?? Date.now(),
              });
            }
          }
        }

        setProjects([...apiProjects, ...extras]);
      } catch (error) {
        if (cancelled) return;
        setProjectsError(error instanceof Error ? error.message : 'Failed to load projects');
        setProjects([]);
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, repositoryGroups]);

  // Pre-select defaultProjectPath (launch mode) or first project
  const defaultProjectPath = isLaunchMode ? props.defaultProjectPath : undefined;

  useEffect(() => {
    if (!open || cwdMode !== 'project' || selectedProjectPath || projects.length === 0) return;
    if (defaultProjectPath) {
      const match = projects.find((p) => p.path === defaultProjectPath);
      if (match) {
        setSelectedProjectPath(match.path);
        return;
      }
    }
    setSelectedProjectPath(projects[0].path);
  }, [open, cwdMode, projects, selectedProjectPath, defaultProjectPath]);

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
    const model = computeEffectiveTeamModel(selectedModel, limitContext, selectedProviderId);
    if (model) args.push('--model', model);
    if (selectedEffort) args.push('--effort', selectedEffort);
    if (!clearContext) args.push('--resume', '<previous>');
    return args;
  }, [
    isLaunchMode,
    skipPermissions,
    selectedModel,
    limitContext,
    selectedEffort,
    clearContext,
    selectedProviderId,
  ]);

  const launchOptionalSummary = useMemo(() => {
    if (!isLaunchMode) return [];

    const summary: string[] = [];
    if (promptDraft.value.trim()) summary.push('Lead prompt');
    summary.push(`Provider: ${getProviderLabel(selectedProviderId)}`);
    if (selectedModel) summary.push(`Model: ${selectedModel}`);
    if (selectedEffort) summary.push(`Effort: ${selectedEffort}`);
    if (selectedProviderId === 'anthropic' && limitContext) summary.push('Limited to 200K context');
    if (skipPermissions) summary.push('Auto-approve tools');
    if (clearContext) summary.push('Fresh session');
    if (worktreeEnabled && worktreeName.trim()) summary.push(`Worktree: ${worktreeName.trim()}`);
    if (customArgs.trim()) summary.push('Custom CLI args');
    return summary;
  }, [
    isLaunchMode,
    promptDraft.value,
    selectedModel,
    selectedProviderId,
    selectedEffort,
    limitContext,
    skipPermissions,
    clearContext,
    worktreeEnabled,
    worktreeName,
    customArgs,
  ]);

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (!effectiveCwd) errors.push('Working directory is required');
    if (isSchedule) {
      if (!effectiveTeamName) errors.push('Team is required');
      if (!promptDraft.value.trim()) errors.push('Prompt is required');
      if (!cronExpression.trim()) errors.push('Cron expression is required');
    }
    return errors;
  }, [effectiveCwd, isSchedule, effectiveTeamName, promptDraft.value, cronExpression]);
  const modelValidationError = useMemo(() => {
    const leadError = getTeamModelSelectionError(
      selectedProviderId,
      selectedModel,
      runtimeProviderStatusById.get(selectedProviderId)
    );
    if (leadError) {
      return leadError;
    }

    if (!isLaunchMode) {
      return null;
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
  }, [
    effectiveMemberDrafts,
    isLaunchMode,
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
    if (isLaunchMode && !effectiveCwd) {
      setLocalError('Select working directory (cwd)');
      return;
    }
    if (
      isLaunchMode &&
      membersDrafts.some(
        (member) => !member.name.trim() || validateMemberNameInline(member.name.trim()) !== null
      )
    ) {
      setLocalError('Fix member names before launch');
      return;
    }
    if (isLaunchMode) {
      const activeNames = membersDrafts
        .map((member) => member.name.trim().toLowerCase())
        .filter(Boolean);
      if (new Set(activeNames).size !== activeNames.length) {
        setLocalError('Member names must be unique before launch');
        return;
      }
    }
    setLocalError(null);
    setIsSubmitting(true);

    void (async () => {
      try {
        if (isLaunchMode) {
          const nextMembers = buildMembersFromDrafts(effectiveMemberDrafts);
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
              previousLaunchParams?.providerBackendId ??
              savedLaunchProviderBackendId ??
              undefined,
            model: computeEffectiveTeamModel(selectedModel, limitContext, selectedProviderId),
            effort: (selectedEffort as EffortLevel) || undefined,
            limitContext,
            clearContext: clearContext || undefined,
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
          const launchConfig: ScheduleLaunchConfig = {
            cwd: effectiveCwd,
            prompt: promptDraft.value.trim(),
            providerId: selectedProviderId,
            model: selectedModel || undefined,
            effort: (selectedEffort as EffortLevel) || undefined,
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
              ? 'Failed to save schedule'
              : isRelaunch
                ? 'Failed to relaunch team'
                : 'Failed to launch team';
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
      hasDuplicateLaunchMemberNames
    : isSubmitting || validationErrors.length > 0 || !!modelValidationError;

  // ---------------------------------------------------------------------------
  // Dynamic labels
  // ---------------------------------------------------------------------------

  const dialogTitle = isLaunchMode
    ? isRelaunch
      ? 'Relaunch Team'
      : 'Launch Team'
    : isEditing
      ? 'Edit Schedule'
      : 'Create Schedule';

  const dialogDescription = isLaunchMode ? (
    isRelaunch ? (
      <>
        Stop the current run for <span className="font-mono font-medium">{effectiveTeamName}</span>{' '}
        and start it again via local Claude CLI.
      </>
    ) : (
      <>
        Start team <span className="font-mono font-medium">{effectiveTeamName}</span> via local
        Claude CLI.
      </>
    )
  ) : isEditing ? (
    `Editing schedule for team "${effectiveTeamName}"`
  ) : effectiveTeamName ? (
    `Schedule automatic runs for team "${effectiveTeamName}"`
  ) : (
    'Schedule automatic Claude task execution'
  );

  const submitLabel = isLaunchMode
    ? isRelaunch
      ? 'Relaunch team'
      : 'Launch team'
    : isEditing
      ? 'Save Changes'
      : 'Create Schedule';

  const submittingLabel = isLaunchMode
    ? isRelaunch
      ? 'Relaunching...'
      : 'Launching...'
    : isEditing
      ? 'Saving...'
      : 'Creating...';

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
        className={isSchedule ? 'max-h-[90vh] max-w-3xl overflow-y-auto' : 'max-w-3xl'}
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
                <p className="font-medium">Relaunch will restart the current team run</p>
                <p className="opacity-80">
                  Saving these settings will stop the current team process, persist the updated
                  roster, and launch the team again with the new runtime.
                </p>
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

        <div className="space-y-4">
          {/* ═══════════════════════════════════════════════════════════════════
              Schedule-only: Team selector (standalone mode)
              ═══════════════════════════════════════════════════════════════════ */}
          {needsTeamSelector ? (
            <div className="space-y-1.5">
              <Label className="text-xs">Team</Label>
              <Combobox
                options={teamOptions}
                value={selectedTeamName}
                onValueChange={setSelectedTeamName}
                placeholder="Select a team..."
                searchPlaceholder="Search teams..."
                emptyMessage={
                  teamOptions.length === 0
                    ? 'No teams available. Create a team first.'
                    : 'No teams match your search.'
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
                  Schedule
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
                      Label (optional)
                    </Label>
                    <Input
                      id="schedule-label"
                      className="h-8 text-xs"
                      value={schedLabel}
                      onChange={(e) => setSchedLabel(e.target.value)}
                      placeholder="e.g., Daily code review, Nightly tests..."
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
          />

          {/* ═══════════════════════════════════════════════════════════════════
              Launch: optional settings
              Schedule: prompt + execution defaults
              ═══════════════════════════════════════════════════════════════════ */}
          {isLaunchMode ? (
            <OptionalSettingsSection
              title={isRelaunch ? 'Relaunch settings' : 'Optional launch settings'}
              description={
                isRelaunch
                  ? 'Review the roster and lead runtime before restarting the team.'
                  : 'Keep the launch flow focused on the project path and only expand this when you want extra control.'
              }
              summary={launchOptionalSummary}
            >
              <div className="space-y-4">
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
                  inheritedEffort={(selectedEffort as EffortLevel) || undefined}
                  inheritModelSettingsByDefault
                  lockProviderModel={syncModelsWithLead}
                  forceInheritedModelSettings={syncModelsWithLead}
                  modelLockReason="This teammate is synced with the lead model. Turn off sync to set a custom provider, model, or effort."
                  providerId={selectedProviderId}
                  model={selectedModel}
                  effort={(selectedEffort as EffortLevel) || undefined}
                  limitContext={limitContext}
                  onProviderChange={setSelectedProviderId}
                  onModelChange={setSelectedModel}
                  onEffortChange={setSelectedEffort}
                  onLimitContextChange={setLimitContext}
                  syncModelsWithTeammates={syncModelsWithLead}
                  onSyncModelsWithTeammatesChange={setSyncModelsWithLead}
                  leadWarningText={leadRuntimeWarningText}
                  memberWarningById={memberRuntimeWarningById}
                  leadModelIssueText={leadModelIssueText}
                  memberModelIssueById={memberModelIssueById}
                  softDeleteMembers
                  disableGeminiOption={isGeminiUiFrozen()}
                />

                <div className="space-y-1.5">
                  <Label htmlFor="dialog-prompt" className="label-optional">
                    Prompt for team lead (optional)
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
                    placeholder="Instructions for team lead..."
                    footerRight={
                      promptDraft.isSaved ? (
                        <span className="text-[10px] text-[var(--color-text-muted)]">Saved</span>
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
                          Provider changed from {getProviderLabel(previousProviderId!)} to{' '}
                          {getProviderLabel(selectedProviderId)}. The previous lead session will not
                          be resumed, and the lead will start with fresh context so the new runtime
                          is applied correctly.
                        </p>
                      </div>
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="clear-context"
                      checked={clearContext}
                      onCheckedChange={(checked) => setClearContext(checked === true)}
                    />
                    <Label
                      htmlFor="clear-context"
                      className="flex cursor-pointer items-center gap-1.5 text-xs font-normal text-text-secondary"
                    >
                      <RotateCcw className="size-3 shrink-0" />
                      Clear context (fresh session)
                    </Label>
                  </div>
                  {clearContext && (
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
                          The team lead will start a new session without resuming previous context.
                          All accumulated session memory and conversation history will not be
                          available.
                        </p>
                      </div>
                    </div>
                  )}
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
                <Label htmlFor="dialog-prompt">Prompt</Label>
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
                  placeholder="Instructions for Claude to execute on schedule..."
                  footerRight={
                    promptDraft.isSaved ? (
                      <span className="text-[10px] text-[var(--color-text-muted)]">Saved</span>
                    ) : null
                  }
                />
                <p className="text-[11px] text-[var(--color-text-muted)]">
                  This prompt will be passed to <code className="font-mono">claude -p</code> for
                  one-shot execution
                </p>
              </div>

              <div>
                <TeamModelSelector
                  providerId={selectedProviderId}
                  onProviderChange={setSelectedProviderId}
                  value={selectedModel}
                  onValueChange={setSelectedModel}
                  id="dialog-model"
                  disableGeminiOption={isGeminiUiFrozen()}
                />
                <EffortLevelSelector
                  value={selectedEffort}
                  onValueChange={setSelectedEffort}
                  id="dialog-effort"
                />
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
                  Max turns
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
                  Max budget (USD)
                </Label>
                <Input
                  id="schedule-max-budget"
                  type="number"
                  min={0}
                  step={0.5}
                  className="h-8 text-xs"
                  value={maxBudgetUsd}
                  onChange={(e) => setMaxBudgetUsd(e.target.value)}
                  placeholder="No limit"
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
              {prepareState === 'idle' || prepareState === 'loading' ? (
                <>
                  <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                    <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    <div>
                      <span>
                        {prepareMessage ??
                          (prepareState === 'idle'
                            ? 'Warming up CLI environment...'
                            : 'Preparing environment...')}
                      </span>
                      <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)] opacity-70">
                        <span>
                          Pre-flight check to catch errors before{' '}
                          {isRelaunch ? 'relaunch' : 'launch'}
                        </span>
                      </p>
                    </div>
                  </div>
                  <ProvisioningProviderStatusList checks={prepareChecks} className="mt-2" />
                </>
              ) : null}

              {prepareState === 'ready' ? (
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
                  {prepareMessage ? (
                    <p className="mt-0.5 pl-5 text-[11px] text-[var(--color-text-muted)]">
                      {prepareMessage}
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

              {prepareState === 'failed' ? (
                <div className="text-xs">
                  <div className="flex items-start gap-2 text-red-300">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium">
                        CLI environment is not available - {isRelaunch ? 'relaunch' : 'launch'} is
                        blocked
                      </p>
                      <p className="mt-0.5 text-red-300/80">
                        {prepareMessage ?? 'Failed to prepare environment'}
                      </p>
                      <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)] opacity-70">
                        Pre-flight check to catch errors before {isRelaunch ? 'relaunch' : 'launch'}
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
                  <div className="mt-1 flex items-center gap-2 pl-6">
                    <p className="text-[11px] text-[var(--color-text-muted)]">
                      {getProvisioningFailureHint(prepareMessage, prepareChecks)}
                    </p>
                    {(prepareMessage ?? '').toLowerCase().includes('spawn ') ||
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
                        Go to Dashboard
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={closeDialog}>
              {isLaunchMode ? 'Close' : 'Cancel'}
            </Button>
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
    </Dialog>
  );
};
