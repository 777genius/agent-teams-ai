import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { AttachmentPreviewList } from '@renderer/components/team/attachments/AttachmentPreviewList';
import { DropZoneOverlay } from '@renderer/components/team/attachments/DropZoneOverlay';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { ActionModeSelector } from '@renderer/components/team/messages/ActionModeSelector';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useComposerDraft } from '@renderer/hooks/useComposerDraft';
import { useTaskSuggestions } from '@renderer/hooks/useTaskSuggestions';
import { useTeamSuggestions } from '@renderer/hooks/useTeamSuggestions';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { isTeamProvisioningActive } from '@renderer/store/slices/teamSlice';
import { serializeChipsWithText } from '@renderer/types/inlineChip';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { nameColorSet } from '@renderer/utils/projectColor';
import {
  extractTaskRefsFromText,
  stripEncodedTaskReferenceMetadata,
} from '@renderer/utils/taskReferenceUtils';
import { MAX_TEXT_LENGTH } from '@shared/constants';
import { isLeadMember } from '@shared/utils/leadDetection';
import { AlertCircle, Check, ChevronDown, Mic, Paperclip, Search, Send } from 'lucide-react';

import type { ActionMode } from '@renderer/components/team/messages/ActionModeSelector';
import type { MentionSuggestion } from '@renderer/types/mention';
import type {
  AttachmentPayload,
  ResolvedTeamMember,
  SendMessageResult,
  TaskRef,
} from '@shared/types';

interface MessageComposerProps {
  teamName: string;
  members: ResolvedTeamMember[];
  isTeamAlive?: boolean;
  sending: boolean;
  sendError: string | null;
  lastResult?: SendMessageResult | null;
  /** Ref to the underlying textarea element for external focus management. */
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  onSend: (
    recipient: string,
    text: string,
    summary?: string,
    attachments?: AttachmentPayload[],
    actionMode?: ActionMode,
    taskRefs?: TaskRef[]
  ) => void;
  onCrossTeamSend?: (
    toTeam: string,
    text: string,
    summary?: string,
    actionMode?: ActionMode,
    taskRefs?: TaskRef[]
  ) => void;
}

