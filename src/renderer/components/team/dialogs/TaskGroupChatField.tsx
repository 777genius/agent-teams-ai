import { useId, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useTeamGroupChats } from '@features/team-group-chats/renderer';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { useStore } from '@renderer/store';

interface TaskGroupChatFieldProps {
  teamName: string;
  value: string | null;
  onChange: (groupChatId: string | null) => void | Promise<void>;
  disabled?: boolean;
}

/** Assignment uses the current team's catalog; unassignment survives catalog failures. */
export const TaskGroupChatField = ({
  teamName,
  value,
  onChange,
  disabled,
}: Readonly<TaskGroupChatFieldProps>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const id = useId();
  const contextId = useStore((state) => state.activeContextId);
  const catalog = useTeamGroupChats(teamName, contextId, '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = catalog.allGroups.find((group) => group.id === value);
  const pending = catalog.loading && !catalog.error;
  const options = catalog.allGroups.filter((group) => !group.archivedAt);
  const preserved = value && (!current || current.archivedAt);
  const change = async (next: string) => {
    setSaving(true);
    setError(null);
    try {
      await onChange(next === '__none__' ? null : next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="grid min-w-[180px] gap-2">
      <Label htmlFor={id} className="label-optional">
        {t('tasks.groupChat.label')}
      </Label>
      <Select
        value={value ?? '__none__'}
        onValueChange={(next) => void change(next)}
        disabled={disabled || saving}
      >
        <SelectTrigger id={id} aria-label={t('tasks.groupChat.label')} className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">{t('tasks.groupChat.none')}</SelectItem>
          {preserved ? (
            <SelectItem value={value} disabled>
              {current?.name ??
                (pending || catalog.error
                  ? t('tasks.groupChat.loading', { id: value.slice(0, 8) })
                  : t('tasks.groupChat.unavailable', { id: value.slice(0, 8) }))}
              {current?.archivedAt ? t('tasks.groupChat.archived') : ''}
            </SelectItem>
          ) : null}
          {options.map((group) => (
            <SelectItem key={group.id} value={group.id} disabled={!!catalog.error || pending}>
              {group.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {catalog.error ? (
        <p role="status" className="text-xs text-[var(--color-text-muted)]">
          {t('tasks.groupChat.catalogError')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
};
