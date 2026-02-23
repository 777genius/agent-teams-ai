import React, { useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
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
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { cn } from '@renderer/lib/utils';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { Check, CheckCircle2, Loader2 } from 'lucide-react';

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
  onClose: () => void;
  onLaunch: (request: TeamLaunchRequest) => Promise<void>;
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

export const LaunchTeamDialog = ({
  open,
  teamName,
  members,
  defaultProjectPath,
  provisioningError,
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

  const resetFormState = (): void => {
    setLocalError(null);
    setIsSubmitting(false);
    setPrepareState('idle');
    setPrepareMessage(null);
    setPrepareWarnings([]);
    setCwdMode('project');
    setSelectedProjectPath('');
    setCustomCwd('');
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

  // Fetch projects on open
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

  const mentionSuggestions = useMemo<MentionSuggestion[]>(
    () =>
      members.map((m) => ({
        id: m.name,
        name: m.name,
        subtitle: formatAgentRole(m.role) ?? formatAgentRole(m.agentType) ?? undefined,
        color: m.color,
      })),
    [members]
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
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">Launch Team</DialogTitle>
          <DialogDescription className="text-xs">
            Start team <span className="font-mono font-medium">{teamName}</span> via local Claude
            CLI.
          </DialogDescription>
        </DialogHeader>

        {prepareState === 'failed' ? (
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

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-[var(--color-text-muted)]">Project</Label>
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
                </div>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="launch-prompt" className="text-xs text-[var(--color-text-muted)]">
              Prompt (optional)
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
