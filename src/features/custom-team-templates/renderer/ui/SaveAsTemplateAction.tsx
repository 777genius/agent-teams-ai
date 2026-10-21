import { lazy, Suspense, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
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
    /** Draft teams have no saved configuration to project. */
    pendingCreate?: boolean;
  };
}

/**
 * Team-row action that opens the "Save as Template" dialog.
 *
 * The action renders nothing for a draft team (there is no saved configuration
 * to prepare a preview from), stops propagation so the row does not navigate,
 * and lazy-loads the dialog so its code stays out of the initial bundle — the
 * same lifecycle the list uses for its other dialogs.
 */
export const SaveAsTemplateAction = ({
  team,
}: SaveAsTemplateActionProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const [open, setOpen] = useState(false);

  if (team.pendingCreate) return null;

  const label = t('customTemplates.actions.saveAsTemplate');

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-violet-500/10 hover:text-violet-300 focus-visible:opacity-100 group-hover:opacity-100"
            aria-label={label}
            onClick={(event) => {
              event.stopPropagation();
              setOpen(true);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <BookmarkPlus size={14} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      {open ? (
        // Event-only boundary for everything mounted by this action. The
        // loading fallback renders inline inside the team row (the dialog
        // itself stops its own events), so a click on the overlay or an
        // Enter/Space press must not bubble into the row's open-team handler.
        // `display: contents` keeps the wrapper out of the row's layout.
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
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
