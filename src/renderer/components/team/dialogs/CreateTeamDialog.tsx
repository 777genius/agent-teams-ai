import React, { useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
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
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { cn } from '@renderer/lib/utils';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { getMemberColor } from '@shared/constants/memberColors';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';

import { MembersJsonEditor } from './MembersJsonEditor';
import { ProjectPathSelector } from './ProjectPathSelector';

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

interface MemberDraft {
  id: string;
  name: string;
  roleSelection: string;
  customRole: string;
}

const DEV_DEFAULT_MEMBERS: Pick<MemberDraft, 'name' | 'roleSelection'>[] = [
  { name: 'alice', roleSelection: 'reviewer' },
  { name: 'bob', roleSelection: 'developer' },
  { name: 'carol', roleSelection: 'developer' },
];

function newDraftId(): string {
  // eslint-disable-next-line sonarjs/pseudo-random -- Used for generating unique UI keys, not security
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createMemberDraft(initial?: Partial<MemberDraft>): MemberDraft {
  return {
    id: initial?.id ?? newDraftId(),
    name: initial?.name ?? '',
    roleSelection: initial?.roleSelection ?? '',
    customRole: initial?.customRole ?? '',
  };
}

function buildMembers(members: MemberDraft[]): TeamCreateRequest['members'] {
  return members
    .map((member) => {
      const name = member.name.trim();
      if (!name) {
        return null;
      }

      const role =
        member.roleSelection === CUSTOM_ROLE
          ? member.customRole.trim() || undefined
          : member.roleSelection === NO_ROLE
            ? undefined
            : member.roleSelection.trim() || undefined;

      return {
        name,
        role,
      };
    })
    .filter((member): member is NonNullable<typeof member> => member !== null);
}

function validateRequest(
  request: TeamCreateRequest,
  options?: { requireCwd?: boolean }
): ValidationResult {
  const requireCwd = options?.requireCwd ?? true;
  // eslint-disable-next-line security/detect-unsafe-regex -- kebab-case pattern is linear, no ReDoS
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.teamName) || request.teamName.length > 64) {
    return {
      valid: false,
      errors: {
        teamName: 'Use kebab-case [a-z0-9-], max 64 chars',
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
  if (request.members.length === 0) {
    return {
      valid: false,
      errors: {
        members: 'At least one member is required',
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
  const memberNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
  if (request.members.some((member) => !memberNamePattern.test(member.name.trim()))) {
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
  const [teamColor, setTeamColor] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [jsonEditorOpen, setJsonEditorOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  const resetUIState = (): void => {
    setLocalError(null);
    setFieldErrors({});
    setIsSubmitting(false);
    setPrepareState('idle');
    setPrepareMessage(null);
    setPrepareWarnings([]);
  };

  const resetFormState = (): void => {
    setTeamName('');
    descriptionDraft.clearDraft();
    promptDraft.clearDraft();
    setMembers([]);
    setTeamColor('');
    setCwdMode('project');
    setSelectedProjectPath('');
    setCustomCwd('');
    setLaunchTeam(true);
    setSelectedModel('');
    setJsonEditorOpen(false);
    setJsonText('');
    setJsonError(null);
    resetUIState();
  };

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

    void (async () => {
      try {
        const prepResult: TeamProvisioningPrepareResult = await api.teams.prepareProvisioning();
        if (cancelled) {
          return;
        }
        setPrepareState(prepResult.ready ? 'ready' : 'failed');
        setPrepareMessage(prepResult.message);
        setPrepareWarnings(prepResult.warnings ?? []);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setPrepareState('failed');
        setPrepareWarnings([]);
        setPrepareMessage(
          error instanceof Error ? error.message : 'Failed to warm up Claude CLI environment'
        );
      }
    })();

    return () => {
      cancelled = true;
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

  useEffect(() => {
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
  }, [cwdMode, projects, selectedProjectPath, defaultProjectPath]);

  const effectiveCwd = cwdMode === 'project' ? selectedProjectPath.trim() : customCwd.trim();

  const membersToJsonText = (drafts: MemberDraft[]): string => {
    const arr = drafts
      .filter((d) => d.name.trim())
      .map((d) => {
        const role =
          d.roleSelection === CUSTOM_ROLE
            ? d.customRole.trim() || undefined
            : d.roleSelection === NO_ROLE
              ? undefined
              : d.roleSelection.trim() || undefined;
        return role ? { name: d.name.trim(), role } : { name: d.name.trim() };
      });
    return JSON.stringify(arr, null, 2);
  };

  const handleJsonChange = (text: string): void => {
    setJsonText(text);
    try {
      const arr: unknown = JSON.parse(text);
      if (!Array.isArray(arr)) {
        setJsonError('Root must be an array');
        return;
      }
      const drafts: MemberDraft[] = (arr as Record<string, unknown>[]).map((item) => {
        const name = typeof item.name === 'string' ? item.name : '';
        const role = typeof item.role === 'string' ? item.role.trim() : '';
        const presetRoles: readonly string[] = PRESET_ROLES;
        const isPreset = presetRoles.includes(role);
        return createMemberDraft({
          name,
          roleSelection: role ? (isPreset ? role : CUSTOM_ROLE) : '',
          customRole: role && !isPreset ? role : '',
        });
      });
      setMembers(drafts);
      setJsonError(null);
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : 'Invalid JSON');
    }
  };

  const toggleJsonEditor = (): void => {
    if (!jsonEditorOpen) {
      setJsonText(membersToJsonText(members));
      setJsonError(null);
    }
    setJsonEditorOpen((prev) => !prev);
  };

  useEffect(() => {
    if (!jsonEditorOpen || jsonError !== null) return;
    setJsonText(membersToJsonText(members));
  }, [members, jsonEditorOpen, jsonError]);

  const description = descriptionDraft.value;
  const prompt = promptDraft.value;

  const mentionSuggestions = useMemo<MentionSuggestion[]>(
    () =>
      members
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
    [members]
  );

  const effectiveModel =
    selectedModel && selectedModel !== '__default__' ? selectedModel : undefined;

  const request = useMemo<TeamCreateRequest>(
    () => ({
      teamName: teamName.trim(),
      description: description.trim() || undefined,
      color: teamColor || undefined,
      members: buildMembers(members),
      cwd: effectiveCwd,
      prompt: prompt.trim() || undefined,
      model: effectiveModel,
    }),
    [teamName, description, teamColor, members, effectiveCwd, prompt, effectiveModel]
  );

  const activeError = localError ?? provisioningError;
  const canOpenExistingTeam =
    activeError?.includes('Team already exists') === true && request.teamName.length > 0;

  const conflictingTeam = useMemo(() => {
    if (!activeTeams?.length || !effectiveCwd) return null;
    const norm = normalizePath(effectiveCwd);
    return activeTeams.find((t) => normalizePath(t.projectPath) === norm) ?? null;
  }, [activeTeams, effectiveCwd]);

  const updateMemberName = (memberId: string, name: string): void => {
    setMembers((prev) =>
      prev.map((candidate) => (candidate.id === memberId ? { ...candidate, name } : candidate))
    );
  };

  const updateMemberRole = (memberId: string, roleSelection: string): void => {
    const resolvedRole = roleSelection === NO_ROLE ? '' : roleSelection;
    setMembers((prev) =>
      prev.map((candidate) =>
        candidate.id === memberId
          ? {
              ...candidate,
              roleSelection: resolvedRole,
              customRole: resolvedRole === CUSTOM_ROLE ? candidate.customRole : '',
            }
          : candidate
      )
    );
  };

  const updateMemberCustomRole = (memberId: string, customRole: string): void => {
    setMembers((prev) =>
      prev.map((candidate) =>
        candidate.id === memberId ? { ...candidate, customRole } : candidate
      )
    );
  };

  const removeMember = (memberId: string): void => {
    setMembers((prev) => prev.filter((candidate) => candidate.id !== memberId));
  };

  const handleSubmit = (): void => {
    if (existingTeamNames.includes(request.teamName)) {
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

        {conflictingTeam ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
              <div className="min-w-0 space-y-1">
                <p className="font-medium text-amber-300">
                  Team &ldquo;{conflictingTeam.displayName}&rdquo; is already running in this
                  project
                </p>
                <p className="text-amber-300/80">
                  Running two teams in the same directory is risky — they may conflict editing the
                  same files. Consider using a different directory or a git worktree for isolation.
                </p>
              </div>
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
            {existingTeamNames.includes(teamName.trim()) ? (
              <p className="text-[11px] text-red-300">Team name already exists</p>
            ) : fieldErrors.teamName ? (
              <p className="text-[11px] text-red-300">{fieldErrors.teamName}</p>
            ) : null}
          </div>

          <div className="space-y-1.5 md:col-span-2">
            <div className="flex items-center justify-between">
              <Label>Members</Label>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setMembers((prev) => [...prev, createMemberDraft()]);
                  }}
                >
                  Add member
                </Button>
                <Button variant="ghost" size="sm" onClick={toggleJsonEditor}>
                  {jsonEditorOpen ? 'Hide JSON' : 'Edit as JSON'}
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              {members.map((member, index) => {
                const memberColorSet = getTeamColorSet(getMemberColor(index));
                return (
                  <div
                    key={member.id}
                    className="grid grid-cols-1 gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-2 md:grid-cols-[1fr_220px_auto]"
                    style={{
                      borderLeftWidth: '3px',
                      borderLeftColor: memberColorSet.border,
                    }}
                  >
                    <Input
                      className="h-8 text-xs"
                      value={member.name}
                      aria-label={`Member ${index + 1} name`}
                      onChange={(event) => updateMemberName(member.id, event.target.value)}
                      placeholder="member-name"
                      style={
                        member.name.trim()
                          ? {
                              color: memberColorSet.text,
                            }
                          : undefined
                      }
                    />
                    <div className="space-y-1">
                      <Select
                        value={member.roleSelection || NO_ROLE}
                        onValueChange={(roleSelection) =>
                          updateMemberRole(member.id, roleSelection)
                        }
                      >
                        <SelectTrigger
                          className="h-8 text-xs"
                          aria-label={`Member ${index + 1} role`}
                        >
                          <SelectValue placeholder="No role" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_ROLE}>No role</SelectItem>
                          {PRESET_ROLES.map((role) => (
                            <SelectItem key={role} value={role}>
                              {role}
                            </SelectItem>
                          ))}
                          <SelectItem value={CUSTOM_ROLE}>Custom role...</SelectItem>
                        </SelectContent>
                      </Select>
                      {member.roleSelection === CUSTOM_ROLE ? (
                        <Input
                          className="h-8 text-xs"
                          value={member.customRole}
                          aria-label={`Member ${index + 1} custom role`}
                          onChange={(event) =>
                            updateMemberCustomRole(member.id, event.target.value)
                          }
                          placeholder="e.g. architect"
                        />
                      ) : null}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-red-500/40 text-red-300 hover:bg-red-500/10 hover:text-red-200"
                      onClick={() => removeMember(member.id)}
                    >
                      Remove
                    </Button>
                  </div>
                );
              })}
              {jsonEditorOpen ? (
                <MembersJsonEditor value={jsonText} onChange={handleJsonChange} error={jsonError} />
              ) : null}
            </div>
            {fieldErrors.members ? (
              <p className="text-[11px] text-red-300">{fieldErrors.members}</p>
            ) : null}
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
                    suggestions={mentionSuggestions}
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

                <div className="space-y-1.5">
                  <Label className="label-optional">Model (optional)</Label>
                  <Select value={selectedModel} onValueChange={setSelectedModel}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Default (account setting)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">Default (account setting)</SelectItem>
                      <SelectItem value="opus">Opus 4.6</SelectItem>
                      <SelectItem value="sonnet">Sonnet 4.5</SelectItem>
                      <SelectItem value="haiku">Haiku 4.5</SelectItem>
                    </SelectContent>
                  </Select>
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
                  <div className="flex items-center gap-2 text-xs text-emerald-400">
                    <CheckCircle2 className="size-3.5 shrink-0" />
                    <span>CLI environment ready</span>
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
