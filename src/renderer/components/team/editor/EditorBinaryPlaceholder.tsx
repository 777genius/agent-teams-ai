/**
 * Placeholder for non-previewable binary files — shows file info and "Open in System Viewer" button.
 */

import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import { FileQuestion } from 'lucide-react';

interface EditorBinaryPlaceholderProps {
  filePath: string;
  fileName: string;
  size: number;
}

export const EditorBinaryPlaceholder = ({
  filePath,
  fileName,
  size,
}: EditorBinaryPlaceholderProps): React.ReactElement => {
  const projectPath = useStore((s) => s.editorProjectPath);
  const sizeFormatted =
    size < 1024
      ? `${size} B`
      : size < 1024 * 1024
        ? `${(size / 1024).toFixed(1)} KB`
        : `${(size / 1024 / 1024).toFixed(1)} MB`;

  const handleOpenExternal = (): void => {
    window.electronAPI.openPath(filePath, projectPath ?? undefined).catch(console.error);
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-text-muted">
      <FileQuestion className="size-12 opacity-30" />
      <p className="text-sm font-medium text-text-secondary">{fileName}</p>
      <p className="text-xs">Binary file ({sizeFormatted})</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={handleOpenExternal}>
        Open in System Viewer
      </Button>
    </div>
  );
};
