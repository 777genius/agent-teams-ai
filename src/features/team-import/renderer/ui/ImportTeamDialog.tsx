import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { FolderOpen, X } from 'lucide-react';

import { validateTeamImportName } from '../../core/domain/teamImportPolicy';
import { useTeamImportDialog } from '../hooks/useTeamImportDialog';

interface ImportTeamDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: (teamName: string) => void;
}

export const ImportTeamDialog = ({
  open,
  onClose,
  onImported,
}: ImportTeamDialogProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const state = useTeamImportDialog({
    open,
    onClose,
    onImported,
    inspectErrorFallback: t('teamImport.inspectFailed'),
    createErrorFallback: t('teamImport.createFailed'),
  });
  const teamNameError = validateTeamImportName(state.teamName);
  const canCreate =
    state.preview !== null &&
    state.preview.blockingErrors.length === 0 &&
    teamNameError === null &&
    !state.importing;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !state.importing && onClose()}>
      <DialogContent
        className="gap-0 overflow-hidden p-0"
        onEscapeKeyDown={(event) => state.importing && event.preventDefault()}
        onInteractOutside={(event) => state.importing && event.preventDefault()}
      >
        <div className="flex max-h-[85vh] min-h-0 flex-col">
          <DialogHeader className="border-b border-border px-6 py-5">
            <DialogTitle>{t('teamImport.title')}</DialogTitle>
            <DialogDescription>{t('teamImport.description')}</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="space-y-4">
              <Button
                variant="outline"
                onClick={() => void state.chooseFolder()}
                disabled={state.loading || state.importing}
              >
                <FolderOpen className="mr-1.5 size-3.5" />
                {state.loading ? t('teamImport.scanning') : t('teamImport.chooseFolder')}
              </Button>

              {state.preview ? (
                <div className="space-y-4 rounded-md border border-border p-4">
                  <div className="space-y-2">
                    <label htmlFor="team-import-name" className="text-sm font-semibold text-text">
                      {t('teamImport.teamName')}
                    </label>
                    <Input
                      id="team-import-name"
                      value={state.teamName}
                      onChange={(event) => state.setTeamName(event.target.value)}
                      disabled={state.importing}
                    />
                    {teamNameError ? (
                      <p className="text-xs text-red-400">{t('teamImport.invalidTeamName')}</p>
                    ) : null}
                  </div>

                  <div>
                    <p className="text-sm font-semibold text-text">{t('teamImport.projectPath')}</p>
                    <p className="break-all text-sm text-text-muted">{state.preview.projectPath}</p>
                  </div>

                  <section className="space-y-3">
                    <h3 className="text-sm font-semibold text-text">
                      {t('teamImport.members', { count: state.preview.members.length })}
                    </h3>
                    {state.preview.members.map((member) => (
                      <article key={member.name} className="rounded border border-border p-3">
                        <h4 className="text-sm font-medium text-text">{member.name}</h4>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-text-muted">
                          {member.workflow}
                        </pre>
                      </article>
                    ))}
                  </section>

                  {state.preview.prompt ? (
                    <section>
                      <h3 className="text-sm font-semibold text-text">
                        {t('teamImport.leadPrompt')}
                      </h3>
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-border p-3 text-xs text-text-muted">
                        {state.preview.prompt}
                      </pre>
                    </section>
                  ) : null}

                  {state.preview.skillsFound.length > 0 ? (
                    <div>
                      <p className="text-sm font-semibold text-text">
                        {t('teamImport.skills', { count: state.preview.skillsFound.length })}
                      </p>
                      <p className="text-sm text-text-muted">
                        {state.preview.skillsFound.join(', ')}
                      </p>
                    </div>
                  ) : null}

                  {state.preview.warnings.length > 0 ? (
                    <div
                      role="status"
                      className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3 text-sm text-yellow-400"
                    >
                      {state.preview.warnings.map((warning) => (
                        <p key={warning}>{warning}</p>
                      ))}
                    </div>
                  ) : null}

                  {state.preview.blockingErrors.length > 0 ? (
                    <div
                      role="alert"
                      className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-400"
                    >
                      {state.preview.blockingErrors.map((blockingError) => (
                        <p key={blockingError}>{blockingError}</p>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div aria-live="polite">
                {state.error ? (
                  <div
                    role="alert"
                    className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-400"
                  >
                    {state.error}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t border-border bg-surface px-6 py-4">
            <Button variant="outline" onClick={onClose} disabled={state.importing}>
              <X className="mr-1.5 size-3.5" />
              {t('teamImport.cancel')}
            </Button>
            <p className="min-w-64 flex-1 text-sm text-text-muted" aria-live="polite">
              {state.preview
                ? t('teamImport.summary', {
                    teamName: state.teamName,
                    count: state.preview.members.length,
                  })
                : t('teamImport.selectPrompt')}
            </p>
            <Button onClick={() => void state.createDraft()} disabled={!canCreate || state.loading}>
              {state.importing ? t('teamImport.creating') : t('teamImport.createDraft')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
