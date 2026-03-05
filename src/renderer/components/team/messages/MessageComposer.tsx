import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AttachmentPreviewList } from '@renderer/components/team/attachments/AttachmentPreviewList';
import { DropZoneOverlay } from '@renderer/components/team/attachments/DropZoneOverlay';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useAttachments } from '@renderer/hooks/useAttachments';
import { useChipDraftPersistence } from '@renderer/hooks/useChipDraftPersistence';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { serializeChipsWithText } from '@renderer/types/inlineChip';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { getModifierKeyName } from '@renderer/utils/keyboardUtils';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { AlertCircle, Check, ChevronDown, ImagePlus, Send } from 'lucide-react';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { AttachmentPayload, ResolvedTeamMember } from '@shared/types';

interface MessageComposerProps {
  teamName: string;
  members: ResolvedTeamMember[];
  isTeamAlive?: boolean;
  sending: boolean;
  sendError: string | null;
  onSend: (
    recipient: string,
    text: string,
    summary?: string,
    attachments?: AttachmentPayload[]
  ) => void;
}

const MAX_MESSAGE_LENGTH = 4000;

export const MessageComposer = ({
  teamName,
  members,
  isTeamAlive,
  sending,
  sendError,
  onSend,
}: MessageComposerProps): React.JSX.Element => {
  const [recipient, setRecipient] = useState<string>(() => {
    const lead = members.find((m) => m.role === 'lead' || m.name === 'team-lead');
    return lead?.name ?? members[0]?.name ?? '';
  });
  const [recipientOpen, setRecipientOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Members load async with team data; keep recipient stable if valid, otherwise default to lead/first.
  useEffect(() => {
    if (recipient && members.some((m) => m.name === recipient)) {
      return;
    }
    const lead = members.find((m) => m.role === 'lead' || m.name === 'team-lead');
    const next = lead?.name ?? members[0]?.name ?? '';
    if (next && next !== recipient) {
      setRecipient(next);
    }
  }, [members, recipient]);

  const projectPath = useStore((s) => s.selectedTeamData?.config.projectPath ?? null);
  const draft = useDraftPersistence({ key: `compose:${teamName}` });
  const chipDraft = useChipDraftPersistence(`compose:${teamName}:chips`);
  const {
    attachments,
    error: attachmentError,
    canAddMore,
    addFiles,
    removeAttachment,
    clearAttachments,
    handlePaste,
    handleDrop,
  } = useAttachments({ persistenceKey: `compose:${teamName}:attachments` });

  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);

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
  const canSend =
    recipient.length > 0 && trimmed.length > 0 && trimmed.length <= MAX_MESSAGE_LENGTH && !sending;

  const selectedMember = members.find((m) => m.name === recipient);
  const selectedResolvedColor = selectedMember ? colorMap.get(selectedMember.name) : undefined;
  const selectedColorSet = selectedResolvedColor ? getTeamColorSet(selectedResolvedColor) : null;
  const isLeadRecipient = selectedMember?.role === 'lead' || selectedMember?.name === 'team-lead';
  const canAttach = isLeadRecipient && isTeamAlive && canAddMore;

  // Track whether we initiated a send — clear draft only on confirmed success
  const pendingSendRef = useRef(false);

  const handleSend = useCallback(() => {
    if (!canSend) return;
    pendingSendRef.current = true;
    const serialized = serializeChipsWithText(trimmed, chipDraft.chips);
    onSend(recipient, serialized, serialized, attachments.length > 0 ? attachments : undefined);
  }, [canSend, recipient, trimmed, onSend, attachments, chipDraft.chips]);

  // Clear draft only after send completes successfully (sending: true → false, no error)
  useEffect(() => {
    if (!sending && pendingSendRef.current) {
      pendingSendRef.current = false;
      if (!sendError) {
        draft.clearDraft();
        chipDraft.clearChipDraft();
        clearAttachments();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clearChipDraft is stable (useCallback with [])
  }, [sending, sendError, draft, clearAttachments, chipDraft.clearChipDraft]);

  const handleKeyDownCapture = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        handleSend();
      }
    },
    [handleSend]
  );

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
      dragCounterRef.current = 0;
      setIsDragOver(false);
      if (canAttach) handleDrop(e);
    },
    [canAttach, handleDrop]
  );

  const handlePasteWrapper = useCallback(
    (e: React.ClipboardEvent) => {
      if (canAttach) handlePaste(e);
    },
    [canAttach, handlePaste]
  );

  const remaining = MAX_MESSAGE_LENGTH - trimmed.length;

  return (
    <div
      className="relative mb-3 p-3"
      role="group"
      onKeyDownCapture={handleKeyDownCapture}
      onDragEnter={canAttach ? handleDragEnter : undefined}
      onDragLeave={canAttach ? handleDragLeave : undefined}
      onDragOver={canAttach ? handleDragOver : undefined}
      onDrop={canAttach ? handleDropWrapper : undefined}
      onPaste={canAttach ? handlePasteWrapper : undefined}
    >
      <DropZoneOverlay active={isDragOver && !!canAttach} />

      <div className="mb-2 flex items-center gap-2">
        <Popover open={recipientOpen} onOpenChange={setRecipientOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-2.5 py-1 text-xs transition-colors hover:border-[var(--color-border-emphasis)] hover:bg-[var(--color-surface-raised)]"
            >
              {selectedColorSet ? (
                <span
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: selectedColorSet.border }}
                />
              ) : (
                <span className="inline-block size-2 shrink-0 rounded-full bg-[var(--color-text-muted)]" />
              )}
              <span
                className="max-w-[120px] truncate font-medium"
                style={selectedColorSet ? { color: selectedColorSet.text } : undefined}
              >
                {recipient || 'Select...'}
              </span>
              <ChevronDown size={12} className="shrink-0 text-[var(--color-text-muted)]" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-56 p-1.5">
            <div className="max-h-48 space-y-0.5 overflow-y-auto">
              {members.map((m) => {
                const resolvedColor = colorMap.get(m.name);
                const colorSet = resolvedColor ? getTeamColorSet(resolvedColor) : null;
                const role = formatAgentRole(m.role) ?? formatAgentRole(m.agentType);
                const isSelected = m.name === recipient;
                return (
                  <button
                    key={m.name}
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-raised)]',
                      isSelected && 'bg-[var(--color-surface-raised)]'
                    )}
                    onClick={() => {
                      setRecipient(m.name);
                      setRecipientOpen(false);
                    }}
                  >
                    {colorSet ? (
                      <span
                        className="inline-block size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: colorSet.border }}
                      />
                    ) : (
                      <span className="inline-block size-2 shrink-0 rounded-full bg-[var(--color-text-muted)]" />
                    )}
                    <span
                      className="min-w-0 truncate font-medium"
                      style={colorSet ? { color: colorSet.text } : undefined}
                    >
                      {m.name}
                    </span>
                    {role ? (
                      <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                        {role}
                      </span>
                    ) : null}
                    {isSelected ? (
                      <Check size={12} className="ml-auto shrink-0 text-blue-400" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>

        {isLeadRecipient ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={handleFileInputChange}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'inline-flex items-center gap-1 rounded p-1 transition-colors',
                    canAttach
                      ? 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
                      : 'text-[var(--color-text-muted)] opacity-40'
                  )}
                  disabled={!canAttach}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImagePlus size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {!isTeamAlive
                  ? 'Team must be online to attach images'
                  : !canAddMore
                    ? 'Maximum attachments reached'
                    : 'Attach images (paste or drag & drop)'}
              </TooltipContent>
            </Tooltip>
          </>
        ) : null}

        {!isTeamAlive ? (
          <span className="ml-auto text-[10px] text-amber-400">Team offline</span>
        ) : null}
      </div>

      <AttachmentPreviewList
        attachments={attachments}
        onRemove={removeAttachment}
        error={attachmentError}
      />

      <MentionableTextarea
        id={`compose-${teamName}`}
        placeholder={`Write a message... (${getModifierKeyName()}+Enter to send)`}
        value={draft.value}
        onValueChange={draft.setValue}
        suggestions={mentionSuggestions}
        chips={chipDraft.chips}
        onChipRemove={chipDraft.removeChip}
        projectPath={projectPath}
        onFileChipInsert={chipDraft.addChip}
        minRows={2}
        maxRows={6}
        maxLength={MAX_MESSAGE_LENGTH}
        disabled={sending}
        cornerAction={
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canSend}
            onClick={handleSend}
          >
            <Send size={12} />
            Send
          </button>
        }
        footerRight={
          <div className="flex items-center gap-2">
            {sendError ? (
              <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400">
                <AlertCircle size={10} className="shrink-0" />
                {sendError}
              </span>
            ) : null}
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
  );
};
