import React, { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import {
  buildMemberDraftColorMap,
  buildMemberDraftSuggestions,
  buildMembersFromDrafts,
  createMemberDraft,
  MembersEditorSection,
  validateMemberNameInline,
} from '@renderer/components/team/members/MembersEditorSection';
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
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useFileListCacheWarmer } from '@renderer/hooks/useFileListCacheWarmer';
import { useTaskSuggestions } from '@renderer/hooks/useTaskSuggestions';
import { useTeamSuggestions } from '@renderer/hooks/useTeamSuggestions';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';

import { AdvancedCliSection } from './AdvancedCliSection';
import { EffortLevelSelector } from './EffortLevelSelector';
import { LimitContextCheckbox } from './LimitContextCheckbox';
import { OptionalSettingsSection } from './OptionalSettingsSection';
import { ProjectPathSelector } from './ProjectPathSelector';
import { SkipPermissionsCheckbox } from './SkipPermissionsCheckbox';
import { getNextSuggestedTeamName } from './teamNameSets';
import { computeEffectiveTeamModel, TeamModelSelector } from './TeamModelSelector';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';

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

import type {
  EffortLevel,
  Project,
  TeamCreateRequest,
  TeamProvisioningMemberInput,
  TeamProvisioningPrepareResult,
} from '@shared/types';

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
const DEV_DEFAULT_TEAM = {
  teamName: 'signal-ops',
} as const;

