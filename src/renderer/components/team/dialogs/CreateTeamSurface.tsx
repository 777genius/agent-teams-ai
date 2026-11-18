import React, { type ReactNode } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { ArrowLeft } from 'lucide-react';

interface CreateTeamSurfaceProps {
  presentation: 'dialog' | 'page';
  open: boolean;
  isCopy: boolean;
  onClose: () => void;
  backDisabled?: boolean;
  children: ReactNode;
  headerActions?: ReactNode;
  footer?: ReactNode;
  overlay: ReactNode;
}

/**
 * Only the creation shell changes between the legacy dialog and the Teams page.
 * The form, provider checks, and submission flow have exactly one owner.
 * LaunchTeamDialog is intentionally independent of this component.
 */
export const CreateTeamSurface = ({
  presentation,
  open,
  isCopy,
  onClose,
  backDisabled = false,
  children,
  headerActions,
  footer,
  overlay,
}: CreateTeamSurfaceProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const title = isCopy ? t('create.title.copy') : t('create.title.create');
  const description = isCopy ? t('create.description.copy') : t('create.description.create');

  if (presentation === 'page') {
    return (
      <section
        aria-label={title}
        data-testid="create-team-page"
        className="flex size-full min-h-0 min-w-0 flex-col overflow-y-auto overflow-x-hidden"
      >
        <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={backDisabled}
            aria-label={t('create.actions.backToTeams', { defaultValue: 'Back to teams' })}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-[7rem] flex-1">
            <h1 className="break-words text-base font-semibold text-[var(--color-text)]">{title}</h1>
          </div>
          {headerActions ? (
            <div className="ml-auto min-w-0 max-w-full shrink-0">{headerActions}</div>
          ) : null}
        </header>
        <div className="mx-auto w-full min-w-0 max-w-[64rem] shrink-0 space-y-4 px-4 pb-6 pt-4">
          {children}
        </div>
        <div className="grow border-t border-[var(--color-border)] bg-[var(--color-surface-sidebar)]">
          <DialogFooter className="mx-auto w-full min-w-0 max-w-[64rem] px-4 pb-5 pt-4 sm:justify-between">
            {footer}
          </DialogFooter>
        </div>
        {overlay}
      </section>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !backDisabled && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-[52rem]">
        <div className="flex items-start gap-4 pr-5">
          <DialogHeader className="min-w-0 flex-1">
            <DialogTitle className="text-sm">{title}</DialogTitle>
            <DialogDescription className="text-xs">{description}</DialogDescription>
          </DialogHeader>
          {headerActions ? (
            <div className="ml-auto min-w-0 max-w-[70%] shrink-0">{headerActions}</div>
          ) : null}
        </div>
        {children}
        {footer ? (
          <DialogFooter className="-mx-6 -mb-6 -mt-4 border-t border-[var(--color-border)] bg-[var(--color-surface-sidebar)] px-6 pb-5 pt-4 sm:justify-between">
            {footer}
          </DialogFooter>
        ) : null}
      </DialogContent>
      {overlay}
    </Dialog>
  );
};
