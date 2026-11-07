import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { MemberSelect } from '@renderer/components/ui/MemberSelect';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { CronScheduleInput } from './CronScheduleInput';

import type { TeamSummary } from '@shared/types';

export type EditableScheduleMode = 'legacy' | 'agent' | 'team';
const DEFAULT_LEAD_VALUE = '__default_lead__';

interface SmartScheduleFieldsProps {
  isLight: boolean;
  expanded: boolean;
  onToggle: () => void;
  mode: EditableScheduleMode;
  onModeChange: (mode: EditableScheduleMode) => void;
  targetMember: string;
  onTargetMemberChange: (name: string) => void;
  team?: Pick<TeamSummary, 'members' | 'leadName'>;
  label: string;
  onLabelChange: (value: string) => void;
  cronExpression: string;
  onCronExpressionChange: (value: string) => void;
  timezone: string;
  onTimezoneChange: (value: string) => void;
  warmUpMinutes: number;
  onWarmUpMinutesChange: (value: number) => void;
}

/** Schedule-only controls: the shared team launch dialog remains untouched. */
export const SmartScheduleFields = ({
  isLight,
  expanded,
  onToggle,
  mode,
  onModeChange,
  targetMember,
  onTargetMemberChange,
  team,
  label,
  onLabelChange,
  cronExpression,
  onCronExpressionChange,
  timezone,
  onTimezoneChange,
  warmUpMinutes,
  onWarmUpMinutesChange,
}: SmartScheduleFieldsProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const leadName = team?.leadName?.trim() ?? '';
  const memberOptions = React.useMemo(() => {
    const roster = team?.members ?? [];
    // TeamSummary supplies the canonical lead separately from teammate rows.
    // Add only that real lead identity for display; do not synthesize runtime status.
    if (!leadName) {
      // Local UI-only default. Never write the placeholder as a member identity.
      return [{ name: DEFAULT_LEAD_VALUE, agentType: 'team-lead' }, ...roster];
    }
    if (roster.some((member) => member.name === leadName)) return roster;
    return [{ name: leadName, role: 'Lead', agentType: 'team-lead' }, ...roster];
  }, [leadName, team?.members]);

  return (
    <div
      className="rounded-lg border border-[var(--color-border-emphasis)] shadow-sm"
      style={{
        backgroundColor: isLight
          ? 'color-mix(in srgb, var(--color-surface-overlay) 24%, white 76%)'
          : 'var(--color-surface-overlay)',
      }}
    >
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left"
        onClick={onToggle}
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-[var(--color-text-muted)]" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-[var(--color-text-muted)]" />
        )}
        <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          {t('launch.schedule.title')}
        </span>
        {!expanded && (label || cronExpression) ? (
          <span className="ml-auto truncate text-[11px] text-[var(--color-text-muted)] opacity-70">
            {label || cronExpression}
          </span>
        ) : null}
      </button>
      {expanded ? (
      <div className="space-y-3 border-t border-[var(--color-border)] px-3 pb-3 pt-2">
        <div className="space-y-1.5">
        <Label className="text-xs">{t('launch.schedule.execution')}</Label>
        {mode === 'legacy' ? (
          <div className="rounded border border-[var(--color-border)] p-2 text-xs text-[var(--color-text-secondary)]">
            {t('launch.schedule.legacyNotice')}
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => onModeChange('agent')}
            >
              {t('launch.schedule.upgradeSmart')}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2" role="group" aria-label={t('launch.schedule.execution')}>
            {(['agent', 'team'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={mode === option}
                className={`rounded-md border px-3 py-2 text-xs font-medium transition-colors ${mode === option ? 'border-[var(--color-border-emphasis)] bg-[var(--color-surface-raised)] text-[var(--color-text)]' : 'border-[var(--color-border)] text-[var(--color-text-secondary)]'}`}
                onClick={() => onModeChange(option)}
              >
                {t(option === 'agent' ? 'launch.schedule.oneAgent' : 'launch.schedule.wholeTeam')}
              </button>
            ))}
          </div>
        )}
        {mode === 'agent' ? (
          <>
            <Label htmlFor="schedule-member" className="text-xs">
              {t('launch.schedule.target')}
            </Label>
            <MemberSelect
              id="schedule-member"
              members={memberOptions}
              value={targetMember || leadName || DEFAULT_LEAD_VALUE}
              onChange={(name) =>
                onTargetMemberChange(name === leadName || name === DEFAULT_LEAD_VALUE ? '' : (name ?? ''))
              }
              placeholder={t('launch.schedule.leadDefault')}
              ariaLabel={t('launch.schedule.target')}
              getMemberLabel={(member) =>
                member.name === leadName || member.name === DEFAULT_LEAD_VALUE
                  ? t('launch.schedule.leadDefault')
                  : member.name
              }
              disabled={!team}
            />
            <p className="text-[11px] text-[var(--color-text-muted)]">
              {t('launch.schedule.agentDescription')}
            </p>
          </>
        ) : mode === 'team' ? (
          <p className="text-[11px] text-[var(--color-text-muted)]">
            {t('launch.schedule.teamDescription')}
          </p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="schedule-label" className="label-optional">
          {t('launch.schedule.labelOptional')}
        </Label>
        <Input
          id="schedule-label"
          className="h-8 text-xs"
          value={label}
          onChange={(event) => onLabelChange(event.target.value)}
          placeholder={t('launch.schedule.labelPlaceholder')}
        />
      </div>
      <CronScheduleInput
        showWarmUp={mode === 'legacy'}
        cronExpression={cronExpression}
        onCronExpressionChange={onCronExpressionChange}
        timezone={timezone}
        onTimezoneChange={onTimezoneChange}
        warmUpMinutes={warmUpMinutes}
        onWarmUpMinutesChange={onWarmUpMinutesChange}
      />
      </div>
      ) : null}
    </div>
  );
};
