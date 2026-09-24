import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { normalizeConversationParticipant } from '@features/team-direct-chats/renderer';
import { api } from '@renderer/api';
import { AttachmentPreviewList } from '@renderer/components/team/attachments/AttachmentPreviewList';
import { DropZoneOverlay } from '@renderer/components/team/attachments/DropZoneOverlay';
import {
  ComposerSurface,
  ComposerTextarea,
} from '@renderer/components/team/composer/ComposerSurface';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { ActionModeSelector } from '@renderer/components/team/messages/ActionModeSelector';
import { ComposerLockedRecipient } from '@renderer/components/team/messages/ComposerLockedRecipient';
import { useTeamStartupCopy } from '@renderer/components/team/useTeamStartupCopy';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useTaskSuggestions } from '@renderer/hooks/useTaskSuggestions';
import { useTeamSuggestions } from '@renderer/hooks/useTeamSuggestions';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';
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
import { Check, ChevronDown, Mic, Paperclip, Search, Send } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { crossTeamDraftMeta, memberDraftPreviews } from './composerDraftPreviews';
import { buildRevisionCorrectionText, createPendingSendId } from './composerSendUtils';
import { runComposerSubmission } from './composerSubmission';
import { MessageComposerRevisionNotice } from './MessageComposerRevisionNotice';
import { MessageComposerStatusNotice } from './MessageComposerStatusNotice';
import { MessageComposerTeamSelector } from './MessageComposerTeamSelector';
import { useAutoDelegateActionMode } from './useAutoDelegateActionMode';
import { type ComposerDraftAddressRequest, useComposerDraftAddressRequest } from './useComposerDraftAddressRequest';
import { useComposerSubmissionFeedback } from './useComposerSubmissionFeedback';
import { useComposerTextarea } from './useComposerTextarea';
import { useFloatingComposerWidth } from './useFloatingComposerWidth';
import { useMessageComposerDraft } from './useMessageComposerDraft';

import type { ActionMode } from '@renderer/components/team/messages/ActionModeSelector';
import type { ComposerDraftDestination } from '@renderer/components/team/messages/composerDraftDestination';
import type { MessageRevisionTargetController } from '@renderer/components/team/messages/messageRevisionTarget';
import type { ComposerDraftAddress, ComposerWorkingSummary } from '@renderer/types/composerDraft';
import type { MentionSuggestion } from '@renderer/types/mention';
import type { OpenCodeRuntimeDeliveryDebugDetails } from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
import type {
  AttachmentPayload,
  CrossTeamSendResult,
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
  revisionPreparation?: { kind: 'preparing' | 'occupied'; recipient: string } | null;
  revisableMessageId?: string | null;
  cornerActionPrefix?: React.ReactNode;
  lockedRecipient?: string;
  /** Ref to the underlying textarea element for external focus management. */
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  suggestionPlacement?: 'above';
  /** Bump this when a chat thread is opened so the composer steals keyboard focus. */
  autoFocusKey?: number;
  draftAddressRequest?: ComposerDraftAddressRequest | null;
  workingDraftSummaries?: readonly ComposerWorkingSummary[];
  onSend: (
    recipient: string,
    text: string,
    summary?: string,
    attachments?: AttachmentPayload[],
    actionMode?: ActionMode,
    taskRefs?: TaskRef[]
  ) => Promise<SendMessageResult>;
  onCrossTeamSend?: (
    toTeam: string,
    text: string,
    summary?: string,
    actionMode?: ActionMode,
    taskRefs?: TaskRef[],
    toMember?: string
  ) => Promise<CrossTeamSendResult | null>;
  onSubmitIntent?: () => void;
  onDraftMutation?: () => void;
  onRecoveryDestinationChange?: (destination: ComposerDraftDestination | null) => void;
  onRevisionPreparationChange?: (
    controller: MessageRevisionTargetController | null
  ) => void;
  onRevisionCancel?: () => void;
  onRevisionComplete?: (requestId: string, address: ComposerDraftAddress) => void;
}

