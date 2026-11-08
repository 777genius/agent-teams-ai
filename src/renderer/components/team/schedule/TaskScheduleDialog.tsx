import React, { useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
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
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Textarea } from '@renderer/components/ui/textarea';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import { Cron } from 'croner';
import { AlertTriangle } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { SmartScheduleFields } from './SmartScheduleFields';

import type { TeamCreateRequest, TeamSummary } from '@shared/types';

interface TaskScheduleDialogProps {
  readonly open: boolean;
  readonly fixedTeamName?: string;
  readonly onClose: () => void;
}

/**
 * New schedules only. Editing old schedules stays in LaunchTeamDialog to avoid
 * silently changing persisted one-shot/team launch behavior.
 */
export const TaskScheduleDialog = ({
  open,
  fixedTeamName,
  onClose,
}: TaskScheduleDialogProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const { isLight } = useTheme();
  const { teams, teamByName, fetchTeams, createSchedule, openTeamTab } = useStore(
    useShallow((state) => ({
      teams: state.teams,
      teamByName: state.teamByName,
      fetchTeams: state.fetchTeams,
      createSchedule: state.createSchedule,
      openTeamTab: state.openTeamTab,
    }))
  );
  const [selectedTeamName, setSelectedTeamName] = useState(fixedTeamName ?? '');
  const [saved, setSaved] = useState<TeamCreateRequest | null>(null);
  const [savedLoading, setSavedLoading] = useState(false);
  const [mode, setMode] = useState<'agent' | 'team'>('team');
  const [targetMember, setTargetMember] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cronExpression, setCronExpression] = useState('0 9 * * 1-5');
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submitInFlight = useRef(false);

  const teamName = fixedTeamName ?? selectedTeamName;
  const teamChoices = useMemo(() => {
    const byName = new Map<string, TeamSummary>();
    for (const team of [...teams, ...Object.values(teamByName)]) {
      if (!team.deletedAt) byName.set(team.teamName, team);
    }
    return [...byName.values()].sort((a, b) =>
      (a.displayName || a.teamName).localeCompare(b.displayName || b.teamName)
    );
  }, [teams, teamByName]);
  const team = teamByName[teamName] ?? teamChoices.find((item) => item.teamName === teamName);
  const pickerTeam = useMemo(
    () => ({
      leadName: team?.leadName,
      members: saved?.members ?? team?.members ?? [],
    }),
    [saved?.members, team?.leadName, team?.members]
  );
  const teammates = pickerTeam.members.filter(
    (member) => member.name.trim().toLowerCase() !== (pickerTeam.leadName ?? 'team-lead').toLowerCase()
  );
  const selectedMemberValid =
    mode === 'team' || teammates.length === 0 || teammates.some((item) => item.name === targetMember);
  const canSubmit = Boolean(
    teamName && saved?.cwd?.trim() && saved.providerId && prompt.trim() &&
    selectedMemberValid && !team?.pendingCreate && !submitting && !savedLoading
  );

  useEffect(() => {
    if (open && !fixedTeamName) void fetchTeams();
  }, [open, fixedTeamName, fetchTeams]);

  useEffect(() => {
    setSelectedTeamName(fixedTeamName ?? '');
  }, [fixedTeamName]);

  useEffect(() => {
    setSaved(null);
    setTargetMember('');
    setError(null);
    if (!open || !teamName) return;
    let cancelled = false;
    setSavedLoading(true);
    void api.teams.getSavedRequest(teamName).then(
      (request) => {
        if (!cancelled) setSaved(request);
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : t('launch.errors.saveScheduleFailed'));
      }
    ).finally(() => {
      if (!cancelled) setSavedLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, teamName, t]);

  const handleSave = (): void => {
    if (submitInFlight.current || !canSubmit || !saved) return;
    if (saved.prompt?.trim()) {
      setError(t('schedule.taskFirstHistoricPrompt'));
      return;
    }
    try {
      new Cron(cronExpression.trim(), { timezone, paused: true }).stop();
    } catch {
      setError(t('schedule.cron.errors.invalidExpression'));
      return;
    }
    submitInFlight.current = true;
    setSubmitting(true);
    setError(null);
    void (async () => {
      // Re-read the chosen profile at the irreversible create boundary.
      const latest = await api.teams.getSavedRequest(teamName);
      if (!latest?.cwd?.trim() || !latest.providerId) {
        throw new Error(t('launch.schedule.teamPathMissing'));
      }
      if (latest.prompt?.trim()) {
        throw new Error(t('schedule.taskFirstHistoricPrompt'));
      }
      if (mode === 'agent' && targetMember &&
        !latest.members.some((member) => member.name === targetMember)) {
        throw new Error(t('messages.manualQueue.recipientUnavailable'));
      }
      await createSchedule({
        teamName,
        executionMode: mode,
        taskFirst: true,
        targetMember: mode === 'agent' ? targetMember : '',
        label: prompt.trim().replace(/\s+/g, ' ').slice(0, 100),
        cronExpression: cronExpression.trim(),
        timezone,
        warmUpMinutes: 0,
        launchConfig: { cwd: latest.cwd, prompt: prompt.trim() },
      });
      onClose();
    })().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : t('launch.errors.saveScheduleFailed'));
    }).finally(() => {
      submitInFlight.current = false;
      setSubmitting(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('launch.title.createSchedule')}</DialogTitle>
          <DialogDescription>{t('schedule.taskFirstDesktopRequired')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t('launch.schedule.team')}</Label>
            {fixedTeamName ? (
              <div className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm">
                {team?.displayName || teamName}
              </div>
            ) : (
              <Select value={selectedTeamName} onValueChange={setSelectedTeamName}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder={t('launch.schedule.selectTeam')} />
                </SelectTrigger>
                <SelectContent>
                  {teamChoices.map((choice) => (
                    <SelectItem key={choice.teamName} value={choice.teamName}>
                      {choice.displayName || choice.teamName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {!teamName && teamChoices.length === 0 ? (
              <p className="text-xs text-[var(--color-text-muted)]">{t('launch.schedule.noTeams')}</p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-schedule-instructions">{t('launch.prompt.label')}</Label>
            <Textarea
              id="task-schedule-instructions"
              rows={3}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={t('tasks.createTask.subjectPlaceholder')}
            />
          </div>
          <SmartScheduleFields
            isLight={isLight}
            expanded
            onToggle={() => undefined}
            mode={mode}
            onModeChange={(next) => { if (next !== 'legacy') { setMode(next); setTargetMember(''); } }}
            targetMember={targetMember}
            onTargetMemberChange={setTargetMember}
            team={pickerTeam}
            label=""
            onLabelChange={() => undefined}
            cronExpression={cronExpression}
            onCronExpressionChange={setCronExpression}
            timezone={timezone}
            onTimezoneChange={setTimezone}
            warmUpMinutes={0}
            onWarmUpMinutesChange={() => undefined}
            taskFirst
          />
          {saved?.prompt?.trim() ? (
            <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] p-3 text-xs">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{t('schedule.taskFirstHistoricPrompt')}</span>
            </div>
          ) : null}
          {team?.pendingCreate ? (
            <p role="alert" className="text-xs text-[var(--warning-text)]">
              {t('launch.schedule.teamPathMissing')}
            </p>
          ) : null}
          {error ? <p role="alert" className="text-xs text-red-400">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {tCommon('actions.cancel')}
          </Button>
          {saved?.prompt?.trim() ? (
            <Button variant="outline" onClick={() => { openTeamTab(teamName); onClose(); }}>
              {t('launch.schedule.team')}
            </Button>
          ) : null}
          <Button onClick={handleSave} disabled={!canSubmit || Boolean(saved?.prompt?.trim())}>
            {submitting ? t('tasks.createTask.creating') : t('launch.title.createSchedule')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
