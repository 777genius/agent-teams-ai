import { useCallback, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { useStore } from '@renderer/store';
import { getCronDescription } from '@renderer/utils/scheduleFormatters';
import { useShallow } from 'zustand/react/shallow';

type ScheduleAction = 'delete' | 'pause' | 'resume' | 'run';
export type ScheduleActionFeedback = { kind: 'error' | 'success'; message: string };

/** Same deletion safety and visible failure semantics in both schedule lists. */
export function useScheduleActions() {
  const { t, resolvedLanguage } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const { schedules, deleteSchedule, pauseSchedule, resumeSchedule, triggerNow } =
    useStore(useShallow((s) => ({
      schedules: s.schedules,
      deleteSchedule: s.deleteSchedule,
      pauseSchedule: s.pauseSchedule,
      resumeSchedule: s.resumeSchedule,
      triggerNow: s.triggerNow,
    })));
  const [feedback, setFeedback] = useState<ScheduleActionFeedback | null>(null);

  const act = useCallback(async (kind: ScheduleAction, id: string): Promise<void> => {
    setFeedback(null);
    if (kind === 'delete') {
      const schedule = schedules.find((candidate) => candidate.id === id);
      if (!schedule) return;
      const label = schedule.label || getCronDescription(schedule.cronExpression, resolvedLanguage);
      const accepted = await confirm({
        title: t('schedule.actions.delete'),
        message: t('schedule.deleteConfirmation', { label }),
        confirmLabel: t('schedule.actions.delete'),
        cancelLabel: tCommon('actions.cancel'),
        variant: 'danger',
      });
      if (!accepted) return;
    }

    try {
      if (kind === 'delete') await deleteSchedule(id);
      else if (kind === 'pause') await pauseSchedule(id);
      else if (kind === 'resume') await resumeSchedule(id);
      else {
        await triggerNow(id);
        setFeedback({ kind: 'success', message: t('schedule.runRequested') });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setFeedback({ kind: 'error', message: `${t('schedule.actionFailed')}: ${reason}` });
    }
  }, [deleteSchedule, pauseSchedule, resumeSchedule, resolvedLanguage, schedules, t, triggerNow]);

  return { feedback, act };
}
