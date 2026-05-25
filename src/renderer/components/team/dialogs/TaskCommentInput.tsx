import { useCallback, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { ImageLightbox } from '@renderer/components/team/attachments/ImageLightbox';
import { FileIcon } from '@renderer/components/team/editor/FileIcon';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useChipDraftPersistence } from '@renderer/hooks/useChipDraftPersistence';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useTaskSuggestions } from '@renderer/hooks/useTaskSuggestions';
import { useTeamSuggestions } from '@renderer/hooks/useTeamSuggestions';
import { useStore } from '@renderer/store';
import { serializeChipsWithText } from '@renderer/types/inlineChip';
import { buildReplyBlock } from '@renderer/utils/agentMessageFormatting';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import {
  extractTaskRefsFromText,
  stripEncodedTaskReferenceMetadata,
} from '@renderer/utils/taskReferenceUtils';
import { MAX_TEXT_LENGTH } from '@shared/constants';
import { categorizeFile, getEffectiveMimeType, isImageMime } from '@shared/constants/attachments';
import { Mic, Paperclip, Send, Trash2, X } from 'lucide-react';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { CommentAttachmentPayload, ResolvedTeamMember } from '@shared/types';

const MAX_ATTACHMENTS = 5;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const LONG_QUOTE_THRESHOLD = 200;

interface TaskCommentInputProps {
  teamName: string;
  taskId: string;
  members: ResolvedTeamMember[];
  replyTo: { author: string; text: string } | null;
  onClearReply: () => void;
}

interface PendingAttachment {
  id: string;
  filename: string;
  mimeType: string;
  base64Data: string;
  previewUrl: string;
  size: number;
}

