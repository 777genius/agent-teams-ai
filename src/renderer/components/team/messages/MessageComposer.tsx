import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { AttachmentPreviewList } from '@renderer/components/team/attachments/AttachmentPreviewList';
import { DropZoneOverlay } from '@renderer/components/team/attachments/DropZoneOverlay';
import {
  ComposerSurface,
  ComposerTextarea,
} from '@renderer/components/team/composer/ComposerSurface';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { ActionModeSelector } from '@renderer/components/team/messages/ActionModeSelector';
import { OpenCodeDeliveryWarning } from '@renderer/components/team/messages/OpenCodeDeliveryWarning';
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
import {
  canMemberShowAttachmentControl,
  getAttachmentInputAcceptForMember,
  getMemberAttachmentUnavailableReason,
  validateAttachmentFilesForMember,
  validateAttachmentPayloadsForMember,
} from '@renderer/utils/attachmentRecipientCapabilities';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberAvatarMap, buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { isOpenCodeRuntimeDeliveryHardUxFailureFromDebugDetails } from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
import { nameColorSet } from '@renderer/utils/projectColor';
import { getSuggestedSlashCommandsForProvider } from '@renderer/utils/providerSlashCommands';
import { buildSlashCommandSuggestions } from '@renderer/utils/skillCommandSuggestions';
import {
  extractTaskRefsFromText,
  stripEncodedTaskReferenceMetadata,
} from '@renderer/utils/taskReferenceUtils';
import { MAX_TEXT_LENGTH } from '@shared/constants';
import { isLeadMember } from '@shared/utils/leadDetection';
import { parseStandaloneSlashCommand } from '@shared/utils/slashCommands';
import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';
import { AlertCircle, Check, ChevronDown, Mic, Paperclip, Search, Send } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import type { ActionMode } from '@renderer/components/team/messages/ActionModeSelector';
import type { ComposerDraftContent } from '@renderer/hooks/useComposerDraft';
import type { MentionSuggestion } from '@renderer/types/mention';
import type { OpenCodeRuntimeDeliveryDebugDetails } from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
import type {
  AttachmentPayload,
  ResolvedTeamMember,
  SendMessageResult,
  TaskRef,
} from '@shared/types';

interface MessageComposerProps {
  teamName: string;
  members: ResolvedTeamMember[];
  layout?: 'default' | 'compact';
  widthMode?: 'full' | 'floating-adaptive';
  isTeamAlive?: boolean;
  sending: boolean;
  sendError: string | null;
  sendWarning?: string | null;
  sendDebugDetails?: OpenCodeRuntimeDeliveryDebugDetails | null;
  lastResult?: SendMessageResult | null;
  revisionRequest?: MessageRevisionRequest | null;
  cornerActionPrefix?: React.ReactNode;
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
  onRevisionCancel?: () => void;
  onRevisionComplete?: (requestId: string) => void;
}

export interface MessageRevisionRequest {
  requestId: string;
  originalMessageId: string;
  originalText: string;
  recipient: string;
  actionMode?: ActionMode;
}

interface PendingSendState {
  teamName: string;
  snapshot: ComposerDraftContent;
  previousDebugDetails: OpenCodeRuntimeDeliveryDebugDetails | null | undefined;
  previousLastResult: SendMessageResult | null | undefined;
  revisionRequestId?: string;
  observedSending: boolean;
  optimisticallyCleared: boolean;
}

let pendingSendIdCounter = 0;
const FLOATING_COMPOSER_MIN_WIDTH = 350;
const FLOATING_COMPOSER_MAX_WIDTH = 500;
const FLOATING_COMPOSER_TEXT_BUFFER = 4;
const EMPTY_MENTION_SUGGESTIONS: MentionSuggestion[] = [];
const EMPTY_SKILL_CATALOG = [] as const;

function createPendingSendId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return randomId;
  pendingSendIdCounter += 1;
  return `${Date.now()}-${pendingSendIdCounter}`;
}

function buildRevisionCorrectionText(originalMessageId: string, text: string): string {
  return [
    `Correction for my previous message (MessageId: ${originalMessageId}).`,
    '',
    'Please use this corrected version instead:',
    '',
    text,
  ].join('\n');
}

