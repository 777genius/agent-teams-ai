import { useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { CodeBlockViewer } from '@renderer/components/chat/viewers/CodeBlockViewer';
import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { useStore } from '@renderer/store';
import { formatSkillRootKind, getSkillAudienceLabel } from '@shared/utils/skillRoots';
import { AlertTriangle, ExternalLink, FolderOpen, Info, Pencil, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { resolveSkillProjectPath } from './skillProjectUtils';

import type { SkillValidationIssue } from '@shared/types/extensions';

interface SkillDetailDialogProps {
  skillId: string | null;
  open: boolean;
  onClose: () => void;
  projectPath: string | null;
  onEdit: () => void;
  onDeleted: () => void;
}

export const SkillDetailDialog = ({
  skillId,
  open,
  onClose,
  projectPath,
  onEdit,
  onDeleted,
}: SkillDetailDialogProps): React.JSX.Element => {
  const { t } = useAppTranslation('extensions');
  const fetchSkillDetail = useStore((s) => s.fetchSkillDetail);
  const deleteSkill = useStore((s) => s.deleteSkill);
  const detail = useStore(useShallow((s) => (skillId ? s.skillsDetailsById[skillId] : undefined)));
  const loading = useStore((s) =>
    skillId ? (s.skillsDetailLoadingById[skillId] ?? false) : false
  );
  const detailError = useStore((s) =>
    skillId ? (s.skillsDetailErrorById[skillId] ?? null) : null
  );
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  useEffect(() => {
    if (!open || !skillId) return;
    void fetchSkillDetail(
      skillId,
      detail?.item.scope
        ? resolveSkillProjectPath(detail.item.scope, projectPath, detail.item.projectRoot)
        : (projectPath ?? undefined)
    ).catch(() => undefined);
  }, [detail?.item.projectRoot, detail?.item.scope, fetchSkillDetail, open, projectPath, skillId]);

  useEffect(() => {
    if (!open) {
      setDeleteError(null);
      setDeleteLoading(false);
      setDeleteConfirmOpen(false);
    }
  }, [open]);

  const item = detail?.item;
  const effectiveProjectPath = item
    ? resolveSkillProjectPath(item.scope, projectPath, item.projectRoot)
    : (projectPath ?? undefined);
  const issuesTone = item?.issues.length ? getIssuesTone(item.issues) : null;

  function formatScopeLabel(scope: 'user' | 'project'): string {
    return scope === 'project'
      ? t('skillDetail.scope.projectOnly')
      : t('skillDetail.scope.personal');
  }

  function formatInvocationLabel(invocationMode: 'auto' | 'manual-only'): string {
    return invocationMode === 'manual-only'
      ? t('skillDetail.invocation.manualOnly')
      : t('skillDetail.invocation.auto');
  }

  function getIssuesTone(issues: SkillValidationIssue[]): {
    className: string;
    title: string;
    Icon: typeof AlertTriangle;
  } {
    const informationalOnly = issues.every((issue) => issue.severity === 'info');
    if (informationalOnly) {
      return {
        className: 'border-blue-500/30 bg-blue-500/5',
        title: t('skillDetail.issues.bundledScripts'),
        Icon: Info,
      };
    }

    return {
      className: 'border-amber-500/30 bg-amber-500/5',
      title: t('skillDetail.issues.reviewCarefully'),
      Icon: AlertTriangle,
    };
  }

  async function handleDelete(): Promise<void> {
    if (!item) return;
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      await deleteSkill({
        skillId: item.id,
        projectPath: effectiveProjectPath,
      });
      setDeleteConfirmOpen(false);
      onDeleted();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t('skillDetail.errors.deleteFailed'));
    } finally {
      setDeleteLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{item?.name ?? t('skillDetail.titleFallback')}</DialogTitle>
          <DialogDescription>
            {item?.description ?? t('skillDetail.descriptionFallback')}
          </DialogDescription>
        </DialogHeader>

        {(loading || (open && skillId && detail === undefined)) && (
          <p className="text-sm text-text-muted">{t('skillDetail.loading')}</p>
        )}

        {!loading && detailError && (
          <div className="space-y-3 rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">
            <p>{detailError}</p>
            {skillId && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void fetchSkillDetail(skillId, effectiveProjectPath).catch(() => undefined);
                }}
              >
                {t('skillDetail.actions.retry')}
              </Button>
            )}
          </div>
        )}

        {!loading && !detailError && detail === null && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">
            {t('skillDetail.errors.loadFailed')}
          </div>
        )}

        {!loading && detail && item && (
          <div className="space-y-4">
            {deleteError && (
              <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-400">
                {deleteError}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{formatScopeLabel(item.scope)}</Badge>
              <Badge variant="outline">
                {t('skillDetail.badges.storedIn', { root: formatSkillRootKind(item.rootKind) })}
              </Badge>
              <Badge variant="outline">{getSkillAudienceLabel(item.rootKind)}</Badge>
              <Badge variant="secondary">
                {item.invocationMode === 'manual-only'
                  ? t('skillDetail.badges.manualUse')
                  : t('skillDetail.badges.autoUse')}
              </Badge>
              {item.flags.hasScripts && (
                <Badge variant="destructive">{t('skillDetail.badges.hasScripts')}</Badge>
              )}
              {item.flags.hasReferences && (
                <Badge variant="secondary">{t('skillDetail.badges.references')}</Badge>
              )}
              {item.flags.hasAssets && (
                <Badge variant="secondary">{t('skillDetail.badges.assets')}</Badge>
              )}
            </div>

            {item.issues.length > 0 && (
              <div className={`space-y-2 rounded-md border p-4 ${issuesTone?.className ?? ''}`}>
                <p
                  className={`text-sm font-medium ${
                    issuesTone?.Icon === Info
                      ? 'text-blue-700 dark:text-blue-300'
                      : 'text-amber-700 dark:text-amber-300'
                  }`}
                >
                  {issuesTone?.title}
                </p>
                {item.issues.map((issue, index) => (
                  <div
                    key={`${issue.code}-${index}`}
                    className={`flex gap-2 text-sm ${
                      issue.severity === 'info'
                        ? 'text-blue-700 dark:text-blue-300'
                        : 'text-amber-700 dark:text-amber-300'
                    }`}
                  >
                    {issue.severity === 'info' ? (
                      <Info className="mt-0.5 size-4 shrink-0" />
                    ) : (
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    )}
                    <span>{issue.message}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-3">
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  {t('skillDetail.summary.whoCanUse')}
                </p>
                <p className="text-sm text-text">{formatScopeLabel(item.scope)}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  {t('skillDetail.summary.howUsed')}
                </p>
                <p className="text-sm text-text">{formatInvocationLabel(item.invocationMode)}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  {t('skillDetail.summary.included')}
                </p>
                <p className="text-sm text-text">
                  {[
                    item.flags.hasReferences ? t('skillDetail.includes.references') : null,
                    item.flags.hasScripts ? t('skillDetail.includes.scripts') : null,
                    item.flags.hasAssets ? t('skillDetail.includes.assets') : null,
                  ]
                    .filter(Boolean)
                    .join(', ') || t('skillDetail.includes.instructionsOnly')}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={onEdit}>
                <Pencil className="mr-1.5 size-3.5" />
                {t('skillDetail.actions.editSkill')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeleteConfirmOpen(true)}
                disabled={deleteLoading}
              >
                <Trash2 className="mr-1.5 size-3.5" />
                {deleteLoading
                  ? t('skillDetail.actions.deleting')
                  : t('skillDetail.actions.delete')}
              </Button>
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
              <div className="min-w-0 rounded-lg border border-border p-4">
                <MarkdownViewer
                  content={detail.body || detail.rawContent}
                  baseDir={item.skillDir}
                  bare
                  copyable
                />
              </div>

              <div className="space-y-4">
                <div className="rounded-lg border border-border p-3 text-sm text-text-secondary">
                  <div className="space-y-2">
                    <p className="font-medium text-text">{t('skillDetail.files.storedAt')}</p>
                    <p className="break-all text-xs text-text-muted">{item.skillDir}</p>
                  </div>

                  {detail.scriptFiles.length > 0 && (
                    <div className="mt-4 space-y-1">
                      <p className="font-medium text-text">{t('skillDetail.files.scripts')}</p>
                      {detail.scriptFiles.map((file) => (
                        <p key={file} className="text-xs text-text-muted">
                          {file}
                        </p>
                      ))}
                    </div>
                  )}

                  {detail.referencesFiles.length > 0 && (
                    <div className="mt-4 space-y-1">
                      <p className="font-medium text-text">{t('skillDetail.files.references')}</p>
                      {detail.referencesFiles.map((file) => (
                        <p key={file} className="text-xs text-text-muted">
                          {file}
                        </p>
                      ))}
                    </div>
                  )}

                  {detail.assetFiles.length > 0 && (
                    <div className="mt-4 space-y-1">
                      <p className="font-medium text-text">{t('skillDetail.files.assets')}</p>
                      {detail.assetFiles.map((file) => (
                        <p key={file} className="text-xs text-text-muted">
                          {file}
                        </p>
                      ))}
                    </div>
                  )}
                </div>

                <details className="rounded-lg border border-border p-3 text-sm text-text-secondary">
                  <summary className="cursor-pointer font-medium text-text">
                    {t('skillDetail.files.advancedDetails')}
                  </summary>
                  <div className="mt-3 space-y-3">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void api.showInFolder(item.skillFile)}
                      >
                        <FolderOpen className="mr-1.5 size-3.5" />
                        {t('skillDetail.actions.openFolder')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void api.openPath(item.skillFile, effectiveProjectPath)}
                      >
                        <ExternalLink className="mr-1.5 size-3.5" />
                        {t('skillDetail.actions.openSkillFile')}
                      </Button>
                    </div>
                    <CodeBlockViewer
                      fileName={item.skillFile}
                      content={detail.rawContent}
                      maxHeight="max-h-72"
                    />
                  </div>
                </details>
              </div>
            </div>
          </div>
        )}
      </DialogContent>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('skillDetail.deleteDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {item
                ? t('skillDetail.deleteDialog.descriptionWithName', { name: item.name })
                : t('skillDetail.deleteDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteLoading}>
              {t('skillDetail.actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()} disabled={deleteLoading}>
              {deleteLoading
                ? t('skillDetail.actions.deleting')
                : t('skillDetail.actions.deleteSkill')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
};
