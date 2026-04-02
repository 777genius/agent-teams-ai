import React, { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import {
  buildMemberDraftColorMap,
  buildMemberDraftSuggestions,
  buildMembersFromDrafts,
  clearMemberModelOverrides,
  createMemberDraftsFromInputs,
  validateMemberNameInline,
} from '@renderer/components/team/members/MembersEditorSection';
import { TeamRosterEditorSection } from '@renderer/components/team/members/TeamRosterEditorSection';
import { SkipPermissionsCheckbox } from '@renderer/components/team/dialogs/SkipPermissionsCheckbox';
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
import { normalizePath } from '@renderer/utils/pathNormalize';
import { nameColorSet } from '@renderer/utils/projectColor';
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

import { CronScheduleInput } from '../schedule/CronScheduleInput';

import { AdvancedCliSection } from './AdvancedCliSection';
import { EffortLevelSelector } from './EffortLevelSelector';
import { OptionalSettingsSection } from './OptionalSettingsSection';
import {
  createInitialProviderChecks,
  failIncompleteProviderChecks,
  getProvisioningFailureHint,
  ProvisioningProviderStatusList,
  shouldHideProvisioningProviderStatusList,
  updateProviderCheck,
  type ProvisioningProviderCheck,
} from './ProvisioningProviderStatusList';
import { ProjectPathSelector } from './ProjectPathSelector';
import { computeEffectiveTeamModel, TeamModelSelector } from './TeamModelSelector';

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
  TeamLaunchRequest,
  TeamProviderId,
  TeamProvisioningPrepareResult,
  UpdateSchedulePatch,
} from '@shared/types';

// =============================================================================
// Props — discriminated union
// =============================================================================

interface LaunchDialogBase {
  open: boolean;
  teamName: string;
  onClose: () => void;
}

interface LaunchDialogLaunchMode extends LaunchDialogBase {
  mode: 'launch';
  members: ResolvedTeamMember[];
  defaultProjectPath?: string;
  provisioningError: string | null;
  clearProvisioningError?: (teamName?: string) => void;
  activeTeams?: ActiveTeamRef[];
  onLaunch: (request: TeamLaunchRequest) => Promise<void>;
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

export type LaunchTeamDialogProps = LaunchDialogLaunchMode | LaunchDialogScheduleMode;

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
  return stored === 'codex' || stored === 'gemini' ? stored : 'anthropic';
}

function getStoredTeamModel(providerId: TeamProviderId): string {
  const stored = localStorage.getItem(`team:lastSelectedModel:${providerId}`);
  if (stored === null) {
    return providerId === 'anthropic' ? 'opus' : '';
  }
  return stored === '__default__' ? '' : stored;
}

function getProviderLabel(providerId: TeamProviderId): string {
  switch (providerId) {
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'anthropic':
    default:
      return 'Anthropic';
  }
}

// =============================================================================
// Component
// =============================================================================

