import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { AttachmentPreviewList } from '@renderer/components/team/attachments/AttachmentPreviewList';
import { DropZoneOverlay } from '@renderer/components/team/attachments/DropZoneOverlay';
import { ActionModeSelector } from '@renderer/components/team/messages/ActionModeSelector';
import { OpenCodeDeliveryWarning } from '@renderer/components/team/messages/OpenCodeDeliveryWarning';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Label } from '@renderer/components/ui/label';
import { MemberSelect } from '@renderer/components/ui/MemberSelect';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useAttachments } from '@renderer/hooks/useAttachments';
import { useChipDraftPersistence } from '@renderer/hooks/useChipDraftPersistence';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useTaskSuggestions } from '@renderer/hooks/useTaskSuggestions';
import { useTeamSuggestions } from '@renderer/hooks/useTeamSuggestions';
import { useStore } from '@renderer/store';
import { chipToken, serializeChipsWithText } from '@renderer/types/inlineChip';
import { buildReplyBlock } from '@renderer/utils/agentMessageFormatting';
import { removeChipTokenFromText } from '@renderer/utils/chipUtils';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import type { OpenCodeRuntimeDeliveryDebugDetails } from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
import {
  extractTaskRefsFromText,
  stripEncodedTaskReferenceMetadata,
} from '@renderer/utils/taskReferenceUtils';
import { MAX_TEXT_LENGTH } from '@shared/constants';
import { isLeadMember } from '@shared/utils/leadDetection';
import { AlertCircle, Paperclip, Send, X } from 'lucide-react';

import { MemberBadge } from '../MemberBadge';

import type { ActionMode } from '@renderer/components/team/messages/ActionModeSelector';
import type { InlineChip } from '@renderer/types/inlineChip';
import type { MentionSuggestion } from '@renderer/types/mention';
import type {
  AttachmentPayload,
  ResolvedTeamMember,
  SendMessageResult,
  TaskRef,
} from '@shared/types';

interface QuotedMessage {
  from: string;
  text: string;
}

interface SendMessageDialogProps {
  open: boolean;
  teamName: string;
  members: ResolvedTeamMember[];
  defaultRecipient?: string;
  /** Pre-filled message text (e.g. from editor selection action) */
  defaultText?: string;
  /** Pre-filled inline code chip (from editor selection action) */
  defaultChip?: InlineChip;
  quotedMessage?: QuotedMessage;
  isTeamAlive?: boolean;
  sending: boolean;
  sendError: string | null;
  sendWarning?: string | null;
  sendDebugDetails?: OpenCodeRuntimeDeliveryDebugDetails | null;
  lastResult: SendMessageResult | null;
  onSend: (
    member: string,
    text: string,
    summary?: string,
    attachments?: AttachmentPayload[],
    actionMode?: ActionMode,
    taskRefs?: TaskRef[]
  ) => void | Promise<SendMessageResult | void>;
  onClose: () => void;
}

// Sticky action mode within the current session.
// Each dialog open still re-derives the default from the current team shape.
let stickyActionMode: ActionMode = 'delegate';

