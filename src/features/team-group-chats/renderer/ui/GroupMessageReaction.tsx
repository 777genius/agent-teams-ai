import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';

import { useGroupMessageReaction } from '../hooks/useGroupMessageReaction';

import type { GroupMessageReactionTarget } from '../../contracts';

export const GroupMessageReaction = ({ target }: { target: GroupMessageReactionTarget }) => {
  const { t } = useAppTranslation('team');
  const { snapshot, pending, failed, disabled, toggle } = useGroupMessageReaction(target);
  const count = snapshot?.actorNames.length ?? 0;
  const action = snapshot?.hasUserReacted ? 'remove' : 'add';
  const label = t(`activity.reactions.${action}`, { count });
  return (
    <div className="flex items-center gap-2" data-group-message-reaction="true">
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)]"
            tabIndex={disabled && count > 0 ? 0 : undefined}
            aria-label={disabled ? t('activity.reactions.count', { count }) : undefined}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={`h-6 gap-1 px-1.5 text-[11px] ${snapshot?.hasUserReacted ? 'bg-blue-500/10 text-blue-400' : 'text-[var(--color-text-muted)]'}`}
              disabled={disabled}
              aria-label={label}
              aria-pressed={snapshot?.hasUserReacted ?? false}
              aria-busy={pending}
              onClick={(event) => {
                event.stopPropagation();
                void toggle();
              }}
            >
              <span aria-hidden>👍</span>
              {count > 0 ? <span aria-hidden>{count}</span> : null}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {count > 0 ? (
            <ul className="max-h-60 overflow-y-auto">
              {snapshot?.actorNames.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          ) : (
            label
          )}
        </TooltipContent>
      </Tooltip>
      {failed ? (
        <span role="status" className="text-[11px] text-red-400">
          {t('activity.reactions.failed')}
        </span>
      ) : null}
    </div>
  );
};
