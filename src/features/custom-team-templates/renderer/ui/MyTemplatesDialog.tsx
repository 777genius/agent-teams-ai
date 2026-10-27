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
import { AlertTriangle, Pencil, Copy, Trash2, RefreshCw } from 'lucide-react';

import { useCustomTemplateLibrary } from '../hooks/useCustomTemplateLibrary';
import { useTemplateManagement } from '../hooks/useTemplateManagement';

import { BuiltInTemplateCatalogue } from './BuiltInTemplateCatalogue';
import { CopyBuiltinTemplateDialog } from './CopyBuiltinTemplateDialog';
import { DeleteCustomTemplateDialog } from './DeleteCustomTemplateDialog';
import { DuplicateCustomTemplateDialog } from './DuplicateCustomTemplateDialog';
import { EditCustomTemplateDialog } from './EditCustomTemplateDialog';

import type {
  BuiltinTeamTemplateId,
  CustomTeamTemplateV1,
} from '@features/custom-team-templates/contracts';

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

export const MyTemplatesDialog = ({ open, onClose }: MyTemplatesDialogProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const { state, reload } = useCustomTemplateLibrary(open);
  const management = useTemplateManagement({ onSuccess: reload });
  const [tab, setTab] = useState<TemplateLibraryTab>('my-templates');

  const [editingTemplate, setEditingTemplate] = useState<CustomTeamTemplateV1 | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState<CustomTeamTemplateV1 | null>(null);
  const [duplicatingTemplate, setDuplicatingTemplate] = useState<CustomTeamTemplateV1 | null>(null);
  const [copyBuiltinOpen, setCopyBuiltinOpen] = useState(false);
  const [copyBuiltinId, setCopyBuiltinId] = useState<BuiltinTeamTemplateId | null>(null);

  const failed = state.status === 'storageUnavailable' || state.status === 'requestFailed';

  const handleEditSaved = (updated: CustomTeamTemplateV1) => {
    setEditingTemplate(null);
    void reload();
  };

  const handleDuplicated = () => {
    setDuplicatingTemplate(null);
    void reload();
  };

  const handleDeleted = () => {
    setDeletingTemplate(null);
    void reload();
  };

  const handleCopied = () => {
    setCopyBuiltinOpen(false);
    void reload();
  };

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
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            data-testid={`edit-template-${template.templateId}`}
                            disabled={management.busy}
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingTemplate(template);
                            }}
                          >
                            <Pencil className="size-3.5" />
                            {t('customTemplates.actions.edit')}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            data-testid={`duplicate-template-${template.templateId}`}
                            disabled={management.busy}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDuplicatingTemplate(template);
                            }}
                          >
                            <Copy className="size-3.5" />
                            {t('customTemplates.actions.duplicate')}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            data-testid={`delete-template-${template.templateId}`}
                            disabled={management.busy}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeletingTemplate(template);
                            }}
                          >
                            <Trash2 className="size-3.5" />
                            {t('customTemplates.actions.delete')}
                          </Button>
                        </div>
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
            <div className="space-y-3">
              <BuiltInTemplateCatalogue
                onCopyBuiltin={(id) => {
                  setCopyBuiltinId(id);
                  setCopyBuiltinOpen(true);
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="copy-builtin-open"
                onClick={() => setCopyBuiltinOpen(true)}
              >
                <Copy className="size-3.5" />
                {t('customTemplates.actions.copyToMyTemplates')}
              </Button>
            </div>
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

        <EditCustomTemplateDialog
          open={editingTemplate !== null}
          template={editingTemplate}
          onClose={() => setEditingTemplate(null)}
          onSaved={handleEditSaved}
        />
        <DuplicateCustomTemplateDialog
          open={duplicatingTemplate !== null}
          template={duplicatingTemplate}
          onClose={() => setDuplicatingTemplate(null)}
          onDuplicated={handleDuplicated}
        />
        <DeleteCustomTemplateDialog
          open={deletingTemplate !== null}
          template={deletingTemplate}
          onClose={() => setDeletingTemplate(null)}
          onDeleted={handleDeleted}
        />
        <CopyBuiltinTemplateDialog
          open={copyBuiltinOpen}
          onClose={() => setCopyBuiltinOpen(false)}
          onCopied={handleCopied}
          initialBuiltinId={copyBuiltinId ?? undefined}
        />
      </DialogContent>
    </Dialog>
  );
};