export const SendMessageDialog = ({
  open,
  teamName,
  members,
  defaultRecipient,
  defaultText,
  defaultChip,
  quotedMessage,
  isTeamAlive,
  sending,
  sendError,
  sendWarning,
  sendDebugDetails,
  lastResult,
  onSend,
  onClose,
}: SendMessageDialogProps): React.JSX.Element => {
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const projectPath = useStore((s) => s.selectedTeamData?.config.projectPath ?? null);
  const [quote, setQuote] = useState<QuotedMessage | undefined>(undefined);
  const [quoteExpanded, setQuoteExpanded] = useState(false);
  const [member, setMember] = useState('');
  const textDraft = useDraftPersistence({ key: `sendMessage:${teamName}:text` });
  const chipDraft = useChipDraftPersistence(`sendMessage:${teamName}:chips`);
  const prevOpenRef = useRef(false);
  const prevResultRef = useRef<SendMessageResult | null>(null);

  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileRestrictionError, setFileRestrictionError] = useState<string | null>(null);
  const fileRestrictionTimerRef = useRef(0);
  const [actionMode, setActionModeState] = useState<ActionMode>(stickyActionMode);
  const actionModeRef = useRef<ActionMode>(stickyActionMode);
  const setActionMode = useCallback((mode: ActionMode) => {
    actionModeRef.current = mode;
    stickyActionMode = mode;
    setActionModeState(mode);
  }, []);

  const {
    attachments,
    error: attachmentError,
    canAddMore,
    addFiles,
    removeAttachment,
    clearAttachments,
    clearError: clearAttachmentError,
    handlePaste,
    handleDrop,
  } = useAttachments({ persistenceKey: `sendMessage:${teamName}:attachments` });

  const selectedMember = members.find((m) => m.name === member);
  const isLeadRecipient = selectedMember ? isLeadMember(selectedMember) : false;
  const hasTeammates = members.length > 1;
  const canDelegate = hasTeammates && isLeadRecipient;
  const shouldAutoDelegate = canDelegate;
  const supportsAttachments = isLeadRecipient && !!isTeamAlive;
  const canAttach = supportsAttachments && canAddMore;
  const attachmentRestrictionReason = !supportsAttachments
    ? !isLeadRecipient
      ? 'Files can only be sent to the team lead'
      : 'Team must be online to attach files'
    : undefined;

  // Auto-switch to delegate when lead recipient is selected, but don't
  // override user's explicit choice on dialog open.
  const prevShouldAutoDelegateRef = useRef(shouldAutoDelegate);
  useEffect(() => {
    if (!canDelegate && actionMode === 'delegate') {
      setActionMode('do');
      return;
    }

    // Skip the initial mount — honour the sticky mode
    if (prevShouldAutoDelegateRef.current === shouldAutoDelegate) return;
    prevShouldAutoDelegateRef.current = shouldAutoDelegate;

    if (shouldAutoDelegate) {
      setActionMode('delegate');
    } else {
      setActionModeState((prev) => (prev === 'delegate' ? 'do' : prev));
    }
  }, [actionMode, canDelegate, setActionMode, shouldAutoDelegate]);

  const [pendingAutoClose, setPendingAutoClose] = useState(false);
  // Reset form on open transition (avoid setState in render)
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      const leadName = members.find((m) => isLeadMember(m))?.name;
      const nextRecipient = defaultRecipient ?? leadName ?? '';
      const nextRecipientMember = members.find((candidate) => candidate.name === nextRecipient);
      const nextCanDelegate =
        members.length > 1 && Boolean(nextRecipientMember && isLeadMember(nextRecipientMember));
      setMember(nextRecipient);
      setActionMode(nextCanDelegate ? 'delegate' : 'do');
      setQuote(quotedMessage);
      setQuoteExpanded(false);
      prevResultRef.current = lastResult;
      if (defaultChip) {
        const token = chipToken(defaultChip);
        textDraft.setValue(token + '\n');
        chipDraft.setChips([defaultChip]);
      } else if (defaultText) {
        textDraft.setValue(defaultText);
      }
    }
    prevOpenRef.current = open;
  }, [
    open,
    defaultRecipient,
    defaultText,
    defaultChip,
    quotedMessage,
    lastResult,
    members,
    setActionMode,
    textDraft,
    chipDraft,
  ]);

  // Track whether auto-close is needed (avoid setState in render)
  useEffect(() => {
    if (!open) return;
    if (lastResult && lastResult !== prevResultRef.current) {
      prevResultRef.current = lastResult;
      setMember('');
      setPendingAutoClose(true);
    }
  }, [open, lastResult]);

  // Side effects (onClose mutates parent state) must run in useEffect, not render phase
  useEffect(() => {
    if (pendingAutoClose) {
      textDraft.clearDraft();
      chipDraft.clearChipDraft();
      clearAttachments();
      setPendingAutoClose(false);
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only trigger on pendingAutoClose flag
  }, [pendingAutoClose]);

  const QUOTE_COLLAPSE_THRESHOLD = 120;
  const isQuoteLong = (quote?.text.length ?? 0) > QUOTE_COLLAPSE_THRESHOLD;

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

  const { suggestions: teamMentionSuggestions } = useTeamSuggestions(teamName);
  const { suggestions: taskSuggestions } = useTaskSuggestions(teamName);

  const attachmentsBlocked = attachments.length > 0 && !supportsAttachments;

  const trimmedText = stripEncodedTaskReferenceMetadata(textDraft.value).trim();
  const serialized = serializeChipsWithText(trimmedText, chipDraft.chips);
  const finalText = quote ? buildReplyBlock(quote.from, quote.text, serialized) : serialized;
  const remaining = MAX_TEXT_LENGTH - finalText.length;

  const canSend =
    member.trim().length > 0 &&
    finalText.length > 0 &&
    finalText.length <= MAX_TEXT_LENGTH &&
    !sending &&
    !attachmentsBlocked;

  const handleChipRemove = (chipId: string): void => {
    const chip = chipDraft.chips.find((c) => c.id === chipId);
    if (chip) {
      textDraft.setValue(removeChipTokenFromText(textDraft.value, chip));
    }
    chipDraft.setChips(chipDraft.chips.filter((c) => c.id !== chipId));
  };

  const handleSubmit = (): void => {
    if (!canSend) return;
    const taskRefs = extractTaskRefsFromText(textDraft.value, taskSuggestions);
    void Promise.resolve(
      onSend(
        member.trim(),
        finalText,
        trimmedText,
        attachments.length > 0 ? attachments : undefined,
        actionMode,
        taskRefs
      )
    )
      .then((result) => {
        if (
          result?.runtimeDelivery?.attempted === true &&
          result.runtimeDelivery.delivered === false
        ) {
          return;
        }
        textDraft.clearDraft();
        chipDraft.clearChipDraft();
        clearAttachments();
      })
      .catch(() => {
        // The store owns the visible send error; keep the draft intact for retry.
      });
  };

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) {
      onClose();
    }
  };

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const input = e.target;
      if (input.files?.length) {
        void addFiles(input.files);
      }
      input.value = '';
    },
    [addFiles]
  );

  const showFileRestrictionError = useCallback(() => {
    setFileRestrictionError(
      attachmentRestrictionReason ?? 'Files can only be sent to the team lead'
    );
    window.clearTimeout(fileRestrictionTimerRef.current);
    fileRestrictionTimerRef.current = window.setTimeout(() => {
      setFileRestrictionError(null);
    }, 4000);
  }, [attachmentRestrictionReason]);

  // Cleanup restriction error timer on unmount
  useEffect(() => {
    const ref = fileRestrictionTimerRef;
    return () => window.clearTimeout(ref.current);
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDropWrapper = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragOver(false);
      if (!supportsAttachments) {
        const files = e.dataTransfer?.files;
        if (files?.length) {
          showFileRestrictionError();
        }
        return;
      }
      handleDrop(e);
    },
    [supportsAttachments, handleDrop, showFileRestrictionError]
  );

  const handlePasteWrapper = useCallback(
    (e: React.ClipboardEvent) => {
      if (!supportsAttachments) {
        const hasFiles = Array.from(e.clipboardData.items).some((item) => item.kind === 'file');
        if (hasFiles) {
          e.preventDefault();
          showFileRestrictionError();
        }
        return;
      }
      handlePaste(e);
    },
    [supportsAttachments, handlePaste, showFileRestrictionError]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="min-w-0 max-w-3xl"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDropWrapper}
        onPaste={handlePasteWrapper}
      >
        <DropZoneOverlay
          active={isDragOver}
          rejected={!supportsAttachments}
          rejectionReason={attachmentRestrictionReason}
        />

        <DialogHeader>
          <DialogTitle>Send Message</DialogTitle>
          <DialogDescription>Send a direct message to a team member.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="smd-recipient">Recipient</Label>
            <MemberSelect
              members={members}
              value={member || null}
              onChange={(v) => setMember(v ?? '')}
              placeholder="Select member..."
              size="sm"
            />
          </div>

          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="smd-message">Message</Label>
              {isLeadRecipient ? (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="*/*"
                    multiple
                    className="hidden"
                    onChange={handleFileInputChange}
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className={`inline-flex items-center gap-1 rounded p-1 transition-colors ${
                          canAttach
                            ? 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
                            : 'text-[var(--color-text-muted)] opacity-40'
                        }`}
                        disabled={!canAttach}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <Paperclip size={14} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {!isTeamAlive
                        ? 'Team must be online to attach files'
                        : !canAddMore
                          ? 'Maximum attachments reached'
                          : 'Attach files (paste or drag & drop)'}
                    </TooltipContent>
                  </Tooltip>
                </>
              ) : null}
            </div>

            <AttachmentPreviewList
              attachments={attachments}
              onRemove={removeAttachment}
              error={attachmentError ?? fileRestrictionError}
              onDismissError={clearAttachmentError}
              disabled={attachmentsBlocked}
              disabledHint="File attachments are only supported when sending to the team lead while the team is online. Remove attachments or switch recipient."
            />

            <div className={quote ? 'flex flex-col' : 'contents'}>
              {quote ? (
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
                        onClick={() => setQuote(undefined)}
                      >
                        <X size={12} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left">Remove quote</TooltipContent>
                  </Tooltip>

                  <div className="mb-1 flex items-center gap-1.5">
                    <span className="text-[10px] text-blue-600/70 dark:text-blue-300/60">
                      Replying to
                    </span>
                    <MemberBadge name={quote.from} color={colorMap.get(quote.from)} size="sm" />
                  </div>
                  <div
                    className={`pr-5 opacity-60 dark:opacity-50 ${quoteExpanded ? '' : 'max-h-[3.75rem] overflow-hidden'}`}
                  >
                    <MarkdownViewer
                      content={quote.text}
                      bare
                      maxHeight={quoteExpanded ? 'max-h-48' : 'max-h-[3.75rem]'}
                    />
                  </div>
                  {isQuoteLong ? (
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
              <MentionableTextarea
                id="smd-message"
                className={quote ? 'rounded-t-none' : undefined}
                placeholder="Write your message... (Enter to send)"
                value={textDraft.value}
                onValueChange={textDraft.setValue}
                suggestions={mentionSuggestions}
                teamSuggestions={teamMentionSuggestions}
                taskSuggestions={taskSuggestions}
                chips={chipDraft.chips}
                onChipRemove={handleChipRemove}
                projectPath={projectPath}
                onFileChipInsert={(chip) => chipDraft.setChips([...chipDraft.chips, chip])}
                onModEnter={handleSubmit}
                minRows={4}
                maxRows={12}
                maxLength={MAX_TEXT_LENGTH}
                disabled={sending}
                cornerActionLeft={
                  <ActionModeSelector
                    value={actionMode}
                    onChange={setActionMode}
                    showDelegate={canDelegate}
                  />
                }
                cornerAction={
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!canSend}
                    onClick={handleSubmit}
                  >
                    <Send size={12} />
                    {sending ? 'Sending...' : 'Send'}
                  </button>
                }
                footerRight={
                  <div className="flex items-center gap-2">
                    {sendError ? (
                      <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400">
                        <AlertCircle size={10} className="shrink-0" />
                        {sendError}
                      </span>
                    ) : sendWarning ? (
                      <OpenCodeDeliveryWarning
                        warning={sendWarning}
                        debugDetails={sendDebugDetails}
                      />
                    ) : null}
                    {remaining < 200 ? (
                      <span
                        className={`text-[10px] ${remaining < 100 ? 'text-yellow-400' : 'text-[var(--color-text-muted)]'}`}
                      >
                        {remaining} chars left
                      </span>
                    ) : null}
                    {textDraft.isSaved ? (
                      <span className="text-[10px] text-[var(--color-text-muted)]">Saved</span>
                    ) : null}
                  </div>
                }
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
