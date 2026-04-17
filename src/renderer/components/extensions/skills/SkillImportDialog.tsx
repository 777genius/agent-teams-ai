import { useEffect, useState } from 'react';

import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { useStore } from '@renderer/store';
import { SKILL_ROOT_DEFINITIONS } from '@shared/utils/skillRoots';
import { FileSearch, FolderOpen, X } from 'lucide-react';

import { getSuggestedSkillFolderNameFromPath } from './skillFolderNameUtils';
import { resolveSkillProjectPath } from './skillProjectUtils';
import { SkillReviewDialog } from './SkillReviewDialog';
import { validateSkillFolderName, validateSkillImportSourceDir } from './skillValidationUtils';

import type { SkillReviewPreview, SkillRootKind } from '@shared/types/extensions';

function getFriendlyImportError(message: string): string {
  if (message.includes('valid skill file')) {
    return 'This folder does not look like a skill yet. It needs a SKILL.md, Skill.md, or skill.md file.';
  }
  if (message.includes('symbolic links')) {
    return 'This folder contains symbolic links. Import the real files instead of links.';
  }
  if (message.includes('too many files')) {
    return 'This skill folder is too large to import at once. Remove extra files and try again.';
  }
  if (message.includes('too large')) {
    return 'This skill folder is too large to import safely. Trim large assets and try again.';
  }
  if (message.includes('Invalid folder name')) {
    return 'Pick a simpler destination folder name using letters, numbers, dots, dashes, or underscores.';
  }
  if (message.includes('must be a directory')) {
    return 'Choose a folder to import, not a single file.';
  }
  return message;
}

interface SkillImportDialogProps {
  open: boolean;
  projectPath: string | null;
  projectLabel: string | null;
  allowCodexRootKind: boolean;
  onClose: () => void;
  onImported: (skillId: string | null) => void;
}

