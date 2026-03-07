import { useCallback, useEffect, useRef, useState } from 'react';

import { AlertCircle, X } from 'lucide-react';

import { AttachmentPreviewItem } from './AttachmentPreviewItem';
import { ImageLightbox } from './ImageLightbox';

import type { AttachmentPayload } from '@shared/types';

const ANIMATION_MS = 400;

interface AttachmentPreviewListProps {
  attachments: AttachmentPayload[];
  onRemove: (id: string) => void;
  error?: string | null;
  onDismissError?: () => void;
  /** When true, previews are overlaid with a disabled indicator (recipient doesn't support attachments). */
  disabled?: boolean;
  /** Hint text shown when disabled and attachments are present. */
  disabledHint?: string;
}

export const AttachmentPreviewList = ({
  attachments,
  onRemove,
  error,
  onDismissError,
  disabled,
  disabledHint,
}: AttachmentPreviewListProps): React.JSX.Element | null => {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  // Track IDs known on previous render to detect newly added items
  const knownIdsRef = useRef<Set<string>>(new Set());
  const [enteringIds, setEnteringIds] = useState<Set<string>>(new Set());
  const exitTimersRef = useRef<Map<string, number>>(new Map());
  const enterTimersRef = useRef<Map<string, number>>(new Map());

  // Detect newly added attachments
  useEffect(() => {
    const currentIds = new Set(attachments.map((a) => a.id));
    const newIds = new Set<string>();
    for (const id of currentIds) {
      if (!knownIdsRef.current.has(id)) {
        newIds.add(id);
      }
    }
    knownIdsRef.current = currentIds;

    if (newIds.size === 0) return;

    queueMicrotask(() => {
      setEnteringIds((prev) => {
        const next = new Set(prev);
        for (const id of newIds) next.add(id);
        return next;
      });
    });

    // Clear entering state after animation completes
    for (const id of newIds) {
      const timer = window.setTimeout(() => {
        setEnteringIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        enterTimersRef.current.delete(id);
      }, ANIMATION_MS);
      enterTimersRef.current.set(id, timer);
    }
  }, [attachments]);

  // Cleanup timers on unmount
  useEffect(() => {
    const exitTimers = exitTimersRef.current;
    const enterTimers = enterTimersRef.current;
    return () => {
      for (const t of exitTimers.values()) window.clearTimeout(t);
      for (const t of enterTimers.values()) window.clearTimeout(t);
    };
  }, []);

  const handleRemove = useCallback(
    (id: string) => {
      // Start exit animation
      setExitingIds((prev) => new Set(prev).add(id));

      // Actually remove after animation
      const timer = window.setTimeout(() => {
        setExitingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        exitTimersRef.current.delete(id);
        onRemove(id);
      }, ANIMATION_MS);
      exitTimersRef.current.set(id, timer);
    },
    [onRemove]
  );

  // Include exiting items that are no longer in attachments (they were removed by parent)
  // This shouldn't normally happen since we delay onRemove, but guard against it.
  const visibleAttachments = attachments;

  if (visibleAttachments.length === 0 && exitingIds.size === 0 && !error) return null;

  const lightboxSlides = visibleAttachments.map((att) => ({
    src: `data:${att.mimeType};base64,${att.data}`,
    alt: att.filename,
  }));

  return (
    <div className="space-y-1.5 px-1">
      {visibleAttachments.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto py-1">
          {visibleAttachments.map((att, i) => {
            const isExiting = exitingIds.has(att.id);
            const isEntering = enteringIds.has(att.id);
            return (
              <div
                key={att.id}
                style={{
                  transition: `transform ${ANIMATION_MS}ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity ${ANIMATION_MS}ms ease`,
                  transform: isExiting ? 'scale(0)' : isEntering ? undefined : 'scale(1)',
                  opacity: isExiting ? 0 : 1,
                  transformOrigin: 'center center',
                  animation: isEntering
                    ? `att-scale-in ${ANIMATION_MS}ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards`
                    : undefined,
                }}
              >
                <AttachmentPreviewItem
                  attachment={att}
                  onRemove={handleRemove}
                  onPreview={() => setLightboxIndex(i)}
                  disabled={disabled}
                />
              </div>
            );
          })}
        </div>
      ) : null}
      {disabled && disabledHint && visibleAttachments.length > 0 ? (
        <div
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5"
          style={{ backgroundColor: 'var(--warning-bg)', color: 'var(--warning-text)' }}
        >
          <AlertCircle size={13} className="shrink-0" />
          <p className="text-[11px]">{disabledHint}</p>
        </div>
      ) : null}
      {error ? (
        <div className="flex items-center gap-1.5 rounded-md bg-red-500/10 px-2.5 py-1.5">
          <AlertCircle size={13} className="shrink-0 text-red-400" />
          <p className="flex-1 text-[11px] text-red-400">{error}</p>
          {onDismissError ? (
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-red-400 transition-colors hover:bg-red-500/20 hover:text-red-300"
              onClick={onDismissError}
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
      ) : null}
      {lightboxIndex !== null && lightboxSlides[lightboxIndex] ? (
        <ImageLightbox
          open
          onClose={() => setLightboxIndex(null)}
          slides={lightboxSlides}
          index={lightboxIndex}
        />
      ) : null}
    </div>
  );
};
