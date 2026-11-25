import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { ReviewFlowTeamPanel } from '@features/review-flow/renderer';
import { Button } from '@renderer/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { Settings2 } from 'lucide-react';

interface KanbanApprovedSettingsMenuProps {
  teamName: string;
}

/** Popover on the Approved column: quick access to this team's review flow. */
export const KanbanApprovedSettingsMenu = ({
  teamName,
}: Readonly<KanbanApprovedSettingsMenuProps>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const openSettingsTab = useStore((state) => state.openSettingsTab);
  const [open, setOpen] = useState(false);

  const handleOpenDefaults = (): void => {
    setOpen(false);
    openSettingsTab('reviewFlow');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t('reviewFlow.title')}
              data-testid="kanban-approved-settings"
              className="kanban-grid-no-drag h-6 w-6 p-0 text-[var(--color-text-muted)]"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Settings2 size={13} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{t('reviewFlow.title')}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        className="kanban-grid-no-drag w-96 space-y-3"
        data-testid="kanban-review-flow-panel"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <ReviewFlowTeamPanel
          teamName={teamName}
          testIdPrefix="kanban-review-flow"
          onSaved={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
        <button
          type="button"
          className="text-xs text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)]"
          data-testid="kanban-review-flow-open-settings"
          onClick={handleOpenDefaults}
        >
          {t('reviewFlow.popover.openSettings')}
        </button>
      </PopoverContent>
    </Popover>
  );
};
