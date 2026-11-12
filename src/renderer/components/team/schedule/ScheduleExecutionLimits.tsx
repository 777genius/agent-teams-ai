import { useAppTranslation } from '@features/localization/renderer';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';

export const ScheduleExecutionLimits = (props: {
  supported: boolean;
  maxTurns: number;
  maxBudgetUsd: string;
  onMaxTurns(value: number): void;
  onMaxBudgetUsd(value: string): void;
}) => {
  const { t } = useAppTranslation('team');
  if (!props.supported)
    return <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
      {t('launch.schedule.codexLimitsUnavailable', { defaultValue:
        'Codex does not support turn, budget or tool-list limits for standalone runs. Saving clears those settings. You can cancel a running task.' })}
    </p>;
  return <div className="grid grid-cols-2 gap-3">
    <div className="space-y-1">
      <Label htmlFor="schedule-max-turns" className="text-[11px] text-[var(--color-text-muted)]">
        {t('launch.schedule.maxTurns')}
      </Label>
      <Input id="schedule-max-turns" type="number" min={1} max={500} className="h-8 text-xs"
        value={props.maxTurns} onChange={event => props.onMaxTurns(Math.max(1, parseInt(event.target.value) || 50))} />
    </div>
    <div className="space-y-1">
      <Label htmlFor="schedule-max-budget" className="text-[11px] text-[var(--color-text-muted)]">
        {t('launch.schedule.maxBudgetUsd')}
      </Label>
      <Input id="schedule-max-budget" type="number" min={0} step={0.5} className="h-8 text-xs"
        value={props.maxBudgetUsd} onChange={event => props.onMaxBudgetUsd(event.target.value)}
        placeholder={t('launch.schedule.noLimit')} />
    </div>
    <p className="col-span-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
      {t('launch.schedule.executionLimitsNote', { defaultValue:
        'These limits apply only to standalone one-shot runs. Tasks assigned to a running team do not use them.' })}
    </p>
  </div>;
};
