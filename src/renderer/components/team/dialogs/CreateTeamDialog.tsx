import React, { useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import {
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
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useChipDraftPersistence } from '@renderer/hooks/useChipDraftPersistence';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useFileListCacheWarmer } from '@renderer/hooks/useFileListCacheWarmer';
import { cn } from '@renderer/lib/utils';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { getMemberColor } from '@shared/constants/memberColors';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';

import { ExtendedContextCheckbox } from './ExtendedContextCheckbox';
import { ProjectPathSelector } from './ProjectPathSelector';
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

import type { MentionSuggestion } from '@renderer/types/mention';
import type {
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
  provisioningError: string | null;
  clearProvisioningError?: () => void;
  existingTeamNames: string[];
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

import { CUSTOM_ROLE, NO_ROLE, PRESET_ROLES } from '@renderer/constants/teamRoles';
const DEV_DEFAULT_TEAM = {
  teamName: 'team-alpha',
  description: 'Dev test team for provisioning flow',
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
  provisioningError,
  clearProvisioningError,
  existingTeamNames,
  activeTeams,
  initialData,
  defaultProjectPath,
  onClose,
  onCreate,
  onOpenTeam,
}: CreateTeamDialogProps): React.JSX.Element => {
  const isDev = process.env.NODE_ENV !== 'production';

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
  const [extendedContext, setExtendedContextRaw] = useState(
    () => localStorage.getItem('team:lastExtendedContext') === 'true'
  );

  const setSelectedModel = (value: string): void => {
    setSelectedModelRaw(value);
    localStorage.setItem('team:lastSelectedModel', value);
  };

  const setExtendedContext = (value: boolean): void => {
    setExtendedContextRaw(value);
    localStorage.setItem('team:lastExtendedContext', String(value));
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

  // Clear stale provisioning error when dialog opens
  useEffect(() => {
    if (open) {
      clearProvisioningError?.();
    }
  }, [open, clearProvisioningError]);

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

    let cancelled = false;
    setPrepareState('loading');
    setPrepareMessage('Warming up CLI environment...');
    setPrepareWarnings([]);

    // Defer so file list fetch (triggered by project select) can run first
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const prepResult: TeamProvisioningPrepareResult = await api.teams.prepareProvisioning();
          if (cancelled) return;
          setPrepareState(prepResult.ready ? 'ready' : 'failed');
          setPrepareMessage(prepResult.message);
          setPrepareWarnings(prepResult.warnings ?? []);
        } catch (error) {
          if (cancelled) return;
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
  }, [open, canCreate, launchTeam]);

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
    if (!open || !isDev || initialData) {
      return;
    }
    setTeamName((prev) => (prev.trim().length === 0 ? DEV_DEFAULT_TEAM.teamName : prev));
    if (descriptionDraft.value.trim().length === 0) {
      descriptionDraft.setValue(DEV_DEFAULT_TEAM.description);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dev defaults applied once on open
  }, [open]);

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

  const effectiveCwd = cwdMode === 'project' ? selectedProjectPath.trim() : customCwd.trim();

  useFileListCacheWarmer(effectiveCwd || null);

  const description = descriptionDraft.value;
  const prompt = promptDraft.value;

  const mentionSuggestions = useMemo<MentionSuggestion[]>(
    () =>
      soloTeam
        ? [{ id: 'team-lead', name: 'team-lead', subtitle: 'Team Lead', color: 'blue' }]
        : members
            .filter((m) => m.name.trim())
            .map((m, index) => ({
              id: m.id,
              name: m.name.trim(),
              subtitle:
                m.roleSelection === CUSTOM_ROLE
                  ? m.customRole.trim() || undefined
                  : m.roleSelection && m.roleSelection !== NO_ROLE
                    ? m.roleSelection
                    : undefined,
              color: getMemberColor(index),
            })),
    [members, soloTeam]
  );

  const effectiveModel = useMemo(
    () => computeEffectiveTeamModel(selectedModel, extendedContext),
    [selectedModel, extendedContext]
  );

  const sanitizedTeamName = sanitizeTeamName(teamName.trim());

  const request = useMemo<TeamCreateRequest>(
    () => ({
      teamName: sanitizedTeamName,
      description: description.trim() || undefined,
      color: teamColor || undefined,
      members: soloTeam ? [] : buildMembersFromDrafts(members),
      cwd: effectiveCwd,
      prompt: prompt.trim() || undefined,
      model: effectiveModel,
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
    ]
  );

  const activeError = localError ?? provisioningError;
  const canOpenExistingTeam =
    activeError?.includes('Team already exists') === true && request.teamName.length > 0;

  const conflictingTeam = useMemo(() => {
    if (!activeTeams?.length || !effectiveCwd) return null;
    const norm = normalizePath(effectiveCwd);
    return activeTeams.find((t) => normalizePath(t.projectPath) === norm) ?? null;
  }, [activeTeams, effectiveCwd]);

  // Reset dismiss when conflict target changes
  useEffect(() => {
    setConflictDismissed(false);
  }, [conflictingTeam?.teamName, effectiveCwd]);

  const handleSubmit = (): void => {
    if (existingTeamNames.includes(sanitizedTeamName)) {
      setFieldErrors({ teamName: 'Team name already exists' });
      setLocalError('Check form fields');
      return;
    }
    const validation = validateRequest(request, { requireCwd: launchTeam });
    if (!validation.valid) {
      setFieldErrors(validation.errors ?? {});
      setLocalError('Check form fields');
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
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="font-medium text-amber-300">
                  Team &ldquo;{conflictingTeam.displayName}&rdquo; is already running in this
                  project
                </p>
                <p className="text-amber-300/80">
                  Running two teams in the same directory is risky — they may conflict editing the
                  same files. Consider using a different directory or a git worktree for isolation.
                </p>
              </div>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-amber-400/60 transition-colors hover:text-amber-300"
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
                      <p key={warning} className="text-[11px] text-amber-300">
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
          <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-300">
            Available only in local Electron mode.
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="team-name">Team name</Label>
            <Input
              id="team-name"
              className="h-8 text-xs"
              value={teamName}
              onChange={(event) => setTeamName(event.target.value)}
              placeholder="team-alpha"
            />
            {existingTeamNames.includes(sanitizedTeamName) ? (
              <p className="text-[11px] text-red-300">Team name already exists</p>
            ) : validateTeamNameInline(teamName) ? (
              <p className="text-[11px] text-red-300">{validateTeamNameInline(teamName)}</p>
            ) : fieldErrors.teamName ? (
              <p className="text-[11px] text-red-300">{fieldErrors.teamName}</p>
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

          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4 md:col-span-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="launch-team"
                checked={launchTeam}
                onCheckedChange={(checked) => setLaunchTeam(checked === true)}
              />
              <Label htmlFor="launch-team" className="cursor-pointer">
                Launch team
              </Label>
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
                    projectPath={effectiveCwd || null}
                    chips={promptChipDraft.chips}
                    onChipRemove={promptChipDraft.removeChip}
                    onFileChipInsert={promptChipDraft.addChip}
                    placeholder="Instructions for the team lead during provisioning..."
                    footerRight={
                      promptDraft.isSaved ? (
                        <span className="text-[10px] text-[var(--color-text-muted)]">
                          Draft saved
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
                  <ExtendedContextCheckbox
                    id="create-extended-context"
                    checked={extendedContext}
                    onCheckedChange={setExtendedContext}
                    disabled={selectedModel === 'haiku'}
                  />
                </div>

                {canCreate && (prepareState === 'idle' || prepareState === 'loading') ? (
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

                {canCreate && prepareState === 'ready' ? (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-xs text-emerald-400">
                      <CheckCircle2 className="size-3.5 shrink-0" />
                      <span>
                        {prepareWarnings.length > 0
                          ? 'CLI environment ready (with notes)'
                          : 'CLI environment ready'}
                      </span>
                    </div>
                    {prepareMessage ? (
                      <p className="text-[11px] text-[var(--color-text-muted)]">{prepareMessage}</p>
                    ) : null}
                    {prepareWarnings.length > 0 ? (
                      <div className="space-y-0.5">
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
            ) : null}
          </div>

          <div className="space-y-1.5 md:col-span-2">
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
              <span className="text-[10px] text-[var(--color-text-muted)]">Draft saved</span>
            ) : null}
          </div>

          <div className="space-y-1.5 md:col-span-2">
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
                      backgroundColor: colorSet.badge,
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

        {activeError ? (
          <p className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
            {activeError}
          </p>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-0">
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
