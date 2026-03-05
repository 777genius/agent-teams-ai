import { useCallback, useEffect, useMemo, useState } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { ReplyQuoteBlock } from '@renderer/components/team/activity/ReplyQuoteBlock';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useMarkCommentsRead } from '@renderer/hooks/useMarkCommentsRead';
import { useStore } from '@renderer/store';
import { buildReplyBlock, parseMessageReply } from '@renderer/utils/agentMessageFormatting';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { getModifierKeyName } from '@renderer/utils/keyboardUtils';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { formatDistanceToNow } from 'date-fns';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eye,
  Loader2,
  MessageSquare,
  Reply,
  Send,
  X,
} from 'lucide-react';

import type { MentionSuggestion } from '@renderer/types/mention';
import type {
  AttachmentMediaType,
  ResolvedTeamMember,
  TaskAttachmentMeta,
  TaskComment,
} from '@shared/types';

/**
 * Convert literal backslash-n sequences to real newlines.
 * CLI tools (teamctl.js) may store `\n` as literal text when
 * shell double-quotes don't interpret escape sequences.
 */
function normalizeLiteralNewlines(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

const MAX_COMMENT_LENGTH = 2000;
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
}

/** Convert `#<digits>` in plain text to markdown links with task:// protocol. */
function linkifyTaskIdsInMarkdown(text: string): string {
  return text.replace(/#(\d+)/g, '[#$1](task://$1)');
}

/** Convert `@memberName` to markdown links with mention:// protocol for colored badge rendering. */
function linkifyMentionsInMarkdown(text: string, memberColorMap: Map<string, string>): string {
  if (memberColorMap.size === 0) return text;
  const names = [...memberColorMap.keys()].sort((a, b) => b.length - a.length);
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(^|\\s)@(${escaped.join('|')})(?=[\\s,.:;!?)\\]}-]|$)`, 'gi');
  return text.replace(pattern, (match, prefix: string, name: string) => {
    const canonical = names.find((n) => n.toLowerCase() === name.toLowerCase()) ?? name;
    const color = memberColorMap.get(canonical) ?? '';
    return `${prefix}[@${canonical}](mention://${encodeURIComponent(color)}/${encodeURIComponent(canonical)})`;
  });
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
}: TaskCommentsSectionProps): React.JSX.Element => {
  const addTaskComment = useStore((s) => s.addTaskComment);
  const addingComment = useStore((s) => s.addingComment);
  const commentsRef = useMarkCommentsRead(teamName, taskId, comments);

  const [replyTo, setReplyTo] = useState<{ author: string; text: string } | null>(null);
  const [expandedCommentIds, setExpandedCommentIds] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COMMENTS);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);

  // Reset local state when team/task changes (React-recommended pattern for
  // adjusting state based on props without using effects or refs during render)
  const currentKey = teamIdKey(teamName, taskId);
  const [prevKey, setPrevKey] = useState(currentKey);
  if (prevKey !== currentKey) {
    setPrevKey(currentKey);
    setVisibleCount(INITIAL_VISIBLE_COMMENTS);
    setExpandedCommentIds(new Set());
    setReplyTo(null);
  }

  const toggleCommentExpanded = useCallback((commentId: string) => {
    setExpandedCommentIds((prev) => {
      const next = new Set(prev);
      if (next.has(commentId)) next.delete(commentId);
      else next.add(commentId);
      return next;
    });
  }, []);

  const draft = useDraftPersistence({ key: `taskComment:${teamName}:${taskId}` });
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);

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
  const remaining = MAX_COMMENT_LENGTH - trimmed.length;
  const canSubmit = trimmed.length > 0 && trimmed.length <= MAX_COMMENT_LENGTH && !addingComment;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    try {
      const text = replyTo ? buildReplyBlock(replyTo.author, replyTo.text, trimmed) : trimmed;
      await addTaskComment(teamName, taskId, text);
      draft.clearDraft();
      setReplyTo(null);
    } catch {
      // Error is stored in addCommentError via store
    }
  }, [canSubmit, addTaskComment, teamName, taskId, trimmed, draft, replyTo]);

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
        <div className="mb-3 space-y-2">
          {comments.length > MAX_COMMENTS_TO_RENDER ? (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
              Showing the most recent {MAX_COMMENTS_TO_RENDER.toLocaleString()} comments to keep the
              UI responsive.
            </div>
          ) : null}

          {visibleComments.map((comment, index) => (
            <div
              key={comment.id}
              className={[
                'group rounded-md p-2.5',
                comment.type === 'review_approved'
                  ? 'border border-emerald-500/20 bg-emerald-500/5'
                  : comment.type === 'review_request'
                    ? 'border border-blue-500/20 bg-blue-500/5'
                    : '',
              ].join(' ')}
              style={
                !comment.type && index % 2 === 1
                  ? { backgroundColor: 'var(--card-bg-zebra)' }
                  : undefined
              }
            >
              <div className="mb-1 flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
                <MemberBadge name={comment.author} color={colorMap.get(comment.author)} />
                {comment.type === 'review_approved' ? (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                    <CheckCircle2 size={10} />
                    Approved
                  </span>
                ) : comment.type === 'review_request' ? (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-400">
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
              </div>
              {(() => {
                const reply = parseMessageReply(comment.text);
                const rawForDisplay = reply ? reply.replyText : comment.text;
                const displayText = normalizeLiteralNewlines(stripAgentBlocks(rawForDisplay));
                const needsExpandCollapse = displayText.includes('\n');
                const expanded = expandedCommentIds.has(comment.id);
                const collapsedHeight = 'max-h-[120px]';
                const showCollapsed = needsExpandCollapse && !expanded;
                const showExpandedButton = needsExpandCollapse && expanded;
                return (
                  <div className="relative text-xs">
                    <div
                      className={
                        showCollapsed ? `relative ${collapsedHeight} overflow-hidden` : undefined
                      }
                    >
                      {reply ? (
                        <ReplyQuoteBlock
                          reply={{
                            ...reply,
                            originalText: stripAgentBlocks(reply.originalText),
                            replyText: stripAgentBlocks(reply.replyText),
                          }}
                          bodyMaxHeight={
                            needsExpandCollapse && !expanded ? 'max-h-56' : 'max-h-none'
                          }
                        />
                      ) : (
                        <span
                          onClickCapture={
                            onTaskIdClick
                              ? (e) => {
                                  const link = (e.target as HTMLElement).closest<HTMLAnchorElement>(
                                    'a[href^="task://"]'
                                  );
                                  if (link) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    const id = link.getAttribute('href')?.replace('task://', '');
                                    if (id) onTaskIdClick(id);
                                  }
                                }
                              : undefined
                          }
                        >
                          <MarkdownViewer
                            content={(() => {
                              let t = displayText;
                              if (onTaskIdClick) t = linkifyTaskIdsInMarkdown(t);
                              if (colorMap.size > 0) t = linkifyMentionsInMarkdown(t, colorMap);
                              return t;
                            })()}
                            maxHeight={
                              needsExpandCollapse && !expanded ? collapsedHeight : 'max-h-none'
                            }
                            bare
                          />
                        </span>
                      )}
                      {showCollapsed && (
                        <>
                          <div
                            className="pointer-events-none absolute inset-x-0 bottom-0 h-14"
                            style={{
                              background:
                                'linear-gradient(to top, var(--color-surface) 0%, transparent 100%)',
                            }}
                            aria-hidden
                          />
                          <div className="absolute inset-x-0 bottom-0 flex justify-center pt-1">
                            <button
                              type="button"
                              className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)] shadow-sm transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
                              onClick={() => toggleCommentExpanded(comment.id)}
                              title="Expand"
                            >
                              <ChevronDown size={12} />
                              Expand
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                    {showExpandedButton && (
                      <div className="flex justify-center pt-2">
                        <button
                          type="button"
                          className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text-secondary)]"
                          onClick={() => toggleCommentExpanded(comment.id)}
                          title="Collapse"
                        >
                          <ChevronUp size={12} />
                          Collapse
                        </button>
                      </div>
                    )}
                  </div>
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
          ))}

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

      {/* Full-size image preview overlay */}
      {previewImageUrl ? (
        <div className="relative mb-3 rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
          <button
            type="button"
            className="absolute right-2 top-2 rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
            onClick={() => setPreviewImageUrl(null)}
          >
            <X size={14} />
          </button>
          <img
            src={previewImageUrl}
            alt="Attachment preview"
            className="max-h-[400px] max-w-full rounded object-contain"
          />
        </div>
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
              placeholder={`Add a comment... (${getModifierKeyName()}+Enter to send)`}
              value={draft.value}
              onValueChange={draft.setValue}
              suggestions={mentionSuggestions}
              minRows={2}
              maxRows={8}
              maxLength={MAX_COMMENT_LENGTH}
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
                    <span className="text-[10px] text-[var(--color-text-muted)]">Draft saved</span>
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
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
    <div
      className="group relative flex size-14 cursor-pointer items-center justify-center overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface)] transition-colors hover:border-[var(--color-border-emphasis)]"
      onClick={() => thumbUrl && onPreview(thumbUrl)}
    >
      {thumbUrl ? (
        <img src={thumbUrl} alt={attachment.filename} className="size-full object-cover" />
      ) : (
        <Loader2 size={12} className="animate-spin text-[var(--color-text-muted)]" />
      )}
      <div className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-0.5 py-px text-center text-[7px] text-white opacity-0 transition-opacity group-hover:opacity-100">
        {attachment.filename}
      </div>
    </div>
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

function teamIdKey(teamName: string, taskId: string): string {
  return `${teamName}::${taskId}`;
}
