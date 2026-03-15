import { useCallback, useMemo, useRef, useState } from 'react';

import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useChipDraftPersistence } from '@renderer/hooks/useChipDraftPersistence';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useTaskSuggestions } from '@renderer/hooks/useTaskSuggestions';
import { useTeamSuggestions } from '@renderer/hooks/useTeamSuggestions';
import { useStore } from '@renderer/store';
import { buildReplyBlock } from '@renderer/utils/agentMessageFormatting';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { serializeChipsWithText } from '@renderer/types/inlineChip';
import {
  extractTaskRefsFromText,
  stripEncodedTaskReferenceMetadata,
} from '@renderer/utils/taskReferenceUtils';
import { MAX_TEXT_LENGTH } from '@shared/constants';
import { ImagePlus, Mic, Send, Trash2, X } from 'lucide-react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { ImageLightbox } from '@renderer/components/team/attachments/ImageLightbox';
import { MemberBadge } from '@renderer/components/team/MemberBadge';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { CommentAttachmentPayload, ResolvedTeamMember } from '@shared/types';

const MAX_ATTACHMENTS = 5;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
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

  const addFiles = useCallback((files: FileList | File[]) => {
    setAttachError(null);
    const fileArray = Array.from(files);
    for (const file of fileArray) {
      if (!ACCEPTED_TYPES.has(file.type)) {
        setAttachError(`Unsupported type: ${file.type}`);
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        setAttachError(`File too large: ${(file.size / (1024 * 1024)).toFixed(1)} MB (max 20 MB)`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        if (!base64) return;
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
              mimeType: file.type,
              base64Data: base64,
              previewUrl: result,
              size: file.size,
            },
          ];
        });
      };
      reader.readAsDataURL(file);
    }
  }, []);

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
      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && ACCEPTED_TYPES.has(item.type)) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        addFiles(imageFiles);
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
            <TooltipContent side="left">Cancel reply</TooltipContent>
          </Tooltip>

          <div className="mb-1 flex items-center gap-1.5">
            <span className="text-[10px] text-blue-600/70 dark:text-blue-300/60">Replying to</span>
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
              {quoteExpanded ? 'less' : 'more'}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Pending attachment previews */}
      {pendingAttachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {pendingAttachments.map((att, idx) => (
            <div
              key={att.id}
              className="group relative size-14 cursor-pointer overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface)] transition-colors hover:border-[var(--color-border-emphasis)]"
              onClick={() => setLightboxIndex(idx)}
            >
              <img src={att.previewUrl} alt={att.filename} className="size-full object-cover" />
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
          ))}
        </div>
      ) : null}

      {lightboxIndex !== null && pendingAttachments.length > 0 ? (
        <ImageLightbox
          open
          onClose={() => setLightboxIndex(null)}
          slides={pendingAttachments.map((att) => ({
            src: att.previewUrl,
            alt: att.filename,
            title: att.filename,
          }))}
          index={lightboxIndex}
          showCounter={pendingAttachments.length > 1}
        />
      ) : null}

      {attachError ? <p className="mb-1 text-[10px] text-red-400">{attachError}</p> : null}

      <div className="relative" onPaste={handlePaste}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            // eslint-disable-next-line no-param-reassign -- reset file input to allow re-selecting same file
            e.target.value = '';
          }}
        />
        <MentionableTextarea
          id={`task-comment-${taskId}`}
          className={replyTo ? 'rounded-t-none' : undefined}
          placeholder="Add a comment... (Enter to send)"
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
                    <ImagePlus size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Attach image (or paste)</TooltipContent>
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
                <TooltipContent side="top">Voice to text</TooltipContent>
              </Tooltip>
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canSubmit}
                onClick={() => void handleSubmit()}
              >
                <Send size={12} />
                Comment
              </button>
            </div>
          }
          footerRight={
            <div className="flex items-center gap-2">
              {remaining < 200 ? (
                <span
                  className={`text-[10px] ${remaining < 100 ? 'text-yellow-400' : 'text-[var(--color-text-muted)]'}`}
                >
                  {remaining} chars left
                </span>
              ) : null}
              {draft.isSaved ? (
                <span className="text-[10px] text-[var(--color-text-muted)]">Saved</span>
              ) : null}
            </div>
          }
        />
      </div>
    </div>
  );
};