export const MessageComposer = ({
  teamName,
  members,
  isTeamAlive,
  sending,
  sendError,
  lastResult,
  textareaRef: externalTextareaRef,
  onSend,
  onCrossTeamSend,
}: MessageComposerProps): React.JSX.Element => {
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = useMemo(() => {
    // Merge internal and external refs into a single callback ref
    return (node: HTMLTextAreaElement | null) => {
      (internalTextareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
      if (typeof externalTextareaRef === 'function') {
        externalTextareaRef(node);
      } else if (externalTextareaRef) {
        (externalTextareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
      }
    };
  }, [externalTextareaRef]);
  const [recipient, setRecipient] = useState<string>(() => {
    const lead = members.find((m) => isLeadMember(m));
    return lead?.name ?? members[0]?.name ?? '';
  });
  const [recipientOpen, setRecipientOpen] = useState(false);
  const [recipientSearch, setRecipientSearch] = useState('');
  const recipientSearchRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileRestrictionError, setFileRestrictionError] = useState<string | null>(null);
  const fileRestrictionTimerRef = useRef(0);
  const dismissMentionsRef = useRef<(() => void) | null>(null);

  // Cross-team state
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [teamSelectorOpen, setTeamSelectorOpen] = useState(false);
  const [aliveTeams, setAliveTeams] = useState<Set<string>>(new Set());
  const allCrossTeamTargets = useStore((s) => s.crossTeamTargets);
  const fetchCrossTeamTargets = useStore((s) => s.fetchCrossTeamTargets);

  useEffect(() => {
    void fetchCrossTeamTargets();
  }, [fetchCrossTeamTargets]);

  const refreshAliveTeams = useCallback(async () => {
    try {
      const list = await api.teams.aliveList();
      setAliveTeams(new Set(list));
    } catch {
      // best-effort
    }
  }, []);

  useEffect(() => {
    void refreshAliveTeams();
  }, [refreshAliveTeams]);

  useEffect(() => {
    if (!teamSelectorOpen) return;
    void refreshAliveTeams();
  }, [teamSelectorOpen, refreshAliveTeams]);

  // Always filter out current team on the UI side (store is global, shared across tabs)
  const crossTeamTargets = useMemo(
    () => allCrossTeamTargets.filter((t) => t.teamName !== teamName),
    [allCrossTeamTargets, teamName]
  );
  const sortedCrossTeamTargets = useMemo(
    () =>
      crossTeamTargets
        .map((target) => ({
          ...target,
          isOnline: aliveTeams.has(target.teamName),
        }))
        .sort((a, b) => {
          if (a.isOnline && !b.isOnline) return -1;
          if (!a.isOnline && b.isOnline) return 1;
          return (a.displayName || a.teamName).localeCompare(
            b.displayName || b.teamName,
            undefined,
            {
              sensitivity: 'base',
            }
          );
        }),
    [aliveTeams, crossTeamTargets]
  );

  const isCrossTeam = selectedTeam !== null;
  const selectedTarget = sortedCrossTeamTargets.find((t) => t.teamName === selectedTeam);
  const targetDisplayName = selectedTarget?.displayName ?? selectedTeam;
  const crossTeamHintText = isCrossTeam
    ? 'Tip: Cross-team messages go to the target team lead. If you want the reply to come back to your team lead instead of you, say that explicitly in the message.'
    : undefined;

  // Members load async with team data; keep recipient stable if valid, otherwise default to lead/first.
  useEffect(() => {
    if (recipient && members.some((m) => m.name === recipient)) {
      return;
    }
    const lead = members.find((m) => isLeadMember(m));
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
  const isProvisioning = useStore((s) => isTeamProvisioningActive(s, teamName));
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
  const { suggestions: taskSuggestions } = useTaskSuggestions(teamName);

  const trimmed = stripEncodedTaskReferenceMetadata(draft.text).trim();

  const selectedMember = members.find((m) => m.name === recipient);
  const selectedResolvedColor = selectedMember ? colorMap.get(selectedMember.name) : undefined;
  const isLeadRecipient = selectedMember ? isLeadMember(selectedMember) : false;
  const hasTeammates = members.length > 1;
  const canDelegate = hasTeammates && (isCrossTeam || isLeadRecipient);
  const shouldAutoDelegate = isLeadRecipient && canDelegate;

  const { actionMode, setActionMode, isLoaded: draftLoaded } = draft;

  // Re-focus textarea after action mode changes (Do/Ask/Delegate button clicks)
  const prevActionModeRef = useRef(actionMode);
  useEffect(() => {
    if (prevActionModeRef.current !== actionMode) {
      prevActionModeRef.current = actionMode;
      internalTextareaRef.current?.focus();
    }
  }, [actionMode]);

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
  const supportsAttachments = isLeadRecipient && !isCrossTeam && !!isTeamAlive;
  const canAttach = supportsAttachments && draft.canAddMore;
  const attachmentRestrictionReason = !supportsAttachments
    ? isCrossTeam
      ? 'File attachments are not supported for cross-team messages'
      : !isLeadRecipient
        ? 'Files can only be sent to the team lead'
        : 'Team must be online to attach files'
    : undefined;
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

  const handleCycleActionMode = useCallback(() => {
    const modes: ActionMode[] = canDelegate ? ['do', 'ask', 'delegate'] : ['do', 'ask'];
    const idx = modes.indexOf(actionMode);
    setActionMode(modes[(idx + 1) % modes.length]);
  }, [actionMode, canDelegate, setActionMode]);

  const handleSend = useCallback(() => {
    if (!canSend) return;
    dismissMentionsRef.current?.();
    pendingSendRef.current = true;
    const taskRefs = extractTaskRefsFromText(draft.text, taskSuggestions);
    const serialized = serializeChipsWithText(trimmed, draft.chips);
    if (isCrossTeam && selectedTeam && onCrossTeamSend) {
      onCrossTeamSend(selectedTeam, serialized, trimmed, actionMode, taskRefs);
    } else {
      // Summary should stay compact (no expanded chip markdown)
      onSend(
        recipient,
        serialized,
        trimmed,
        draft.attachments.length > 0 ? draft.attachments : undefined,
        actionMode,
        taskRefs
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
    taskSuggestions,
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

  const { handleDrop: draftHandleDrop } = draft;
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
      draftHandleDrop(e);
    },
    [supportsAttachments, draftHandleDrop, showFileRestrictionError]
  );

  const { handlePaste: draftHandlePaste } = draft;
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
      draftHandlePaste(e);
    },
    [supportsAttachments, draftHandlePaste, showFileRestrictionError]
  );

  const remaining = MAX_TEXT_LENGTH - trimmed.length;
  const hasAttachmentPreviewContent =
    draft.attachments.length > 0 || Boolean(draft.attachmentError ?? fileRestrictionError);

  return (
    <div
      className="relative mb-3 pb-3"
      role="group"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDropWrapper}
      onPaste={handlePasteWrapper}
    >
      <div className="mb-1 space-y-2">
        <div className="flex items-center gap-2">
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
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded p-1 transition-colors',
                      canAttach
                        ? 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
                        : 'text-[var(--color-text-muted)] opacity-40'
                    )}
                    disabled={!canAttach}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Paperclip size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {!isTeamAlive
                    ? 'Team must be online to attach files'
                    : !draft.canAddMore
                      ? 'Maximum attachments reached'
                      : 'Attach files (paste or drag & drop)'}
                </TooltipContent>
              </Tooltip>
            </>
          ) : null}

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {!isTeamAlive && !isProvisioning && (
              <span className="text-[10px]" style={{ color: 'var(--warning-text)' }}>
                Team offline
              </span>
            )}

            {/* Combined team + member selector */}
            {sortedCrossTeamTargets.length > 0 ? (
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
                            className={cn(
                              'inline-block size-2 shrink-0 rounded-full',
                              selectedTarget?.isOnline && 'animate-pulse'
                            )}
                            style={{
                              backgroundColor: selectedTarget?.isOnline
                                ? '#22c55e'
                                : selectedTarget
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
                      {sortedCrossTeamTargets.map((target) => {
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
                              className={cn(
                                'inline-block size-2 shrink-0 rounded-full',
                                target.isOnline && 'animate-pulse'
                              )}
                              style={{
                                backgroundColor: target.isOnline
                                  ? '#22c55e'
                                  : target.color
                                    ? getTeamColorSet(target.color).border
                                    : nameColorSet(target.displayName).border,
                              }}
                              title={target.isOnline ? 'Online' : 'Offline'}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <div className="truncate text-[var(--color-text)]">
                                  {target.displayName}
                                </div>
                                <span
                                  className={cn(
                                    'shrink-0 text-[10px]',
                                    target.isOnline
                                      ? 'text-green-400'
                                      : 'text-[var(--color-text-muted)]'
                                  )}
                                >
                                  {target.isOnline ? 'online' : 'offline'}
                                </span>
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
                          const aIsLead = isLeadMember(a) ? 1 : 0;
                          const bIsLead = isLeadMember(b) ? 1 : 0;
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
                        const aIsLead = isLeadMember(a) ? 1 : 0;
                        const bIsLead = isLeadMember(b) ? 1 : 0;
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

        {hasAttachmentPreviewContent ? (
          <AttachmentPreviewList
            attachments={draft.attachments}
            onRemove={draft.removeAttachment}
            error={draft.attachmentError ?? fileRestrictionError}
            onDismissError={draft.clearAttachmentError}
            disabled={attachmentsBlocked}
            disabledHint="File attachments are only supported when sending to the team lead while the team is online. Remove attachments or switch recipient."
          />
        ) : null}
      </div>

      <div className="relative">
        <DropZoneOverlay
          active={isDragOver}
          rejected={!supportsAttachments}
          rejectionReason={attachmentRestrictionReason}
        />
        <MentionableTextarea
          ref={textareaRef}
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
          taskSuggestions={taskSuggestions}
          chips={draft.chips}
          onChipRemove={draft.removeChip}
          projectPath={projectPath}
          onFileChipInsert={draft.addChip}
          onModEnter={handleSend}
          onShiftTab={handleCycleActionMode}
          dismissMentionsRef={dismissMentionsRef}
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
                <span className="text-[10px] text-[var(--color-text-muted)]">Saved</span>
              ) : null}
            </div>
          }
        />
      </div>
    </div>
  );
};
