import { useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { FileIcon } from '@renderer/components/team/editor/FileIcon';
import { createTeamMessageAttachmentReadTransport } from '@renderer/composition/team/createTeamMessageAttachmentReadTransport';
import { useStore } from '@renderer/store';
import { isImageMime } from '@renderer/utils/attachmentUtils';
import { Loader2 } from 'lucide-react';

import { AttachmentThumbnail } from './AttachmentThumbnail';
import { ImageLightbox } from './ImageLightbox';

import type { AttachmentFileData, AttachmentMeta } from '@shared/types';

interface AttachmentDisplayProps {
  teamName: string;
  messageId: string;
  attachments: AttachmentMeta[];
}

const attachmentReadTransport = createTeamMessageAttachmentReadTransport();

export const AttachmentDisplay = ({
  teamName,
  messageId,
  attachments,
}: AttachmentDisplayProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const revealFileInEditor = useStore((s) => s.revealFileInEditor);
  const [state, setState] = useState<{
    loaded: AttachmentFileData[];
    loading: boolean;
    key: string;
  }>({ loaded: [], loading: true, key: `${teamName}:${messageId}` });
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const currentKey = `${teamName}:${messageId}`;
  // Reset loading state when deps change (React 18+ pattern: derive from props)
  if (state.key !== currentKey) {
    setState({ loaded: [], loading: true, key: currentKey });
  }

  useEffect(() => {
    let cancelled = false;
    void attachmentReadTransport
      .getAttachments(teamName, messageId)
      .then((data) => {
        if (!cancelled) setState({ loaded: data, loading: false, key: `${teamName}:${messageId}` });
      })
      .catch(() => {
        if (!cancelled) setState((prev) => ({ ...prev, loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, [teamName, messageId]);

  const { loaded, loading } = state;

  if (attachments.length === 0) return null;

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 py-1 text-[11px] text-[var(--color-text-muted)]">
        <Loader2 size={14} className="animate-spin" />
        {t('taskAttachments.loading')}
      </div>
    );
  }

  // Build lookup for loaded data
  const dataById = new Map(loaded.map((d) => [d.id, d]));

  const items = attachments
    .map((meta) => {
      const data = dataById.get(meta.id);
      if (!data) return null;
      const isImage = isImageMime(data.mimeType);
      return {
        meta,
        dataUrl: isImage ? `data:${data.mimeType};base64,${data.data}` : undefined,
        filePath: data.filePath ?? meta.filePath,
        isImage,
      };
    })
    .filter(Boolean) as {
    meta: AttachmentMeta;
    dataUrl: string | undefined;
    filePath: string | undefined;
    isImage: boolean;
  }[];

  if (items.length === 0) return null;

  // Build lightbox slides for images only, with visual→lightbox index mapping
  const imageSlides: { src: string; alt: string }[] = [];
  const visualToLightbox = new Map<number, number>();
  items.forEach((item, i) => {
    if (item.isImage && item.dataUrl) {
      visualToLightbox.set(i, imageSlides.length);
      imageSlides.push({ src: item.dataUrl, alt: item.meta.filename });
    }
  });

  return (
    <>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {items.map((item, i) =>
          item.isImage && item.dataUrl ? (
            <AttachmentThumbnail
              key={item.meta.id}
              src={item.dataUrl}
              alt={item.meta.filename}
              size="md"
              onClick={
                visualToLightbox.has(i)
                  ? () => setLightboxIndex(visualToLightbox.get(i)!)
                  : undefined
              }
            />
          ) : item.filePath ? (
            <button
              key={item.meta.id}
              type="button"
              className="flex size-20 flex-col items-center justify-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] transition-colors hover:border-[var(--color-border-emphasis)] hover:bg-[var(--color-surface)]"
              title={item.meta.filename}
              aria-label={`Open ${item.meta.filename}`}
              onClick={(event) => {
                event.stopPropagation();
                revealFileInEditor(item.filePath!);
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <FileIcon fileName={item.meta.filename} className="size-5" />
              <span className="max-w-[72px] truncate text-[9px] text-[var(--color-text-muted)]">
                {item.meta.filename}
              </span>
            </button>
          ) : (
            <div
              key={item.meta.id}
              className="flex size-20 flex-col items-center justify-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)]"
              title={item.meta.filename}
            >
              <FileIcon fileName={item.meta.filename} className="size-5" />
              <span className="max-w-[72px] truncate text-[9px] text-[var(--color-text-muted)]">
                {item.meta.filename}
              </span>
            </div>
          )
        )}
      </div>
      {lightboxIndex !== null && imageSlides[lightboxIndex] ? (
        <ImageLightbox
          open
          onClose={() => setLightboxIndex(null)}
          slides={imageSlides}
          index={lightboxIndex}
        />
      ) : null}
    </>
  );
};
