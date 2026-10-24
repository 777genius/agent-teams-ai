import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { Archive, ArchiveRestore } from 'lucide-react';

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
  const actionLabel = group.archivedAt
    ? t('messages.groups.restore')
    : t('messages.groups.archive');
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
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-6 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            aria-label={actionLabel}
            disabled={pending}
            onClick={(event) => {
              event.stopPropagation();
              void change();
            }}
          >
            {group.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{actionLabel}</TooltipContent>
      </Tooltip>
      {error ? (
        <span role="alert" className="text-xs text-red-400">
          {error}
        </span>
      ) : null}
    </span>
  );
};
