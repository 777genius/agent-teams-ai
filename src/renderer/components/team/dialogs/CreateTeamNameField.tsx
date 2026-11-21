import { useAppTranslation } from '@features/localization/renderer';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { cn } from '@renderer/lib/utils';

interface Props {
  teamName: string;
  suggestedTeamName: string;
  fieldError?: string;
  teamNameInlineError?: string | null;
  isNameTakenByExistingTeam: boolean;
  isNameProvisioning: boolean;
  sanitizedTeamName: string;
  onTeamNameChange(value: string): void;
}

/** Reuses current Create Team validation without inflating the legacy editor. */
export function CreateTeamNameField({
  teamName,
  suggestedTeamName,
  fieldError,
  teamNameInlineError,
  isNameTakenByExistingTeam,
  isNameProvisioning,
  sanitizedTeamName,
  onTeamNameChange,
}: Props): React.JSX.Element {
  const { t } = useAppTranslation('team');
  return (
    <div className="w-full max-w-[24rem] space-y-1.5 md:col-span-2">
      <Label htmlFor="team-name">{t('create.fields.teamName')}</Label>
      <Input
        id="team-name"
        className={cn(
          'h-8 text-xs',
          (fieldError || teamNameInlineError || isNameTakenByExistingTeam) &&
            'border-[var(--field-error-border)] bg-[var(--field-error-bg)] focus-visible:ring-[var(--field-error-border)]'
        )}
        value={teamName}
        onChange={(event) => onTeamNameChange(event.target.value)}
        placeholder={suggestedTeamName}
      />
      {isNameTakenByExistingTeam ? (
        <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
          {t('create.errors.nameExists')}
        </p>
      ) : teamNameInlineError ? (
        <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
          {teamNameInlineError}
        </p>
      ) : isNameProvisioning ? (
        <p className="text-[11px]" style={{ color: 'var(--warning-text)' }}>
          {t('create.errors.nameLaunching')}
        </p>
      ) : fieldError ? (
        <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
          {fieldError}
        </p>
      ) : null}
      {sanitizedTeamName && sanitizedTeamName !== teamName.trim() ? (
        <p className="text-[11px] text-[var(--color-text-muted)]">
          {t('create.onDisk')} <span className="font-mono">{sanitizedTeamName}</span>
        </p>
      ) : null}
    </div>
  );
}
