import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { Settings2 } from 'lucide-react';

interface KanbanApprovedSettingsMenuProps {
  enabled: boolean;
  onChange: (enabled: boolean) => Promise<void>;
}

export const KanbanApprovedSettingsMenu = ({
  enabled,
  onChange,
}: Readonly<KanbanApprovedSettingsMenuProps>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [pending, setPending] = useState(false);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t('kanban.approvalSettings.title')}
              data-testid="kanban-approved-settings"
              className="kanban-grid-no-drag h-6 w-6 p-0 text-[var(--color-text-muted)]"
              disabled={pending}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Settings2 size={13} />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{t('kanban.approvalSettings.title')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem
          checked={enabled}
          disabled={pending}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={(checked) => {
            setPending(true);
            void onChange(checked === true)
              .catch(() => {
                // Store reports the failure; the controlled checkbox stays persisted.
              })
              .finally(() => setPending(false));
          }}
        >
          {t('kanban.approvalSettings.onlyHumans')}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
