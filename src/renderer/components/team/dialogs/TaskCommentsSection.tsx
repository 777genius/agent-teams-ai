import { useCallback, useEffect, useMemo, useState } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { CopyButton } from '@renderer/components/common/CopyButton';
import { AnimatedHeightReveal } from '@renderer/components/team/activity/AnimatedHeightReveal';
import { ReplyQuoteBlock } from '@renderer/components/team/activity/ReplyQuoteBlock';
import { useNewItemKeys } from '@renderer/components/team/activity/useNewItemKeys';
import { ImageLightbox } from '@renderer/components/team/attachments/ImageLightbox';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { ExpandableContent } from '@renderer/components/ui/ExpandableContent';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useChipDraftPersistence } from '@renderer/hooks/useChipDraftPersistence';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useMarkCommentsRead } from '@renderer/hooks/useMarkCommentsRead';
import { useTaskSuggestions } from '@renderer/hooks/useTaskSuggestions';
import { useTeamSuggestions } from '@renderer/hooks/useTeamSuggestions';
import { useStore } from '@renderer/store';
import { serializeChipsWithText } from '@renderer/types/inlineChip';
import { buildReplyBlock, parseMessageReply } from '@renderer/utils/agentMessageFormatting';
import { isImageMimeType } from '@renderer/utils/attachmentUtils';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { linkifyAllMentionsInMarkdown } from '@renderer/utils/mentionLinkify';
import {
  extractTaskRefsFromText,
  linkifyTaskIdsInMarkdown,
  parseTaskLinkHref,
  stripEncodedTaskReferenceMetadata,
} from '@renderer/utils/taskReferenceUtils';
import { MAX_TEXT_LENGTH } from '@shared/constants';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { formatDistanceToNow } from 'date-fns';
import { CheckCircle2, Eye, File, Loader2, MessageSquare, Reply, Send, X } from 'lucide-react';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { ResolvedTeamMember, TaskAttachmentMeta, TaskComment } from '@shared/types';

/**
 * Convert literal backslash-n sequences to real newlines.
 * Historical CLI-produced comments may store `\n` as literal text
 * when shell double-quotes don't interpret escape sequences.
 */
