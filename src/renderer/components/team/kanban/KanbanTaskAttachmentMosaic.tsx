import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ImageLightbox } from '@renderer/components/team/attachments/ImageLightbox';
import { useStore } from '@renderer/store';
import { isImageMimeType } from '@renderer/utils/attachmentUtils';
import { Loader2 } from 'lucide-react';

import type { TaskAttachmentMeta, TeamTaskWithKanban } from '@shared/types';

const MAX_VISIBLE_IMAGES = 4;

interface KanbanTaskAttachmentMosaicProps {
  teamName: string;
  task: Pick<TeamTaskWithKanban, 'id' | 'attachments'>;
}

interface LoadedKanbanTaskAttachmentMosaicProps {
  teamName: string;
  taskId: string;
  imageAttachments: readonly TaskAttachmentMeta[];
}

interface LoadedLightbox {
  slides: Array<{ src: string; alt: string }>;
  index: number;
}

function getMosaicLayout(imageCount: number): 'single' | 'pair' | 'trio' | 'grid' {
  if (imageCount === 1) return 'single';
  if (imageCount === 2) return 'pair';
  if (imageCount === 3) return 'trio';
  return 'grid';
}

function getMosaicClass(layout: ReturnType<typeof getMosaicLayout>): string {
  switch (layout) {
    case 'single':
      return 'grid-cols-1 aspect-video';
    case 'pair':
      return 'grid-cols-2 aspect-[2/1]';
    case 'trio':
      return 'grid-cols-[2fr_1fr] grid-rows-2 aspect-video';
    case 'grid':
      return 'grid-cols-2 grid-rows-2 aspect-[4/3]';
  }
}

function getTileClass(layout: ReturnType<typeof getMosaicLayout>, index: number): string {
  return layout === 'trio' && index === 0 ? 'row-span-2' : '';
}

const LoadedKanbanTaskAttachmentMosaic = ({
  teamName,
  taskId,
  imageAttachments,
}: LoadedKanbanTaskAttachmentMosaicProps): React.JSX.Element => {
  const getTaskAttachmentData = useStore((state) => state.getTaskAttachmentData);
  const visibleAttachments = useMemo(
    () => imageAttachments.slice(0, MAX_VISIBLE_IMAGES),
    [imageAttachments]
  );
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [openingAttachmentId, setOpeningAttachmentId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<LoadedLightbox | null>(null);
  const loadedUrlsRef = useRef(new Map<string, string>());
  const pendingLoadsRef = useRef(new Map<string, Promise<string | null>>());
  const scopeKey = `${teamName}/${taskId}`;
  const activeScopeRef = useRef(scopeKey);

  useEffect(() => {
    activeScopeRef.current = scopeKey;
    loadedUrlsRef.current.clear();
    pendingLoadsRef.current.clear();
    setPreviewUrls({});
    setOpeningAttachmentId(null);
    setLightbox(null);
  }, [scopeKey]);

  const loadAttachment = useCallback(
    async (attachment: TaskAttachmentMeta): Promise<string | null> => {
      const cached = loadedUrlsRef.current.get(attachment.id);
      if (cached) return cached;

      const pending = pendingLoadsRef.current.get(attachment.id);
      if (pending) return pending;

      const requestScope = scopeKey;
      const request = getTaskAttachmentData(teamName, taskId, attachment.id, attachment.mimeType)
        .then((base64) => {
          if (!base64 || activeScopeRef.current !== requestScope) return null;
          const dataUrl = `data:${attachment.mimeType};base64,${base64}`;
          loadedUrlsRef.current.set(attachment.id, dataUrl);
          return dataUrl;
        })
        .catch(() => null)
        .finally(() => {
          pendingLoadsRef.current.delete(attachment.id);
        });

      pendingLoadsRef.current.set(attachment.id, request);
      return request;
    },
    [getTaskAttachmentData, scopeKey, taskId, teamName]
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      visibleAttachments.map(async (attachment) => ({
        id: attachment.id,
        url: await loadAttachment(attachment),
      }))
    ).then((loaded) => {
      if (cancelled) return;
      setPreviewUrls(
        Object.fromEntries(
          loaded
            .filter((item): item is { id: string; url: string } => item.url !== null)
            .map((item) => [item.id, item.url])
        )
      );
    });
    return () => {
      cancelled = true;
    };
  }, [loadAttachment, visibleAttachments]);

  const openLightbox = useCallback(
    async (attachment: TaskAttachmentMeta): Promise<void> => {
      if (openingAttachmentId) return;
      setOpeningAttachmentId(attachment.id);
      const requestScope = scopeKey;
      try {
        const loaded = await Promise.all(
          imageAttachments.map(async (image) => ({
            attachment: image,
            url: await loadAttachment(image),
          }))
        );
        if (activeScopeRef.current !== requestScope) return;

        const available = loaded.filter(
          (item): item is { attachment: TaskAttachmentMeta; url: string } => item.url !== null
        );
        if (available.length === 0) return;

        const selectedIndex = available.findIndex((item) => item.attachment.id === attachment.id);
        setLightbox({
          slides: available.map((item) => ({
            src: item.url,
            alt: item.attachment.filename,
          })),
          index: selectedIndex >= 0 ? selectedIndex : 0,
        });
      } finally {
        if (activeScopeRef.current === requestScope) {
          setOpeningAttachmentId(null);
        }
      }
    },
    [imageAttachments, loadAttachment, openingAttachmentId, scopeKey]
  );

  const layout = getMosaicLayout(imageAttachments.length);
  const overflowCount =
    imageAttachments.length > MAX_VISIBLE_IMAGES ? imageAttachments.length - 3 : 0;

  return (
    <>
      <div
        data-kanban-image-mosaic
        data-image-count={imageAttachments.length}
        data-mosaic-layout={layout}
        className={`mb-2 grid max-h-36 w-full min-w-0 gap-0.5 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] ${getMosaicClass(layout)}`}
      >
        {visibleAttachments.map((attachment, index) => {
          const previewUrl = previewUrls[attachment.id];
          const isOpening = openingAttachmentId === attachment.id;
          const tileOverflowCount = index === MAX_VISIBLE_IMAGES - 1 ? overflowCount : 0;

          return (
            <button
              key={attachment.id}
              type="button"
              data-mosaic-tile-index={index}
              data-mosaic-overflow={tileOverflowCount || undefined}
              aria-label={`${attachment.filename}${tileOverflowCount ? `, +${tileOverflowCount}` : ''}`}
              className={`group relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden bg-[var(--color-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] ${getTileClass(layout, index)}`}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                void openLightbox(attachment);
              }}
            >
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt={attachment.filename}
                  draggable={false}
                  className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                />
              ) : (
                <span className="size-full animate-pulse bg-[var(--color-surface-raised)]" />
              )}
              {isOpening ? (
                <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-white">
                  <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                </span>
              ) : null}
              {tileOverflowCount ? (
                <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm font-semibold text-white">
                  +{tileOverflowCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {lightbox ? (
        <ImageLightbox
          open
          slides={lightbox.slides}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </>
  );
};

export const KanbanTaskAttachmentMosaic = ({
  teamName,
  task,
}: KanbanTaskAttachmentMosaicProps): React.JSX.Element | null => {
  const imageAttachments =
    task.attachments?.filter((attachment) => isImageMimeType(attachment.mimeType)) ?? [];
  if (imageAttachments.length === 0) return null;

  return (
    <LoadedKanbanTaskAttachmentMosaic
      teamName={teamName}
      taskId={task.id}
      imageAttachments={imageAttachments}
    />
  );
};
