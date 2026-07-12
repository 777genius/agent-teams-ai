import { useEffect, useState } from 'react';

import { api } from '@renderer/api';
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

import type { TeamImportPreviewResult } from '@shared/types/team';

interface ImportTeamDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: (teamName: string | null) => void;
}

export const ImportTeamDialog = ({
  open,
  onClose,
  onImported,
}: ImportTeamDialogProps): React.JSX.Element => {
  const [sourceDir, setSourceDir] = useState('');
  const [preview, setPreview] = useState<TeamImportPreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSourceDir('');
    setPreview(null);
    setLoading(false);
    setImporting(false);
    setError(null);
  }, [open]);

  async function handleChooseFolder(): Promise<void> {
    const selected = await api.config.selectFolders();
    const first = selected[0];
    if (!first) return;
    setSourceDir(first);
    setPreview(null);
    setError(null);
    setLoading(true);
    try {
      const result = await api.teams.importFromFolder(first);
      setPreview(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to inspect folder');
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirmImport(): Promise<void> {
    if (!preview) return;
    setImporting(true);
    setError(null);
    try {
      await api.teams.createConfig({
        teamName: preview.teamName,
        displayName: preview.teamName,
        cwd: preview.projectPath,
        members: preview.members,
        prompt: preview.prompt,
      });
      onImported(preview.teamName);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create team');
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="gap-0 overflow-hidden p-0">
        <div className="flex max-h-[85vh] min-h-0 flex-col">
          <DialogHeader className="border-b border-border px-6 py-5">
            <DialogTitle>Import Agent Team from Folder</DialogTitle>
            <DialogDescription>
              Select a local agent team folder (with agents/*.md + .claude/CLAUDE.md). It will be
              scanned and a draft team created with members + workflow.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-semibold text-text">Agent team folder</label>
                <div className="flex gap-2">
                  <Input value={sourceDir} readOnly placeholder="Select a folder..." />
                  <Button
                    variant="outline"
                    onClick={() => void handleChooseFolder()}
                    disabled={loading}
                  >
                    <FolderOpen className="mr-1.5 size-3.5" />
                    Browse
                  </Button>
                </div>
              </div>

              {loading ? <p className="text-sm text-text-muted">Scanning folder...</p> : null}

              {preview ? (
                <div className="space-y-3 rounded-md border border-border p-4">
                  <div>
                    <p className="text-sm font-semibold text-text">Team name</p>
                    <p className="text-sm text-text-muted">{preview.teamName}</p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-text">Project path</p>
                    <p className="text-sm text-text-muted">{preview.projectPath}</p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-text">
                      Members ({preview.members.length})
                    </p>
                    <ul className="mt-1 space-y-1">
                      {preview.members.map((m) => (
                        <li key={m.name} className="text-sm text-text-muted">
                          • {m.name}
                          {m.role ? ` (${m.role})` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                  {preview.skillsFound.length > 0 ? (
                    <div>
                      <p className="text-sm font-semibold text-text">
                        Skills found ({preview.skillsFound.length})
                      </p>
                      <p className="text-sm text-text-muted">{preview.skillsFound.join(', ')}</p>
                    </div>
                  ) : null}
                  {preview.warnings.length > 0 ? (
                    <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3 text-sm text-yellow-400">
                      {preview.warnings.map((w) => (
                        <p key={w}>⚠ {w}</p>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {error ? (
                <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-400">
                  {error}
                </div>
              ) : null}
            </div>
          </div>

          <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t border-border bg-surface px-6 py-4">
            <Button variant="outline" onClick={onClose}>
              <X className="mr-1.5 size-3.5" />
              Cancel
            </Button>
            <p className="min-w-64 flex-1 text-sm text-text-muted">
              {preview
                ? `Will create draft team "${preview.teamName}" with ${preview.members.length} members.`
                : 'Select a folder to preview.'}
            </p>
            <Button onClick={() => void handleConfirmImport()} disabled={!preview || importing}>
              {importing ? 'Creating...' : 'Create Draft Team'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