function normalizeLiteralNewlines(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

const INITIAL_VISIBLE_COMMENTS = 30;
const VISIBLE_COMMENTS_STEP = 50;
const MAX_COMMENTS_TO_RENDER = 2000;

interface TaskCommentsSectionProps {
  teamName: string;
  taskId: string;
  comments: TaskComment[];
  members: ResolvedTeamMember[];
  /** When true, the "Comments" header is not rendered (e.g. inside a collapsible section). */
  hideHeader?: boolean;
  /** When true, the comment input area is not rendered (useful when input is rendered externally). */
  hideInput?: boolean;
  /** Called when the user clicks Reply on a comment (used when input is rendered externally). */
  onReply?: (author: string, text: string) => void;
  /** Called when a task ID link (e.g. #10) is clicked in comment text. */
  onTaskIdClick?: (taskId: string) => void;
  /** Extra className on the outer comments container (e.g. negative margins for edge-to-edge). */
  containerClassName?: string;
  /** Snapshot of unread comment IDs captured when the dialog opened. Blue dot is shown for these. */
  unreadCommentIds?: Set<string>;
  /**
   * Ref callback factory from useViewportCommentRead.
   * When provided, each comment element is registered for viewport-based read tracking.
   */
  registerCommentForViewport?: (commentId: string) => (el: HTMLElement | null) => void;
}

export const TaskCommentsSection = ({
  teamName,
  taskId,
  comments,
  members,
  hideHeader = false,
  hideInput = false,
  onReply,
  onTaskIdClick,
  containerClassName,
  unreadCommentIds,
  registerCommentForViewport,
}: TaskCommentsSectionProps): React.JSX.Element => {
  const addTaskComment = useStore((s) => s.addTaskComment);
  const addingComment = useStore((s) => s.addingComment);
  const projectPath = useStore((s) => s.selectedTeamData?.config.projectPath ?? null);
  const commentsRef = useMarkCommentsRead(teamName, taskId, comments);

  const [replyTo, setReplyTo] = useState<{ author: string; text: string } | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COMMENTS);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);

  // Reset local UI state when team/task changes using the
  // "adjust state during render" pattern (no effect needed).
  // See: https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const resetKey = `${teamName}:${taskId}`;
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setVisibleCount(INITIAL_VISIBLE_COMMENTS);
    setReplyTo(null);
    setPreviewImageUrl(null);
  }

  const draft = useDraftPersistence({ key: `taskComment:${teamName}:${taskId}` });
  const chipDraft = useChipDraftPersistence(`taskCommentChips:${teamName}:${taskId}`);
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const { suggestions: teamMentionSuggestions } = useTeamSuggestions(teamName);
  const { suggestions: taskSuggestions } = useTaskSuggestions(teamName);
  const teamNamesForLinkify = useMemo(
    () => teamMentionSuggestions.map((t) => t.name),
    [teamMentionSuggestions]
  );

  const cappedComments = useMemo(() => {
    if (comments.length <= MAX_COMMENTS_TO_RENDER) return comments;
    // In extreme cases, rendering thousands of markdown blocks can freeze the renderer.
    // Keep the UI responsive by showing only the most recent subset.
    return comments.slice(-MAX_COMMENTS_TO_RENDER);
  }, [comments]);

  const sortedComments = useMemo(() => {
    const list = [...cappedComments];
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return list;
  }, [cappedComments]);

  const visibleComments = useMemo(
    () => sortedComments.slice(0, Math.min(visibleCount, sortedComments.length)),
    [sortedComments, visibleCount]
  );

  const visibleCommentIds = useMemo(
    () => visibleComments.map((comment) => comment.id),
    [visibleComments]
  );
  const newCommentIds = useNewItemKeys({
    itemKeys: visibleCommentIds,
    paginationKey: visibleCount,
    resetKey: `${teamName}:${taskId}`,
  });

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
    (trimmed.length > 0 || chipDraft.chips.length > 0) &&
    trimmed.length <= MAX_TEXT_LENGTH &&
    !addingComment;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    try {
      const serialized = serializeChipsWithText(trimmed, chipDraft.chips);
      const text = replyTo ? buildReplyBlock(replyTo.author, replyTo.text, serialized) : serialized;
      const taskRefs = extractTaskRefsFromText(draft.value, taskSuggestions);
      await addTaskComment(teamName, taskId, { text, taskRefs });
      draft.clearDraft();
      chipDraft.clearChipDraft();
      setReplyTo(null);
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
    taskSuggestions,
  ]);

  return (
    <div ref={commentsRef}>
      {!hideHeader ? (
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-muted)]">
          <MessageSquare size={12} />
          Comments
          {comments.length > 0 ? (
            <span className="rounded-full bg-[var(--color-surface-raised)] px-1.5 py-0 text-[10px]">
              {comments.length}
            </span>
          ) : null}
        </div>
      ) : null}

      {comments.length > 0 ? (
        <div className="mb-3">
          {comments.length > MAX_COMMENTS_TO_RENDER ? (
            <div className="mb-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
              Showing the most recent {MAX_COMMENTS_TO_RENDER.toLocaleString()} comments to keep the
              UI responsive.
            </div>
          ) : null}

          <div className={containerClassName ?? ''}>
            {visibleComments.map((comment, index) => (
              <AnimatedHeightReveal key={comment.id} animate={newCommentIds.has(comment.id)}>
                <div
                  ref={
                    registerCommentForViewport ? registerCommentForViewport(comment.id) : undefined
                  }
                  className={[
                    'group min-w-0 overflow-hidden px-4 py-2.5',
                    comment.type === 'review_approved'
                      ? 'border-y border-emerald-500/20 bg-emerald-500/5'
                      : comment.type === 'review_request'
                        ? 'border-y border-blue-500/20 bg-blue-500/5'
                        : '',
                  ].join(' ')}
                  style={
                    !comment.type || comment.type === 'regular'
                      ? {
                          backgroundColor:
                            index % 2 === 1 ? 'var(--card-bg-zebra)' : 'var(--card-bg)',
                        }
                      : undefined
                  }
                >
                  <div className="mb-1 flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
                    {unreadCommentIds?.has(comment.id) ? (
                      <span className="size-2 shrink-0 rounded-full bg-blue-500" />
                    ) : null}
                    <MemberBadge
                      name={comment.author}
                      color={colorMap.get(comment.author)}
                      hideAvatar={comment.author === 'user'}
                    />
                    {comment.type === 'review_approved' ? (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                        <CheckCircle2 size={10} />
                        Approved
                      </span>
                    ) : comment.type === 'review_request' ? (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                        <Eye size={10} />
                        Review requested
                      </span>
                    ) : null}
                    <span>
                      {(() => {
                        const date = new Date(comment.createdAt);
                        return isNaN(date.getTime())
                          ? 'unknown time'
                          : formatDistanceToNow(date, { addSuffix: true });
                      })()}
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="ml-auto flex items-center gap-0.5 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:text-[var(--color-text-secondary)] group-hover:opacity-100"
                          onClick={() => {
                            const replyText = stripAgentBlocks(
                              parseMessageReply(comment.text)?.replyText ?? comment.text
                            );
                            if (onReply) {
                              onReply(comment.author, replyText);
                            } else {
                              setReplyTo({ author: comment.author, text: replyText });
                            }
                          }}
                        >
                          <Reply size={11} />
                          Reply
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left">Reply to comment</TooltipContent>
                    </Tooltip>
                    <span className="opacity-0 transition-opacity group-hover:opacity-100">
                      <CopyButton text={comment.text} inline />
                    </span>
                  </div>
                  {(() => {
                    const reply = parseMessageReply(comment.text);
                    const rawForDisplay = reply ? reply.replyText : comment.text;
                    const displayText = normalizeLiteralNewlines(stripAgentBlocks(rawForDisplay));
                    return (
                      <ExpandableContent collapsedHeight={120} className="text-xs">
                        {reply ? (
                          <ReplyQuoteBlock
                            reply={{
                              ...reply,
                              originalText: stripAgentBlocks(reply.originalText),
                              replyText: stripAgentBlocks(reply.replyText),
                            }}
                            memberColor={colorMap.get(reply.agentName)}
                            replyTaskRefs={comment.taskRefs}
                            bodyMaxHeight="max-h-none"
                          />
                        ) : (
                          <span
                            className="break-words"
                            onClickCapture={
                              onTaskIdClick
                                ? (e) => {
                                    const link = (
                                      e.target as HTMLElement
                                    ).closest<HTMLAnchorElement>('a[href^="task://"]');
                                    if (link) {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      const href = link.getAttribute('href');
                                      const parsed = href ? parseTaskLinkHref(href) : null;
                                      if (parsed?.taskId) onTaskIdClick(parsed.taskId);
                                    }
                                  }
                                : undefined
                            }
                          >
                            <MarkdownViewer
                              content={(() => {
                                let t = linkifyTaskIdsInMarkdown(displayText, comment.taskRefs);
                                if (colorMap.size > 0 || teamNamesForLinkify.length > 0)
                                  t = linkifyAllMentionsInMarkdown(
                                    t,
                                    colorMap,
                                    teamNamesForLinkify
                                  );
                                return t;
                              })()}
                              maxHeight="max-h-none"
                              bare
                            />
                          </span>
                        )}
                      </ExpandableContent>
                    );
                  })()}
                  {comment.attachments && comment.attachments.length > 0 ? (
                    <CommentAttachments
                      attachments={comment.attachments}
                      teamName={teamName}
                      taskId={taskId}
                      onPreview={setPreviewImageUrl}
                    />
                  ) : null}
                </div>
              </AnimatedHeightReveal>
            ))}
          </div>

          {sortedComments.length > visibleComments.length ? (
            <div className="flex items-center justify-center pt-2">
              <button
                type="button"
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
                onClick={() =>
                  setVisibleCount((v) => Math.min(sortedComments.length, v + VISIBLE_COMMENTS_STEP))
                }
              >
                Show more comments ({visibleComments.length}/{sortedComments.length})
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Image lightbox */}
      {previewImageUrl ? (
        <ImageLightbox
          open
          onClose={() => setPreviewImageUrl(null)}
          src={previewImageUrl}
          alt="Attachment preview"
        />
      ) : null}

      {!hideInput && (
        <>
          {replyTo ? (
            <div className="mb-2 flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-2">
              <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-center gap-1 text-[10px] font-medium text-[var(--color-text-muted)]">
                  Replying to
                  <MemberBadge name={replyTo.author} color={colorMap.get(replyTo.author)} />
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
                    onClick={() => setReplyTo(null)}
                  >
                    <X size={12} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">Cancel reply</TooltipContent>
              </Tooltip>
            </div>
          ) : null}

          <div className="relative">
            <MentionableTextarea
              id={`task-comment-${taskId}`}
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
                <button
                  type="button"
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!canSubmit}
                  onClick={() => void handleSubmit()}
                >
                  <Send size={12} />
                  Comment
                </button>
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
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Comment attachment thumbnail (read-only, no delete)
// ---------------------------------------------------------------------------

interface CommentAttachmentThumbnailProps {
  attachment: TaskAttachmentMeta;
  teamName: string;
  taskId: string;
  onPreview: (dataUrl: string) => void;
}

const CommentAttachmentThumbnail = ({
  attachment,
  teamName,
  taskId,
  onPreview,
}: CommentAttachmentThumbnailProps): React.JSX.Element => {
  const getTaskAttachmentData = useStore((s) => s.getTaskAttachmentData);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!isImageMimeType(attachment.mimeType)) return;
        const base64 = await getTaskAttachmentData(
          teamName,
          taskId,
          attachment.id,
          attachment.mimeType
        );
        if (!cancelled && base64) {
          setThumbUrl(`data:${attachment.mimeType};base64,${base64}`);
        }
      } catch {
        // ignore — thumbnail simply won't render
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamName, taskId, attachment.id, attachment.mimeType, getTaskAttachmentData]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={`group relative flex size-14 cursor-pointer items-center justify-center overflow-hidden rounded border bg-[var(--color-surface)] transition-colors ${
            downloadError
              ? 'border-red-500/60'
              : 'border-[var(--color-border)] hover:border-[var(--color-border-emphasis)]'
          }`}
          onClick={() => {
            if (isImageMimeType(attachment.mimeType)) {
              if (thumbUrl) onPreview(thumbUrl);
              return;
            }
            void (async () => {
              setDownloading(true);
              setDownloadError(null);
              try {
                const base64 = await getTaskAttachmentData(
                  teamName,
                  taskId,
                  attachment.id,
                  attachment.mimeType
                );
                if (!base64) return;
                const mime =
                  attachment.mimeType && typeof attachment.mimeType === 'string'
                    ? attachment.mimeType
                    : 'application/octet-stream';
                const dataUrl = `data:${mime};base64,${base64}`;
                const blob = await fetch(dataUrl).then((r) => r.blob());
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = attachment.filename || 'attachment';
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
              } catch (err) {
                setDownloadError(err instanceof Error ? err.message : 'Download failed');
              } finally {
                setDownloading(false);
              }
            })();
          }}
        >
          {isImageMimeType(attachment.mimeType) ? (
            thumbUrl ? (
              <img src={thumbUrl} alt={attachment.filename} className="size-full object-cover" />
            ) : (
              <Loader2 size={12} className="animate-spin text-[var(--color-text-muted)]" />
            )
          ) : downloading ? (
            <Loader2 size={12} className="animate-spin text-[var(--color-text-muted)]" />
          ) : (
            <File size={14} className="text-[var(--color-text-muted)]" />
          )}
          <div className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-0.5 py-px text-center text-[7px] text-white opacity-0 transition-opacity group-hover:opacity-100">
            {attachment.filename}
          </div>
        </div>
      </TooltipTrigger>
      {downloadError ? (
        <TooltipContent side="top" className="text-red-400">
          {downloadError}
        </TooltipContent>
      ) : (
        <TooltipContent side="top">{attachment.filename}</TooltipContent>
      )}
    </Tooltip>
  );
};

// ---------------------------------------------------------------------------
// Comment attachments grid
// ---------------------------------------------------------------------------

interface CommentAttachmentsProps {
  attachments: TaskAttachmentMeta[];
  teamName: string;
  taskId: string;
  onPreview: (dataUrl: string) => void;
}

const CommentAttachments = ({
  attachments,
  teamName,
  taskId,
  onPreview,
}: CommentAttachmentsProps): React.JSX.Element => (
  <div className="mt-1.5 flex flex-wrap gap-1.5">
    {attachments.map((att) => (
      <CommentAttachmentThumbnail
        key={att.id}
        attachment={att}
        teamName={teamName}
        taskId={taskId}
        onPreview={onPreview}
      />
    ))}
  </div>
);
