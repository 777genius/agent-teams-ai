import { lazy, Suspense, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { BookmarkPlus } from 'lucide-react';

const SaveAsTemplateDialog = lazy(() =>
  import('./SaveAsTemplateDialog').then((module) => ({ default: module.SaveAsTemplateDialog }))
);

export interface SaveAsTemplateActionProps {
  team: {
    /** Existing team whose saved configuration becomes the template source. */
    teamName: string;
    /** Proposed display name; only name and description stay editable. */
    displayName: string;
    /** Config-only teams have a saved configuration even before runtime launch. */
    pendingCreate?: boolean;
  };
}

/**
 * Team-row action that opens the "Save as Template" dialog.
 *
 * Configuration-only teams can provide a saved team.meta.json before runtime
 * launch. The action stops propagation so the row does not navigate,
 * and lazy-loads the dialog so its code stays out of the initial bundle — the
 * same lifecycle the list uses for its other dialogs.
 */
export const SaveAsTemplateAction = ({
  team,
}: SaveAsTemplateActionProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [open, setOpen] = useState(false);

  const label = t('customTemplates.actions.saveAsTemplate');

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6 shrink-0 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-violet-500/10 hover:text-violet-300 focus-visible:opacity-100 group-hover:opacity-100"
            aria-label={label}
            onClick={(event) => {
              event.stopPropagation();
              setOpen(true);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <BookmarkPlus size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      {open ? (
        // Event-only boundary for everything mounted by this action. The
        // loading fallback renders inline inside the team row (the dialog
        // itself stops its own events), so a click on the overlay or an
        // Enter/Space press must not bubble into the row's open-team handler.
        // `display: contents` keeps the wrapper out of the row's layout.
        <div
          className="contents"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
          }}
        >
          <Suspense
            fallback={
              <div
                role="status"
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 text-sm text-[var(--color-text-muted)]"
              >
                {t('customTemplates.states.loading')}
              </div>
            }
          >
            <SaveAsTemplateDialog
              open={open}
              sourceTeamName={team.teamName}
              initialName={team.displayName}
              onClose={() => setOpen(false)}
            />
          </Suspense>
        </div>
      ) : null}
    </>
  );
};