export interface MessageRevisionRequest {
  requestId: string;
  originalMessageId: string;
  originalText: string;
  recipient: string;
  actionMode?: ActionMode;
}

const EMPTY_MENTION_SUGGESTIONS: MentionSuggestion[] = [];
const EMPTY_SKILL_CATALOG = [] as const;

export const MessageComposer = ({
  teamName,
  members,
  layout = 'default',
  widthMode = 'full',
  isTeamAlive,
  sending,
  sendWarning,
  sendDebugDetails,
  lastResult,
  revisionRequest,
  revisionPreparation,
  revisableMessageId,
  cornerActionPrefix,
  textareaRef: externalTextareaRef,
  suggestionPlacement,
  lockedRecipient,
  autoFocusKey,
  draftAddressRequest,
  workingDraftSummaries = [],
  onSend,
  onCrossTeamSend,
  onSubmitIntent,
  onDraftMutation,
  onRecoveryDestinationChange,
  onRevisionPreparationChange,
  onRevisionCancel,
  onRevisionComplete,
}: MessageComposerProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { textareaRef, internalTextareaRef, focusComposerTextarea } = useComposerTextarea(
    externalTextareaRef,
    autoFocusKey
  );
  const [recipient, setRecipient] = useState<string>(() => {
    const lead = members.find((m) => isLeadMember(m));
    return lead?.name ?? members[0]?.name ?? '';
  });
  const [recipientOpen, setRecipientOpen] = useState(false);
  const [recipientSearch, setRecipientSearch] = useState('');
  const recipientSearchRef = useRef<HTMLInputElement>(null);
  const [groupChatSelected, setGroupChatSelected] = useState(() => !lockedRecipient);
  const [isTextareaFocused, setIsTextareaFocused] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileRestrictionError, setFileRestrictionError] = useState<string | null>(null);
  const fileRestrictionTimerRef = useRef(0);
  const dismissMentionsRef = useRef<(() => void) | null>(null);

  // Cross-team state
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [crossTeamRecipient, setCrossTeamRecipient] = useState<string | null>(null);
  const [teamSelectorOpen, setTeamSelectorOpen] = useState(false);
  const [aliveTeams, setAliveTeams] = useState<Set<string>>(new Set());
  const crossTeamTargetsFetchPendingRef = useRef(false);
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
    if (!teamSelectorOpen || crossTeamTargetsFetchPendingRef.current) return;
    crossTeamTargetsFetchPendingRef.current = true;
    void fetchCrossTeamTargets()
      .catch(() => false)
      .finally(() => {
        crossTeamTargetsFetchPendingRef.current = false;
      });
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
  useComposerDraftAddressRequest({ request: draftAddressRequest, lockedRecipient, targets: crossTeamTargets, selectTeam: setSelectedTeam, selectMember: setCrossTeamRecipient });

  const isCrossTeam = selectedTeam !== null;
  const selectedTarget = sortedCrossTeamTargets.find((t) => t.teamName === selectedTeam);
  const targetDisplayName = selectedTarget?.displayName ?? selectedTeam;
  const selectedTargetMembers = useMemo(() => selectedTarget?.members ?? [], [selectedTarget]);
  const draftPreview = useCallback(
    (summary: ComposerWorkingSummary): string =>
      summary.preview ||
      [
        summary.chipCount > 0
          ? t('messages.chats.draftReferences', { count: summary.chipCount })
          : '',
        summary.attachmentCount > 0
          ? t('messages.chats.draftAttachments', { count: summary.attachmentCount })
          : '',
      ]
        .filter(Boolean)
        .join(', '),
    [t]
  );
  const crossTeamDrafts = useMemo(
    () =>
      workingDraftSummaries.filter(
        (summary) => summary.address.target.kind === 'cross-team'
      ),
    [workingDraftSummaries]
  );
  const draftMetaByTeam = useMemo(
    () => crossTeamDraftMeta(crossTeamDrafts, draftPreview),
    [crossTeamDrafts, draftPreview]
  );
  const selectedTeamDraftsByMember = useMemo(
    () => memberDraftPreviews(crossTeamDrafts, selectedTeam, draftPreview),
    [crossTeamDrafts, draftPreview, selectedTeam]
  );
  useEffect(() => {
    if (crossTeamRecipient && !selectedTargetMembers.some((m) => m.name === crossTeamRecipient))
      queueMicrotask(() => setCrossTeamRecipient(null));
  }, [crossTeamRecipient, selectedTargetMembers]);
  const crossTeamHintText = isCrossTeam ? t('messageComposer.crossTeam.hint') : undefined;
  const groupChatRecipient =
    members.find((member) => isLeadMember(member))?.name ?? members[0]?.name ?? '';
  const selectLocalGroupChat = useCallback(() => {
    setRecipient(groupChatRecipient);
    setGroupChatSelected(true);
  }, [groupChatRecipient]);
  const previousLockedRecipientRef = useRef(lockedRecipient);
  useEffect(() => {
    const previousLockedRecipient = previousLockedRecipientRef.current;
    previousLockedRecipientRef.current = lockedRecipient;
    if (!lockedRecipient) {
      if (!previousLockedRecipient) return;
      queueMicrotask(() => {
        setSelectedTeam(null);
        setCrossTeamRecipient(null);
        selectLocalGroupChat();
      });
      return;
    }
    if (
      lockedRecipient === recipient &&
      !groupChatSelected &&
      selectedTeam === null &&
      crossTeamRecipient === null
    ) {
      return;
    }
    queueMicrotask(() => {
      setSelectedTeam(null);
      setCrossTeamRecipient(null);
      setRecipient(lockedRecipient);
      setGroupChatSelected(false);
    });
  }, [
    crossTeamRecipient,
    groupChatSelected,
    lockedRecipient,
    recipient,
    selectLocalGroupChat,
    selectedTeam,
  ]);
  // Members load async with team data; keep recipient stable if valid, otherwise default to lead/first.
  useEffect(() => {
    if (lockedRecipient) return;
    if (recipient && members.some((m) => m.name === recipient)) {
      return;
    }
    const lead = members.find((m) => isLeadMember(m));
    const next = lead?.name ?? members[0]?.name ?? '';
    if (next && next !== recipient) {
      queueMicrotask(() => setRecipient(next));
    }
  }, [lockedRecipient, members, recipient]);

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
  const currentTeamDisplayName = useStore((s) =>
    s.selectedTeamName === teamName ? (s.selectedTeamData?.config.name ?? teamName) : teamName
  );
  const startupCopy = useTeamStartupCopy(teamName);
  const activeContextId = useStore((state) => state.activeContextId);
  const isContextSwitching = useStore((state) => state.isContextSwitching);
  const selectRevisionRecipient = useCallback((nextRecipient: string) => {
    setSelectedTeam(null);
    setRecipient(nextRecipient);
    setGroupChatSelected(false);
  }, []);
  const draft = useMessageComposerDraft({
    activeContextId,
    teamName,
    lockedRecipient,
    selectedTeam,
    crossTeamRecipient,
    groupChatSelected,
    recipient,
    revisionRequest,
    onSelectRevisionRecipient: selectRevisionRecipient,
    onDraftMutation,
    onRecoveryDestinationChange,
    onRevisionPreparationChange,
    focusComposer: focusComposerTextarea,
  });
  const submissionFeedback = useComposerSubmissionFeedback(
    draft.addressKey,
    sendWarning,
    sendDebugDetails,
    lastResult
  );
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
  const isLaunchBlocking = startupCopy.isProvisioning && !isTeamAlive;

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

  const effectiveRecipient =
    lockedRecipient ?? (groupChatSelected ? groupChatRecipient : recipient);
  const selectedMember = members.find((m) => m.name === effectiveRecipient);
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
  const canDelegate = isCrossTeam ? crossTeamRecipient === null : hasTeammates && isLeadRecipient;
  const shouldAutoDelegate = canDelegate && (isCrossTeam || isLeadRecipient);

  const { actionMode, setActionMode, isLoaded: draftLoaded } = draft;

  // Re-focus textarea after action mode changes (Do/Ask/Delegate button clicks)
  const prevActionModeRef = useRef(actionMode);
  useEffect(() => {
    if (prevActionModeRef.current !== actionMode) {
      prevActionModeRef.current = actionMode;
      focusComposerTextarea();
    }
  }, [actionMode, focusComposerTextarea]);

  useAutoDelegateActionMode({
    addressKey: draft.addressKey,
    isLoaded: draftLoaded,
    canDelegate,
    shouldAutoDelegate,
    actionMode,
    setActionMode,
  });
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
  const activeRevision = draft.revisionContext;
  const isRevisionActive = activeRevision !== null;
  const revisionOriginalValid =
    activeRevision == null ||
    revisableMessageId === undefined ||
    activeRevision.originalMessageId === revisableMessageId;
  const revisionRecipientMatches =
    activeRevision == null ||
    (draft.address.target.kind === 'direct' &&
      draft.address.target.participant ===
        normalizeConversationParticipant(activeRevision.recipient) &&
      normalizeConversationParticipant(effectiveRecipient) ===
        normalizeConversationParticipant(activeRevision.recipient));
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
    effectiveRecipient.length > 0 &&
    trimmed.length > 0 &&
    trimmed.length <= MAX_TEXT_LENGTH &&
    !sending &&
    !isContextSwitching &&
    draft.canSubmit &&
    !isLaunchBlocking &&
    !attachmentsBlocked &&
    !slashCommandRestrictionReason &&
    (!isRevisionActive || (!isCrossTeam && revisionRecipientMatches && revisionOriginalValid)) &&
    (!isCrossTeam || onCrossTeamSend !== undefined);

  const handleCycleActionMode = useCallback(() => {
    if (sending) return;
    const modes: ActionMode[] = canDelegate ? ['do', 'ask', 'delegate'] : ['do', 'ask'];
    const idx = modes.indexOf(actionMode);
    setActionMode(modes[(idx + 1) % modes.length]);
  }, [actionMode, canDelegate, sending, setActionMode]);

  const handleSend = useCallback(() => {
    if (!canSend) return;
    dismissMentionsRef.current?.();
    onSubmitIntent?.();
    const attemptId = createPendingSendId();
    const submissionAddressKey = draft.addressKey;
    const submissionAddress = draft.address;
    const capturedContextId = activeContextId;
    const capturedContextEpoch = captureContextScopedRequestEpoch();
    const taskRefs = extractTaskRefsFromText(draft.text, taskSuggestions);
    const serialized = serializeChipsWithText(trimmed, draft.chips);
    const outboundText = activeRevision
      ? buildRevisionCorrectionText(activeRevision.originalMessageId, serialized)
      : serialized;
    const outboundSummary = activeRevision
      ? `Correction for MessageId: ${activeRevision.originalMessageId}`
      : trimmed;
    const preparedRequest =
      isCrossTeam && selectedTeam && !lockedRecipient
        ? {
            kind: 'cross-team' as const,
            request: {
              fromTeam: teamName,
              fromMember: 'user',
              toTeam: selectedTeam,
              ...(crossTeamRecipient ? { toMember: crossTeamRecipient } : {}),
              text: outboundText,
              summary: outboundSummary,
              actionMode,
              taskRefs,
            },
          }
        : {
            kind: 'local' as const,
            teamName,
            request: {
              member: effectiveRecipient,
              text: outboundText,
              summary: outboundSummary,
              attachments: draft.attachments.length ? draft.attachments : undefined,
              actionMode,
              taskRefs,
            },
          };
    const revisionRequestId = activeRevision?.requestId;
    void runComposerSubmission({
      attemptId,
      prepare: () => draft.beginAttempt(attemptId, preparedRequest),
      isContextCurrent: () => {
        const store = useStore.getState();
        return (
          !store.isContextSwitching &&
          store.activeContextId === capturedContextId &&
          isContextScopedRequestEpochCurrent(capturedContextEpoch)
        );
      },
      transport: () =>
        preparedRequest.kind === 'cross-team'
          ? (onCrossTeamSend?.(
              preparedRequest.request.toTeam,
              preparedRequest.request.text,
              preparedRequest.request.summary,
              preparedRequest.request.actionMode,
              preparedRequest.request.taskRefs,
              preparedRequest.request.toMember
            ) ?? Promise.resolve(null))
          : onSend(
              preparedRequest.request.member,
              preparedRequest.request.text,
              preparedRequest.request.summary,
              preparedRequest.request.attachments,
              preparedRequest.request.actionMode,
              preparedRequest.request.taskRefs
            ),
    }).then((result) => {
      submissionFeedback.record(submissionAddressKey, result);
      if (result.kind === 'accepted' && revisionRequestId) {
        onRevisionComplete?.(revisionRequestId, submissionAddress);
      }
    });
    focusComposerTextarea();
  }, [
    actionMode,
    canSend,
    lockedRecipient,
    effectiveRecipient,
    trimmed,
    onSend,
    onCrossTeamSend,
    isCrossTeam,
    selectedTeam,
    crossTeamRecipient,
    activeContextId,
    activeRevision,
    draft,
    focusComposerTextarea,
    onRevisionComplete,
    onSubmitIntent,
    submissionFeedback,
    taskSuggestions,
    teamName,
  ]);

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
    draft.clearRevision();
    onRevisionCancel?.();
    focusComposerTextarea();
  }, [draft, focusComposerTextarea, onRevisionCancel]);

  const remaining = MAX_TEXT_LENGTH - trimmed.length;
  const hasAttachmentPreviewContent =
    draft.attachments.length > 0 || Boolean(draft.attachmentError ?? fileRestrictionError);
  const isCompactLayout = layout === 'compact';
  const floatingAdaptiveStyle = useFloatingComposerWidth({
    enabled: widthMode === 'floating-adaptive',
    text: draft.text,
    attachmentCount: draft.attachments.length,
    textareaRef: internalTextareaRef,
  });
  const revisionNotice = activeRevision || revisionPreparation ? (
    <MessageComposerRevisionNotice
      active={activeRevision !== null}
      originalValid={revisionOriginalValid}
      preparation={revisionPreparation}
      onCancel={handleRevisionCancel}
      onStash={draft.stashWorking}
    />
  ) : null;
  const hasStatusNotice = Boolean(
    draft.readError ||
    draft.persistenceStatus === 'memory-only' ||
    draft.snapshot().restoredOrigin ||
    slashCommandRestrictionReason ||
    submissionFeedback.submissionError ||
    submissionFeedback.sendWarning ||
    submissionFeedback.deduplicated
  );
  const compactFooterNotice = hasStatusNotice ? (
    <MessageComposerStatusNotice
      readError={draft.readError}
      persistenceStatus={draft.persistenceStatus}
      restoredDeliveryUnknown={draft.snapshot().restoredOrigin != null}
      restrictionReason={slashCommandRestrictionReason}
      submissionError={submissionFeedback.submissionError}
      sendWarning={submissionFeedback.sendWarning}
      sendDebugDetails={submissionFeedback.sendDebugDetails}
      deduplicated={submissionFeedback.deduplicated}
    />
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
            {lockedRecipient ? (
              <ComposerLockedRecipient
                name={lockedRecipient}
                color={colorMap.get(lockedRecipient)}
                avatarUrl={avatarMap.get(lockedRecipient)}
              />
            ) : (
              <div
                className={cn(
                  'message-composer-target-selectors flex w-fit min-w-0 max-w-full items-stretch overflow-hidden text-xs',
                  isCrossTeam && 'bg-[var(--cross-team-bg)]'
                )}
              >
                <MessageComposerTeamSelector
                  currentTeamColor={currentTeamColor}
                  currentTeamDisplayName={currentTeamDisplayName}
                  hasCrossTeamOptions={hasCrossTeamOptions}
                  isCrossTeam={isCrossTeam}
                  open={teamSelectorOpen}
                  selectedTarget={selectedTarget}
                  selectedTeam={selectedTeam}
                  sortedCrossTeamTargets={sortedCrossTeamTargets}
                  targetDisplayName={targetDisplayName}
                  draftMetaByTeam={draftMetaByTeam}
                  onOpenChange={setTeamSelectorOpen}
                  onSelectCurrent={() => {
                    setSelectedTeam(null);
                    setCrossTeamRecipient(null);
                    selectLocalGroupChat();
                    setTeamSelectorOpen(false);
                    focusComposerTextarea();
                  }}
                  onSelectTarget={(nextTeam) => {
                    setSelectedTeam(nextTeam);
                    setCrossTeamRecipient(null);
                    setTeamSelectorOpen(false);
                    focusComposerTextarea();
                  }}
                />

                <Popover open={recipientOpen} onOpenChange={setRecipientOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'message-composer-recipient-selector inline-flex min-w-0 items-center justify-end gap-1 overflow-hidden whitespace-nowrap pl-2 pr-1 text-xs transition-colors',
                        isCrossTeam
                          ? 'hover:bg-[var(--cross-team-bg)]/80 bg-[var(--cross-team-bg)]'
                          : 'hover:bg-white/[0.025]'
                      )}
                    >
                      {(isCrossTeam ? crossTeamRecipient !== null : !groupChatSelected) ? (
                        <MemberBadge
                          name={isCrossTeam ? (crossTeamRecipient ?? '') : recipient}
                          color={
                            isCrossTeam
                              ? selectedTargetMembers.find(
                                  (member) => member.name === crossTeamRecipient
                                )?.color
                              : selectedResolvedColor
                          }
                          size="sm"
                          avatarUrl={isCrossTeam ? undefined : avatarMap.get(recipient)}
                          hideAvatar={!isCrossTeam && recipient === 'user'}
                          disableHoverCard
                          variant="text"
                        />
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-[var(--color-text-secondary)]">
                          <span
                            className="inline-block size-2 shrink-0 rounded-full"
                            style={{
                              backgroundColor: isCrossTeam
                                ? selectedTarget?.color
                                  ? getTeamColorSet(selectedTarget.color).border
                                  : nameColorSet(targetDisplayName ?? '').border
                                : currentTeamColor,
                            }}
                          />
                          {t('messages.chats.teamFeed')}
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
                    {(isCrossTeam ? selectedTargetMembers.length : members.length) > 5 && (
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
                      <button
                        type="button"
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-raised)]',
                          (isCrossTeam ? crossTeamRecipient === null : groupChatSelected) &&
                            'bg-[var(--color-surface-raised)]'
                        )}
                        onClick={() => {
                          if (isCrossTeam) {
                            setCrossTeamRecipient(null);
                          } else {
                            selectLocalGroupChat();
                          }
                          setRecipientOpen(false);
                          setRecipientSearch('');
                          focusComposerTextarea();
                        }}
                      >
                        <span
                          className="inline-block size-2 shrink-0 rounded-full"
                          style={{
                            backgroundColor: isCrossTeam
                              ? selectedTarget?.color
                                ? getTeamColorSet(selectedTarget.color).border
                                : nameColorSet(targetDisplayName ?? '').border
                              : currentTeamColor,
                          }}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[var(--color-text)]">
                            {t('messages.chats.teamFeed')}
                          </span>
                          {isCrossTeam && selectedTeamDraftsByMember.has('') ? (
                            <span className="block truncate text-[10px] text-[var(--color-text-secondary)]">
                              <span className="font-medium text-blue-400">
                                {t('messages.chats.draft')}:
                              </span>{' '}
                              {selectedTeamDraftsByMember.get('')}
                            </span>
                          ) : null}
                        </span>
                        {(isCrossTeam ? crossTeamRecipient === null : groupChatSelected) ? (
                          <Check size={12} className="ml-auto shrink-0 text-blue-400" />
                        ) : null}
                      </button>
                      <div className="my-1 h-px bg-[var(--color-border)]" />
                      {/* eslint-disable-next-line sonarjs/function-return-type -- IIFE rendering mixed elements/null */}
                      {(() => {
                        const query = recipientSearch.toLowerCase().trim();
                        const availableMembers = isCrossTeam ? selectedTargetMembers : members;
                        const filtered = query
                          ? availableMembers.filter((m) => m.name.toLowerCase().includes(query))
                          : availableMembers;
                        if (filtered.length === 0) {
                          return (
                            <div className="px-2 py-3 text-center text-xs text-[var(--color-text-muted)]">
                              {t('messageComposer.recipient.noResults')}
                            </div>
                          );
                        }
                        const sorted = [...filtered].sort((a, b) => {
                          const aIsLead = isCrossTeam
                            ? a.name === selectedTarget?.leadName
                              ? 1
                              : 0
                            : isLeadMember(a)
                              ? 1
                              : 0;
                          const bIsLead = isCrossTeam
                            ? b.name === selectedTarget?.leadName
                              ? 1
                              : 0
                            : isLeadMember(b)
                              ? 1
                              : 0;
                          return bIsLead - aIsLead;
                        });
                        return sorted.map((m) => {
                          const resolvedColor = isCrossTeam ? m.color : colorMap.get(m.name);
                          const role =
                            formatAgentRole(m.role) ??
                            (!isCrossTeam
                              ? formatAgentRole((m as ResolvedTeamMember).agentType)
                              : undefined);
                          const isSelected = isCrossTeam
                            ? m.name === crossTeamRecipient
                            : !groupChatSelected && m.name === recipient;
                          return (
                            <button
                              key={m.name}
                              type="button"
                              className={cn(
                                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-raised)]',
                                isSelected && 'bg-[var(--color-surface-raised)]'
                              )}
                              onClick={() => {
                                if (isCrossTeam) {
                                  setCrossTeamRecipient(m.name);
                                } else {
                                  setRecipient(m.name);
                                  setGroupChatSelected(false);
                                }
                                setRecipientOpen(false);
                                setRecipientSearch('');
                                focusComposerTextarea();
                              }}
                            >
                              <span className="min-w-0 flex-1">
                                <MemberBadge
                                  name={m.name}
                                  color={resolvedColor}
                                  size="sm"
                                  avatarUrl={avatarMap.get(m.name)}
                                  hideAvatar={m.name === 'user'}
                                  disableHoverCard
                                />
                                {isCrossTeam && selectedTeamDraftsByMember.has(m.name) ? (
                                  <span className="block truncate pl-5 text-[10px] text-[var(--color-text-secondary)]">
                                    <span className="font-medium text-blue-400">
                                      {t('messages.chats.draft')}:
                                    </span>{' '}
                                    {selectedTeamDraftsByMember.get(m.name)}
                                  </span>
                                ) : null}
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
                        });
                      })()}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            )}
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
          suggestionPlacement={suggestionPlacement}
          ref={textareaRef}
          connectedToHeader
          id={`compose-${teamName}`}
          placeholder={
            isLaunchBlocking
              ? startupCopy.placeholder
              : isCrossTeam
                ? t('messageComposer.input.crossTeamPlaceholder', {
                    team: targetDisplayName ?? t('messageComposer.input.teamFallback'),
                  })
                : t('messageComposer.input.placeholder')
          }
          value={draft.text}
          readOnly={draft.isRestoring}
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
                      <TooltipContent side="top">{startupCopy.sendingUnavailable}</TooltipContent>
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
