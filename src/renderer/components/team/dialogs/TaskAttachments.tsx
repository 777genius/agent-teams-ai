import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ImageLightbox } from '@renderer/components/team/attachments/ImageLightbox';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import { isImageMimeType } from '@renderer/utils/attachmentUtils';
import { File, ImagePlus, Loader2, Trash2 } from 'lucide-react';

import type { TaskAttachmentMeta } from '@shared/types';

const ACCEPTED_TYPES = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

interface TaskAttachmentsProps {
  teamName: string;
  taskId: string;
  attachments: TaskAttachmentMeta[];
}

export const TaskAttachments = ({
  teamName,
  taskId,
  attachments,
}: TaskAttachmentsProps): React.JSX.Element => {
  const saveTaskAttachment = useStore((s) => s.saveTaskAttachment);
  const deleteTaskAttachment = useStore((s) => s.deleteTaskAttachment);
  const getTaskAttachmentData = useStore((s) => s.getTaskAttachmentData);

  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [thumbCache, setThumbCache] = useState<Map<string, string>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const imageAttachments = attachments.filter((a) => isImageMimeType(a.mimeType));

  const handleThumbLoaded = useCallback((attachmentId: string, dataUrl: string) => {
    setThumbCache((prev) => {
      if (prev.get(attachmentId) === dataUrl) return prev;
      const next = new Map(prev);
      next.set(attachmentId, dataUrl);
      return next;
    });
  }, []);

  const handleFileSelect = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setError(null);
      setUploading(true);

      try {
        for (const file of Array.from(files)) {
          if (!ACCEPTED_TYPES.has(file.type)) {
            setError(`Unsupported file type: ${file.type}`);
            continue;
          }
          if (file.size > MAX_FILE_SIZE) {
            setError(`File too large: ${(file.size / (1024 * 1024)).toFixed(1)} MB (max 20 MB)`);
            continue;
          }

          const base64 = await fileToBase64(file);
          await saveTaskAttachment(teamName, taskId, {
            name: file.name,
            type: file.type,
            base64,
          });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to upload');
      } finally {
        setUploading(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    },
    [teamName, taskId, saveTaskAttachment]
  );

  const handleDelete = useCallback(
    async (attachmentId: string, mimeType: string) => {
      setDeletingId(attachmentId);
      try {
        await deleteTaskAttachment(teamName, taskId, attachmentId, mimeType);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete');
      } finally {
        setDeletingId(null);
      }
    },
    [teamName, taskId, deleteTaskAttachment]
  );

  const handleDownload = useCallback(
    async (att: TaskAttachmentMeta) => {
      setError(null);
      try {
        const base64 = await getTaskAttachmentData(teamName, taskId, att.id, att.mimeType);
        if (!base64) {
          setError('Attachment file not found');
          return;
        }
        const mime =
          att.mimeType && typeof att.mimeType === 'string'
            ? att.mimeType
            : 'application/octet-stream';
        const dataUrl = `data:${mime};base64,${base64}`;
        const blob = await fetch(dataUrl).then((r) => r.blob());
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = att.filename || 'attachment';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to download');
      }
    },
    [getTaskAttachmentData, teamName, taskId]
  );

  // 1x1 transparent PNG placeholder for slides where thumb is not yet loaded
  const PLACEHOLDER_SRC =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAA0lEQVQI12P4z8BQDwAEgAF/QualIQAAAABJRU5ErkJggg==';

  const lightboxSlides = useMemo(
    () =>
      imageAttachments.map((a) => ({
        src: thumbCache.get(a.id) ?? PLACEHOLDER_SRC,
        alt: a.filename,
      })),
    [imageAttachments, thumbCache]
  );

  const handlePreview = useCallback(
    (att: TaskAttachmentMeta) => {
      if (!isImageMimeType(att.mimeType)) {
        void handleDownload(att);
        return;
      }
      const idx = imageAttachments.findIndex((a) => a.id === att.id);
      if (idx >= 0) {
        setLightboxIndex(idx);
      }
    },
    [imageAttachments, handleDownload]
  );

  // Handle paste events for quick image attachment
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: ClipboardEvent): void => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && ACCEPTED_TYPES.has(item.type)) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        const dt = new DataTransfer();
        imageFiles.forEach((f) => dt.items.add(f));
        void handleFileSelect(dt.files);
      }
    };
    const el = containerRef.current;
    if (el) {
      el.addEventListener('paste', handler);
      return () => el.removeEventListener('paste', handler);
    }
  }, [handleFileSelect]);

  // Handle drag-and-drop
  const [dragOver, setDragOver] = useState(false);
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);
  const handleDragLeave = useCallback(() => setDragOver(false), []);
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      void handleFileSelect(e.dataTransfer.files);
    },
    [handleFileSelect]
  );

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="space-y-2"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Attachment thumbnails */}
      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {attachments.map((att) => (
            <AttachmentThumbnail
              key={att.id}
              attachment={att}
              teamName={teamName}
              taskId={taskId}
              isDeleting={deletingId === att.id}
              onPreview={() => {
                // eslint-disable-next-line sonarjs/void-use -- void needed to mark floating promise
                void handlePreview(att);
              }}
              onDelete={() => {
                void handleDelete(att.id, att.mimeType);
              }}
              onDataLoaded={handleThumbLoaded}
            />
          ))}
        </div>
      ) : null}

      {/* Image lightbox */}
      {lightboxIndex !== null && (
        <ImageLightbox
          open
          onClose={() => {
            setLightboxIndex(null);
          }}
          slides={lightboxSlides}
          index={lightboxIndex}
        />
      )}

      {/* Drop zone indicator */}
      {dragOver ? (
        <div className="flex items-center justify-center rounded-md border-2 border-dashed border-blue-500/40 bg-blue-500/5 py-4 text-xs text-blue-400">
          Drop image here
        </div>
      ) : null}

      {/* Controls */}
      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={(e) => void handleFileSelect(e.target.files)}
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs text-[var(--color-text-muted)]"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? <Loader2 size={12} className="animate-spin" /> : <ImagePlus size={12} />}
          Attach image
        </Button>
        <span className="text-[10px] text-[var(--color-text-muted)]">or paste / drag-drop</span>
      </div>

      {error ? <p className="text-xs text-red-400">{error}</p> : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Thumbnail sub-component
// ---------------------------------------------------------------------------

interface AttachmentThumbnailProps {
  attachment: TaskAttachmentMeta;
  teamName: string;
  taskId: string;
  isDeleting: boolean;
  onPreview: () => void;
  onDelete: () => void;
  onDataLoaded?: (attachmentId: string, dataUrl: string) => void;
}

const AttachmentThumbnail = ({
  attachment,
  teamName,
  taskId,
  isDeleting,
  onPreview,
  onDelete,
  onDataLoaded,
}: AttachmentThumbnailProps): React.JSX.Element => {
  const getTaskAttachmentData = useStore((s) => s.getTaskAttachmentData);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!isImageMimeType(attachment.mimeType)) return;
        const base64 = await getTaskAttachmentData(
          teamName,
          taskId,
          attachment.id,
          attachment.mimeType
        );
        if (!cancelled && base64) {
          const dataUrl = `data:${attachment.mimeType};base64,${base64}`;
          setThumbUrl(dataUrl);
          onDataLoaded?.(attachment.id, dataUrl);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamName, taskId, attachment.id, attachment.mimeType, getTaskAttachmentData, onDataLoaded]);

  const sizeLabel =
    attachment.size < 1024
      ? `${attachment.size} B`
      : attachment.size < 1024 * 1024
        ? `${(attachment.size / 1024).toFixed(0)} KB`
        : `${(attachment.size / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <div
      className={`group relative flex size-20 cursor-pointer items-center justify-center overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface)] transition-colors hover:border-[var(--color-border-emphasis)]`}
      onClick={onPreview}
    >
      {isImageMimeType(attachment.mimeType) ? (
        thumbUrl ? (
          <img src={thumbUrl} alt={attachment.filename} className="size-full object-cover" />
        ) : (
          <Loader2 size={16} className="animate-spin text-[var(--color-text-muted)]" />
        )
      ) : (
        <div className="flex flex-col items-center gap-1 px-1 text-center">
          <File size={18} className="text-[var(--color-text-muted)]" />
          <div className="max-w-full truncate text-[9px] text-[var(--color-text-muted)]">
            {attachment.filename}
          </div>
        </div>
      )}
      {/* Delete button overlay */}
      <button
        type="button"
        className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white opacity-0 transition-opacity hover:bg-red-600 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        disabled={isDeleting}
      >
        {isDeleting ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
      </button>
      {/* Filename tooltip */}
      <div className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 py-0.5 text-center text-[8px] text-white opacity-0 transition-opacity group-hover:opacity-100">
        {attachment.filename} ({sizeLabel})
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data URL prefix (e.g., "data:image/png;base64,")
      const base64 = result.split(',')[1];
      if (base64) {
        resolve(base64);
      } else {
        reject(new Error('Failed to read file as base64'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}
