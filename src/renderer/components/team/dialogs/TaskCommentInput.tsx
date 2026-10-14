import { useCallback, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { taskDetailKey } from '@features/team-task-detail/core';
import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { ImageLightbox } from '@renderer/components/team/attachments/ImageLightbox';
import {
  ComposerSurface,
  ComposerTextarea,
} from '@renderer/components/team/composer/ComposerSurface';
import { FileIcon } from '@renderer/components/team/editor/FileIcon';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useTaskSuggestions } from '@renderer/hooks/useTaskSuggestions';
import { useTeamSuggestions } from '@renderer/hooks/useTeamSuggestions';
import { cn } from '@renderer/lib/utils';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { stripEncodedTaskReferenceMetadata } from '@renderer/utils/taskReferenceUtils';
import { MAX_TEXT_LENGTH } from '@shared/constants';
import { isImageMime } from '@shared/constants/attachments';
import { Loader2, Mic, Paperclip, Send, Trash2, X } from 'lucide-react';

import type { TaskDetailSessionController } from '@features/team-task-detail/renderer';
import type { MentionSuggestion } from '@renderer/types/mention';
import type { ResolvedTeamMember } from '@shared/types';

const MAX_ATTACHMENTS = 5;
const LONG_QUOTE_THRESHOLD = 200;

interface TaskCommentInputProps {
  contextId: string;
  surfaceId: string;
  teamName: string;
  taskId: string;
  projectPath: string | null;
  members: ResolvedTeamMember[];
  controller: TaskDetailSessionController;
}

