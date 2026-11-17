import { useId, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';

import type { TeamProjectContextMode } from '@shared/types';

interface Props {
  teamName: string;
  mode: TeamProjectContextMode;
  onChanged(): Promise<void>;
}

/** Team-definition setting; switching never merges or deletes any history. */
export function TeamHistoryModePicker({
  teamName,
  mode,
  onChanged,
}: Props): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = async (target: string): Promise<void> => {
    if (busy || target === mode || (target !== 'per_project' && target !== 'shared')) return;
    const accepted = await confirm({
      title: t('projectContextView.modeChange.title'),
      message: t('projectContextView.modeChange.description'),
      confirmLabel: t('projectContextView.modeChange.confirm'),
    });
    if (!accepted) return;
    setBusy(true);
    setError(null);
    try {
      await api.teams.setProjectContextMode(teamName, target);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Label htmlFor={id} className="text-xs text-text-muted">
        {t('create.projectContextMode.label')}
      </Label>
      <Select value={mode} onValueChange={(value) => { void change(value); }} disabled={busy}>
        <SelectTrigger id={id} className="h-8 max-w-64 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="per_project">{t('create.projectContextMode.perProject')}</SelectItem>
          <SelectItem value="shared">{t('create.projectContextMode.shared')}</SelectItem>
        </SelectContent>
      </Select>
      {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
    </div>
  );
}
