import { useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { ImageLightbox } from '@renderer/components/team/attachments/ImageLightbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { Loader2, MessageSquare } from 'lucide-react';

import type { TaskAttachmentMeta } from '@shared/types';

export interface TaskDetailCommentImage {
  attachment: TaskAttachmentMeta;
  commentText: string;
  commentAuthor: string;
}

interface TaskDetailCommentImagesProps {
  items: readonly TaskDetailCommentImage[];
  teamName: string;
  taskId: string;
  loadAttachmentData: (
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: string
  ) => Promise<string | null>;
}

export const TaskDetailCommentImages = ({
  items,
  teamName,
  taskId,
  loadAttachmentData,
}: TaskDetailCommentImagesProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  return (
    <div className="mt-3 space-y-1">
      <div className="flex items-center gap-1.5">
        <MessageSquare size={12} className="text-[var(--color-text-muted)]" />
        <span className="text-[11px] font-medium text-[var(--color-text-muted)]">
          {t('taskDetail.attachments.fromComments')}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <TaskDetailCommentImageThumbnail
            key={item.attachment.id}
            item={item}
            teamName={teamName}
            taskId={taskId}
            loadAttachmentData={loadAttachmentData}
            onPreview={setPreviewUrl}
          />
        ))}
      </div>
      {previewUrl ? (
        <ImageLightbox
          open
          onClose={() => setPreviewUrl(null)}
          src={previewUrl}
          alt={t('taskDetail.attachments.commentAttachment')}
        />
      ) : null}
    </div>
  );
};

const TaskDetailCommentImageThumbnail = ({
  item,
  teamName,
  taskId,
  loadAttachmentData,
  onPreview,
}: Pick<TaskDetailCommentImagesProps, 'teamName' | 'taskId' | 'loadAttachmentData'> & {
  item: TaskDetailCommentImage;
  onPreview: (dataUrl: string) => void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const base64 = await loadAttachmentData(
          teamName,
          taskId,
          item.attachment.id,
          item.attachment.mimeType
        );
        if (!cancelled && base64) {
          setThumbUrl(`data:${item.attachment.mimeType};base64,${base64}`);
        }
      } catch {
        // Attachment previews are optional and must not affect task content.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item.attachment.id, item.attachment.mimeType, loadAttachmentData, taskId, teamName]);

  const tooltipText = `${item.commentAuthor}: ${
    item.commentText.length > 200 ? `${item.commentText.slice(0, 200)}...` : item.commentText
  }`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="group relative flex size-16 cursor-pointer items-center justify-center overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface)] transition-colors hover:border-[var(--color-border-emphasis)]"
          onClick={() => thumbUrl && onPreview(thumbUrl)}
          aria-label={t('taskDetail.attachments.preview', { filename: item.attachment.filename })}
        >
          {thumbUrl ? (
            <img src={thumbUrl} alt={item.attachment.filename} className="size-full object-cover" />
          ) : (
            <Loader2 size={12} className="animate-spin text-[var(--color-text-muted)]" />
          )}
          <div className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-0.5 py-px text-center text-[7px] text-white opacity-0 transition-opacity group-hover:opacity-100">
            {item.attachment.filename}
          </div>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[300px] text-xs">
        {tooltipText}
      </TooltipContent>
    </Tooltip>
  );
};
