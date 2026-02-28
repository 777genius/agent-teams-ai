import React, { useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
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
import { Label } from '@renderer/components/ui/label';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw } from 'lucide-react';

import { ProjectPathSelector } from './ProjectPathSelector';

import type { ActiveTeamRef } from './CreateTeamDialog';
import type { MentionSuggestion } from '@renderer/types/mention';
import type {
  Project,
  ResolvedTeamMember,
  TeamLaunchRequest,
  TeamProvisioningPrepareResult,
} from '@shared/types';

interface LaunchTeamDialogProps {
  open: boolean;
  teamName: string;
  members: ResolvedTeamMember[];
  defaultProjectPath?: string;
  provisioningError: string | null;
  activeTeams?: ActiveTeamRef[];
  onClose: () => void;
  onLaunch: (request: TeamLaunchRequest) => Promise<void>;
}

export const LaunchTeamDialog = ({
  open,
  teamName,
  members,
  defaultProjectPath,
  provisioningError,
  activeTeams,
  onClose,
  onLaunch,
}: LaunchTeamDialogProps): React.JSX.Element => {
  const [cwdMode, setCwdMode] = useState<'project' | 'custom'>('project');
  const [selectedProjectPath, setSelectedProjectPath] = useState('');
  const [customCwd, setCustomCwd] = useState('');
  const promptDraft = useDraftPersistence({ key: `launchTeam:${teamName}:prompt` });
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [prepareState, setPrepareState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [prepareMessage, setPrepareMessage] = useState<string | null>(null);
  const [prepareWarnings, setPrepareWarnings] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [clearContext, setClearContext] = useState(false);

  const resetFormState = (): void => {
    setLocalError(null);
    setIsSubmitting(false);
    setPrepareState('idle');
    setPrepareMessage(null);
    setPrepareWarnings([]);
    setCwdMode('project');
    setSelectedProjectPath('');
    setCustomCwd('');
    setSelectedModel('');
    setClearContext(false);
  };

  // Warm up CLI on open
  useEffect(() => {
    if (!open) {
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
  }, [open]);

  const repositoryGroups = useStore((s) => s.repositoryGroups);

  // Fetch projects on open, merging with repositoryGroups from store
  useEffect(() => {
    if (!open) {
      return;
    }

    setProjectsLoading(true);
    setProjectsError(null);

    let cancelled = false;
    void (async () => {
      try {
        const apiProjects = await api.getProjects();
        if (cancelled) {
          return;
        }

        // Merge repositoryGroups (may include synthetic folders without sessions)
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
                createdAt: wt.createdAt ?? Date.now(),
              });
            }
          }
        }

        setProjects([...apiProjects, ...extras]);
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
  }, [open, repositoryGroups]);

  // Pre-select defaultProjectPath when projects loaded
  useEffect(() => {
    if (cwdMode !== 'project') {
      return;
    }
    if (selectedProjectPath || projects.length === 0) {
      return;
    }
    if (defaultProjectPath) {
      const match = projects.find((p) => p.path === defaultProjectPath);
      if (match) {
        setSelectedProjectPath(match.path);
        return;
      }
    }
    setSelectedProjectPath(projects[0].path);
  }, [cwdMode, projects, selectedProjectPath, defaultProjectPath]);

  const effectiveCwd = cwdMode === 'project' ? selectedProjectPath.trim() : customCwd.trim();

  const conflictingTeam = useMemo(() => {
    if (!activeTeams?.length || !effectiveCwd) return null;
    const norm = normalizePath(effectiveCwd);
    return (
      activeTeams.find((t) => t.teamName !== teamName && normalizePath(t.projectPath) === norm) ??
      null
    );
  }, [activeTeams, effectiveCwd, teamName]);

  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const mentionSuggestions = useMemo<MentionSuggestion[]>(
    () =>
      members.map((m) => ({
        id: m.name,
        name: m.name,
        subtitle: formatAgentRole(m.role) ?? formatAgentRole(m.agentType) ?? undefined,
        color: colorMap.get(m.name),
      })),
    [members, colorMap]
  );

  const activeError = localError ?? provisioningError;

  const handleSubmit = (): void => {
    if (!effectiveCwd) {
      setLocalError('Select working directory (cwd)');
      return;
    }
    setLocalError(null);
    setIsSubmitting(true);

    void (async () => {
      try {
        await onLaunch({
          teamName,
          cwd: effectiveCwd,
          prompt: promptDraft.value.trim() || undefined,
          model: selectedModel || undefined,
          clearContext: clearContext || undefined,
        });
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
          resetFormState();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">Launch Team</DialogTitle>
          <DialogDescription className="text-xs">
            Start team <span className="font-mono font-medium">{teamName}</span> via local Claude
            CLI.
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

        {prepareState === 'failed' ? (
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

        <div className="space-y-4">
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

          <div className="space-y-1.5">
            <Label htmlFor="launch-prompt" className="label-optional">
              Prompt for team lead (optional)
            </Label>
            <MentionableTextarea
              id="launch-prompt"
              className="min-h-[100px] text-xs"
              minRows={4}
              maxRows={12}
              value={promptDraft.value}
              onValueChange={promptDraft.setValue}
              suggestions={mentionSuggestions}
              placeholder="Instructions for team lead... Use @ to mention team members."
              footerRight={
                promptDraft.isSaved ? (
                  <span className="text-[10px] text-[var(--color-text-muted)]">Draft saved</span>
                ) : null
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label className="label-optional">Model (optional)</Label>
            <div className="inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
              {[
                { value: '', label: 'Default' },
                { value: 'opus', label: 'Opus 4.6' },
                { value: 'sonnet', label: 'Sonnet 4.5' },
                { value: 'haiku', label: 'Haiku 4.5' },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={cn(
                    'rounded-[3px] px-3 py-1 text-xs font-medium transition-colors',
                    selectedModel === opt.value
                      ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm'
                      : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                  )}
                  onClick={() => setSelectedModel(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
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
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
                  <p className="text-amber-300/90">
                    The team lead will start a new session without resuming previous context. All
                    accumulated session memory and conversation history will not be available.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {activeError ? (
          <p className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
            {activeError}
          </p>
        ) : null}

        {prepareState === 'idle' || prepareState === 'loading' ? (
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

        {prepareState === 'ready' ? (
          <div className="flex items-center gap-2 text-xs text-emerald-400">
            <CheckCircle2 className="size-3.5 shrink-0" />
            <span>CLI environment ready</span>
          </div>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            size="sm"
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={isSubmitting || prepareState !== 'ready'}
            onClick={handleSubmit}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                Launching...
              </>
            ) : (
              'Launch'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
