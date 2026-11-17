import { useAppTranslation } from '@features/localization/renderer';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { Info } from 'lucide-react';

import type { TeamProjectContextMode } from '@shared/types';
import type { JSX } from 'react';

interface Props {
  projectContextMode: TeamProjectContextMode;
  onProjectContextModeChange(value: TeamProjectContextMode): void;
  launchTeam: boolean;
  onLaunchTeamChange(value: boolean): void;
}

/** Creation-only controls. No runtime routing or fallback to shared history here. */
export function TeamHistoryAndLaunchControls({
  projectContextMode,
  onProjectContextModeChange,
  launchTeam,
  onLaunchTeamChange,
}: Props): JSX.Element {
  const { t } = useAppTranslation('team');
  return (
    <>
      <div className="mb-4 space-y-2">
        <Label htmlFor="team-project-context-mode">
          {t('create.projectContextMode.label')}
        </Label>
        <Select
          value={projectContextMode}
          onValueChange={(value) => {
            if (value === 'shared' || value === 'per_project') onProjectContextModeChange(value);
          }}
        >
          <SelectTrigger
            id="team-project-context-mode"
            aria-label={t('create.projectContextMode.label')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="per_project">
              {t('create.projectContextMode.perProject')}
            </SelectItem>
            <SelectItem value="shared">{t('create.projectContextMode.shared')}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-[var(--color-text-muted)]">
          {t('create.projectContextMode.description')}
        </p>
      </div>
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
    </>
  );
}