export const SkillImportDialog = ({
  open,
  projectPath,
  projectLabel,
  allowCodexRootKind,
  onClose,
  onImported,
}: SkillImportDialogProps): React.JSX.Element => {
  const previewSkillImport = useStore((s) => s.previewSkillImport);
  const applySkillImport = useStore((s) => s.applySkillImport);

  const [sourceDir, setSourceDir] = useState('');
  const [folderName, setFolderName] = useState('');
  const [folderNameEdited, setFolderNameEdited] = useState(false);
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [rootKind, setRootKind] = useState<SkillRootKind>('claude');
  const [preview, setPreview] = useState<SkillReviewPreview | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSourceDir('');
    setFolderName('');
    setFolderNameEdited(false);
    setScope(projectPath ? 'project' : 'user');
    setRootKind('claude');
    setPreview(null);
    setReviewOpen(false);
    setReviewLoading(false);
    setImportLoading(false);
    setMutationError(null);
  }, [open, projectPath]);

  useEffect(() => {
    if (open) {
      return;
    }

    setPreview(null);
    setReviewOpen(false);
    setReviewLoading(false);
    setImportLoading(false);
    setMutationError(null);
  }, [open]);

  useEffect(() => {
    if (!open || folderNameEdited) {
      return;
    }
    setFolderName(sourceDir.trim() ? getSuggestedSkillFolderNameFromPath(sourceDir) : '');
  }, [folderNameEdited, open, sourceDir]);

  useEffect(() => {
    if (open && scope === 'project' && !projectPath) {
      setScope('user');
    }
  }, [open, projectPath, scope]);

  useEffect(() => {
    if (open && rootKind === 'codex' && !allowCodexRootKind) {
      setRootKind('claude');
    }
  }, [allowCodexRootKind, open, rootKind]);

  const visibleRootDefinitions = SKILL_ROOT_DEFINITIONS.filter(
    (definition) => definition.rootKind !== 'codex' || allowCodexRootKind
  );

  async function handleChooseFolder(): Promise<void> {
    const selected = await api.config.selectFolders();
    const first = selected[0];
    if (!first) return;
    setSourceDir(first);
  }

  async function handleReview(): Promise<void> {
    const normalizedSourceDir = sourceDir.trim();
    const normalizedFolderName = folderName.trim();
    const sourceDirError = validateSkillImportSourceDir(sourceDir);
    if (sourceDirError) {
      setMutationError(sourceDirError);
      return;
    }

    const folderNameError =
      normalizedFolderName.length > 0 ? validateSkillFolderName(normalizedFolderName) : null;
    if (folderNameError) {
      setMutationError(folderNameError);
      return;
    }

    setReviewLoading(true);
    setMutationError(null);
    try {
      const nextPreview = await previewSkillImport({
        sourceDir: normalizedSourceDir,
        folderName: normalizedFolderName || undefined,
        scope,
        rootKind,
        projectPath: resolveSkillProjectPath(scope, projectPath),
      });
      setPreview(nextPreview);
      setReviewOpen(true);
    } catch (error) {
      setMutationError(
        getFriendlyImportError(
          error instanceof Error ? error.message : 'Failed to review import changes'
        )
      );
    } finally {
      setReviewLoading(false);
    }
  }

  async function handleConfirmImport(): Promise<void> {
    const normalizedSourceDir = sourceDir.trim();
    const normalizedFolderName = folderName.trim();

    setImportLoading(true);
    setMutationError(null);
    try {
      const detail = await applySkillImport({
        sourceDir: normalizedSourceDir,
        folderName: normalizedFolderName || undefined,
        scope,
        rootKind,
        projectPath: resolveSkillProjectPath(scope, projectPath),
        reviewPlanId: preview?.planId,
      });
      setReviewOpen(false);
      onImported(detail?.item.id ?? null);
      onClose();
    } catch (error) {
      setMutationError(
        getFriendlyImportError(error instanceof Error ? error.message : 'Failed to import skill')
      );
    } finally {
      setImportLoading(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent className="gap-0 overflow-hidden p-0">
          <div className="flex max-h-[85vh] min-h-0 flex-col">
            <DialogHeader className="border-b border-border px-6 py-5">
              <DialogTitle>Import skill</DialogTitle>
              <DialogDescription>
                Pick an existing skill folder, review what will be copied, then import it into one
                of your supported skill locations.
              </DialogDescription>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <div className="space-y-5">
                <section className="space-y-1">
                  <h3 className="text-sm font-semibold text-text">1. Choose a skill folder</h3>
                  <p className="text-sm text-text-muted">
                    This should be a folder that already contains a `SKILL.md`, `Skill.md`, or
                    `skill.md` file.
                  </p>
                </section>
                <div className="space-y-2">
                  <Label htmlFor="skill-import-source">Source folder</Label>
                  <div className="flex gap-2">
                    <Input
                      id="skill-import-source"
                      value={sourceDir}
                      onChange={(event) => setSourceDir(event.target.value)}
                    />
                    <Button variant="outline" onClick={() => void handleChooseFolder()}>
                      <FolderOpen className="mr-1.5 size-3.5" />
                      Browse
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="skill-import-folder">Destination folder name</Label>
                  <Input
                    id="skill-import-folder"
                    value={folderName}
                    onChange={(event) => {
                      setFolderNameEdited(true);
                      setFolderName(event.target.value);
                    }}
                    placeholder="Defaults to source folder name"
                  />
                </div>

                <section className="space-y-1">
                  <h3 className="text-sm font-semibold text-text">2. Decide where it belongs</h3>
                  <p className="text-sm text-text-muted">
                    Personal skills work everywhere. Project skills only show up for one codebase.
                  </p>
                </section>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="skill-import-scope">Who can use it</Label>
                    <Select
                      value={scope}
                      onValueChange={(value) => setScope(value as 'user' | 'project')}
                    >
                      <SelectTrigger id="skill-import-scope">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="user">User</SelectItem>
                        <SelectItem value="project" disabled={!projectPath}>
                          {projectPath
                            ? `Project: ${projectLabel ?? projectPath}`
                            : 'Project unavailable'}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="skill-import-root">Where to store it</Label>
                    <Select
                      value={rootKind}
                      onValueChange={(value) => setRootKind(value as SkillRootKind)}
                    >
                      <SelectTrigger id="skill-import-root">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {visibleRootDefinitions.map((definition) => (
                          <SelectItem key={definition.rootKind} value={definition.rootKind}>
                            {definition.directoryName}
                            {definition.audience === 'codex' ? ' - Codex only' : ' - Shared'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {mutationError && (
                  <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-400">
                    {mutationError}
                  </div>
                )}
              </div>
            </div>

            <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t border-border bg-surface px-6 py-4 shadow-[0_-8px_24px_rgba(0,0,0,0.08)]">
              <Button variant="outline" onClick={onClose}>
                <X className="mr-1.5 size-3.5" />
                Cancel
              </Button>
              <p className="min-w-64 flex-1 text-sm text-text-muted">
                Review the copied files first, then confirm the import in the next step.
              </p>
              <Button
                onClick={() => void handleReview()}
                disabled={!sourceDir.trim() || reviewLoading || importLoading}
              >
                <FileSearch className="mr-1.5 size-3.5" />
                {reviewLoading ? 'Preparing...' : 'Review And Import'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <SkillReviewDialog
        open={reviewOpen}
        preview={preview}
        loading={importLoading}
        error={mutationError}
        onClose={() => setReviewOpen(false)}
        onConfirm={() => void handleConfirmImport()}
        confirmLabel="Import Skill"
        reviewLabel="Importing this skill"
        backLabel="Back To Import"
      />
    </>
  );
};
