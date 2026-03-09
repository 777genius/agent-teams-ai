import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AttachmentPreviewList } from '@renderer/components/team/attachments/AttachmentPreviewList';
import { DropZoneOverlay } from '@renderer/components/team/attachments/DropZoneOverlay';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useComposerDraft } from '@renderer/hooks/useComposerDraft';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { serializeChipsWithText } from '@renderer/types/inlineChip';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { MAX_TEXT_LENGTH } from '@shared/constants';
import { AlertCircle, Check, ChevronDown, ImagePlus, Mic, Search, Send } from 'lucide-react';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { AttachmentPayload, LeadContextUsage, ResolvedTeamMember } from '@shared/types';

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

/** Circular progress indicator for lead context usage. */
const _ContextRing = ({ ctx }: { ctx: LeadContextUsage }): React.JSX.Element => {
  const size = 26;
  const stroke = 2.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.min(ctx.percent, 100);
  const offset = circumference - (pct / 100) * circumference;
  const color = pct > 90 ? '#ef4444' : pct > 70 ? '#f59e0b' : '#3b82f6';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="relative flex shrink-0 cursor-default items-center justify-center"
          style={{ width: size, height: size }}
        >
          <svg width={size} height={size} className="-rotate-90">
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="var(--color-border)"
              strokeWidth={stroke}
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={color}
              strokeWidth={stroke}
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              strokeLinecap="round"
              className="transition-all duration-500"
            />
          </svg>
          <span className="absolute text-[8px] font-medium" style={{ color }}>
            {Math.round(pct)}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">
        Context: {Math.round(pct)}% ({(ctx.currentTokens / 1000).toFixed(1)}k /{' '}
        {(ctx.contextWindow / 1000).toFixed(0)}k tokens)
      </TooltipContent>
    </Tooltip>
  );
};

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
  const [recipientSearch, setRecipientSearch] = useState('');
  const recipientSearchRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageRestrictionError, setImageRestrictionError] = useState<string | null>(null);
  const imageRestrictionTimerRef = useRef(0);

  // Members load async with team data; keep recipient stable if valid, otherwise default to lead/first.
  useEffect(() => {
    if (recipient && members.some((m) => m.name === recipient)) {
      return;
    }
    const lead = members.find((m) => m.role === 'lead' || m.name === 'team-lead');
    const next = lead?.name ?? members[0]?.name ?? '';
    if (next && next !== recipient) {
      queueMicrotask(() => setRecipient(next));
    }
  }, [members, recipient]);

  const projectPath = useStore((s) => s.selectedTeamData?.config.projectPath ?? null);
  const isProvisioning = useStore((s) =>
    Object.values(s.provisioningRuns).some(
      (run) =>
        run.teamName === teamName &&
        !['ready', 'disconnected', 'failed', 'cancelled'].includes(run.state)
    )
  );
  const draft = useComposerDraft(teamName);

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

  const trimmed = draft.text.trim();

  const selectedMember = members.find((m) => m.name === recipient);
  const selectedResolvedColor = selectedMember ? colorMap.get(selectedMember.name) : undefined;
  const isLeadRecipient = selectedMember?.role === 'lead' || selectedMember?.name === 'team-lead';
  // NOTE: lead context ring disabled — usage formula is inaccurate
  // const isLeadAgentRecipient = selectedMember?.agentType === 'team-lead';
  // const leadContext = useStore((s) =>
  //   isLeadAgentRecipient ? s.leadContextByTeam[teamName] : undefined
  // );
  const supportsAttachments = isLeadRecipient;
  const canAttach = supportsAttachments && draft.canAddMore;
  const attachmentsBlocked = draft.attachments.length > 0 && !supportsAttachments;
  const canSend =
    recipient.length > 0 &&
    trimmed.length > 0 &&
    trimmed.length <= MAX_TEXT_LENGTH &&
    !sending &&
    !attachmentsBlocked;

  // Track whether we initiated a send — clear draft only on confirmed success
  const pendingSendRef = useRef(false);

  const handleSend = useCallback(() => {
    if (!canSend) return;
    pendingSendRef.current = true;
    const serialized = serializeChipsWithText(trimmed, draft.chips);
    // Summary should stay compact (no expanded chip markdown)
    onSend(
      recipient,
      serialized,
      trimmed,
      draft.attachments.length > 0 ? draft.attachments : undefined
    );
  }, [canSend, recipient, trimmed, onSend, draft.attachments, draft.chips]);

  // Clear draft only after send completes successfully (sending: true → false, no error)
  useEffect(() => {
    if (!sending && pendingSendRef.current) {
      pendingSendRef.current = false;
      if (!sendError) {
        draft.clearDraft();
      }
    }
  }, [sending, sendError, draft]);

  const { addFiles: draftAddFiles } = draft;
  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const input = e.target;
      if (input.files?.length) {
        void draftAddFiles(input.files);
      }
      input.value = '';
    },
    [draftAddFiles]
  );

  const showImageRestrictionError = useCallback(() => {
    setImageRestrictionError('Images can only be sent to the team lead');
    window.clearTimeout(imageRestrictionTimerRef.current);
    imageRestrictionTimerRef.current = window.setTimeout(() => {
      setImageRestrictionError(null);
    }, 4000);
  }, []);

  // Cleanup restriction error timer on unmount
  useEffect(() => {
    const ref = imageRestrictionTimerRef;
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

  const { handleDrop: draftHandleDrop } = draft;
  const handleDropWrapper = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragOver(false);
      if (!isLeadRecipient) {
        const files = e.dataTransfer?.files;
        if (files?.length) {
          const hasImages = Array.from(files).some((f) => f.type.startsWith('image/'));
          if (hasImages) {
            showImageRestrictionError();
          }
        }
        return;
      }
      if (canAttach) draftHandleDrop(e);
    },
    [isLeadRecipient, canAttach, draftHandleDrop, showImageRestrictionError]
  );

  const { handlePaste: draftHandlePaste } = draft;
  const handlePasteWrapper = useCallback(
    (e: React.ClipboardEvent) => {
      if (!isLeadRecipient) {
        const hasImages = Array.from(e.clipboardData.items).some((item) =>
          item.type.startsWith('image/')
        );
        if (hasImages) {
          e.preventDefault();
          showImageRestrictionError();
        }
        return;
      }
      if (canAttach) draftHandlePaste(e);
    },
    [isLeadRecipient, canAttach, draftHandlePaste, showImageRestrictionError]
  );

  const remaining = MAX_TEXT_LENGTH - trimmed.length;

  return (
    <div
      className="relative mb-3 p-3"
      role="group"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDropWrapper}
      onPaste={handlePasteWrapper}
    >
      <DropZoneOverlay active={isDragOver} rejected={!isLeadRecipient} />

      <div className="mb-1 flex items-center gap-2">
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
                    'inline-flex shrink-0 items-center gap-1 rounded p-1 transition-colors',
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
                  : !draft.canAddMore
                    ? 'Maximum attachments reached'
                    : 'Attach images (paste or drag & drop)'}
              </TooltipContent>
            </Tooltip>
            <div className="min-w-0 flex-1">
              <AttachmentPreviewList
                attachments={draft.attachments}
                onRemove={draft.removeAttachment}
                error={draft.attachmentError ?? imageRestrictionError}
                onDismissError={draft.clearAttachmentError}
                disabled={attachmentsBlocked}
                disabledHint="Image attachments are only supported when sending to the team lead while the team is online. Remove attachments or switch recipient."
              />
            </div>
          </>
        ) : (
          <AttachmentPreviewList
            attachments={draft.attachments}
            onRemove={draft.removeAttachment}
            error={draft.attachmentError ?? imageRestrictionError}
            onDismissError={draft.clearAttachmentError}
            disabled={attachmentsBlocked}
            disabledHint="Image attachments are only supported when sending to the team lead while the team is online. Remove attachments or switch recipient."
          />
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {isProvisioning ? (
            <span className="text-[10px]" style={{ color: 'var(--warning-text)' }}>
              Launching... inbox delivery only
            </span>
          ) : !isTeamAlive ? (
            <span className="text-[10px]" style={{ color: 'var(--warning-text)' }}>
              Team offline
            </span>
          ) : null}

          <Popover open={recipientOpen} onOpenChange={setRecipientOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-2.5 py-1 text-xs transition-colors hover:border-[var(--color-border-emphasis)] hover:bg-[var(--color-surface-raised)]"
              >
                {recipient ? (
                  <MemberBadge
                    name={recipient}
                    color={selectedResolvedColor}
                    size="sm"
                    hideAvatar={recipient === 'user'}
                  />
                ) : (
                  <span className="text-[var(--color-text-muted)]">Select...</span>
                )}
                <ChevronDown size={12} className="shrink-0 text-[var(--color-text-muted)]" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-56 p-1.5"
              onOpenAutoFocus={(e) => {
                e.preventDefault();
                setRecipientSearch('');
                setTimeout(() => recipientSearchRef.current?.focus(), 0);
              }}
            >
              {members.length > 5 && (
                <div className="relative mb-1">
                  <Search
                    size={12}
                    className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                  />
                  <input
                    ref={recipientSearchRef}
                    type="text"
                    className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 pl-6 pr-2 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-border-emphasis)] focus:outline-none"
                    placeholder="Search..."
                    value={recipientSearch}
                    onChange={(e) => setRecipientSearch(e.target.value)}
                  />
                </div>
              )}
              <div className="max-h-48 space-y-0.5 overflow-y-auto">
                {/* eslint-disable-next-line sonarjs/function-return-type -- IIFE rendering mixed elements/null */}
                {(() => {
                  const query = recipientSearch.toLowerCase().trim();
                  const filtered = query
                    ? members.filter((m) => m.name.toLowerCase().includes(query))
                    : members;
                  if (filtered.length === 0) {
                    return (
                      <div className="px-2 py-3 text-center text-xs text-[var(--color-text-muted)]">
                        No results
                      </div>
                    );
                  }
                  const sorted = [...filtered].sort((a, b) => {
                    const aIsLead = a.role === 'lead' || a.name === 'team-lead' ? 1 : 0;
                    const bIsLead = b.role === 'lead' || b.name === 'team-lead' ? 1 : 0;
                    return bIsLead - aIsLead;
                  });
                  return sorted.map((m) => {
                    const resolvedColor = colorMap.get(m.name);
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
                          setRecipientSearch('');
                        }}
                      >
                        <MemberBadge
                          name={m.name}
                          color={resolvedColor}
                          size="sm"
                          hideAvatar={m.name === 'user'}
                        />
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
                  });
                })()}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <MentionableTextarea
        id={`compose-${teamName}`}
        placeholder={
          isProvisioning
            ? 'Team is launching... message will be queued for inbox delivery.'
            : 'Write a message... (Enter to send, Shift+Enter for new line)'
        }
        value={draft.text}
        onValueChange={draft.setText}
        suggestions={mentionSuggestions}
        chips={draft.chips}
        onChipRemove={draft.removeChip}
        projectPath={projectPath}
        onFileChipInsert={draft.addChip}
        onModEnter={handleSend}
        minRows={2}
        maxRows={6}
        maxLength={MAX_TEXT_LENGTH}
        disabled={sending}
        cornerAction={
          <div className="flex items-center gap-2">
            {/* NOTE: ContextRing disabled — usage formula is inaccurate */}
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
              disabled={!canSend}
              onClick={handleSend}
            >
              <Send size={12} />
              Send
            </button>
          </div>
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
