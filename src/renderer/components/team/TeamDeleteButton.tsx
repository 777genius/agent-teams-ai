import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { Trash2 } from 'lucide-react';

import { useTeamDeleteInProgress } from './teamDeleteProgress';

interface TeamDeleteButtonProps {
  teamName: string;
  /** `card` is the hover action row of a team list card, `header` the team view header. */
  placement: 'card' | 'header';
  label: string;
  onClick(event: React.MouseEvent<HTMLButtonElement>): void;
}

/**
 * Move to trash control that stays busy while the request runs.
 *
 * Trashing stops the team runtime first, which can take minutes when an
 * OpenCode lane does not confirm its stop. During that time the button is
 * disabled and says that the team is being stopped, instead of looking idle and
 * inviting another click.
 */
export const TeamDeleteButton = ({
  teamName,
  placement,
  label,
  onClick,
}: Readonly<TeamDeleteButtonProps>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const deleting = useTeamDeleteInProgress(teamName);
  const currentLabel = deleting ? t('list.actions.stopping') : label;
  const content = (
    <>
      <Trash2
        size={placement === 'card' ? 14 : 12}
        className={deleting ? 'animate-pulse' : undefined}
      />
      {deleting ? <span>{currentLabel}</span> : null}
    </>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {placement === 'card' ? (
          <button
            type="button"
            className={cn(
              'flex shrink-0 items-center gap-1 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-300 focus-visible:opacity-100 group-hover:opacity-100',
              deleting && 'cursor-wait text-[11px] opacity-100'
            )}
            onClick={onClick}
            onKeyDown={(event) => event.stopPropagation()}
            disabled={deleting}
            aria-busy={deleting}
            aria-label={currentLabel}
          >
            {content}
          </button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'text-red-400 hover:bg-red-500/10 hover:text-red-300',
              deleting
                ? 'h-7 gap-1 rounded-md px-2 text-xs disabled:opacity-100'
                : 'size-7 rounded-full p-0'
            )}
            onClick={onClick}
            disabled={deleting}
            aria-busy={deleting}
            aria-label={currentLabel}
          >
            {content}
          </Button>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom">{currentLabel}</TooltipContent>
    </Tooltip>
  );
};
