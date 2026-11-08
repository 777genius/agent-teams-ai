import React, { type ReactNode } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
        <header className="sticky top-0 z-10 flex items-start gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={backDisabled} aria-label={t('create.actions.backToTeams', { defaultValue: 'Back to teams' })}>
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-[var(--color-text)]">{title}</h1>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">{description}</p>
          </div>
        </header>
        <div className="mx-auto w-full max-w-[64rem] min-w-0 space-y-4 px-4 pb-6 pt-4">
          {children}
        </div>
        {overlay}
      </section>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !backDisabled && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-[52rem]">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="text-xs">{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
      {overlay}
    </Dialog>
  );
};