export const TaskCommentInput = ({
  contextId,
  surfaceId,
  teamName,
  taskId,
  projectPath,
  members,
  controller,
}: TaskCommentInputProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const { session } = controller;
  const pendingAttachments = session.pendingAttachments;
  const addingComment = session.submitPending;
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const { suggestions: teamMentionSuggestions } = useTeamSuggestions(teamName);
  const { suggestions: taskSuggestions } = useTaskSuggestions(teamName, {
    enabled: controller.isOwner,
  });
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [quoteExpanded, setQuoteExpanded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const mentionSuggestions = useMemo<MentionSuggestion[]>(
    () =>
      members.map((m) => ({
        id: m.name,
        name: m.name,
        subtitle: formatAgentRole(m.role) ?? formatAgentRole(m.agentType) ?? undefined,
        color: colorMap.get(m.name),
      })),
    [members, colorMap]
  );

  const trimmed = stripEncodedTaskReferenceMetadata(session.commentText).trim();
  const remaining = MAX_TEXT_LENGTH - trimmed.length;
  const canSubmit =
    (trimmed.length > 0 || pendingAttachments.length > 0) &&
    trimmed.length <= MAX_TEXT_LENGTH &&
    controller.canSubmit;
  const replyTo = session.reply;
  const replyConnectedToComposer =
    Boolean(replyTo) && !controller.attachmentError && pendingAttachments.length === 0;

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      await controller.addPendingFiles(files);
    },
    [controller]
  );

  // Handle paste from MentionableTextarea area
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const pastedFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) pastedFiles.push(file);
        }
      }
      if (pastedFiles.length > 0) {
        e.preventDefault();
        void addFiles(pastedFiles);
      }
    },
    [addFiles]
  );

  return (
    <div>
      {replyTo ? (
        <div
          className={cn(
            'relative overflow-hidden border border-blue-400/30 bg-blue-100/80 py-2 pl-3 pr-2 dark:border-blue-500/20 dark:bg-blue-950/20',
            replyConnectedToComposer ? 'rounded-t-md border-b-0' : 'mb-2 rounded-md'
          )}
        >
          {/* Decorative quotation mark */}
          <span className="pointer-events-none absolute -right-1 top-1/2 -translate-y-1/2 select-none font-serif text-[64px] leading-none text-blue-500/[0.08] dark:text-blue-400/[0.08]">
            &ldquo;
          </span>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="absolute right-1.5 top-1.5 z-10 rounded p-0.5 text-blue-400/60 hover:text-blue-600 dark:text-blue-300/40 dark:hover:text-blue-200"
                onClick={() => controller.setReply(null)}
              >
                <X size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">{t('taskComments.cancelReply')}</TooltipContent>
          </Tooltip>

          <div className="mb-1 flex items-center gap-1.5">
            <span className="text-[10px] text-blue-600/70 dark:text-blue-300/60">
              {t('taskComments.replyingTo')}
            </span>
            <MemberBadge name={replyTo.author} color={colorMap.get(replyTo.author)} size="sm" />
          </div>
          <div
            className={`pr-5 opacity-60 dark:opacity-50 ${quoteExpanded ? '' : 'max-h-[3.75rem] overflow-hidden'}`}
          >
            <MarkdownViewer
              content={replyTo.text}
              bare
              taskOriginTeamName={teamName}
              maxHeight={quoteExpanded ? 'max-h-48' : 'max-h-[3.75rem]'}
            />
          </div>
          {replyTo.text.length > LONG_QUOTE_THRESHOLD ? (
            <button
              type="button"
              className="mt-0.5 text-[10px] text-blue-500 hover:text-blue-700 dark:text-blue-400/60 dark:hover:text-blue-300"
              onClick={() => setQuoteExpanded((v) => !v)}
            >
              {quoteExpanded ? tCommon('actions.showLess') : tCommon('actions.showMore')}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Pending attachment previews */}
      {pendingAttachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {pendingAttachments.map((att, idx) => {
            const isImage = isImageMime(att.mimeType);
            const preparing = session.pendingAttachmentPreparationIds.includes(att.id);
            const lightboxIdx = isImage
              ? pendingAttachments
                  .slice(0, idx)
                  .filter((a) => isImageMime(a.mimeType) && a.previewUrl).length
              : -1;
            return (
              <div
                key={att.id}
                className={`group relative size-14 overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface)] transition-colors hover:border-[var(--color-border-emphasis)] ${isImage ? 'cursor-pointer' : ''}`}
              >
                {preparing ? (
                  <div
                    className="flex size-full flex-col items-center justify-center gap-0.5"
                    role="status"
                  >
                    <Loader2 className="size-4 animate-spin" />
                    <span className="max-w-[48px] truncate text-[7px]">{att.filename}</span>
                  </div>
                ) : isImage ? (
                  <button
                    type="button"
                    className="size-full"
                    onClick={() => setLightboxIndex(lightboxIdx)}
                  >
                    <img
                      src={att.previewUrl}
                      alt={att.filename}
                      className="size-full object-cover"
                    />
                  </button>
                ) : (
                  <div className="flex size-full flex-col items-center justify-center gap-0.5">
                    <FileIcon fileName={att.filename} className="size-5" />
                    <span className="max-w-[48px] truncate text-[7px] text-[var(--color-text-muted)]">
                      {att.filename}
                    </span>
                  </div>
                )}
                <button
                  type="button"
                  disabled={!controller.isOwner}
                  className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white opacity-0 transition-opacity hover:bg-red-600 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    controller.removePendingAttachment(att.id);
                  }}
                >
                  <Trash2 size={8} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      {lightboxIndex !== null && pendingAttachments.length > 0 ? (
        <ImageLightbox
          open
          onClose={() => setLightboxIndex(null)}
          slides={pendingAttachments
            .filter((att) => isImageMime(att.mimeType) && att.previewUrl)
            .map((att) => ({
              src: att.previewUrl,
              alt: att.filename,
              title: att.filename,
            }))}
          index={lightboxIndex}
          showCounter={
            pendingAttachments.filter((a) => isImageMime(a.mimeType) && a.previewUrl).length > 1
          }
        />
      ) : null}

      {controller.attachmentError ? (
        <p className="mb-1 text-[10px] text-red-400">{controller.attachmentError}</p>
      ) : null}
      {session.submitError ? (
        <p role="alert" className="mb-1 text-xs text-red-400">
          {session.submitError}
        </p>
      ) : null}

      <ComposerSurface onPaste={handlePaste}>
        <input
          ref={fileInputRef}
          type="file"
          accept="*/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);

            e.target.value = '';
          }}
        />
        <ComposerTextarea
          id={`task-comment-input-${encodeURIComponent(
            JSON.stringify([surfaceId, taskDetailKey({ contextId, teamName, taskId })])
          )}`}
          connectedToHeader={replyConnectedToComposer}
          placeholder={t('taskComments.placeholder')}
          value={session.commentText}
          onValueChange={controller.setCommentText}
          suggestions={mentionSuggestions}
          teamSuggestions={teamMentionSuggestions}
          taskSuggestions={taskSuggestions}
          projectPath={projectPath}
          chips={session.commentChips}
          onFileChipInsert={controller.addCommentChip}
          onChipRemove={controller.removeCommentChip}
          onModEnter={() => void controller.submitComment()}
          minRows={2}
          maxRows={6}
          maxLength={MAX_TEXT_LENGTH}
          disabled={addingComment || !controller.isOwner}
          cornerAction={
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-white/[0.035] hover:text-[var(--color-text-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={
                      addingComment ||
                      !controller.isOwner ||
                      pendingAttachments.length >= MAX_ATTACHMENTS
                    }
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Paperclip size={16} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{t('taskComments.attachFile')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-white/[0.035] hover:text-[var(--color-text-secondary)]"
                    onClick={() => void window.electronAPI.openExternal('https://voicetext.site')}
                  >
                    <Mic size={16} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{t('taskComments.voiceToText')}</TooltipContent>
              </Tooltip>
              <span
                className="message-composer-send-slot"
                data-visible={
                  trimmed.length > 0 || pendingAttachments.length > 0 ? 'true' : 'false'
                }
              >
                {trimmed.length > 0 || pendingAttachments.length > 0 ? (
                  <button
                    type="button"
                    className="message-composer-send-button inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-xs font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                    disabled={!canSubmit}
                    onClick={() => void controller.submitComment()}
                  >
                    <Send size={14} />
                    {t('taskComments.comment')}
                  </button>
                ) : null}
              </span>
            </div>
          }
          footerRight={
            <div className="flex items-center gap-2">
              {remaining < 200 ? (
                <span
                  className={`text-[10px] ${remaining < 100 ? 'text-yellow-400' : 'text-[var(--color-text-muted)]'}`}
                >
                  {t('taskComments.charsLeft', { count: remaining })}
                </span>
              ) : null}
              {controller.isDraftSaved ? (
                <span className="text-[10px] text-[var(--color-text-muted)]">
                  {t('taskComments.saved')}
                </span>
              ) : null}
            </div>
          }
        />
      </ComposerSurface>
    </div>
  );
};
