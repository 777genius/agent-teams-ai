import { useState } from 'react';

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { AlertTriangle, RefreshCw } from 'lucide-react';

import { useCustomTemplateLibrary } from '../hooks/useCustomTemplateLibrary';

import { BuiltInTemplateCatalogue } from './BuiltInTemplateCatalogue';

export interface MyTemplatesDialogProps {
  open: boolean;
  onClose: () => void;
}

type TemplateLibraryTab = 'my-templates' | 'built-in';

function formatCreatedAt(value?: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString();
}

/**
 * Unified template browser.
 *
 * Opens on My Templates by default. The Built-in tab renders the static
 * closed catalogue and never depends on the custom-template request, so a
 * custom-template failure cannot hide or disable built-ins. The single
 * `useCustomTemplateLibrary` read is shared by both tabs without duplication,
 * and its request-sequence guard keeps late responses from overwriting newer
 * state when the dialog closes or the tab changes.
 */
export const MyTemplatesDialog = ({ open, onClose }: MyTemplatesDialogProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const { state, reload } = useCustomTemplateLibrary(open);
  const [tab, setTab] = useState<TemplateLibraryTab>('my-templates');

  const failed = state.status === 'storageUnavailable' || state.status === 'requestFailed';

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('customTemplates.library.title')}</DialogTitle>
          <DialogDescription>{t('customTemplates.library.description')}</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(value) => setTab(value as TemplateLibraryTab)}>
          <TabsList aria-label={t('customTemplates.library.title')}>
            <TabsTrigger value="my-templates">
              {t('customTemplates.library.tabs.myTemplates')}
            </TabsTrigger>
            <TabsTrigger value="built-in">{t('customTemplates.library.tabs.builtIn')}</TabsTrigger>
          </TabsList>

          <TabsContent value="my-templates">
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
                      count: state.unreadableRecords.length,
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
          </TabsContent>

          <TabsContent value="built-in">
            <BuiltInTemplateCatalogue />
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tCommon('actions.close')}
          </Button>
          {tab === 'my-templates' && failed ? (
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
