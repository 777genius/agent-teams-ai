/**
 * Placeholder for binary files — shows file info and "Open in System Viewer" button.
 */

import { FileQuestion } from 'lucide-react';

interface EditorBinaryStateProps {
  filePath: string;
  size: number;
}

export const EditorBinaryState = ({
  filePath,
  size,
}: EditorBinaryStateProps): React.ReactElement => {
  const fileName = filePath.split('/').pop() ?? filePath;
  const sizeFormatted =
    size < 1024
      ? `${size} B`
      : size < 1024 * 1024
        ? `${(size / 1024).toFixed(1)} KB`
        : `${(size / 1024 / 1024).toFixed(1)} MB`;

  const handleOpenExternal = (): void => {
    window.electronAPI.openPath(filePath).catch(console.error);
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-text-muted">
      <FileQuestion className="size-12 opacity-30" />
      <p className="text-sm font-medium text-text-secondary">{fileName}</p>
      <p className="text-xs">Binary file ({sizeFormatted})</p>
      <button
        onClick={handleOpenExternal}
        className="mt-2 rounded border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-raised"
      >
        Open in System Viewer
      </button>
    </div>
  );
};
