import React, { useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
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
import { Textarea } from '@renderer/components/ui/textarea';
import { useStore } from '@renderer/store';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { EffortLevelSelector } from '../dialogs/EffortLevelSelector';
import { ProjectPathSelector } from '../dialogs/ProjectPathSelector';
import { SkipPermissionsCheckbox } from '../dialogs/SkipPermissionsCheckbox';
import { TeamModelSelector } from '../dialogs/TeamModelSelector';
import { CronScheduleInput } from './CronScheduleInput';

import type { CwdMode } from '../dialogs/ProjectPathSelector';
import type {
  CreateScheduleInput,
  EffortLevel,
  Project,
  Schedule,
  UpdateSchedulePatch,
} from '@shared/types';

// =============================================================================
// Props
// =============================================================================

interface ScheduleDialogProps {
  open: boolean;
  teamName: string;
  /** When provided, dialog works in edit mode */
  schedule?: Schedule | null;
  onClose: () => void;
}

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

// =============================================================================
// Component
// =============================================================================

export const ScheduleDialog = ({
  open,
  teamName,
  schedule,
  onClose,
}: ScheduleDialogProps): React.JSX.Element => {
  const isEditing = !!schedule;

  // --- Form state ---
  const [label, setLabel] = useState('');
  const [cronExpression, setCronExpression] = useState('0 9 * * 1-5');
  const [timezone, setTimezone] = useState(getLocalTimezone);
  const [warmUpMinutes, setWarmUpMinutes] = useState(15);
  const [maxTurns, setMaxTurns] = useState(50);
  const [maxBudgetUsd, setMaxBudgetUsd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cwdMode, setCwdMode] = useState<CwdMode>('project');
  const [selectedProjectPath, setSelectedProjectPath] = useState('');
  const [customCwd, setCustomCwd] = useState('');
  const [selectedModel, setSelectedModelRaw] = useState(() => {
    const stored = localStorage.getItem('schedule:lastSelectedModel') ?? '';
    return stored === '__default__' ? '' : stored;
  });
  const [skipPermissions, setSkipPermissionsRaw] = useState(true);
  const [selectedEffort, setSelectedEffortRaw] = useState(
    () => localStorage.getItem('schedule:lastSelectedEffort') ?? ''
  );

  // --- Projects state ---
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  // --- Submission state ---
  const [localError, setLocalError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // --- Store actions ---
  const createSchedule = useStore((s) => s.createSchedule);
  const updateSchedule = useStore((s) => s.updateSchedule);

  // --- Persist preferences ---
  const setSelectedModel = (value: string): void => {
    setSelectedModelRaw(value);
    localStorage.setItem('schedule:lastSelectedModel', value);
  };

  const setSkipPermissions = (value: boolean): void => {
    setSkipPermissionsRaw(value);
  };

  const setSelectedEffort = (value: string): void => {
    setSelectedEffortRaw(value);
    localStorage.setItem('schedule:lastSelectedEffort', value);
  };

  // --- Populate form in edit mode ---
  useEffect(() => {
    if (!open) return;

    if (schedule) {
      setLabel(schedule.label ?? '');
      setCronExpression(schedule.cronExpression);
      setTimezone(schedule.timezone);
      setWarmUpMinutes(schedule.warmUpMinutes);
      setMaxTurns(schedule.maxTurns);
      setMaxBudgetUsd(schedule.maxBudgetUsd != null ? String(schedule.maxBudgetUsd) : '');
      setPrompt(schedule.launchConfig.prompt);
      setCustomCwd(schedule.launchConfig.cwd);
      setCwdMode('custom');
      setSelectedModelRaw(schedule.launchConfig.model ?? '');
      setSkipPermissionsRaw(schedule.launchConfig.skipPermissions !== false);
      setSelectedEffortRaw(schedule.launchConfig.effort ?? '');
    } else {
      // Reset for create mode
      setLabel('');
      setCronExpression('0 9 * * 1-5');
      setTimezone(getLocalTimezone());
      setWarmUpMinutes(15);
      setMaxTurns(50);
      setMaxBudgetUsd('');
      setPrompt('');
      setCwdMode('project');
      setSelectedProjectPath('');
      setCustomCwd('');
    }

    setLocalError(null);
    setIsSubmitting(false);
  }, [open, schedule]);

  // --- Load projects ---
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

  // --- Pre-select project ---
  useEffect(() => {
    if (!open || cwdMode !== 'project' || selectedProjectPath || projects.length === 0) return;
    setSelectedProjectPath(projects[0].path);
  }, [open, cwdMode, projects, selectedProjectPath]);

  const effectiveCwd = cwdMode === 'project' ? selectedProjectPath.trim() : customCwd.trim();

  // --- Validation ---
  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (!effectiveCwd) errors.push('Working directory is required');
    if (!prompt.trim()) errors.push('Prompt is required');
    if (!cronExpression.trim()) errors.push('Cron expression is required');
    return errors;
  }, [effectiveCwd, prompt, cronExpression]);

  // --- Submit ---
  const handleSubmit = (): void => {
    if (validationErrors.length > 0) {
      setLocalError(validationErrors[0]);
      return;
    }

    setLocalError(null);
    setIsSubmitting(true);

    const parsedBudget = maxBudgetUsd ? parseFloat(maxBudgetUsd) : undefined;

    void (async () => {
      try {
        if (isEditing && schedule) {
          const patch: UpdateSchedulePatch = {
            label: label.trim() || undefined,
            cronExpression: cronExpression.trim(),
            timezone,
            warmUpMinutes,
            maxTurns,
            maxBudgetUsd: parsedBudget,
            launchConfig: {
              cwd: effectiveCwd,
              prompt: prompt.trim(),
              model: selectedModel || undefined,
              effort: (selectedEffort as EffortLevel) || undefined,
              skipPermissions,
            },
          };
          await updateSchedule(schedule.id, patch);
        } else {
          const input: CreateScheduleInput = {
            teamName,
            label: label.trim() || undefined,
            cronExpression: cronExpression.trim(),
            timezone,
            warmUpMinutes,
            maxTurns,
            maxBudgetUsd: parsedBudget,
            launchConfig: {
              cwd: effectiveCwd,
              prompt: prompt.trim(),
              model: selectedModel || undefined,
              effort: (selectedEffort as EffortLevel) || undefined,
              skipPermissions,
            },
          };
          await createSchedule(input);
        }
        onClose();
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : 'Failed to save schedule');
      } finally {
        setIsSubmitting(false);
      }
    })();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {isEditing ? 'Edit Schedule' : 'Create Schedule'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isEditing
              ? `Editing schedule for team "${teamName}"`
              : `Schedule automatic runs for team "${teamName}"`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Label */}
          <div className="space-y-1.5">
            <Label htmlFor="schedule-label" className="label-optional">
              Label (optional)
            </Label>
            <Input
              id="schedule-label"
              className="h-8 text-xs"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
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

          {/* Project / Working directory */}
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

          {/* Prompt (required for schedule) */}
          <div className="space-y-1.5">
            <Label htmlFor="schedule-prompt">
              Prompt <span className="text-red-400">*</span>
            </Label>
            <Textarea
              id="schedule-prompt"
              className="min-h-[100px] text-xs"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Instructions for Claude to execute on schedule..."
              rows={4}
            />
            <p className="text-[11px] text-[var(--color-text-muted)]">
              This prompt will be passed to <code className="font-mono">claude -p</code> for
              one-shot execution
            </p>
          </div>

          {/* Model + Effort + Skip Permissions */}
          <div>
            <TeamModelSelector
              value={selectedModel}
              onValueChange={setSelectedModel}
              id="schedule-model"
            />
            <EffortLevelSelector
              value={selectedEffort}
              onValueChange={setSelectedEffort}
              id="schedule-effort"
            />
            <SkipPermissionsCheckbox
              id="schedule-skip-permissions"
              checked={skipPermissions}
              onCheckedChange={setSkipPermissions}
            />
          </div>

          {/* Execution limits — single row */}
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
        </div>

        {/* Error display */}
        {localError ? (
          <div className="flex items-start gap-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{localError}</span>
          </div>
        ) : null}

        <DialogFooter className="pt-4">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={isSubmitting || validationErrors.length > 0}
            onClick={handleSubmit}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                {isEditing ? 'Saving...' : 'Creating...'}
              </>
            ) : isEditing ? (
              'Save Changes'
            ) : (
              'Create Schedule'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