export const TaskCommentInput = ({
  teamName,
  taskId,
  members,
  replyTo,
  onClearReply,
}: TaskCommentInputProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const addTaskComment = useStore((s) => s.addTaskComment);
  const addingComment = useStore((s) => s.addingComment);
  const projectPath = useStore((s) => s.selectedTeamData?.config.projectPath ?? null);

  const draft = useDraftPersistence({ key: `taskComment:${teamName}:${taskId}` });
  const chipDraft = useChipDraftPersistence(`taskCommentChips:${teamName}:${taskId}`);
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const { suggestions: teamMentionSuggestions } = useTeamSuggestions(teamName);
  const { suggestions: taskSuggestions } = useTaskSuggestions(teamName);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
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

  const trimmed = stripEncodedTaskReferenceMetadata(draft.value).trim();
  const remaining = MAX_TEXT_LENGTH - trimmed.length;
  const canSubmit =
    (trimmed.length > 0 || pendingAttachments.length > 0) &&
    trimmed.length <= MAX_TEXT_LENGTH &&
    !addingComment;

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      setAttachError(null);
      const fileArray = Array.from(files);

      // 1. Separate unsupported files → path prepend
      const supported: File[] = [];
      for (const file of fileArray) {
        if (categorizeFile(file) === 'unsupported') {
          let filePath = '';
          try {
            filePath = window.electronAPI.getPathForFile(file);
          } catch {
            // Clipboard files: no path available
          }
          if (filePath) {
            const current = draft.value;
            draft.setValue(current ? filePath + '\n' + current : filePath + '\n');
          }
          continue;
        }
        if (file.size === 0) {
          setAttachError(`File "${file.name}" is empty`);
          continue;
        }
        if (file.size > MAX_FILE_SIZE) {
          setAttachError(
            `File too large: ${(file.size / (1024 * 1024)).toFixed(1)} MB (max 20 MB)`
          );
          continue;
        }
        supported.push(file);
      }

      if (supported.length === 0) return;

      // 2. Read all files sequentially to avoid race condition with MAX_ATTACHMENTS
      for (const file of supported) {
        const result = await new Promise<string | null>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(file);
        });
        if (!result) continue;
        const base64 = result.split(',')[1];
        if (!base64) continue;

        const id = crypto.randomUUID();
        setPendingAttachments((prev) => {
          if (prev.length >= MAX_ATTACHMENTS) {
            setAttachError(`Maximum ${MAX_ATTACHMENTS} attachments per comment`);
            return prev;
          }
          return [
            ...prev,
            {
              id,
              filename: file.name,
              mimeType: getEffectiveMimeType(file),
              base64Data: base64,
              previewUrl: result,
              size: file.size,
            },
          ];
        });
      }
    },
    [draft]
  );

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    try {
      const serialized = serializeChipsWithText(trimmed, chipDraft.chips);
      const text = replyTo
        ? buildReplyBlock(replyTo.author, replyTo.text, serialized || '(image)')
        : serialized || '(image)';
      const taskRefs = extractTaskRefsFromText(draft.value, taskSuggestions);
      const attachments: CommentAttachmentPayload[] | undefined =
        pendingAttachments.length > 0
          ? pendingAttachments.map((a) => ({
              id: a.id,
              filename: a.filename,
              mimeType: a.mimeType,
              base64Data: a.base64Data,
            }))
          : undefined;
      await addTaskComment(teamName, taskId, {
        text,
        attachments,
        taskRefs,
      });
      draft.clearDraft();
      chipDraft.clearChipDraft();
      setPendingAttachments([]);
      setAttachError(null);
      onClearReply();
    } catch {
      // Error is stored in addCommentError via store
    }
  }, [
    canSubmit,
    addTaskComment,
    teamName,
    taskId,
    trimmed,
    draft,
    chipDraft,
    replyTo,
    onClearReply,
    pendingAttachments,
    taskSuggestions,
  ]);

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
        <div className="relative overflow-hidden rounded-t-md border border-b-0 border-blue-400/30 bg-blue-100/80 py-2 pl-3 pr-2 dark:border-blue-500/20 dark:bg-blue-950/20">
          {/* Decorative quotation mark */}
          <span className="pointer-events-none absolute -right-1 top-1/2 -translate-y-1/2 select-none font-serif text-[64px] leading-none text-blue-500/[0.08] dark:text-blue-400/[0.08]">
            &ldquo;
          </span>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="absolute right-1.5 top-1.5 z-10 rounded p-0.5 text-blue-400/60 hover:text-blue-600 dark:text-blue-300/40 dark:hover:text-blue-200"
                onClick={onClearReply}
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
            const lightboxIdx = isImage
              ? pendingAttachments.slice(0, idx).filter((a) => isImageMime(a.mimeType)).length
              : -1;
            return (
              <div
                key={att.id}
                className="group relative size-14 cursor-pointer overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface)] transition-colors hover:border-[var(--color-border-emphasis)]"
                onClick={isImage ? () => setLightboxIndex(lightboxIdx) : undefined}
              >
                {isImage ? (
                  <img src={att.previewUrl} alt={att.filename} className="size-full object-cover" />
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
                  className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white opacity-0 transition-opacity hover:bg-red-600 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeAttachment(att.id);
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
            .filter((att) => isImageMime(att.mimeType))
            .map((att) => ({
              src: att.previewUrl,
              alt: att.filename,
              title: att.filename,
            }))}
          index={lightboxIndex}
          showCounter={pendingAttachments.filter((a) => isImageMime(a.mimeType)).length > 1}
        />
      ) : null}

      {attachError ? <p className="mb-1 text-[10px] text-red-400">{attachError}</p> : null}

      <div className="relative" onPaste={handlePaste}>
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
        <MentionableTextarea
          id={`task-comment-${taskId}`}
          className={replyTo ? 'rounded-t-none' : undefined}
          placeholder={t('taskComments.placeholder')}
          value={draft.value}
          onValueChange={draft.setValue}
          suggestions={mentionSuggestions}
          teamSuggestions={teamMentionSuggestions}
          taskSuggestions={taskSuggestions}
          projectPath={projectPath}
          chips={chipDraft.chips}
          onFileChipInsert={chipDraft.addChip}
          onChipRemove={chipDraft.removeChip}
          onModEnter={() => void handleSubmit()}
          minRows={2}
          maxRows={8}
          maxLength={MAX_TEXT_LENGTH}
          disabled={addingComment}
          cornerAction={
            <div className="flex items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center rounded-full p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text-secondary)]"
                    disabled={addingComment || pendingAttachments.length >= MAX_ATTACHMENTS}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Paperclip size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{t('taskComments.attachFile')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center rounded-full p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text-secondary)]"
                    onClick={() => void window.electronAPI.openExternal('https://voicetext.site')}
                  >
                    <Mic size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{t('taskComments.voiceToText')}</TooltipContent>
              </Tooltip>
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canSubmit}
                onClick={() => void handleSubmit()}
              >
                <Send size={12} />
                {t('taskComments.comment')}
              </button>
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
              {draft.isSaved ? (
                <span className="text-[10px] text-[var(--color-text-muted)]">
                  {t('taskComments.saved')}
                </span>
              ) : null}
            </div>
          }
        />
      </div>
    </div>
  );
};
