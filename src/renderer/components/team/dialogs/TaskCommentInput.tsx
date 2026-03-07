import { useCallback, useMemo, useRef, useState } from 'react';

import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useStore } from '@renderer/store';
import { buildReplyBlock } from '@renderer/utils/agentMessageFormatting';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { MAX_TEXT_LENGTH } from '@shared/constants';
import { ImagePlus, Mic, Send, Trash2, X } from 'lucide-react';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { CommentAttachmentPayload, ResolvedTeamMember } from '@shared/types';

const MAX_ATTACHMENTS = 5;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

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
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
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

  const trimmed = draft.value.trim();
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
      const text = replyTo
        ? buildReplyBlock(replyTo.author, replyTo.text, trimmed || '(image)')
        : trimmed || '(image)';
      const attachments: CommentAttachmentPayload[] | undefined =
        pendingAttachments.length > 0
          ? pendingAttachments.map((a) => ({
              id: a.id,
              filename: a.filename,
              mimeType: a.mimeType,
              base64Data: a.base64Data,
            }))
          : undefined;
      await addTaskComment(teamName, taskId, text, attachments);
      draft.clearDraft();
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
    replyTo,
    onClearReply,
    pendingAttachments,
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
        <div className="mb-2 flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-2">
          <div className="min-w-0 flex-1">
            <div className="mb-0.5 text-[10px] font-medium text-[var(--color-text-muted)]">
              Replying to{' '}
              <span
                className="font-semibold"
                style={{
                  color: (() => {
                    const rc = colorMap.get(replyTo.author);
                    return rc ? getTeamColorSet(rc).text : 'var(--color-text-secondary)';
                  })(),
                }}
              >
                @{replyTo.author}
              </span>
            </div>
            <div className="line-clamp-3 text-[11px] text-[var(--color-text-muted)]">
              {replyTo.text}
            </div>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text-secondary)]"
                onClick={onClearReply}
              >
                <X size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">Cancel reply</TooltipContent>
          </Tooltip>
        </div>
      ) : null}

      {/* Pending attachment previews */}
      {pendingAttachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {pendingAttachments.map((att) => (
            <div
              key={att.id}
              className="group relative size-14 overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface)]"
            >
              <img src={att.previewUrl} alt={att.filename} className="size-full object-cover" />
              <button
                type="button"
                className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white opacity-0 transition-opacity hover:bg-red-600 group-hover:opacity-100"
                onClick={() => removeAttachment(att.id)}
              >
                <Trash2 size={8} />
              </button>
            </div>
          ))}
        </div>
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
          placeholder="Add a comment... (Enter to send)"
          value={draft.value}
          onValueChange={draft.setValue}
          suggestions={mentionSuggestions}
          projectPath={projectPath}
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
                <span className="text-[10px] text-[var(--color-text-muted)]">Draft saved</span>
              ) : null}
            </div>
          }
        />
      </div>
    </div>
  );
};
