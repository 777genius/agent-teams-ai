/**
 * Quick Open dialog (Cmd+P) — fuzzy file search using cmdk.
 *
 * Escape closes dialog (not the editor overlay).
 * Loads ALL project files via backend API on mount (not limited to expanded dirs).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useStore } from '@renderer/store';
import { Command } from 'cmdk';
import { Loader2 } from 'lucide-react';

import { getFileIcon } from './fileIcons';

import type { QuickOpenFile } from '@shared/types/editor';

// =============================================================================
// Types
// =============================================================================

interface QuickOpenDialogProps {
  onClose: () => void;
  onSelectFile: (filePath: string) => void;
}

// =============================================================================
// Component
// =============================================================================

export const QuickOpenDialog = ({
  onClose,
  onSelectFile,
}: QuickOpenDialogProps): React.ReactElement => {
  const projectPath = useStore((s) => s.editorProjectPath);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [allFiles, setAllFiles] = useState<QuickOpenFile[]>([]);
  const [loading, setLoading] = useState(true);

  // Load all project files on mount via backend API
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    window.electronAPI.editor
      .listFiles()
      .then((files) => {
        if (!cancelled) {
          setAllFiles(files);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // Escape to close dialog (not overlay)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    },
    [onClose]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  const handleSelect = useCallback(
    (value: string) => {
      // value is relativePath from cmdk — look up full path
      const file = allFiles.find((f) => f.relativePath === value);
      if (file) {
        onSelectFile(file.path);
        onClose();
      }
    },
    [allFiles, onSelectFile, onClose]
  );

  // Memoize file icon lookups
  const fileItems = useMemo(
    () =>
      allFiles.map((file) => ({
        ...file,
        iconInfo: getFileIcon(file.name),
      })),
    [allFiles]
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40"
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
        role="presentation"
      />

      {/* Dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Quick Open"
        className="relative z-10 w-[520px] overflow-hidden rounded-lg border border-border-emphasis bg-surface shadow-2xl"
      >
        <Command label="Quick Open" shouldFilter={true}>
          <Command.Input
            placeholder="Search files by name..."
            className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-text outline-none placeholder:text-text-muted"
            autoFocus
          />
          <Command.List className="max-h-80 overflow-y-auto p-1">
            {loading && (
              <div className="flex items-center justify-center gap-2 p-6 text-sm text-text-muted">
                <Loader2 className="size-4 animate-spin" />
                <span>Loading files...</span>
              </div>
            )}
            {!loading && (
              <Command.Empty className="p-6 text-center text-sm text-text-muted">
                No files found
              </Command.Empty>
            )}
            {fileItems.map((file) => {
              const Icon = file.iconInfo.icon;
              return (
                <Command.Item
                  key={file.path}
                  value={file.relativePath}
                  onSelect={() => handleSelect(file.relativePath)}
                  className="flex cursor-pointer items-center gap-2 rounded px-3 py-1.5 text-sm text-text-secondary aria-selected:bg-surface-raised aria-selected:text-text"
                >
                  <Icon className="size-4 shrink-0" style={{ color: file.iconInfo.color }} />
                  <span className="truncate font-medium">{file.name}</span>
                  <span className="ml-auto truncate text-xs text-text-muted">
                    {file.relativePath}
                  </span>
                </Command.Item>
              );
            })}
          </Command.List>
        </Command>
      </div>
    </div>
  );
};