export const LaunchTeamDialog = (props: LaunchTeamDialogProps): React.JSX.Element => {
  const { open, onClose } = props;
  const { isLight } = useTheme();
  const isLaunch = props.mode === 'launch';
  const isSchedule = props.mode === 'schedule';
  const schedule = isSchedule ? (props.schedule ?? null) : null;
  const isEditing = isSchedule && !!schedule;

  // Team name: always present for launch mode, may be absent in schedule mode (standalone page)
  const propsTeamName = props.teamName ?? '';
  const [selectedTeamName, setSelectedTeamName] = useState('');
  const teamByName = useStore((s) => s.teamByName);
  const openDashboard = useStore((s) => s.openDashboard);
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
  const storeMembers = useStore((s) => s.selectedTeamData?.members ?? []);
  const members = isLaunch ? props.members : storeMembers;

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
  const selectedMemberProviders = useMemo(
    () =>
      Array.from(
        new Set([
          selectedProviderId,
          ...effectiveMemberDrafts.flatMap((member) =>
            member.providerId === 'codex' || member.providerId === 'gemini'
              ? [member.providerId]
              : []
          ),
        ])
      ),
    [effectiveMemberDrafts, selectedProviderId]
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
    setSelectedProviderIdRaw(value);
    localStorage.setItem('team:lastSelectedProvider', value);
    if (value !== 'anthropic') {
      setLimitContextRaw(false);
      localStorage.setItem('team:lastLimitContext', 'false');
    }
    setSelectedModelRaw(getStoredTeamModel(value));
  };

  const setSelectedModel = (value: string): void => {
    setSelectedModelRaw(value);
    localStorage.setItem(`team:lastSelectedModel:${selectedProviderId}`, value);
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
      setSelectedProviderIdRaw(schedule.launchConfig.providerId ?? 'anthropic');
      setSelectedModelRaw(schedule.launchConfig.model ?? '');
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
      setSelectedProviderIdRaw(getStoredTeamProvider());
      setSelectedModelRaw(getStoredTeamModel(getStoredTeamProvider()));
      setSelectedEffortRaw('medium');
    }

    setLocalError(null);
    setIsSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isSchedule, schedule?.id]);

  useEffect(() => {
    if (!open || !isLaunch) return;

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

      const nextProviderId =
        savedRequest?.providerId === 'codex' || savedRequest?.providerId === 'gemini'
          ? savedRequest.providerId
          : 'anthropic';
      const providerFromSaved = Boolean(savedRequest?.providerId);
      const nextMembersSource =
        members.length > 0
          ? members
          : savedRequest?.members && savedRequest.members.length > 0
            ? savedRequest.members
            : [];
      const storedEffort = localStorage.getItem('team:lastSelectedEffort');

      setMembersDrafts(createMemberDraftsFromInputs(nextMembersSource));
      setSyncModelsWithLead(
        !nextMembersSource.some((member) => member.providerId || member.model || member.effort)
      );
      setSelectedProviderIdRaw(providerFromSaved ? nextProviderId : getStoredTeamProvider());
      setSelectedModelRaw(
        typeof savedRequest?.model === 'string'
          ? savedRequest.model
          : getStoredTeamModel(providerFromSaved ? nextProviderId : getStoredTeamProvider())
      );
      setSelectedEffortRaw(
        savedRequest?.effort ?? (storedEffort === null ? 'medium' : storedEffort)
      );
      setLimitContextRaw(
        savedRequest?.limitContext === true ||
          localStorage.getItem('team:lastLimitContext') === 'true'
      );
      setSkipPermissionsRaw(
        savedRequest?.skipPermissions ??
          localStorage.getItem('team:lastSkipPermissions') !== 'false'
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [open, isLaunch, effectiveTeamName, members]);

  // ---------------------------------------------------------------------------
  // Launch-only effects
  // ---------------------------------------------------------------------------

  const effectiveCwd = cwdMode === 'project' ? selectedProjectPath.trim() : customCwd.trim();

  // Clear stale provisioning error when dialog opens
  useEffect(() => {
    if (!open || !isLaunch) return;
    props.clearProvisioningError?.(effectiveTeamName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isLaunch, effectiveTeamName]);

  // Warm up CLI for the currently selected working directory (launch mode only).
  useEffect(() => {
    if (!open || !isLaunch) return;

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
    setPrepareState('loading');
    setPrepareMessage('Checking selected providers...');
    setPrepareWarnings([]);
    setPrepareChecks(createInitialProviderChecks(selectedMemberProviders));

    void (async () => {
      let checks = createInitialProviderChecks(selectedMemberProviders);
      let anyFailure = false;
      let anyNotes = false;
      const collectedWarnings: string[] = [];

      try {
        for (const providerId of selectedMemberProviders) {
          checks = updateProviderCheck(checks, providerId, {
            status: 'checking',
            details: [],
          });
          if (!cancelled && prepareRequestSeqRef.current === requestSeq) {
            setPrepareChecks(checks);
            setPrepareMessage(`Checking ${getProviderLabel(providerId)} runtime...`);
          }

          const prepResult: TeamProvisioningPrepareResult = await api.teams.prepareProvisioning(
            effectiveCwd,
            providerId,
            [providerId]
          );
          const detailLines = [
            ...(prepResult.warnings ?? []).filter(Boolean),
            ...(!prepResult.ready && prepResult.message ? [prepResult.message] : []),
          ];
          if (prepResult.warnings?.length) {
            anyNotes = true;
            collectedWarnings.push(
              ...prepResult.warnings.map((warning) => `${getProviderLabel(providerId)}: ${warning}`)
            );
          }
          if (!prepResult.ready) {
            anyFailure = true;
          }
          checks = updateProviderCheck(checks, providerId, {
            status: !prepResult.ready ? 'failed' : detailLines.length > 0 ? 'notes' : 'ready',
            details: detailLines,
          });
          if (!cancelled && prepareRequestSeqRef.current === requestSeq) {
            setPrepareChecks(checks);
          }
        }
        if (cancelled || prepareRequestSeqRef.current !== requestSeq) return;
        setPrepareState(anyFailure ? 'failed' : 'ready');
        setPrepareMessage(
          anyFailure
            ? 'Some selected providers need attention.'
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
  }, [open, isLaunch, effectiveCwd, selectedProviderId, selectedMemberProviders]);

  // ---------------------------------------------------------------------------
  // Shared effects: projects
  // ---------------------------------------------------------------------------

  const repositoryGroups = useStore((s) => s.repositoryGroups);

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
  const defaultProjectPath = isLaunch ? props.defaultProjectPath : undefined;

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

  const activeTeams = isLaunch ? props.activeTeams : undefined;

  const conflictingTeam = useMemo(() => {
    if (!isLaunch || !activeTeams?.length || !effectiveCwd) return null;
    const norm = normalizePath(effectiveCwd);
    return (
      activeTeams.find(
        (t) => t.teamName !== effectiveTeamName && normalizePath(t.projectPath) === norm
      ) ?? null
    );
  }, [isLaunch, activeTeams, effectiveCwd, effectiveTeamName]);

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
    if (!isLaunch) return [];
    const args: string[] = [];
    args.push('--input-format', 'stream-json', '--output-format', 'stream-json');
    args.push('--verbose', '--setting-sources', 'user,project,local');
    args.push('--mcp-config', '<auto>', '--disallowedTools', 'TeamDelete,TodoWrite');
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    const model = computeEffectiveTeamModel(selectedModel, limitContext, selectedProviderId);
    if (model) args.push('--model', model);
    if (selectedEffort) args.push('--effort', selectedEffort);
    if (!clearContext) args.push('--resume', '<previous>');
    return args;
  }, [
    isLaunch,
    skipPermissions,
    selectedModel,
    limitContext,
    selectedEffort,
    clearContext,
    selectedProviderId,
  ]);

  const launchOptionalSummary = useMemo(() => {
    if (!isLaunch) return [];

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
    isLaunch,
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

  // ---------------------------------------------------------------------------
  // Error
  // ---------------------------------------------------------------------------

  const provisioningError = isLaunch ? props.provisioningError : null;
  const activeError = localError ?? provisioningError;

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  const handleSubmit = (): void => {
    if (validationErrors.length > 0) {
      setLocalError(validationErrors[0]);
      return;
    }
    if (isLaunch && !effectiveCwd) {
      setLocalError('Select working directory (cwd)');
      return;
    }
    if (
      isLaunch &&
      membersDrafts.some(
        (member) => !member.name.trim() || validateMemberNameInline(member.name.trim()) !== null
      )
    ) {
      setLocalError('Fix member names before launch');
      return;
    }
    if (isLaunch) {
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
        if (isLaunch) {
          await api.teams.replaceMembers(effectiveTeamName, {
            members: buildMembersFromDrafts(effectiveMemberDrafts),
          });
          await props.onLaunch({
            teamName: effectiveTeamName,
            cwd: effectiveCwd,
            prompt: promptDraft.value.trim() || undefined,
            providerId: selectedProviderId,
            model: computeEffectiveTeamModel(selectedModel, limitContext, selectedProviderId),
            effort: (selectedEffort as EffortLevel) || undefined,
            limitContext,
            clearContext: clearContext || undefined,
            skipPermissions,
            worktree: worktreeEnabled && worktreeName.trim() ? worktreeName.trim() : undefined,
            extraCliArgs: customArgs.trim() || undefined,
          });
          resetFormState();
          onClose();
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
          onClose();
        }
      } catch (err) {
        if (isSchedule) {
          setLocalError(err instanceof Error ? err.message : 'Failed to save schedule');
        }
        // launch errors shown via provisioningError prop
      } finally {
        setIsSubmitting(false);
      }
    })();
  };

  // ---------------------------------------------------------------------------
  // Disabled state
  // ---------------------------------------------------------------------------

  const isDisabled = isLaunch
    ? isSubmitting || prepareState !== 'ready'
    : isSubmitting || validationErrors.length > 0;

  // ---------------------------------------------------------------------------
  // Dynamic labels
  // ---------------------------------------------------------------------------

  const dialogTitle = isLaunch ? 'Launch Team' : isEditing ? 'Edit Schedule' : 'Create Schedule';

  const dialogDescription = isLaunch ? (
    <>
      Start team <span className="font-mono font-medium">{effectiveTeamName}</span> via local Claude
      CLI.
    </>
  ) : isEditing ? (
    `Editing schedule for team "${effectiveTeamName}"`
  ) : effectiveTeamName ? (
    `Schedule automatic runs for team "${effectiveTeamName}"`
  ) : (
    'Schedule automatic Claude task execution'
  );

  const submitLabel = isLaunch ? 'Launch' : isEditing ? 'Save Changes' : 'Create Schedule';

  const submittingLabel = isLaunch ? 'Launching...' : isEditing ? 'Saving...' : 'Creating...';

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          if (isLaunch) resetFormState();
          onClose();
        }
      }}
    >
      <DialogContent
        className={isSchedule ? 'max-h-[90vh] max-w-2xl overflow-y-auto' : 'max-w-2xl'}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">{dialogTitle}</DialogTitle>
          <DialogDescription className="text-xs">{dialogDescription}</DialogDescription>
        </DialogHeader>

        {/* Launch-only: Conflict warning */}
        {isLaunch && conflictingTeam && !conflictDismissed ? (
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

        {/* Launch-only: CLI env failed */}
        {isLaunch && prepareState === 'failed' ? (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-400" />
              <div className="min-w-0 space-y-1">
                <p className="font-medium text-red-300">
                  CLI environment is not available — launch is blocked
                </p>
                <p className="text-red-300/80">
                  {prepareMessage ?? 'Failed to prepare environment'}
                </p>
                {!shouldHideProvisioningProviderStatusList(prepareChecks, prepareMessage) ? (
                  <ProvisioningProviderStatusList
                    checks={prepareChecks}
                    className="mt-1"
                    suppressDetailsMatching={prepareMessage}
                  />
                ) : null}
                {prepareWarnings.length > 0 && prepareChecks.length === 0 ? (
                  <div className="space-y-0.5">
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
                <div className="flex items-center gap-2 pt-1">
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
                        onClose();
                        openDashboard();
                      }}
                    >
                      Go to Dashboard
                    </button>
                  ) : null}
                </div>
              </div>
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

          {isLaunch ? (
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
            />
          ) : null}

          {/* ═══════════════════════════════════════════════════════════════════
              Launch: optional settings
              Schedule: prompt + execution defaults
              ═══════════════════════════════════════════════════════════════════ */}
          {isLaunch ? (
            <OptionalSettingsSection
              title="Optional launch settings"
              description="Keep the launch flow focused on the project path and only expand this when you want extra control."
              summary={launchOptionalSummary}
            >
              <div className="space-y-4">
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

        <DialogFooter className={isLaunch ? 'pt-4 sm:justify-between' : 'pt-4'}>
          {/* Launch-only: CLI warm-up status */}
          {isLaunch ? (
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
                        <span>Pre-flight check to catch errors before launch</span>
                        <button
                          type="button"
                          onClick={() => setPrepareState('ready')}
                          className="rounded px-1.5 py-0.5 text-[10px] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text-secondary)]"
                        >
                          Skip
                        </button>
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

              {prepareState === 'failed' ? <div /> : null}
            </div>
          ) : null}

          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              {isLaunch ? 'Close' : 'Cancel'}
            </Button>
            <Button
              size="sm"
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={isDisabled}
              onClick={handleSubmit}
            >
              {isSubmitting ? (
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
