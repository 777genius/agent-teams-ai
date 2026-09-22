import { useAppTranslation } from '@features/localization/renderer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { Info } from 'lucide-react';

import { AttachmentDisplay } from './AttachmentDisplay';

import type { AttachmentMeta, SourceMessageSnapshot } from '@shared/types';

interface SourceMessageAttachmentsProps {
  teamName: string;
  sourceMessageId: string;
  sourceMessage: SourceMessageSnapshot;
}

export const SourceMessageAttachments = ({
  teamName,
  sourceMessageId,
  sourceMessage,
}: SourceMessageAttachmentsProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');

  if (!sourceMessage.attachments?.length) return null;

  const attachments: AttachmentMeta[] = sourceMessage.attachments.map((a) => ({
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    ...(a.filePath ? { filePath: a.filePath } : {}),
  }));

  const truncatedText =
    sourceMessage.text.length > 300 ? sourceMessage.text.slice(0, 297) + '...' : sourceMessage.text;

  const formattedDate = (() => {
    try {
      return new Date(sourceMessage.timestamp).toLocaleString();
    } catch {
      return sourceMessage.timestamp;
    }
  })();

  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-[11px] font-medium text-[var(--color-text-muted)]">
          {t('taskAttachments.fromOriginalMessage')}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Info
              size={12}
              className="cursor-help text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
            />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <p className="text-[11px] font-medium">
              {sourceMessage.from} &middot; {formattedDate}
            </p>
            <p className="mt-0.5 whitespace-pre-wrap text-[11px] text-[var(--color-text-secondary)]">
              {truncatedText}
            </p>
          </TooltipContent>
        </Tooltip>
      </div>
      <AttachmentDisplay
        teamName={teamName}
        messageId={sourceMessageId}
        attachments={attachments}
      />
    </div>
  );
};
