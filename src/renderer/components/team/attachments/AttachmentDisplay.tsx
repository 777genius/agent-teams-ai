import { useEffect, useState } from 'react';

import { Loader2 } from 'lucide-react';

import { AttachmentThumbnail } from './AttachmentThumbnail';
import { ImageLightbox } from './ImageLightbox';

import type { AttachmentFileData, AttachmentMeta } from '@shared/types';

interface AttachmentDisplayProps {
  teamName: string;
  messageId: string;
  attachments: AttachmentMeta[];
}

export const AttachmentDisplay = ({
  teamName,
  messageId,
  attachments,
}: AttachmentDisplayProps): React.JSX.Element | null => {
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
    void window.electronAPI.teams
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
        Loading attachments...
      </div>
    );
  }

  // Build lookup for loaded data
  const dataById = new Map(loaded.map((d) => [d.id, d]));

  const items = attachments
    .map((meta) => {
      const data = dataById.get(meta.id);
      if (!data) return null;
      return { meta, dataUrl: `data:${data.mimeType};base64,${data.data}` };
    })
    .filter(Boolean) as { meta: AttachmentMeta; dataUrl: string }[];

  if (items.length === 0) return null;

  return (
    <>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {items.map((item, i) => (
          <AttachmentThumbnail
            key={item.meta.id}
            src={item.dataUrl}
            alt={item.meta.filename}
            size="md"
            onClick={() => setLightboxIndex(i)}
          />
        ))}
      </div>
      {lightboxIndex !== null && items[lightboxIndex] ? (
        <ImageLightbox
          open
          onClose={() => setLightboxIndex(null)}
          slides={items.map((item) => ({ src: item.dataUrl, alt: item.meta.filename }))}
          index={lightboxIndex}
        />
      ) : null}
    </>
  );
};
