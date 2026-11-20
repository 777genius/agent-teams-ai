import { useAppTranslation } from '@features/localization/renderer';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Label } from '@renderer/components/ui/label';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { Info } from 'lucide-react';

import type { JSX } from 'react';

interface Props {
  launchTeam: boolean;
  onLaunchTeamChange(value: boolean): void;
}

/** The "run the command after create" checkbox of the Create Team form. */
export const LaunchAfterCreateControl = ({
  launchTeam,
  onLaunchTeamChange,
}: Readonly<Props>): JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <div className="flex items-start gap-3">
      <Checkbox
        id="launch-team"
        className="mt-1 shrink-0"
        checked={launchTeam}
        onCheckedChange={(checked) => onLaunchTeamChange(checked === true)}
      />
      <div className="flex items-center gap-1.5">
        <Label htmlFor="launch-team" className="cursor-pointer text-sm font-semibold">
          {t('create.launchAfterCreate.label')}
        </Label>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('create.launchAfterCreate.description')}
                className="rounded text-[var(--color-text-muted)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)]"
              >
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">
              {t('create.launchAfterCreate.description')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
};
