import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AttachmentPreviewList } from '@renderer/components/team/attachments/AttachmentPreviewList';
import { DropZoneOverlay } from '@renderer/components/team/attachments/DropZoneOverlay';
import { ActionModeSelector } from '@renderer/components/team/messages/ActionModeSelector';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useComposerDraft } from '@renderer/hooks/useComposerDraft';
import { useTeamSuggestions } from '@renderer/hooks/useTeamSuggestions';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { serializeChipsWithText } from '@renderer/types/inlineChip';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { nameColorSet } from '@renderer/utils/projectColor';
import { MAX_TEXT_LENGTH } from '@shared/constants';
import { AlertCircle, Check, ChevronDown, ImagePlus, Mic, Search, Send } from 'lucide-react';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { ActionMode } from '@renderer/components/team/messages/ActionModeSelector';
import type { AttachmentPayload, ResolvedTeamMember, SendMessageResult } from '@shared/types';

interface MessageComposerProps {
  teamName: string;
  members: ResolvedTeamMember[];
  isTeamAlive?: boolean;
  sending: boolean;
  sendError: string | null;
  lastResult?: SendMessageResult | null;
  onSend: (
    recipient: string,
    text: string,
    summary?: string,
    attachments?: AttachmentPayload[],
    actionMode?: ActionMode
  ) => void;
  onCrossTeamSend?: (
    toTeam: string,
    text: string,
    summary?: string,
    actionMode?: ActionMode
  ) => void;
}

