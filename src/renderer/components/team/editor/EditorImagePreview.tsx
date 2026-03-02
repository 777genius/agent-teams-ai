/**
 * Inline image preview for the project editor.
 *
 * Loads binary file as base64 data URL via IPC, displays centered image
 * with checkerboard background for transparency, metadata, and lightbox on click.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ImageLightbox } from '@renderer/components/team/attachments/ImageLightbox';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import { Loader2 } from 'lucide-react';

import { EditorBinaryPlaceholder } from './EditorBinaryPlaceholder';

interface EditorImagePreviewProps {
  filePath: string;
  fileName: string;
  size: number;
}

export const EditorImagePreview = ({
  filePath,
  fileName,
  size,
}: EditorImagePreviewProps): React.ReactElement => {
  const projectPath = useStore((s) => s.editorProjectPath);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Reset state when filePath changes (setState-during-render, React-approved pattern)
  const [prevFilePath, setPrevFilePath] = useState(filePath);
  if (prevFilePath !== filePath) {
    setPrevFilePath(filePath);
    setLoading(true);
    setError(null);
    setDataUrl(null);
    setDimensions(null);
  }

  useEffect(() => {
    let cancelled = false;

    window.electronAPI.editor
      .readBinaryPreview(filePath)
      .then((result) => {
        if (cancelled) return;
        setDataUrl(`data:${result.mimeType};base64,${result.base64}`);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const handleImageLoad = useCallback(() => {
    const img = imgRef.current;
    if (img) {
      setDimensions({ w: img.naturalWidth, h: img.naturalHeight });
    }
  }, []);

  const handleOpenExternal = useCallback((): void => {
    window.electronAPI.openPath(filePath, projectPath ?? undefined).catch(console.error);
  }, [filePath, projectPath]);

  const sizeFormatted =
    size < 1024
      ? `${size} B`
      : size < 1024 * 1024
        ? `${(size / 1024).toFixed(1)} KB`
        : `${(size / 1024 / 1024).toFixed(1)} MB`;

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-text-muted">
        <Loader2 className="size-8 animate-spin opacity-40" />
        <p className="text-xs">Loading preview…</p>
      </div>
    );
  }

  if (error || !dataUrl) {
    return <EditorBinaryPlaceholder filePath={filePath} fileName={fileName} size={size} />;
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <button
        type="button"
        className="checkerboard-bg flex max-h-[60vh] max-w-[80%] cursor-zoom-in items-center justify-center overflow-hidden rounded-lg border border-border-subtle p-1"
        onClick={() => setLightboxOpen(true)}
        aria-label="Open full-size preview"
      >
        <img
          ref={imgRef}
          src={dataUrl}
          alt={fileName}
          className="max-h-[60vh] object-contain"
          onLoad={handleImageLoad}
          draggable={false}
        />
      </button>

      <p className="text-xs text-text-muted">
        {fileName}
        {dimensions ? ` — ${dimensions.w}×${dimensions.h}` : ''}
        {` — ${sizeFormatted}`}
      </p>

      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={handleOpenExternal}>
          Open in System Viewer
        </Button>
      </div>

      <ImageLightbox
        src={dataUrl}
        alt={fileName}
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
      />
    </div>
  );
};
