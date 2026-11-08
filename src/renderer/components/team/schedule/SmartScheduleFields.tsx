import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { MemberSelect } from '@renderer/components/ui/MemberSelect';
import { validateTeamMemberNameFormat } from '@shared/utils/teamMemberName';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { CronScheduleInput } from './CronScheduleInput';

import type { ResolvedTeamMember, TeamSummary } from '@shared/types';

export type EditableScheduleMode = 'legacy' | 'agent' | 'team';

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
  const leadName = team?.leadName?.trim() || 'team-lead';
  const savedTarget = targetMember.trim();
  // Only normalize the picker display; saving without a selection preserves the original target.
  const pickerTarget =
    savedTarget && savedTarget.toLowerCase() === leadName.toLowerCase()
      ? leadName
      : savedTarget || leadName;
  const recipientMembers = React.useMemo<ResolvedTeamMember[]>(() => {
    const source = team?.members ?? [];
    const lead = source.find(
      (member) => member.name.trim().toLowerCase() === leadName.toLowerCase()
    );
    const members: NonNullable<TeamSummary['members']> = [
      lead ? { ...lead, name: leadName } : { name: leadName },
      ...source.filter((member) => member !== lead),
    ];
    const seen = new Set<string>();
    return members.flatMap((member) => {
      const name = member.name.trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) return [];
      if (name !== leadName && validateTeamMemberNameFormat(name)) return [];
      seen.add(key);
      return [{
        name,
        agentId: member.agentId,
        role: member.role,
        color: member.color,
        status: 'unknown' as const,
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
      }];
    });
  }, [leadName, team]);
  const missingSavedMember = Boolean(
    savedTarget && team && !recipientMembers.some((member) => member.name === pickerTarget)
  );
  const invalidRosterNames = (team?.members ?? []).flatMap((member) => {
    if (member.name.trim().toLowerCase() === leadName.toLowerCase()) return [];
    const reason = validateTeamMemberNameFormat(member.name);
    return reason ? [{ name: member.name, reason }] : [];
  });

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
            <Label className="text-xs">
              {t('launch.schedule.target')}
            </Label>
            <MemberSelect
              members={recipientMembers}
              value={pickerTarget}
              onChange={(name) => onTargetMemberChange(name === leadName ? '' : (name ?? ''))}
              placeholder={
                savedTarget && !recipientMembers.some((member) => member.name === pickerTarget)
                  ? savedTarget
                  : t('launch.schedule.leadDefault')
              }
              getMemberLabel={(member) =>
                member.name === leadName ? t('launch.schedule.leadDefault') : member.name
              }
              ariaLabel={t('launch.schedule.target')}
              size="md"
            />
            {missingSavedMember ? (
              <p role="alert" className="text-xs text-[var(--warning-text)]">
                {t('messages.manualQueue.recipientUnavailable')}
              </p>
            ) : null}
            {invalidRosterNames.map(({ name, reason }) => (
              <p key={name} className="text-xs text-[var(--color-text-muted)]">
                {name}: {reason}
              </p>
            ))}
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
