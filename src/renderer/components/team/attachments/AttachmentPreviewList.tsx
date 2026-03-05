import { AlertCircle } from 'lucide-react';

import { AttachmentPreviewItem } from './AttachmentPreviewItem';

import type { AttachmentPayload } from '@shared/types';

interface AttachmentPreviewListProps {
  attachments: AttachmentPayload[];
  onRemove: (id: string) => void;
  error?: string | null;
  /** When true, previews are overlaid with a disabled indicator (recipient doesn't support attachments). */
  disabled?: boolean;
  /** Hint text shown when disabled and attachments are present. */
  disabledHint?: string;
}

export const AttachmentPreviewList = ({
  attachments,
  onRemove,
  error,
  disabled,
  disabledHint,
}: AttachmentPreviewListProps): React.JSX.Element | null => {
  if (attachments.length === 0 && !error) return null;

  return (
    <div className="space-y-1.5 px-1">
      {attachments.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto py-1">
          {attachments.map((att) => (
            <AttachmentPreviewItem
              key={att.id}
              attachment={att}
              onRemove={onRemove}
              disabled={disabled}
            />
          ))}
        </div>
      ) : null}
      {disabled && disabledHint && attachments.length > 0 ? (
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
          <p className="text-[11px] text-red-400">{error}</p>
        </div>
      ) : null}
    </div>
  );
};
