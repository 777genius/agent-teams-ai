import React, { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { highlightLine } from '@renderer/components/chat/viewers/syntaxHighlighter';
import { Badge } from '@renderer/components/ui/badge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Textarea } from '@renderer/components/ui/textarea';
import { cn } from '@renderer/lib/utils';
import { Check, CheckCircle2, Loader2 } from 'lucide-react';

import { STEP_LABELS, STEP_ORDER } from '../provisioningSteps';

import type { ProvisioningStep } from '../provisioningSteps';
import type {
  Project,
  TeamCreateRequest,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
} from '@shared/types';

interface CreateTeamDialogProps {
  open: boolean;
  canCreate: boolean;
  provisioningError: string | null;
  progress: TeamProvisioningProgress | null;
  existingTeamNames: string[];
  onClose: () => void;
  onCreate: (request: TeamCreateRequest) => Promise<void>;
  onCancelProvisioning: (runId: string) => Promise<void>;
  onOpenTeam: (teamName: string) => void;
}

interface ValidationResult {
  valid: boolean;
  errors?: {
    teamName?: string;
    members?: string;
    cwd?: string;
  };
}

const PRESET_ROLES = ['lead', 'reviewer', 'developer', 'qa', 'researcher'] as const;
const CUSTOM_ROLE = '__custom__';
const NO_ROLE = '__none__';
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
  { name: 'carol', roleSelection: 'lead' },
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderHighlightedText(text: string, query: string): React.JSX.Element {
  if (!query.trim()) {
    return <span>{text}</span>;
  }

  const pattern = new RegExp(`(${escapeRegExp(query)})`, 'ig');
  const parts = text.split(pattern);

  return (
    <span>
      {parts.map((part, index) => {
        const isMatch = part.toLowerCase() === query.toLowerCase();
        if (!isMatch) {
          return <span key={`${part}-${index}`}>{part}</span>;
        }
        return (
          <mark
            key={`${part}-${index}`}
            // eslint-disable-next-line tailwindcss/no-custom-classname -- Tailwind arbitrary value with CSS variable
            className="bg-[var(--color-accent)]/25 rounded px-0.5 text-[var(--color-text)]"
          >
            {part}
          </mark>
        );
      })}
    </span>
  );
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

function renderCliLogLine(line: string, index: number): React.JSX.Element {
  const trimmed = line.trim();
  if (!trimmed) {
    return (
      <div key={index} className="h-2">
        {'\n'}
      </div>
    );
  }

  let jsonLines: string[] | null = null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      jsonLines = JSON.stringify(parsed, null, 2).split('\n');
    }
  } catch {
    // Not JSON, render as plain text
  }

  if (jsonLines) {
    return (
      <div key={index}>
        {jsonLines.map((jsonLine, lineIdx) => (
          <div key={lineIdx} className="whitespace-pre font-mono">
            {highlightLine(jsonLine, 'json')}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div key={index} className="whitespace-pre-wrap break-all font-mono [overflow-wrap:anywhere]">
      {trimmed}
    </div>
  );
}

function validateRequest(request: TeamCreateRequest): ValidationResult {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.teamName) || request.teamName.length > 64) {
    return {
      valid: false,
      errors: {
        teamName: 'Use kebab-case [a-z0-9-], max 64 chars',
      },
    };
  }
  if (!request.cwd.trim()) {
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
  progress,
  existingTeamNames,
  onClose,
  onCreate,
  onCancelProvisioning,
  onOpenTeam,
}: CreateTeamDialogProps): React.JSX.Element => {
  const isDev = process.env.NODE_ENV !== 'production';

  const [teamName, setTeamName] = useState('');
  const [description, setDescription] = useState('');
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
  const autoOpenedRef = useRef(false);

  const resetFormState = (): void => {
    setLocalError(null);
    setFieldErrors({});
    setIsSubmitting(false);
    setPrepareState('idle');
    setPrepareMessage(null);
    setPrepareWarnings([]);
    autoOpenedRef.current = false;
  };

  useEffect(() => {
    if (!open || !canCreate) {
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
  }, [open, canCreate]);

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
    if (!open || members.length > 0) {
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
  }, [isDev, members.length, open]);

  useEffect(() => {
    if (!open || !isDev) {
      return;
    }
    if (teamName.trim().length === 0) {
      setTeamName(DEV_DEFAULT_TEAM.teamName);
    }
    if (description.trim().length === 0) {
      setDescription(DEV_DEFAULT_TEAM.description);
    }
  }, [open, isDev, teamName, description]);

  useEffect(() => {
    if (cwdMode !== 'project') {
      return;
    }
    if (selectedProjectPath || projects.length === 0) {
      return;
    }
    setSelectedProjectPath(projects[0].path);
  }, [cwdMode, projects, selectedProjectPath]);

  const effectiveCwd = cwdMode === 'project' ? selectedProjectPath.trim() : customCwd.trim();

  const request = useMemo<TeamCreateRequest>(
    () => ({
      teamName: teamName.trim(),
      description: description.trim() || undefined,
      members: buildMembers(members),
      cwd: effectiveCwd,
    }),
    [teamName, description, members, effectiveCwd]
  );

  const activeError = localError ?? provisioningError;
  const isReady = progress?.state === 'ready' || progress?.state === 'disconnected';
  const isFailed = progress?.state === 'failed';

  // Navigate as soon as team actually appears in the teams list (FileWatcher detected config.json)
  const provisioningTeamName = progress?.teamName;
  const teamExistsInList =
    provisioningTeamName != null && existingTeamNames.includes(provisioningTeamName);

  useEffect(() => {
    if (!teamExistsInList || !provisioningTeamName) {
      return;
    }
    if (autoOpenedRef.current) {
      return;
    }
    autoOpenedRef.current = true;
    onOpenTeam(provisioningTeamName);
    onClose();
  }, [teamExistsInList, provisioningTeamName, onOpenTeam, onClose]);

  const canCancel =
    progress?.state === 'spawning' ||
    progress?.state === 'monitoring' ||
    progress?.state === 'verifying';
  const canOpenExistingTeam =
    activeError?.includes('Team already exists') === true && request.teamName.length > 0;
  const progressStepIndex = progress ? STEP_ORDER.indexOf(progress.state as ProvisioningStep) : -1;
  const failedStepIndex =
    progress?.state === 'failed'
      ? Math.max(
          0,
          STEP_ORDER.findIndex((step) => progress.message.toLowerCase().includes(step))
        )
      : -1;

  const cliLogsText = (() => {
    const tail = progress?.cliLogsTail?.trim();
    if (tail) {
      return tail;
    }
    if (!progress) {
      return '';
    }
    if (progress.state === 'ready' || progress.state === 'disconnected') {
      const timedOut =
        progress.warnings?.some((w) => w.toLowerCase().includes('timed out')) ?? false;
      return timedOut
        ? 'No CLI output captured before timeout. The team appears ready based on created files.'
        : 'No CLI output captured.';
    }
    if (progress.state === 'failed') {
      return 'No CLI output captured.';
    }
    if (progress.state === 'cancelled') {
      return 'Cancelled.';
    }
    return 'Waiting for CLI output...';
  })();

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
    const validation = validateRequest(request);
    if (!validation.valid) {
      setFieldErrors(validation.errors ?? {});
      setLocalError('Check form fields');
      return;
    }
    setFieldErrors({});
    setLocalError(null);
    setIsSubmitting(true);
    void (async () => {
      try {
        await onCreate(request);
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
          resetFormState();
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">Create Team</DialogTitle>
          <DialogDescription className="text-xs">
            Team provisioning via local Claude CLI.
          </DialogDescription>
        </DialogHeader>

        {canCreate && prepareState === 'failed' ? (
          <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
            <p>{prepareMessage ?? 'Failed to prepare environment'}</p>
            {prepareWarnings.length > 0 ? (
              <div className="mt-1 space-y-1">
                {prepareWarnings.map((warning) => (
                  <p key={warning} className="text-[11px] text-amber-300">
                    {warning}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {!canCreate ? (
          <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-300">
            Available only in local Electron mode.
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="team-name" className="text-xs text-[var(--color-text-muted)]">
              teamName
            </Label>
            <Input
              id="team-name"
              className="h-8 text-xs"
              value={teamName}
              onChange={(event) => setTeamName(event.target.value)}
              placeholder="team-alpha"
            />
            {fieldErrors.teamName ? (
              <p className="text-[11px] text-red-300">{fieldErrors.teamName}</p>
            ) : null}
          </div>

          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="team-description" className="text-xs text-[var(--color-text-muted)]">
              description (optional)
            </Label>
            <Textarea
              id="team-description"
              className="min-h-[40px] resize-none text-xs"
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Brief description of the team purpose"
            />
          </div>

          <div className="space-y-1.5 md:col-span-2">
            <Label className="text-xs text-[var(--color-text-muted)]">members</Label>
            <div className="space-y-2">
              {members.map((member, index) => (
                <div
                  key={member.id}
                  className="grid grid-cols-1 gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-2 md:grid-cols-[1fr_220px_auto]"
                >
                  <Input
                    className="h-8 text-xs"
                    value={member.name}
                    aria-label={`Member ${index + 1} name`}
                    onChange={(event) => updateMemberName(member.id, event.target.value)}
                    placeholder="member-name"
                  />
                  <div className="space-y-1">
                    <Select
                      value={member.roleSelection || NO_ROLE}
                      onValueChange={(roleSelection) => updateMemberRole(member.id, roleSelection)}
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
                        onChange={(event) => updateMemberCustomRole(member.id, event.target.value)}
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
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setMembers((prev) => [...prev, createMemberDraft()]);
                }}
              >
                Add member
              </Button>
            </div>
            {fieldErrors.members ? (
              <p className="text-[11px] text-red-300">{fieldErrors.members}</p>
            ) : null}
          </div>

          <div className="space-y-1.5 md:col-span-2">
            <Label className="text-xs text-[var(--color-text-muted)]">cwd</Label>
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant={cwdMode === 'project' ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setCwdMode('project')}
                >
                  From project list
                </Button>
                <Button
                  type="button"
                  variant={cwdMode === 'custom' ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setCwdMode('custom')}
                >
                  Custom path
                </Button>
              </div>

              {cwdMode === 'project' ? (
                <div className="space-y-1.5">
                  <Combobox
                    options={projects.map((project) => ({
                      value: project.path,
                      label: project.name,
                      description: project.path,
                    }))}
                    value={selectedProjectPath}
                    onValueChange={setSelectedProjectPath}
                    placeholder={projectsLoading ? 'Loading projects...' : 'Select a project...'}
                    searchPlaceholder="Search project by name or path"
                    emptyMessage="Nothing found"
                    disabled={projectsLoading || projects.length === 0}
                    renderOption={(option, isSelected, query) => (
                      <>
                        <Check
                          className={cn(
                            'mr-2 size-3.5 shrink-0',
                            isSelected ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-[var(--color-text)]">
                            {renderHighlightedText(option.label, query)}
                          </p>
                          <p className="truncate text-[var(--color-text-muted)]">
                            {renderHighlightedText(option.description ?? '', query)}
                          </p>
                        </div>
                      </>
                    )}
                  />
                  {!selectedProjectPath ? (
                    <p className="text-[11px] text-[var(--color-text-muted)]">
                      Select a project from the list
                    </p>
                  ) : null}
                  {projectsError ? (
                    <p className="text-[11px] text-red-300">{projectsError}</p>
                  ) : null}
                  {!projectsLoading && projects.length === 0 ? (
                    <p className="text-[11px] text-amber-300">
                      No projects found, switch to custom path.
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <div className="flex gap-2">
                    <Input
                      className="h-8 text-xs"
                      value={customCwd}
                      aria-label="Custom working directory"
                      onChange={(event) => setCustomCwd(event.target.value)}
                      placeholder="/absolute/path/to/project"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void (async () => {
                          const paths = await api.config.selectFolders();
                          if (paths.length > 0) {
                            setCustomCwd(paths[0]);
                          }
                        })();
                      }}
                    >
                      Browse
                    </Button>
                  </div>
                  <p className="text-[11px] text-[var(--color-text-muted)]">
                    If the directory does not exist, it will be created automatically.
                  </p>
                </div>
              )}
            </div>
            {fieldErrors.cwd ? <p className="text-[11px] text-red-300">{fieldErrors.cwd}</p> : null}
          </div>
        </div>

        {progress ? (
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
            <p className="text-xs font-medium text-[var(--color-text)]">Provisioning Progress</p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">{progress.message}</p>
            <div className="mt-2 flex items-center gap-1 overflow-x-auto pb-1">
              {STEP_ORDER.map((step, index) => {
                const isFailedStep = progress.state === 'failed' && index === failedStepIndex;
                const isDone =
                  progress.state === 'ready' ||
                  (progressStepIndex >= 0 && index < progressStepIndex) ||
                  (progress.state === 'failed' && index < failedStepIndex);
                const isActive =
                  (progressStepIndex >= 0 && index === progressStepIndex) || isFailedStep;

                return (
                  <div key={step} className="flex items-center gap-1">
                    <Badge
                      variant="secondary"
                      className={cn(
                        'whitespace-nowrap px-2 py-0.5 text-[11px] font-normal',
                        isFailedStep && 'border-red-400/60 bg-red-500/10 text-red-300',
                        !isFailedStep &&
                          isDone &&
                          'border-emerald-400/60 bg-emerald-500/10 text-emerald-200',

                        !isFailedStep &&
                          !isDone &&
                          isActive &&
                          'border-[var(--color-accent)]/70 bg-[var(--color-accent)]/15 text-[var(--color-text)]'
                      )}
                    >
                      <span className="mr-1 inline-flex size-4 items-center justify-center rounded-full border border-current text-[10px]">
                        {index + 1}
                      </span>
                      {STEP_LABELS[step]}
                    </Badge>
                    {index < STEP_ORDER.length - 1 ? (
                      <span className="text-[var(--color-text-muted)]">&rarr;</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {progress.warnings?.length ? (
              <div className="mt-2 space-y-1">
                {progress.warnings.map((warning) => (
                  <p key={warning} className="text-[11px] text-amber-300">
                    {warning}
                  </p>
                ))}
              </div>
            ) : null}
            <div className="mt-2">
              <p className="mb-1 text-[11px] font-medium text-[var(--color-text)]">
                Claude CLI logs
              </p>
              <div className="max-h-44 min-w-0 overflow-auto rounded border border-[var(--color-border)] bg-black/25 p-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                {cliLogsText.split('\n').map((line, index) => renderCliLogLine(line, index))}
              </div>
            </div>
          </div>
        ) : null}

        {activeError ? (
          <p className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
            {activeError}
          </p>
        ) : null}

        {canCreate && (prepareState === 'idle' || prepareState === 'loading') ? (
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            <span>
              {prepareMessage ??
                (prepareState === 'idle'
                  ? 'Warming up CLI environment...'
                  : 'Preparing environment...')}
            </span>
            <span className="text-[var(--color-text-muted)]">&middot;</span>
            <span>Team provisioning via local Claude CLI.</span>
          </div>
        ) : null}

        {canCreate && prepareState === 'ready' ? (
          <div className="flex items-center gap-2 text-xs text-emerald-400">
            <CheckCircle2 className="size-3.5 shrink-0" />
            <span>CLI environment ready</span>
          </div>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-0">
          {canCancel ? (
            <Button
              variant="outline"
              size="sm"
              className="border-red-500/40 text-red-300 hover:bg-red-500/10 hover:text-red-200"
              onClick={() => {
                void onCancelProvisioning(progress.runId);
              }}
            >
              Cancel
            </Button>
          ) : null}
          {isReady ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onOpenTeam(progress.teamName);
                onClose();
              }}
            >
              Open Team
            </Button>
          ) : null}
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
            disabled={!canCreate || isSubmitting || prepareState !== 'ready' || !!progress}
            onClick={handleSubmit}
          >
            {isSubmitting || progress ? (
              <>
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                Creating...
              </>
            ) : isFailed ? (
              'Retry'
            ) : (
              'Create'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