export const MessageComposer = ({
  teamName,
  members,
  isTeamAlive,
  sending,
  sendError,
  lastResult,
  onSend,
  onCrossTeamSend,
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

  // Cross-team state
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [teamSelectorOpen, setTeamSelectorOpen] = useState(false);
  const allCrossTeamTargets = useStore((s) => s.crossTeamTargets);
  const fetchCrossTeamTargets = useStore((s) => s.fetchCrossTeamTargets);

  useEffect(() => {
    void fetchCrossTeamTargets();
  }, [fetchCrossTeamTargets]);

  // Always filter out current team on the UI side (store is global, shared across tabs)
  const crossTeamTargets = useMemo(
    () => allCrossTeamTargets.filter((t) => t.teamName !== teamName),
    [allCrossTeamTargets, teamName]
  );

  const isCrossTeam = selectedTeam !== null;
  const selectedTarget = crossTeamTargets.find((t) => t.teamName === selectedTeam);
  const targetDisplayName = selectedTarget?.displayName ?? selectedTeam;
  const crossTeamHintText = isCrossTeam
    ? 'Tip: Cross-team messages go to the target team lead. If you want the reply to come back to your team lead instead of you, say that explicitly in the message.'
    : undefined;

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
  const currentTeamColor = useStore((s) => {
    const configColor = s.selectedTeamData?.config.color;
    if (configColor) return getTeamColorSet(configColor).border;
    const displayName = s.selectedTeamData?.config.name ?? teamName;
    return nameColorSet(displayName).border;
  });
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

  const { suggestions: teamMentionSuggestions } = useTeamSuggestions(teamName);

  const trimmed = draft.text.trim();

  const selectedMember = members.find((m) => m.name === recipient);
  const selectedResolvedColor = selectedMember ? colorMap.get(selectedMember.name) : undefined;
  const isLeadRecipient = selectedMember?.role === 'lead' || selectedMember?.name === 'team-lead';
  const hasTeammates = members.length > 1;
  const canDelegate = hasTeammates && (isCrossTeam || isLeadRecipient);
  const shouldAutoDelegate = isLeadRecipient && canDelegate;

  const { actionMode, setActionMode, isLoaded: draftLoaded } = draft;

  // Auto-select delegate when lead recipient is chosen by the user.
  // Wait until draft is restored from IndexedDB (draftLoaded) before running,
  // so we don't overwrite the persisted actionMode during initialization.
  // After draft loads, only auto-switch on subsequent recipient changes.
  const isInitializedRef = useRef(false);
  const prevShouldAutoDelegateRef = useRef(shouldAutoDelegate);
  useEffect(() => {
    if (!draftLoaded) return;

    if (!canDelegate && actionMode === 'delegate') {
      setActionMode('do');
      return;
    }

    // On first run after load, just record the baseline — don't overwrite
    if (!isInitializedRef.current) {
      isInitializedRef.current = true;
      prevShouldAutoDelegateRef.current = shouldAutoDelegate;
      return;
    }

    // Only react when delegate availability actually changes
    if (shouldAutoDelegate === prevShouldAutoDelegateRef.current) return;
    prevShouldAutoDelegateRef.current = shouldAutoDelegate;

    if (shouldAutoDelegate) {
      setActionMode('delegate');
    } else if (actionMode === 'delegate') {
      setActionMode('do');
    }
  }, [actionMode, canDelegate, draftLoaded, setActionMode, shouldAutoDelegate]);
  // NOTE: lead context ring disabled — usage formula is inaccurate
  // const isLeadAgentRecipient = selectedMember?.agentType === 'team-lead';
  // const leadContext = useStore((s) =>
  //   isLeadAgentRecipient ? s.leadContextByTeam[teamName] : undefined
  // );
  const supportsAttachments = isLeadRecipient && !isCrossTeam;
  const canAttach = supportsAttachments && draft.canAddMore;
  const attachmentsBlocked = draft.attachments.length > 0 && !supportsAttachments;
  const canSend =
    recipient.length > 0 &&
    trimmed.length > 0 &&
    trimmed.length <= MAX_TEXT_LENGTH &&
    !sending &&
    !isProvisioning &&
    !attachmentsBlocked &&
    (!isCrossTeam || onCrossTeamSend !== undefined);

  // Track whether we initiated a send — clear draft only on confirmed success
  const pendingSendRef = useRef(false);

  const handleSend = useCallback(() => {
    if (!canSend) return;
    pendingSendRef.current = true;
    const serialized = serializeChipsWithText(trimmed, draft.chips);
    if (isCrossTeam && selectedTeam && onCrossTeamSend) {
      onCrossTeamSend(selectedTeam, serialized, trimmed, actionMode);
    } else {
      // Summary should stay compact (no expanded chip markdown)
      onSend(
        recipient,
        serialized,
        trimmed,
        draft.attachments.length > 0 ? draft.attachments : undefined,
        actionMode
      );
    }
  }, [
    actionMode,
    canSend,
    recipient,
    trimmed,
    onSend,
    onCrossTeamSend,
    isCrossTeam,
    selectedTeam,
    draft.attachments,
    draft.chips,
  ]);

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
          {!isTeamAlive && !isProvisioning && (
            <span className="text-[10px]" style={{ color: 'var(--warning-text)' }}>
              Team offline
            </span>
          )}

          {/* Combined team + member selector */}
          {crossTeamTargets.length > 0 ? (
            <div
              className={cn(
                'inline-flex items-center rounded-full border text-xs transition-colors',
                isCrossTeam ? 'border-[var(--cross-team-border)]' : 'border-[var(--color-border)]'
              )}
            >
              <Popover open={teamSelectorOpen} onOpenChange={setTeamSelectorOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-l-full border-r border-r-[var(--color-border)] px-2.5 py-1 text-xs transition-colors',
                      isCrossTeam
                        ? 'hover:bg-[var(--cross-team-bg)]/80 bg-[var(--cross-team-bg)] text-purple-400'
                        : 'hover:bg-[var(--color-surface-raised)]'
                    )}
                  >
                    {isCrossTeam ? (
                      <>
                        <span
                          className="inline-block size-2 shrink-0 rounded-full"
                          style={{
                            backgroundColor: selectedTarget
                              ? selectedTarget.color
                                ? getTeamColorSet(selectedTarget.color).border
                                : nameColorSet(selectedTarget.displayName).border
                              : undefined,
                          }}
                        />
                        <span className="max-w-[100px] truncate">{targetDisplayName}</span>
                      </>
                    ) : (
                      <>
                        {currentTeamColor ? (
                          <span
                            className="inline-block size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: currentTeamColor }}
                          />
                        ) : null}
                        <span className="text-[var(--color-text-secondary)]">This team</span>
                      </>
                    )}
                    <ChevronDown size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-56 p-1.5">
                  <div className="max-h-48 space-y-0.5 overflow-y-auto">
                    {/* Current team option */}
                    <button
                      type="button"
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-raised)]',
                        !isCrossTeam && 'bg-[var(--color-surface-raised)]'
                      )}
                      onClick={() => {
                        setSelectedTeam(null);
                        setTeamSelectorOpen(false);
                      }}
                    >
                      {currentTeamColor ? (
                        <span
                          className="inline-block size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: currentTeamColor }}
                        />
                      ) : null}
                      <span className="truncate text-[var(--color-text)]">This team</span>
                      <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                        current
                      </span>
                      {!isCrossTeam ? (
                        <Check size={12} className="ml-auto shrink-0 text-blue-400" />
                      ) : null}
                    </button>

                    {/* Separator */}
                    <div className="my-1 h-px bg-[var(--color-border)]" />

                    {/* Other teams */}
                    {crossTeamTargets.map((target) => {
                      const isSelected = selectedTeam === target.teamName;
                      return (
                        <button
                          key={target.teamName}
                          type="button"
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-raised)]',
                            isSelected && 'bg-[var(--cross-team-bg)]'
                          )}
                          onClick={() => {
                            setSelectedTeam(target.teamName);
                            setRecipient('team-lead');
                            setTeamSelectorOpen(false);
                          }}
                        >
                          <span
                            className="inline-block size-2 shrink-0 rounded-full"
                            style={{
                              backgroundColor: target.color
                                ? getTeamColorSet(target.color).border
                                : nameColorSet(target.displayName).border,
                            }}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[var(--color-text)]">
                              {target.displayName}
                            </div>
                            {target.description ? (
                              <div className="truncate text-[10px] text-[var(--color-text-muted)]">
                                {target.description}
                              </div>
                            ) : null}
                          </div>
                          {isSelected ? (
                            <Check size={12} className="ml-auto shrink-0 text-purple-400" />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>

              <Popover
                open={isCrossTeam ? false : recipientOpen}
                onOpenChange={isCrossTeam ? undefined : setRecipientOpen}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-r-full px-2.5 py-1 text-xs transition-colors',
                      isCrossTeam
                        ? 'cursor-default bg-[var(--cross-team-bg)] opacity-60'
                        : 'hover:bg-[var(--color-surface-raised)]'
                    )}
                    disabled={isCrossTeam}
                  >
                    {recipient ? (
                      <MemberBadge
                        name={recipient}
                        color={selectedResolvedColor}
                        size="sm"
                        hideAvatar={recipient === 'user'}
                        disableHoverCard
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
                              disableHoverCard
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
          ) : (
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
                      disableHoverCard
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
                            disableHoverCard
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
          )}
        </div>
      </div>

      <MentionableTextarea
        id={`compose-${teamName}`}
        placeholder={
          isProvisioning
            ? 'Team is launching... message will be queued for inbox delivery.'
            : isCrossTeam
              ? `Cross-team message to ${targetDisplayName ?? 'team'}...`
              : 'Write a message... (Enter to send, Shift+Enter for new line)'
        }
        value={draft.text}
        onValueChange={draft.setText}
        suggestions={mentionSuggestions}
        teamSuggestions={teamMentionSuggestions}
        chips={draft.chips}
        onChipRemove={draft.removeChip}
        projectPath={projectPath}
        onFileChipInsert={draft.addChip}
        onModEnter={handleSend}
        minRows={2}
        maxRows={6}
        maxLength={MAX_TEXT_LENGTH}
        disabled={sending}
        hintText={crossTeamHintText}
        cornerActionLeft={
          <ActionModeSelector
            value={actionMode}
            onChange={setActionMode}
            showDelegate={canDelegate}
          />
        }
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
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!canSend}
                    onClick={handleSend}
                  >
                    <Send size={12} />
                    Send
                  </button>
                </span>
              </TooltipTrigger>
              {isProvisioning && !sending ? (
                <TooltipContent side="top">
                  Sending unavailable while team is launching
                </TooltipContent>
              ) : null}
            </Tooltip>
          </div>
        }
        footerRight={
          <div className="flex items-center gap-2">
            {sendError ? (
              <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400">
                <AlertCircle size={10} className="shrink-0" />
                {sendError}
              </span>
            ) : lastResult?.deduplicated ? (
              <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
                <Check size={10} className="shrink-0" />
                Reused recent cross-team request
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
