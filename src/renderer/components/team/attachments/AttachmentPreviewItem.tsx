import { formatFileSize } from '@renderer/utils/attachmentUtils';
import { Ban, X } from 'lucide-react';

import { AttachmentThumbnail } from './AttachmentThumbnail';

import type { AttachmentPayload } from '@shared/types';

interface AttachmentPreviewItemProps {
  attachment: AttachmentPayload;
  onRemove: (id: string) => void;
  disabled?: boolean;
}

export const AttachmentPreviewItem = ({
  attachment,
  onRemove,
  disabled,
}: AttachmentPreviewItemProps): React.JSX.Element => {
  const dataUrl = `data:${attachment.mimeType};base64,${attachment.data}`;

  return (
    <div className="group/att relative flex shrink-0 items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5">
      {disabled ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-black/50">
          <Ban size={18} className="text-red-400" />
        </div>
      ) : null}
      <AttachmentThumbnail src={dataUrl} alt={attachment.filename} size="sm" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="max-w-[100px] truncate text-[11px] text-[var(--color-text-secondary)]">
          {attachment.filename}
        </span>
        <span className="text-[10px] text-[var(--color-text-muted)]">
          {formatFileSize(attachment.size)}
        </span>
      </div>
      <button
        type="button"
        className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-red-500 text-white opacity-0 transition-opacity group-hover/att:opacity-100"
        onClick={() => onRemove(attachment.id)}
        aria-label={`Remove ${attachment.filename}`}
      >
        <X size={10} />
      </button>
    </div>
  );
};