const DEV_DEFAULT_MEMBERS: { name: string; roleSelection: string }[] = [
  { name: 'alice', roleSelection: 'reviewer' },
  { name: 'bob', roleSelection: 'developer' },
  { name: 'carol', roleSelection: 'developer' },
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
  const isDev = process.env.NODE_ENV !== 'production';
  const { isLight } = useTheme();

  const [teamName, setTeamName] = useState('');
  const descriptionDraft = useDraftPersistence({ key: 'createTeam:description' });
  const promptDraft = useDraftPersistence({ key: 'createTeam:prompt' });
  const promptChipDraft = useChipDraftPersistence('createTeam:prompt:chips');
  const [members, setMembers] = useState<MemberDraft[]>([]);
  const [cwdMode, setCwdMode] = useState<'project' | 'custom'>('project');
  const [selectedProjectPath, setSelectedProjectPath] = useState('');
  const [customCwd, setCustomCwd] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [prepareState, setPrepareState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [prepareMessage, setPrepareMessage] = useState<string | null>(null);
  const [prepareWarnings, setPrepareWarnings] = useState<string[]>([]);
  const prepareRequestSeqRef = useRef(0);
  const lastAutoDescriptionRef = useRef<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    teamName?: string;
    members?: string;
    cwd?: string;
  }>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [launchTeam, setLaunchTeam] = useState(true);
  const [soloTeam, setSoloTeam] = useState(false);
  const [teamColor, setTeamColor] = useState('');
  const [conflictDismissed, setConflictDismissed] = useState(false);
  const [selectedModel, setSelectedModelRaw] = useState(() => {
    const stored = localStorage.getItem('team:lastSelectedModel') ?? '';
    return stored === '__default__' ? '' : stored;
  });
  const [limitContext, setLimitContextRaw] = useState(
    () => localStorage.getItem('team:lastLimitContext') === 'true'
  );
  const [skipPermissions, setSkipPermissionsRaw] = useState(
    () => localStorage.getItem('team:lastSkipPermissions') !== 'false'
  );
  const [selectedEffort, setSelectedEffortRaw] = useState(
    () => localStorage.getItem('team:lastSelectedEffort') ?? ''
  );

  // Advanced CLI section state (use teamName-derived key for localStorage)
  const advancedKey = sanitizeTeamName(teamName.trim()) || '_new_';
  const [worktreeEnabled, setWorktreeEnabledRaw] = useState(false);
  const [worktreeName, setWorktreeNameRaw] = useState('');
  const [customArgs, setCustomArgsRaw] = useState('');

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
    setSelectedModelRaw(value);
    localStorage.setItem('team:lastSelectedModel', value);
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
    setConflictDismissed(false);
  };

  const resetFormState = (): void => {
    setTeamName('');
    lastAutoDescriptionRef.current = null;
    descriptionDraft.clearDraft();
    promptDraft.clearDraft();
    promptChipDraft.clearChipDraft();
    setMembers([]);
    setTeamColor('');
    setCwdMode('project');
    setSelectedProjectPath('');
    setCustomCwd('');
    setLaunchTeam(true);
    setSoloTeam(false);
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

  useEffect(() => {
    if (!open || !canCreate || !launchTeam) {
      return;
    }

    if (typeof api.teams.prepareProvisioning !== 'function') {
      setPrepareState('failed');
      setPrepareWarnings([]);
      setPrepareMessage(
        'Current preload version does not support team:prepareProvisioning. Restart the dev app.'
      );
      return;
    }

    if (!effectiveCwd) {
      setPrepareState('idle');
      setPrepareWarnings([]);
      setPrepareMessage('Select a working directory to validate the launch environment.');
      return;
    }

    let cancelled = false;
    const requestSeq = ++prepareRequestSeqRef.current;
    setPrepareState('loading');
    setPrepareMessage('Warming up CLI environment...');
    setPrepareWarnings([]);

    // Defer so file list fetch (triggered by project select) can run first
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const prepResult: TeamProvisioningPrepareResult =
            await api.teams.prepareProvisioning(effectiveCwd);
          if (cancelled || prepareRequestSeqRef.current !== requestSeq) return;
          setPrepareState(prepResult.ready ? 'ready' : 'failed');
          setPrepareMessage(prepResult.message);
          setPrepareWarnings(prepResult.warnings ?? []);
        } catch (error) {
          if (cancelled || prepareRequestSeqRef.current !== requestSeq) return;
          setPrepareState('failed');
          setPrepareWarnings([]);
          setPrepareMessage(
            error instanceof Error ? error.message : 'Failed to warm up Claude CLI environment'
          );
        }
      })();
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, canCreate, launchTeam, effectiveCwd]);

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
  }, [open]);

  useEffect(() => {
    if (!open) {
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
          return createMemberDraft({
            name: m.name,
            roleSelection: isCustom ? CUSTOM_ROLE : (m.role ?? ''),
            customRole: isCustom ? m.role : '',
            workflow: m.workflow,
          });
        })
      );
      return;
    }

    if (members.length > 0) {
      return;
    }

    if (isDev) {
      setMembers(
        DEV_DEFAULT_MEMBERS.map((member) =>
          createMemberDraft({
            name: member.name,
            roleSelection: member.roleSelection,
          })
        )
      );
      return;
    }

    setMembers([createMemberDraft()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialData is checked once on open
  }, [open]);

  useEffect(() => {
    if (!open || initialData) {
      return;
    }
    setTeamName((prev) => (prev.trim().length === 0 ? suggestedTeamName : prev));
  }, [initialData, open, suggestedTeamName]);

  useEffect(() => {
    if (!open || !isDev || initialData) {
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
  }, [descriptionDraft, initialData, isDev, open, suggestedTeamName, teamName]);

  // Pre-select defaultProjectPath when projects loaded (only while dialog is open)
  useEffect(() => {
    if (!open) return;
    if (cwdMode !== 'project') {
      return;
    }
    if (selectedProjectPath || projects.length === 0) {
      return;
    }
    if (defaultProjectPath) {
      const match = projects.find((p) => normalizePath(p.path) === defaultProjectPath);
      if (match) {
        setSelectedProjectPath(match.path);
        return;
      }
    }
    setSelectedProjectPath(projects[0].path);
  }, [open, cwdMode, projects, selectedProjectPath, defaultProjectPath]);

  useFileListCacheWarmer(effectiveCwd || null);

  const { suggestions: taskSuggestions } = useTaskSuggestions(null);
  const { suggestions: teamMentionSuggestions } = useTeamSuggestions(null);

  const description = descriptionDraft.value;
  const prompt = promptDraft.value;
  const memberColorMap = useMemo(() => buildMemberDraftColorMap(members), [members]);

  const mentionSuggestions = useMemo(
    () =>
      soloTeam
        ? [{ id: 'team-lead', name: 'team-lead', subtitle: 'Team Lead', color: 'blue' }]
        : buildMemberDraftSuggestions(members, memberColorMap),
    [memberColorMap, members, soloTeam]
  );

  const effectiveModel = useMemo(
    () => computeEffectiveTeamModel(selectedModel, limitContext),
    [selectedModel, limitContext]
  );

  const sanitizedTeamName = sanitizeTeamName(teamName.trim());
  const isNameProvisioning =
    provisioningTeamNames.includes(sanitizedTeamName) &&
    !existingTeamNames.includes(sanitizedTeamName);

  const request = useMemo<TeamCreateRequest>(
    () => ({
      teamName: sanitizedTeamName,
      description: description.trim() || undefined,
      color: teamColor || undefined,
      members: soloTeam ? [] : buildMembersFromDrafts(members),
      cwd: effectiveCwd,
      prompt: prompt.trim() || undefined,
      model: effectiveModel,
      effort: (selectedEffort as EffortLevel) || undefined,
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
      members,
      effectiveCwd,
      prompt,
      effectiveModel,
      selectedEffort,
      limitContext,
      skipPermissions,
      worktreeEnabled,
      worktreeName,
      customArgs,
    ]
  );

  const internalArgs = useMemo(() => {
    const args: string[] = [];
    args.push('--input-format', 'stream-json', '--output-format', 'stream-json');
    args.push('--verbose', '--setting-sources', 'user,project,local');
    args.push('--mcp-config', '<auto>', '--disallowedTools', 'TeamDelete,TodoWrite');
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    if (effectiveModel) args.push('--model', effectiveModel);
    if (selectedEffort) args.push('--effort', selectedEffort);
    return args;
  }, [skipPermissions, effectiveModel, selectedEffort]);

  const launchOptionalSummary = useMemo(() => {
    const summary: string[] = [];
    if (prompt.trim()) summary.push('Lead prompt');
    if (selectedModel) summary.push(`Model: ${selectedModel}`);
    if (selectedEffort) summary.push(`Effort: ${selectedEffort}`);
    if (limitContext) summary.push('Limited to 200K context');
    if (skipPermissions) summary.push('Auto-approve tools');
    if (worktreeEnabled && worktreeName.trim()) summary.push(`Worktree: ${worktreeName.trim()}`);
    if (customArgs.trim()) summary.push('Custom CLI args');
    return summary;
  }, [
    prompt,
    selectedModel,
    selectedEffort,
    limitContext,
    skipPermissions,
    worktreeEnabled,
    worktreeName,
    customArgs,
  ]);

  const teamDetailsSummary = useMemo(() => {
    const summary: string[] = [];
    if (description.trim()) summary.push('Description');
    if (teamColor) summary.push(`Color: ${teamColor}`);
    return summary;
  }, [description, teamColor]);

  const activeError = localError ?? provisioningErrorsByTeam[request.teamName] ?? null;
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
      const messages = Object.values(errors).filter(Boolean) as string[];
      setLocalError(messages.join(' · ') || 'Check form fields');
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
      const remaining = Object.values(rest).filter(Boolean) as string[];
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
      <DialogContent className="max-w-2xl">
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

        {canCreate && launchTeam && prepareState === 'failed' ? (
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
                {prepareWarnings.length > 0 ? (
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
                <p className="text-[11px] text-[var(--color-text-muted)]">
                  Make sure <span className="font-mono">claude</span> CLI is installed and available
                  in PATH, then reopen this dialog.
                </p>
              </div>
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
                (fieldErrors.teamName || allTakenTeamNames.includes(sanitizedTeamName)) &&
                  'border-[var(--field-error-border)] bg-[var(--field-error-bg)] focus-visible:ring-[var(--field-error-border)]'
              )}
              value={teamName}
              onChange={(event) => handleTeamNameChange(event.target.value)}
              placeholder={suggestedTeamName}
            />
            {allTakenTeamNames.includes(sanitizedTeamName) ? (
              <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
                {isNameProvisioning ? 'Team is currently launching' : 'Team name already exists'}
              </p>
            ) : validateTeamNameInline(teamName) ? (
              <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
                {validateTeamNameInline(teamName)}
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
            <MembersEditorSection
              members={members}
              onChange={setMembers}
              fieldError={fieldErrors.members}
              validateMemberName={validateMemberNameInline}
              showWorkflow
              showJsonEditor
              draftKeyPrefix="createTeam"
              projectPath={effectiveCwd || null}
              taskSuggestions={taskSuggestions}
              teamSuggestions={teamMentionSuggestions}
              hideContent={soloTeam}
              headerExtra={
                <div className="space-y-2">
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
                  {soloTeam && (
                    <div className="flex items-start gap-2 rounded-md border border-sky-500/20 bg-sky-500/5 px-3 py-2">
                      <Info className="mt-0.5 size-3.5 shrink-0 text-sky-400" />
                      <p className="text-[11px] leading-relaxed text-sky-300">
                        Only the team lead (main process) will be started &mdash; no teammates will
                        be spawned. Works like a regular Claude session but with access to the task
                        board for planning. Saves tokens by avoiding teammate coordination overhead.
                        You can add members later from the team settings.
                      </p>
                    </div>
                  )}
                </div>
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
                  description="Prompt, model, safety, and CLI overrides live here when you need them."
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

                    <div>
                      <TeamModelSelector
                        value={selectedModel}
                        onValueChange={setSelectedModel}
                        id="create-model"
                      />
                      <EffortLevelSelector
                        value={selectedEffort}
                        onValueChange={setSelectedEffort}
                        id="create-effort"
                      />
                      <LimitContextCheckbox
                        id="create-limit-context"
                        checked={limitContext}
                        onCheckedChange={setLimitContext}
                        disabled={selectedModel === 'haiku'}
                      />
                      <SkipPermissionsCheckbox
                        id="create-skip-permissions"
                        checked={skipPermissions}
                        onCheckedChange={setSkipPermissions}
                      />
                    </div>

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
            {canCreate && launchTeam && (prepareState === 'idle' || prepareState === 'loading') ? (
              <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                <span>
                  {prepareMessage ??
                    (prepareState === 'idle'
                      ? 'Warming up CLI environment...'
                      : 'Preparing environment...')}
                </span>
              </div>
            ) : null}

            {canCreate && launchTeam && prepareState === 'ready' ? (
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                  <CheckCircle2 className="size-3.5 shrink-0" />
                  <span>
                    {prepareWarnings.length > 0
                      ? 'CLI environment ready (with notes)'
                      : 'CLI environment ready'}
                  </span>
                </div>
                {prepareMessage ? (
                  <p className="mt-0.5 pl-5 text-[11px] text-[var(--color-text-muted)]">
                    {prepareMessage}
                  </p>
                ) : null}
                {prepareWarnings.length > 0 ? (
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
              disabled={!canCreate || isSubmitting || (launchTeam && prepareState !== 'ready')}
              onClick={handleSubmit}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  Creating...
                </>
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
