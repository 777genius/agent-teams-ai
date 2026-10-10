import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';

import type { TeamGroupChatDTO } from '../../contracts';

export const GroupChatArchiveAction = ({
  group,
  setArchived,
}: {
  group?: TeamGroupChatDTO;
  setArchived: (id: string, archived: boolean) => Promise<void>;
}) => {
  const { t } = useAppTranslation('team');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!group) return null;
  const change = async () => {
    setPending(true);
    setError(null);
    try {
      await setArchived(group.id, !group.archivedAt);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <span className="flex flex-col items-end">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={(event) => {
          event.stopPropagation();
          void change();
        }}
      >
        {group.archivedAt ? t('messages.groups.restore') : t('messages.groups.archive')}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-red-400">
          {error}
        </span>
      ) : null}
    </span>
  );
};