export const MessageComposer = ({
  teamName,
  members,
  layout = 'default',
  widthMode = 'full',
  isTeamAlive,
  sending,
  sendError,
  sendWarning,
  sendDebugDetails,
  lastResult,
  revisionRequest,
  cornerActionPrefix,
  textareaRef: externalTextareaRef,
  onSend,
  onCrossTeamSend,
  onRevisionCancel,
  onRevisionComplete,
}: MessageComposerProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
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
  const focusComposerTextarea = useCallback(() => {
    const focus = (): void => {
      internalTextareaRef.current?.focus();
    };
    focus();
    queueMicrotask(focus);
    window.requestAnimationFrame(focus);
  }, []);
  const [recipient, setRecipient] = useState<string>(() => {
    const lead = members.find((m) => isLeadMember(m));
    return lead?.name ?? members[0]?.name ?? '';
  });
  const [recipientOpen, setRecipientOpen] = useState(false);
  const [recipientSearch, setRecipientSearch] = useState('');
  const recipientSearchRef = useRef<HTMLInputElement>(null);
  const [isTextareaFocused, setIsTextareaFocused] = useState(false);
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
  const crossTeamTargetsFetchedRef = useRef(false);
  const allCrossTeamTargets = useStore(useShallow((s) => s.crossTeamTargets));
  const fetchCrossTeamTargets = useStore((s) => s.fetchCrossTeamTargets);

  const refreshAliveTeams = useCallback(async () => {
    try {
      const list = await api.teams.aliveList();
      setAliveTeams(new Set(list));
    } catch {
      // best-effort
    }
  }, []);

  useEffect(() => {
    if (!teamSelectorOpen) return;
    if (!crossTeamTargetsFetchedRef.current) {
      // Set the guard synchronously to dedupe concurrent fetches, but clear it if the fetch
      // fails so a later open retries instead of leaving cross-team targets permanently empty.
      crossTeamTargetsFetchedRef.current = true;
      void fetchCrossTeamTargets()
        .then((ok) => {
          if (!ok) {
            crossTeamTargetsFetchedRef.current = false;
          }
        })
        .catch(() => {
          crossTeamTargetsFetchedRef.current = false;
        });
    }
    void refreshAliveTeams();
  }, [fetchCrossTeamTargets, refreshAliveTeams, teamSelectorOpen]);

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
  const hasCrossTeamOptions = sortedCrossTeamTargets.length > 0;

  const isCrossTeam = selectedTeam !== null;
  const selectedTarget = sortedCrossTeamTargets.find((t) => t.teamName === selectedTeam);
  const targetDisplayName = selectedTarget?.displayName ?? selectedTeam;
  const crossTeamHintText = isCrossTeam ? t('messageComposer.crossTeam.hint') : undefined;

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

  const projectPath = useStore((s) =>
    s.selectedTeamName === teamName ? (s.selectedTeamData?.config.projectPath ?? null) : null
  );
  const currentTeamColor = useStore((s) => {
    if (s.selectedTeamName !== teamName) {
      return nameColorSet(teamName).border;
    }
    const configColor = s.selectedTeamData?.config.color;
    if (configColor) return getTeamColorSet(configColor).border;
    const displayName = s.selectedTeamData?.config.name ?? teamName;
    return nameColorSet(displayName).border;
  });
  const isProvisioning = useStore((s) => isTeamProvisioningActive(s, teamName));
  const draft = useComposerDraft(teamName);
  const appliedRevisionRequestIdRef = useRef<string | null>(null);
  const textHasTeamMentionTrigger = draft.text.includes('@');
  const textHasTaskMentionTrigger = draft.text.includes('#');
  const textHasSlashCommandTrigger = stripEncodedTaskReferenceMetadata(draft.text)
    .trimStart()
    .startsWith('/');
  const taskSuggestionDataEnabled =
    textHasTaskMentionTrigger || draft.chips.length > 0 || revisionRequest != null;
  const teamSuggestionDataEnabled = textHasTeamMentionTrigger;
  const slashCommandDataEnabled = textHasSlashCommandTrigger;

  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const avatarMap = useMemo(() => buildMemberAvatarMap(members), [members]);

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
  const leadProviderId = useMemo(() => {
    const lead = members.find((member) => isLeadMember(member));
    return (
      normalizeOptionalTeamProviderId(lead?.providerId) ?? inferTeamProviderIdFromModel(lead?.model)
    );
  }, [members]);

  const { suggestions: teamMentionSuggestions } = useTeamSuggestions(teamName, {
    enabled: teamSuggestionDataEnabled,
  });
  const { suggestions: taskSuggestions } = useTaskSuggestions(teamName, {
    enabled: taskSuggestionDataEnabled,
  });
  // Project skills as slash command suggestions
  const projectSkills = useStore(
    useShallow((s) =>
      slashCommandDataEnabled && projectPath
        ? (s.skillsProjectCatalogByProjectPath[projectPath] ?? EMPTY_SKILL_CATALOG)
        : EMPTY_SKILL_CATALOG
    )
  );
  const userSkills = useStore(
    useShallow((s) => (slashCommandDataEnabled ? s.skillsUserCatalog : EMPTY_SKILL_CATALOG))
  );
  const fetchSkillsCatalog = useStore((s) => s.fetchSkillsCatalog);
  const isLaunchBlocking = isProvisioning && !isTeamAlive;

  // Fetch the catalog only when slash suggestions are actually needed.
  useEffect(() => {
    if (!slashCommandDataEnabled) return;
    void fetchSkillsCatalog(projectPath ?? undefined);
  }, [fetchSkillsCatalog, projectPath, slashCommandDataEnabled]);

  const slashCommandSuggestions = useMemo<MentionSuggestion[]>(
    () =>
      slashCommandDataEnabled
        ? buildSlashCommandSuggestions(
            getSuggestedSlashCommandsForProvider(leadProviderId),
            projectSkills,
            userSkills,
            leadProviderId
          )
        : EMPTY_MENTION_SUGGESTIONS,
    [leadProviderId, projectSkills, slashCommandDataEnabled, userSkills]
  );

  const trimmed = stripEncodedTaskReferenceMetadata(draft.text).trim();
  const standaloneSlashCommand = useMemo(() => parseStandaloneSlashCommand(trimmed), [trimmed]);

  const selectedMember = members.find((m) => m.name === recipient);
  const selectedResolvedColor = selectedMember ? colorMap.get(selectedMember.name) : undefined;
  const isLeadRecipient = selectedMember ? isLeadMember(selectedMember) : false;
  const selectedProviderId =
    normalizeOptionalTeamProviderId(selectedMember?.providerId) ??
    inferTeamProviderIdFromModel(selectedMember?.model);
  const isOpenCodeRecipient = selectedProviderId === 'opencode';
  const showAttachmentControl = canMemberShowAttachmentControl(selectedMember);
  const memberAttachmentUnavailableReason = showAttachmentControl
    ? getMemberAttachmentUnavailableReason(selectedMember)
    : null;
  const attachmentInputAccept = getAttachmentInputAcceptForMember(selectedMember);
  const hasTeammates = members.length > 1;
  const canDelegate = hasTeammates && (isCrossTeam || isLeadRecipient);
  const shouldAutoDelegate = isLeadRecipient && canDelegate;

  const { actionMode, setActionMode, isLoaded: draftLoaded } = draft;

  useEffect(() => {
    if (!revisionRequest) {
      appliedRevisionRequestIdRef.current = null;
      return;
    }
    if (appliedRevisionRequestIdRef.current === revisionRequest.requestId) {
      return;
    }

    appliedRevisionRequestIdRef.current = revisionRequest.requestId;
    setSelectedTeam(null);
    setRecipient(revisionRequest.recipient);
    draft.restoreDraft({
      text: revisionRequest.originalText,
      chips: [],
      attachments: [],
      actionMode: revisionRequest.actionMode ?? actionMode,
    });
    if (revisionRequest.actionMode) {
      setActionMode(revisionRequest.actionMode);
    }
    focusComposerTextarea();
  }, [actionMode, draft, focusComposerTextarea, revisionRequest, setActionMode]);

  // Re-focus textarea after action mode changes (Do/Ask/Delegate button clicks)
  const prevActionModeRef = useRef(actionMode);
  useEffect(() => {
    if (prevActionModeRef.current !== actionMode) {
      prevActionModeRef.current = actionMode;
      focusComposerTextarea();
    }
  }, [actionMode, focusComposerTextarea]);

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
      if (shouldAutoDelegate && actionMode === 'do') {
        setActionMode('delegate');
      }
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
  const supportsAttachments =
    !isCrossTeam &&
    !!isTeamAlive &&
    showAttachmentControl &&
    memberAttachmentUnavailableReason == null;
  const canAttach = supportsAttachments && draft.canAddMore && !sending;
  const attachmentRestrictionReason = !supportsAttachments
    ? isCrossTeam
      ? t('messageComposer.attachments.restrictions.crossTeam')
      : !isTeamAlive
        ? t('messageComposer.attachments.restrictions.teamOffline')
        : !showAttachmentControl
          ? t('messageComposer.attachments.restrictions.unsupportedRecipient')
          : (memberAttachmentUnavailableReason ??
            (isOpenCodeRecipient
              ? t('messageComposer.attachments.restrictions.openCodeOffline')
              : t('messageComposer.attachments.restrictions.teamOffline')))
    : sending
      ? t('messageComposer.attachments.restrictions.sending')
      : !draft.canAddMore
        ? t('messageComposer.attachments.restrictions.maximumReached')
        : undefined;
  const attachmentPayloadRestrictionReason = validateAttachmentPayloadsForMember({
    member: selectedMember,
    attachments: draft.attachments,
  });
  const attachmentsBlocked =
    draft.attachments.length > 0 &&
    (!supportsAttachments || attachmentPayloadRestrictionReason != null);
  const isRevisionActive = revisionRequest !== null && revisionRequest !== undefined;
  const slashCommandRestrictionReason = standaloneSlashCommand
    ? draft.attachments.length > 0
      ? t('messageComposer.slash.restrictions.attachments')
      : isCrossTeam
        ? t('messageComposer.slash.restrictions.crossTeam')
        : !isLeadRecipient
          ? t('messageComposer.slash.restrictions.notLead')
          : !isTeamAlive
            ? t('messageComposer.slash.restrictions.leadOffline')
            : null
    : null;
  const canSend =
    recipient.length > 0 &&
    trimmed.length > 0 &&
    trimmed.length <= MAX_TEXT_LENGTH &&
    !sending &&
    !isLaunchBlocking &&
    !attachmentsBlocked &&
    !slashCommandRestrictionReason &&
    (!isRevisionActive || !isCrossTeam) &&
    (!isCrossTeam || onCrossTeamSend !== undefined);

  const pendingSendRef = useRef<PendingSendState | null>(null);

  const handleCycleActionMode = useCallback(() => {
    if (sending) return;
    const modes: ActionMode[] = canDelegate ? ['do', 'ask', 'delegate'] : ['do', 'ask'];
    const idx = modes.indexOf(actionMode);
    setActionMode(modes[(idx + 1) % modes.length]);
  }, [actionMode, canDelegate, sending, setActionMode]);

  const handleSend = useCallback(() => {
    if (!canSend) return;
    dismissMentionsRef.current?.();
    pendingSendRef.current = {
      teamName,
      snapshot: {
        text: draft.text,
        chips: draft.chips,
        attachments: draft.attachments,
        actionMode,
        pendingSendId: createPendingSendId(),
      },
      previousDebugDetails: sendDebugDetails,
      previousLastResult: lastResult,
      ...(revisionRequest ? { revisionRequestId: revisionRequest.requestId } : {}),
      observedSending: false,
      optimisticallyCleared: false,
    };
    const taskRefs = extractTaskRefsFromText(draft.text, taskSuggestions);
    const serialized = serializeChipsWithText(trimmed, draft.chips);
    const outboundText = revisionRequest
      ? buildRevisionCorrectionText(revisionRequest.originalMessageId, serialized)
      : serialized;
    const outboundSummary = revisionRequest
      ? `Correction for MessageId: ${revisionRequest.originalMessageId}`
      : trimmed;
    if (isCrossTeam && selectedTeam && onCrossTeamSend) {
      onCrossTeamSend(selectedTeam, outboundText, outboundSummary, actionMode, taskRefs);
    } else {
      // Summary should stay compact (no expanded chip markdown)
      onSend(
        recipient,
        outboundText,
        outboundSummary,
        draft.attachments.length > 0 ? draft.attachments : undefined,
        actionMode,
        taskRefs
      );
    }
    focusComposerTextarea();
  }, [
    actionMode,
    canSend,
    recipient,
    trimmed,
    onSend,
    onCrossTeamSend,
    isCrossTeam,
    selectedTeam,
    sendDebugDetails,
    draft.attachments,
    draft.chips,
    draft.text,
    lastResult,
    focusComposerTextarea,
    revisionRequest,
    taskSuggestions,
    teamName,
  ]);

  // Clear once the send starts, not after the IPC finishes. For OpenCode teammates the message
  // can already be visible from inbox refresh while runtime delivery diagnostics are still pending.
  useLayoutEffect(() => {
    const pending = pendingSendRef.current;
    if (!pending) return;
    const isPendingCurrentTeam = pending.teamName === teamName;

    if (sending) {
      pending.observedSending = true;
      if (isPendingCurrentTeam && !pending.optimisticallyCleared) {
        pending.optimisticallyCleared = true;
        draft.hideDraftForPendingSend(pending.snapshot);
      }
      return;
    }

    const hasNewResult =
      lastResult?.messageId != null &&
      lastResult.messageId !== pending.previousLastResult?.messageId;
    const hasNewDebugDetails =
      sendDebugDetails?.messageId != null &&
      sendDebugDetails.messageId !== pending.previousDebugDetails?.messageId;
    const hasCompletionSignal =
      pending.observedSending || sendError !== null || hasNewResult || hasNewDebugDetails;
    if (!hasCompletionSignal) return;

    pendingSendRef.current = null;
    const failed =
      sendError !== null ||
      isOpenCodeRuntimeDeliveryHardUxFailureFromDebugDetails(sendDebugDetails);
    if (failed) {
      if (!isPendingCurrentTeam) return;
      const currentDraftIsEmpty =
        draft.text.length === 0 && draft.chips.length === 0 && draft.attachments.length === 0;
      if (pending.optimisticallyCleared && currentDraftIsEmpty) {
        draft.restoreDraft(pending.snapshot);
      } else if (!currentDraftIsEmpty) {
        draft.finalizePendingSendClear(undefined, pending.snapshot);
      }
      return;
    }

    if (pending.revisionRequestId) {
      onRevisionComplete?.(pending.revisionRequestId);
    }

    if (!isPendingCurrentTeam) {
      draft.finalizePendingSendClear(pending.teamName, pending.snapshot);
      return;
    }

    if (!pending.optimisticallyCleared) {
      draft.clearDraft();
      return;
    }

    draft.finalizePendingSendClear(undefined, pending.snapshot);
  }, [teamName, sending, sendError, sendDebugDetails, lastResult, draft, onRevisionComplete]);

  const showFileRestrictionError = useCallback(() => {
    setFileRestrictionError(
      attachmentRestrictionReason ??
        attachmentPayloadRestrictionReason ??
        t('messageComposer.attachments.restrictions.leadOnly')
    );
    window.clearTimeout(fileRestrictionTimerRef.current);
    fileRestrictionTimerRef.current = window.setTimeout(() => {
      setFileRestrictionError(null);
    }, 4000);
  }, [attachmentPayloadRestrictionReason, attachmentRestrictionReason, t]);

  const validateSelectedAttachmentFiles = useCallback(
    (files: FileList | File[]): boolean => {
      const reason = validateAttachmentFilesForMember({
        member: selectedMember,
        files,
      });
      if (!reason) {
        return true;
      }
      setFileRestrictionError(reason);
      window.clearTimeout(fileRestrictionTimerRef.current);
      fileRestrictionTimerRef.current = window.setTimeout(() => {
        setFileRestrictionError(null);
      }, 4000);
      return false;
    },
    [selectedMember]
  );

  const { addFiles: draftAddFiles } = draft;
  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const input = e.target;
      if (input.files?.length) {
        if (!canAttach) {
          showFileRestrictionError();
          input.value = '';
          return;
        }
        if (!validateSelectedAttachmentFiles(input.files)) {
          input.value = '';
          return;
        }
        void draftAddFiles(input.files);
      }
      input.value = '';
    },
    [canAttach, draftAddFiles, showFileRestrictionError, validateSelectedAttachmentFiles]
  );

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
      if (!canAttach) {
        const files = e.dataTransfer?.files;
        if (files?.length) {
          showFileRestrictionError();
        }
        return;
      }
      const files = e.dataTransfer?.files;
      if (files?.length && !validateSelectedAttachmentFiles(files)) {
        return;
      }
      draftHandleDrop(e);
    },
    [canAttach, draftHandleDrop, showFileRestrictionError, validateSelectedAttachmentFiles]
  );

  const { handlePaste: draftHandlePaste } = draft;
  const handlePasteWrapper = useCallback(
    (e: React.ClipboardEvent) => {
      if (!canAttach) {
        const hasFiles = Array.from(e.clipboardData.items).some((item) => item.kind === 'file');
        if (hasFiles) {
          e.preventDefault();
          showFileRestrictionError();
        }
        return;
      }
      const pastedFiles = Array.from(e.clipboardData.items)
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => file != null);
      if (pastedFiles.length > 0 && !validateSelectedAttachmentFiles(pastedFiles)) {
        e.preventDefault();
        return;
      }
      draftHandlePaste(e);
    },
    [canAttach, draftHandlePaste, showFileRestrictionError, validateSelectedAttachmentFiles]
  );
  const handleTextareaFocus = useCallback(() => setIsTextareaFocused(true), []);
  const handleTextareaBlur = useCallback(() => setIsTextareaFocused(false), []);
  const handleRevisionCancel = useCallback(() => {
    onRevisionCancel?.();
    focusComposerTextarea();
  }, [focusComposerTextarea, onRevisionCancel]);

  const remaining = MAX_TEXT_LENGTH - trimmed.length;
  const hasAttachmentPreviewContent =
    draft.attachments.length > 0 || Boolean(draft.attachmentError ?? fileRestrictionError);
  const isCompactLayout = layout === 'compact';
  const isFloatingAdaptiveWidth = widthMode === 'floating-adaptive';
  const [floatingComposerWidth, setFloatingComposerWidth] = useState(FLOATING_COMPOSER_MIN_WIDTH);

  useLayoutEffect(() => {
    if (!isFloatingAdaptiveWidth) return;

    if (draft.attachments.length > 0) {
      setFloatingComposerWidth(FLOATING_COMPOSER_MAX_WIDTH);
      return;
    }

    const textarea = internalTextareaRef.current;
    if (!textarea) return;

    const visibleText = stripEncodedTaskReferenceMetadata(draft.text);
    if (visibleText.length === 0) {
      setFloatingComposerWidth(FLOATING_COMPOSER_MIN_WIDTH);
      return;
    }

    const computedStyle = window.getComputedStyle(textarea);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;

    context.font =
      computedStyle.font ||
      [
        computedStyle.fontStyle,
        computedStyle.fontVariant,
        computedStyle.fontWeight,
        computedStyle.fontSize,
        computedStyle.fontFamily,
      ]
        .filter(Boolean)
        .join(' ');

    const longestLineWidth = visibleText
      .split(/\r\n|\r|\n/)
      .reduce((maxWidth, line) => Math.max(maxWidth, context.measureText(line).width), 0);
    const horizontalInset =
      (Number.parseFloat(computedStyle.paddingLeft) || 0) +
      (Number.parseFloat(computedStyle.paddingRight) || 0) +
      (Number.parseFloat(computedStyle.borderLeftWidth) || 0) +
      (Number.parseFloat(computedStyle.borderRightWidth) || 0) +
      FLOATING_COMPOSER_TEXT_BUFFER;
    const nextWidth = Math.min(
      FLOATING_COMPOSER_MAX_WIDTH,
      Math.max(FLOATING_COMPOSER_MIN_WIDTH, Math.ceil(longestLineWidth + horizontalInset))
    );

    setFloatingComposerWidth((currentWidth) =>
      currentWidth === nextWidth ? currentWidth : nextWidth
    );
  }, [draft.attachments.length, draft.text, isFloatingAdaptiveWidth]);

  const floatingAdaptiveStyle = isFloatingAdaptiveWidth
    ? {
        width: floatingComposerWidth,
        maxWidth: `min(${FLOATING_COMPOSER_MAX_WIDTH}px, calc(100vw - 2rem))`,
      }
    : undefined;
  const revisionNotice = revisionRequest ? (
    <div className="flex items-center gap-2 rounded-md border border-amber-400/30 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-200">
      <span className="min-w-0 flex-1 truncate" title={t('messageComposer.revision.tooltip')}>
        {t('messageComposer.revision.editing')}
      </span>
      <button
        type="button"
        className="shrink-0 rounded px-1.5 py-0.5 text-amber-100 transition-colors hover:bg-amber-400/15"
        onClick={handleRevisionCancel}
      >
        {t('messageComposer.revision.cancel')}
      </button>
    </div>
  ) : null;
  const compactFooterNotice = slashCommandRestrictionReason ? (
    <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
      <AlertCircle size={10} className="shrink-0" />
      {slashCommandRestrictionReason}
    </span>
  ) : sendError ? (
    <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400">
      <AlertCircle size={10} className="shrink-0" />
      {sendError}
    </span>
  ) : sendWarning ? (
    <OpenCodeDeliveryWarning warning={sendWarning} debugDetails={sendDebugDetails} />
  ) : lastResult?.deduplicated ? (
    <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
      <Check size={10} className="shrink-0" />
      {t('messageComposer.status.reusedCrossTeamRequest')}
    </span>
  ) : null;
  const shouldShowFooterCharCount = remaining < 200;
  const shouldShowSavedIndicator = isTextareaFocused && draft.isSaved;
  const nonCompactFooterRight =
    compactFooterNotice || shouldShowFooterCharCount || shouldShowSavedIndicator ? (
      <div className="flex flex-col items-end gap-1">
        {compactFooterNotice}
        {shouldShowFooterCharCount || shouldShowSavedIndicator ? (
          <div className="flex items-center gap-2">
            {shouldShowFooterCharCount ? (
              <span
                className={`text-[10px] ${remaining < 100 ? 'text-yellow-400' : 'text-[var(--color-text-muted)]'}`}
              >
                {t('messageComposer.input.charsLeft', { count: remaining })}
              </span>
            ) : null}
            {shouldShowSavedIndicator ? (
              <span className="text-[10px] text-[var(--color-text-muted)]">
                {t('tasks.createTask.saved')}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    ) : null;
  const composerFooterRight = isCompactLayout ? compactFooterNotice : nonCompactFooterRight;

  return (
    <ComposerSurface
      className={cn(!isCompactLayout && 'mb-2')}
      style={floatingAdaptiveStyle}
      role="group"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDropWrapper}
      onPaste={handlePasteWrapper}
    >
      <div>
        <div className="message-composer-flat-toolbar grid min-w-0 grid-cols-[32px_minmax(0,1fr)] items-center gap-2 pl-2">
          <div className="flex size-8 items-center justify-center">
            {showAttachmentControl ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={attachmentInputAccept}
                  multiple
                  className="hidden"
                  onChange={handleFileInputChange}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors',
                        canAttach
                          ? 'text-[var(--color-text-secondary)] hover:bg-white/[0.035] hover:text-[var(--color-text)]'
                          : 'text-[var(--color-text-muted)] opacity-40'
                      )}
                      disabled={!canAttach}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Paperclip size={14} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {canAttach
                      ? t('messageComposer.attachments.attachFiles')
                      : (attachmentRestrictionReason ??
                        t('messageComposer.attachments.unavailable'))}
                  </TooltipContent>
                </Tooltip>
              </>
            ) : null}
          </div>

          <div className="flex min-w-0 items-stretch justify-end self-stretch">
            {/* Combined team + member selector */}
            <div
              className={cn(
                'message-composer-target-selectors flex w-fit min-w-0 max-w-full items-stretch overflow-hidden text-xs',
                isCrossTeam && 'bg-[var(--cross-team-bg)]'
              )}
            >
              <Popover open={teamSelectorOpen} onOpenChange={setTeamSelectorOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex min-w-0 items-center justify-end gap-1 border-r border-r-[var(--color-border)] pl-1 pr-2 text-xs transition-colors',
                      isCrossTeam
                        ? 'hover:bg-[var(--cross-team-bg)]/80 bg-[var(--cross-team-bg)] text-purple-400'
                        : 'hover:bg-white/[0.025]'
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
                        <span className="min-w-0 truncate" title={targetDisplayName ?? undefined}>
                          {targetDisplayName}
                        </span>
                      </>
                    ) : (
                      <>
                        {currentTeamColor ? (
                          <span
                            className="inline-block size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: currentTeamColor }}
                          />
                        ) : null}
                        <span className="min-w-0 truncate text-[var(--color-text-secondary)]">
                          {t('messageComposer.teamSelector.thisTeam')}
                        </span>
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
                        focusComposerTextarea();
                      }}
                    >
                      {currentTeamColor ? (
                        <span
                          className="inline-block size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: currentTeamColor }}
                        />
                      ) : null}
                      <span className="truncate text-[var(--color-text)]">
                        {t('messageComposer.teamSelector.thisTeam')}
                      </span>
                      <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                        {t('messageComposer.teamSelector.current')}
                      </span>
                      {!isCrossTeam ? (
                        <Check size={12} className="ml-auto shrink-0 text-blue-400" />
                      ) : null}
                    </button>

                    {hasCrossTeamOptions ? (
                      <>
                        <div className="my-1 h-px bg-[var(--color-border)]" />

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
                                focusComposerTextarea();
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
                                title={
                                  target.isOnline
                                    ? t('messageComposer.teamSelector.onlineTitle')
                                    : t('messageComposer.teamSelector.offlineTitle')
                                }
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
                                    {target.isOnline
                                      ? t('messageComposer.teamSelector.online')
                                      : t('messageComposer.teamSelector.offline')}
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
                      </>
                    ) : null}
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
                      'message-composer-recipient-selector inline-flex min-w-0 items-center justify-end gap-1 overflow-hidden whitespace-nowrap pl-2 pr-1 text-xs transition-colors',
                      isCrossTeam
                        ? 'cursor-default bg-[var(--cross-team-bg)] opacity-60'
                        : 'hover:bg-white/[0.025]'
                    )}
                    disabled={isCrossTeam}
                  >
                    {recipient ? (
                      <MemberBadge
                        name={recipient}
                        color={selectedResolvedColor}
                        size="sm"
                        avatarUrl={avatarMap.get(recipient)}
                        hideAvatar={recipient === 'user'}
                        disableHoverCard
                        variant="text"
                      />
                    ) : (
                      <span className="text-[var(--color-text-muted)]">
                        {t('messageComposer.recipient.select')}
                      </span>
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
                        placeholder={t('messageComposer.recipient.searchPlaceholder')}
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
                            {t('messageComposer.recipient.noResults')}
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
                              focusComposerTextarea();
                            }}
                          >
                            <MemberBadge
                              name={m.name}
                              color={resolvedColor}
                              size="sm"
                              avatarUrl={avatarMap.get(m.name)}
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
          </div>
        </div>

        {hasAttachmentPreviewContent ? (
          <div className="px-2 pt-2">
            <AttachmentPreviewList
              attachments={draft.attachments}
              onRemove={draft.removeAttachment}
              error={
                draft.attachmentError ?? fileRestrictionError ?? attachmentPayloadRestrictionReason
              }
              onDismissError={draft.clearAttachmentError}
              disabled={attachmentsBlocked}
              disabledHint={
                attachmentPayloadRestrictionReason ??
                attachmentRestrictionReason ??
                t('messageComposer.attachments.disabledHint')
              }
            />
          </div>
        ) : null}
        {revisionNotice ? <div className="px-2 pt-2">{revisionNotice}</div> : null}
      </div>

      <div className="relative">
        <DropZoneOverlay
          active={isDragOver}
          rejected={!canAttach}
          rejectionReason={attachmentRestrictionReason}
        />
        <ComposerTextarea
          ref={textareaRef}
          connectedToHeader
          id={`compose-${teamName}`}
          placeholder={
            isLaunchBlocking
              ? t('messageComposer.input.teamLaunchingPlaceholder')
              : isCrossTeam
                ? t('messageComposer.input.crossTeamPlaceholder', {
                    team: targetDisplayName ?? t('messageComposer.input.teamFallback'),
                  })
                : t('messageComposer.input.placeholder')
          }
          value={draft.text}
          onValueChange={draft.setText}
          suggestions={mentionSuggestions}
          teamSuggestions={teamMentionSuggestions}
          taskSuggestions={taskSuggestions}
          commandSuggestions={slashCommandSuggestions}
          chips={draft.chips}
          onChipRemove={draft.removeChip}
          onFocus={handleTextareaFocus}
          onBlur={handleTextareaBlur}
          projectPath={projectPath}
          onFileChipInsert={draft.addChip}
          onModEnter={handleSend}
          onShiftTab={handleCycleActionMode}
          dismissMentionsRef={dismissMentionsRef}
          extraTips={[t('messageComposer.input.slashTip')]}
          minRows={isCompactLayout ? 1 : 2}
          maxRows={6}
          maxLength={MAX_TEXT_LENGTH}
          hintText={crossTeamHintText}
          showHint={!isCompactLayout && isTextareaFocused}
          cornerActionInset={isCompactLayout ? 'compact' : 'default'}
          cornerActionLeft={
            <ActionModeSelector
              value={actionMode}
              onChange={setActionMode}
              showDelegate={canDelegate}
              disabled={sending}
            />
          }
          cornerAction={
            <div className="flex items-center gap-2">
              {cornerActionPrefix}
              {/* NOTE: ContextRing disabled — usage formula is inaccurate */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-white/[0.035] hover:text-[var(--color-text-secondary)]"
                    onClick={() => void window.electronAPI.openExternal('https://voicetext.site')}
                  >
                    <Mic size={16} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {t('messageComposer.actions.voiceToText')}
                </TooltipContent>
              </Tooltip>
              <span
                className="message-composer-send-slot"
                data-visible={trimmed.length > 0 ? 'true' : 'false'}
              >
                {trimmed.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <button
                          type="button"
                          className="message-composer-send-button inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-xs font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                          disabled={!canSend}
                          onClick={handleSend}
                        >
                          <Send size={14} />
                          {t('messageComposer.actions.send')}
                        </button>
                      </span>
                    </TooltipTrigger>
                    {slashCommandRestrictionReason ? (
                      <TooltipContent side="top">{slashCommandRestrictionReason}</TooltipContent>
                    ) : isLaunchBlocking && !sending ? (
                      <TooltipContent side="top">
                        {t('messageComposer.actions.sendingUnavailableLaunching')}
                      </TooltipContent>
                    ) : null}
                  </Tooltip>
                ) : null}
              </span>
            </div>
          }
          footerRight={composerFooterRight}
        />
      </div>
    </ComposerSurface>
  );
};
