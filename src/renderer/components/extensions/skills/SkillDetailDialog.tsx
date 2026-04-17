import { useEffect, useState } from 'react';

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
import { AlertTriangle, ExternalLink, FolderOpen, Pencil, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { resolveSkillProjectPath } from './skillProjectUtils';

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

  function formatRootKind(rootKind: 'claude' | 'cursor' | 'agents'): string {
    return `.${rootKind}`;
  }

  function formatScopeLabel(scope: 'user' | 'project'): string {
    return scope === 'project' ? 'This project only' : 'Your personal skills';
  }

  function formatInvocationLabel(invocationMode: 'auto' | 'manual-only'): string {
    return invocationMode === 'manual-only'
      ? 'Claude will only use this when you explicitly ask for it.'
      : 'Claude can pick this automatically when it matches the task.';
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
      setDeleteError(error instanceof Error ? error.message : 'Failed to delete skill');
    } finally {
      setDeleteLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{item?.name ?? 'Skill details'}</DialogTitle>
          <DialogDescription>
            {item?.description ?? 'Inspect discovered skill metadata and raw instructions.'}
          </DialogDescription>
        </DialogHeader>

        {(loading || (open && skillId && detail === undefined)) && (
          <p className="text-sm text-text-muted">Loading skill details...</p>
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
                Retry
              </Button>
            )}
          </div>
        )}

        {!loading && !detailError && detail === null && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">
            Unable to load this skill.
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
              <Badge variant="outline">Stored in {formatRootKind(item.rootKind)}</Badge>
              <Badge variant="secondary">
                {item.invocationMode === 'manual-only' ? 'Manual use' : 'Auto use'}
              </Badge>
              {item.flags.hasScripts && <Badge variant="destructive">Has scripts</Badge>}
              {item.flags.hasReferences && <Badge variant="secondary">References</Badge>}
              {item.flags.hasAssets && <Badge variant="secondary">Assets</Badge>}
            </div>

            {item.issues.length > 0 && (
              <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-4">
                <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                  Review this skill carefully before using it
                </p>
                {item.issues.map((issue, index) => (
                  <div
                    key={`${issue.code}-${index}`}
                    className="flex gap-2 text-sm text-amber-700 dark:text-amber-300"
                  >
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <span>{issue.message}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-3">
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  Who can use it
                </p>
                <p className="text-sm text-text">{formatScopeLabel(item.scope)}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  How Claude uses it
                </p>
                <p className="text-sm text-text">{formatInvocationLabel(item.invocationMode)}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  What comes with it
                </p>
                <p className="text-sm text-text">
                  {[
                    item.flags.hasReferences ? 'references' : null,
                    item.flags.hasScripts ? 'scripts' : null,
                    item.flags.hasAssets ? 'assets' : null,
                  ]
                    .filter(Boolean)
                    .join(', ') || 'Just the skill instructions'}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={onEdit}>
                <Pencil className="mr-1.5 size-3.5" />
                Edit Skill
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeleteConfirmOpen(true)}
                disabled={deleteLoading}
              >
                <Trash2 className="mr-1.5 size-3.5" />
                {deleteLoading ? 'Deleting...' : 'Delete'}
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
                    <p className="font-medium text-text">Stored at</p>
                    <p className="break-all text-xs text-text-muted">{item.skillDir}</p>
                  </div>

                  {detail.scriptFiles.length > 0 && (
                    <div className="mt-4 space-y-1">
                      <p className="font-medium text-text">Scripts</p>
                      {detail.scriptFiles.map((file) => (
                        <p key={file} className="text-xs text-text-muted">
                          {file}
                        </p>
                      ))}
                    </div>
                  )}

                  {detail.referencesFiles.length > 0 && (
                    <div className="mt-4 space-y-1">
                      <p className="font-medium text-text">References</p>
                      {detail.referencesFiles.map((file) => (
                        <p key={file} className="text-xs text-text-muted">
                          {file}
                        </p>
                      ))}
                    </div>
                  )}

                  {detail.assetFiles.length > 0 && (
                    <div className="mt-4 space-y-1">
                      <p className="font-medium text-text">Assets</p>
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
                    Advanced file details
                  </summary>
                  <div className="mt-3 space-y-3">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void api.showInFolder(item.skillFile)}
                      >
                        <FolderOpen className="mr-1.5 size-3.5" />
                        Open Folder
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void api.openPath(item.skillFile, effectiveProjectPath)}
                      >
                        <ExternalLink className="mr-1.5 size-3.5" />
                        Open SKILL.md
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
            <AlertDialogTitle>Delete skill?</AlertDialogTitle>
            <AlertDialogDescription>
              {item
                ? `Delete "${item.name}" and move it to Trash? You can restore it later from Trash if needed.`
                : 'Delete this skill and move it to Trash?'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()} disabled={deleteLoading}>
              {deleteLoading ? 'Deleting...' : 'Delete Skill'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
};
