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
import { AlertTriangle, RefreshCw } from 'lucide-react';

import { useCustomTemplateLibrary } from '../hooks/useCustomTemplateLibrary';

export interface MyTemplatesDialogProps {
  open: boolean;
  onClose: () => void;
}

function formatCreatedAt(value?: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString();
}

/**
 * Read-only library of saved templates.
 *
 * A1 deliberately offers no edit, delete, duplicate, export, import or
 * create-team action here: the dialog only reads the library and reports each
 * list outcome distinctly, re-reading on every open so a locally cached list
 * can never masquerade as persisted truth.
 */
export const MyTemplatesDialog = ({ open, onClose }: MyTemplatesDialogProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const { state, reload } = useCustomTemplateLibrary(open);

  const failed = state.status === 'storageUnavailable' || state.status === 'requestFailed';

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('customTemplates.library.title')}</DialogTitle>
          <DialogDescription>{t('customTemplates.library.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {state.status === 'idle' || state.status === 'loading' ? (
            <p role="status" className="text-sm text-[var(--color-text-muted)]">
              {t('customTemplates.library.loading')}
            </p>
          ) : null}

          {state.status === 'empty' ? (
            <div className="rounded-md border border-[var(--color-border)] p-4 text-center">
              <p className="text-sm font-medium text-[var(--color-text)]">
                {t('customTemplates.library.empty')}
              </p>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                {t('customTemplates.library.emptyDescription')}
              </p>
            </div>
          ) : null}

          {state.status === 'ready' || state.status === 'partial' ? (
            <ul className="space-y-2" data-testid="custom-template-library">
              {state.templates.map((template) => {
                const createdAt = formatCreatedAt(template.createdAt);
                return (
                  <li
                    key={template.templateId}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-semibold text-[var(--color-text)]">
                        {template.name}
                      </span>
                      {createdAt ? (
                        <span className="text-xs text-[var(--color-text-muted)]">
                          {t('customTemplates.library.createdAt', { date: createdAt })}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                      {template.description?.trim()
                        ? template.description
                        : t('customTemplates.library.noDescription')}
                    </p>
                    <p className="mt-2 text-xs text-[var(--color-text-secondary)]">
                      {template.members.length > 0
                        ? t('customTemplates.library.memberNames', {
                            names: template.members.map((member) => member.name).join(', '),
                          })
                        : t('customTemplates.library.noMembers')}
                    </p>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {state.status === 'partial' ? (
            <div
              role="status"
              data-testid="custom-template-unreadable"
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>
                {t('customTemplates.library.unreadableRecords', {
                  total: state.unreadableRecords.length,
                })}
              </p>
            </div>
          ) : null}

          {failed ? (
            <div
              role="alert"
              data-testid="custom-template-library-error"
              className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>
                {state.status === 'storageUnavailable'
                  ? t('customTemplates.library.storageUnavailable')
                  : t('customTemplates.library.loadFailed')}
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tCommon('actions.close')}
          </Button>
          {failed ? (
            <Button className="gap-1.5" onClick={() => void reload()}>
              <RefreshCw className="size-3.5" />
              {t('customTemplates.actions.retry')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
