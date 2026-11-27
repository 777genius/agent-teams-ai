import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useDirectMessageQueue } from '@features/manual-message-queue/renderer';
import { useComposerNativeNextPrompt } from '@features/native-prompt-suggestions/renderer';
import { normalizeConversationParticipant } from '@features/team-direct-chats/renderer';
import { useProjectCopyOwnerName } from '@features/team-project-context/renderer';
import { api } from '@renderer/api';
import { AttachmentCatalogRefresh } from '@renderer/components/team/attachments/AttachmentCatalogRefresh';
import { AttachmentPreviewList } from '@renderer/components/team/attachments/AttachmentPreviewList';
import { DropZoneOverlay } from '@renderer/components/team/attachments/DropZoneOverlay';
import { ComposerSurface } from '@renderer/components/team/composer/ComposerSurface';
import { ComposerLockedRecipient } from '@renderer/components/team/messages/ComposerLockedRecipient';
import { useTeamStartupCopy } from '@renderer/components/team/useTeamStartupCopy';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useAttachmentValidation } from '@renderer/hooks/useAttachmentValidation';
import { useRecipientAttachmentDeclarations } from '@renderer/hooks/useRecipientAttachmentDeclarations';
import {
  getTaskSuggestionsForTeamNow,
  useTaskSuggestions,
} from '@renderer/hooks/useTaskSuggestions';
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
  getMemberAttachmentUnavailableReason,
  validateAttachmentPayloadsForMember,
} from '@renderer/utils/attachmentRecipientCapabilities';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberAvatarMap, buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { nameColorSet } from '@renderer/utils/projectColor';
import { getSuggestedSlashCommandsForProvider } from '@renderer/utils/providerSlashCommands';
import {
  buildCapturedSlashCommandSuggestions,
  buildSlashCommandSuggestions,
} from '@renderer/utils/skillCommandSuggestions';
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
import { useShallow } from 'zustand/react/shallow';

import { ComposerAttachmentButton } from './ComposerAttachmentButton';
import { crossTeamDraftMeta, memberDraftPreviews } from './composerDraftPreviews';
import {
  buildPreparedSendRequest,
  buildRevisionCorrectionText,
  createPendingSendId,
  isPreparedSendAllowed,
  preparedAutonomousGoalArgs,
  preparedCrossTeamReplyArgs,
} from './composerSendUtils';
import { runComposerSubmission } from './composerSubmission';
import { AutonomousGoalStatusNotice, ComposerExecutionControls } from './ContinueUntilDoneControl';
import { MessageComposerFooter, MessageComposerInput } from './MessageComposerInput';
import { MessageComposerRecipientSelector } from './MessageComposerRecipientSelector';
import { MessageComposerRevisionNotice } from './MessageComposerRevisionNotice';
import { renderMessageComposerStatusNotice } from './composerStatusNotice';
import { MessageComposerTeamSelector } from './MessageComposerTeamSelector';
import { acquireRevisionOperation, releaseRevisionOperation } from './revisionOperationLease';
import { TeamFeedMessageComposer } from './TeamFeedMessageComposer';
import { TextMessageComposer, type TextMessageComposerProps } from './TextMessageComposer';
import { useAutoDelegateActionMode } from './useAutoDelegateActionMode';
import { useComposerAutonomousGoal } from './useComposerAutonomousGoal';
import { useComposerDraftAddressRequest } from './useComposerDraftAddressRequest';
import { useComposerSubmissionFeedback } from './useComposerSubmissionFeedback';
import { useComposerFocus, useComposerTextarea } from './useComposerTextarea';
import { useFileRestrictionNotice } from './useFileRestrictionNotice';
import { useFloatingComposerWidth } from './useFloatingComposerWidth';
import { useMessageComposerDraft } from './useMessageComposerDraft';
import { useMessageComposerRevisionCancel } from './useMessageComposerRevisionCancel';

import type { MemberMessageComposerProps } from './MessageComposer.types';
import type { ActionMode } from '@renderer/components/team/messages/ActionModeSelector';
import type {
  ComposerPreparedRequest,
  ComposerWorkingSummary,
} from '@renderer/types/composerDraft';
import type { MentionSuggestion } from '@renderer/types/mention';
import type { ResolvedTeamMember } from '@shared/types';

const EMPTY_MENTION_SUGGESTIONS: MentionSuggestion[] = [];
const EMPTY_SKILL_CATALOG = [] as const;

type MessageComposerProps = MemberMessageComposerProps | TextMessageComposerProps;

/** Select the editor before mounting member-only draft and recipient hooks. */
export const MessageComposer = (props: MessageComposerProps): React.JSX.Element =>
  'textInput' in props ? (
    <TextMessageComposer {...props} />
  ) : props.lockedRecipient || !props.groupBroadcast ? (
    <MemberMessageComposer {...props} />
  ) : (
    <TeamFeedMessageComposer {...props} renderMember={renderMemberComposer} />
  );

const renderMemberComposer = (props: MemberMessageComposerProps): React.JSX.Element => (
  <MemberMessageComposer {...props} />
);

const MemberMessageComposer = ({
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
  initialRecipient,
  onSelectAll,
  autoFocusKey,
  draftAddressRequest,
  crossTeamReply,
  workingDraftSummaries = [],
  onSend,
  onCrossTeamSend,
  onSubmitIntent,
  onDraftMutation,
  onRecoveryDestinationChange,
  onRevisionPreparationChange,
  onRevisionCancel,
  onRevisionComplete,
}: MemberMessageComposerProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { textareaRef, internalTextareaRef, focusComposerTextarea } = useComposerTextarea(
    externalTextareaRef,
    autoFocusKey
  );
  const [recipient, setRecipient] = useState<string>(() => {
    const lead = members.find((m) => isLeadMember(m));
    return initialRecipient ?? lead?.name ?? members[0]?.name ?? '';
  });
  const [groupChatSelected, setGroupChatSelected] = useState(
    () =>
      !lockedRecipient &&
      (!initialRecipient ||
        members.some((member) => member.name === initialRecipient && isLeadMember(member)))
  );
  const composerFocus = useComposerFocus();
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  // Hide the current execution team and its logical owner in every tab.
  const ownTeam = useProjectCopyOwnerName(teamName);
  const crossTeamTargets = useMemo(
    () => allCrossTeamTargets.filter((t) => t.teamName !== teamName && t.teamName !== ownTeam),
    [allCrossTeamTargets, ownTeam, teamName]
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
  useComposerDraftAddressRequest({
    request: draftAddressRequest,
    lockedRecipient,
    targets: crossTeamTargets,
    selectTeam: setSelectedTeam,
    selectMember: setCrossTeamRecipient,
  });

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
    () => workingDraftSummaries.filter((summary) => summary.address.target.kind === 'cross-team'),
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
  const commandLead = useMemo(() => members.find((member) => isLeadMember(member)), [members]);
  const leadProviderId =
    normalizeOptionalTeamProviderId(commandLead?.providerId) ??
    inferTeamProviderIdFromModel(commandLead?.model);

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
    if (!slashCommandDataEnabled || commandLead?.runtimeOwner === 'captured-host') return;
    void fetchSkillsCatalog(projectPath ?? undefined);
  }, [fetchSkillsCatalog, projectPath, slashCommandDataEnabled, commandLead?.runtimeOwner]);

  const slashCommandSuggestions = useMemo<MentionSuggestion[]>(
    () =>
      commandLead?.runtimeOwner === 'captured-host'
        ? buildCapturedSlashCommandSuggestions(commandLead.sessionCommands)
        : slashCommandDataEnabled
          ? buildSlashCommandSuggestions(
              getSuggestedSlashCommandsForProvider(leadProviderId),
              projectSkills,
              userSkills,
              leadProviderId
            )
          : EMPTY_MENTION_SUGGESTIONS,
    [leadProviderId, projectSkills, slashCommandDataEnabled, userSkills, commandLead]
  );

  const trimmed = stripEncodedTaskReferenceMetadata(draft.text).trim();
  const standaloneSlashCommand = useMemo(() => parseStandaloneSlashCommand(trimmed), [trimmed]);

  const effectiveRecipient =
    lockedRecipient ?? (groupChatSelected ? groupChatRecipient : recipient);
  const selectedMember = members.find((m) => m.name === effectiveRecipient);
  const isLeadRecipient = selectedMember ? isLeadMember(selectedMember) : false;
  const {
    resolveDeclaration,
    refresh: refreshDeclarations,
    isOpenCode: isOpenCodeRecipient,
  } = useRecipientAttachmentDeclarations(selectedMember, projectPath, !!isTeamAlive);
  const showAttachmentControl = canMemberShowAttachmentControl(selectedMember);
  const memberAttachmentUnavailableReason = showAttachmentControl
    ? getMemberAttachmentUnavailableReason(selectedMember)
    : null;
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
    resolveDeclaration,
  });
  const attachmentsBlocked =
    draft.attachments.length > 0 &&
    (!supportsAttachments || attachmentPayloadRestrictionReason != null);
  const activeRevision = draft.revisionContext;
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
            : selectedMember?.runtimeOwner === 'captured-host' &&
                !selectedMember.sessionCommands?.some(
                  (command) => command.name === standaloneSlashCommand.name
                )
              ? t('modelSelector.unavailableInRuntime')
              : null
    : null;
  const { goalAvailable, goalStatus, goalEligible, goalOptionsValid, goalRestrictionReason } =
    useComposerAutonomousGoal(teamName, draft, {
      isLeadRecipient,
      isCrossTeam,
      isTeamAlive,
      nativeCommand: !!standaloneSlashCommand,
    });
  const canSend =
    (!draft.autonomousGoal || (goalEligible && goalOptionsValid)) &&
    effectiveRecipient.length > 0 &&
    trimmed.length > 0 &&
    trimmed.length <= MAX_TEXT_LENGTH &&
    !sending &&
    !isContextSwitching &&
    draft.canSubmit &&
    !isLaunchBlocking &&
    !attachmentsBlocked &&
    !slashCommandRestrictionReason &&
    (!activeRevision || (!isCrossTeam && revisionRecipientMatches && revisionOriginalValid)) &&
    (!isCrossTeam || onCrossTeamSend !== undefined);
  const currentSendEligibilityRef = useRef<
    (
      content: ReturnType<typeof draft.snapshot>,
      request: ComposerPreparedRequest,
      editorContext: typeof draft.editorContext
    ) => boolean
  >(() => false);
  currentSendEligibilityRef.current = (content, request, editorContext) =>
    isPreparedSendAllowed(
      content,
      request,
      members,
      teamName,
      isTeamAlive,
      resolveDeclaration,
      goalAvailable
    ) &&
    (!content.autonomousGoal || editorContext.kind === 'plain') &&
    (editorContext.kind !== 'revision' ||
      ((activeRevision == null || editorContext.requestId === activeRevision.requestId) &&
        (revisableMessageId === undefined ||
          editorContext.originalMessageId === revisableMessageId)));

  const manualQueue = useDirectMessageQueue({
    teamName,
    recipient: effectiveRecipient,
    members,
    draft,
    onSend,
    disabled: isContextSwitching || sending || isLaunchBlocking || !!draft.autonomousGoal,
    isCrossTeam,
  });
  const isCompactLayout = layout === 'compact';
  const nativeSuggestion = useComposerNativeNextPrompt({
    teamName,
    recipient: effectiveRecipient,
    memberId:
      selectedMember?.runtimeOwner === 'captured-host' ? selectedMember.hostMemberId : undefined,
    draft,
    focusComposerTextarea,
    editable:
      draft.address.target.kind === 'direct' &&
      !groupChatSelected &&
      !isCrossTeam &&
      !!isTeamAlive &&
      !sending &&
      !isContextSwitching &&
      !isLaunchBlocking &&
      draft.isLoaded &&
      !draft.isRestoring,
    editingQueueOrRevision: activeRevision !== null || revisionPreparation != null,
    compact: isCompactLayout,
    labels: [
      t('messageComposer.suggestions.insert'),
      t('messageComposer.suggestions.dismiss'),
      t('messageComposer.suggestions.tab'),
    ],
  });
  const handleCycleActionMode = useCallback(() => {
    if (sending) return;
    const modes: ActionMode[] = canDelegate ? ['do', 'ask', 'delegate'] : ['do', 'ask'];
    const idx = modes.indexOf(actionMode);
    setActionMode(modes[(idx + 1) % modes.length]);
  }, [actionMode, canDelegate, sending, setActionMode]);

  const { fileRestrictionError, setFileRestrictionError, showFileRestrictionError } =
    useFileRestrictionNotice(
      t('messageComposer.attachments.restrictions.leadOnly'),
      attachmentRestrictionReason,
      attachmentPayloadRestrictionReason
    );

  const { validateFiles: validateSelectedAttachmentFiles, validatePayloads } =
    useAttachmentValidation(selectedMember, resolveDeclaration, showFileRestrictionError);

  const handleSend = useCallback(() => {
    if (!canSend) return;
    if (!validatePayloads(draft.attachments)) return;
    dismissMentionsRef.current?.();
    nativeSuggestion.invalidate();
    onSubmitIntent?.();
    const attemptId = createPendingSendId();
    const submissionAddressKey = draft.addressKey;
    const submissionAddress = draft.address;
    const capturedContextId = activeContextId;
    const capturedContextEpoch = captureContextScopedRequestEpoch();
    const revisionRequestId = activeRevision?.requestId;
    if (revisionRequestId && !acquireRevisionOperation(revisionRequestId, 'send')) return;
    void runComposerSubmission({
      attemptId,
      contextId: capturedContextId,
      prepare: () =>
        draft.beginAttempt(attemptId, (snapshot) => {
          const { content, editorContext } = snapshot;
          const syncedRevision = editorContext.kind === 'revision' ? editorContext : null;
          if (syncedRevision?.requestId !== revisionRequestId) return null;
          const syncedTrimmed = stripEncodedTaskReferenceMetadata(content.text).trim();
          if (!syncedTrimmed || syncedTrimmed.length > MAX_TEXT_LENGTH) return null;
          const serialized = serializeChipsWithText(syncedTrimmed, content.chips);
          const outboundText = syncedRevision
            ? buildRevisionCorrectionText(syncedRevision.originalMessageId, serialized)
            : serialized;
          const request = buildPreparedSendRequest({
            attemptId,
            originalGoalRequest: content.restoredOrigin?.autonomousGoalRequest,
            teamName,
            selectedTeam,
            lockedRecipient,
            crossTeamRecipient,
            crossTeamReply,
            localRecipient: effectiveRecipient,
            text: outboundText,
            summary: syncedRevision
              ? `Correction for MessageId: ${syncedRevision.originalMessageId}`
              : syncedTrimmed,
            attachments: content.attachments,
            actionMode: content.actionMode,
            ...(content.autonomousGoal ? { autonomousGoal: content.autonomousGoal } : {}),
            taskRefs: extractTaskRefsFromText(
              content.text,
              content.text.includes('#') ? getTaskSuggestionsForTeamNow(teamName) : taskSuggestions
            ),
          });
          return currentSendEligibilityRef.current(content, request, editorContext)
            ? request
            : null;
        }),
      isContextCurrent: (prepared) => {
        const store = useStore.getState();
        return (
          !store.isContextSwitching &&
          store.activeContextId === capturedContextId &&
          isContextScopedRequestEpochCurrent(capturedContextEpoch) &&
          currentSendEligibilityRef.current(
            prepared.attempt.snapshot.content,
            prepared.attempt.preparedRequest,
            prepared.attempt.snapshot.editorContext
          )
        );
      },
      transport: ({ attempt: { preparedRequest } }) =>
        preparedRequest.kind === 'cross-team'
          ? (onCrossTeamSend?.(
              preparedRequest.request.toTeam,
              preparedRequest.request.text,
              preparedRequest.request.summary,
              preparedRequest.request.actionMode,
              preparedRequest.request.taskRefs,
              preparedRequest.request.toMember,
              preparedRequest.request.messageId,
              ...preparedCrossTeamReplyArgs(preparedRequest.request)
            ) ?? Promise.resolve(null))
          : onSend(
              preparedRequest.request.member,
              preparedRequest.request.text,
              preparedRequest.request.summary,
              preparedRequest.request.attachments,
              preparedRequest.request.actionMode,
              preparedRequest.request.taskRefs,
              preparedRequest.request.messageId,
              ...preparedAutonomousGoalArgs(preparedRequest.request)
            ),
    })
      .then((result) => {
        submissionFeedback.record(submissionAddressKey, result);
        if (result.kind === 'accepted' && revisionRequestId) {
          onRevisionComplete?.(revisionRequestId, submissionAddress);
        }
      })
      .finally(() => {
        if (revisionRequestId) releaseRevisionOperation(revisionRequestId, 'send');
      });
    focusComposerTextarea();
  }, [
    canSend,
    validatePayloads,
    lockedRecipient,
    effectiveRecipient,
    onSend,
    onCrossTeamSend,
    crossTeamReply,
    selectedTeam,
    crossTeamRecipient,
    activeContextId,
    activeRevision,
    draft,
    focusComposerTextarea,
    onRevisionComplete,
    onSubmitIntent,
    nativeSuggestion,
    submissionFeedback,
    taskSuggestions,
    teamName,
  ]);

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
  const handleRevisionCancel = useMessageComposerRevisionCancel(
    draft,
    onRevisionCancel,
    focusComposerTextarea
  );
  const remaining = MAX_TEXT_LENGTH - trimmed.length;
  const hasAttachmentPreviewContent =
    draft.attachments.length > 0 || Boolean(draft.attachmentError ?? fileRestrictionError);
  const floatingAdaptiveStyle = useFloatingComposerWidth({
    enabled: widthMode === 'floating-adaptive',
    text: draft.text,
    attachmentCount: draft.attachments.length,
    textareaRef: internalTextareaRef,
  });
  const revisionNotice =
    activeRevision || revisionPreparation ? (
      <MessageComposerRevisionNotice
        active={activeRevision !== null}
        originalValid={revisionOriginalValid}
        preparation={revisionPreparation}
        onCancel={handleRevisionCancel}
        onStash={draft.stashWorking}
      />
    ) : null;
  const compactFooterNotice = renderMessageComposerStatusNotice({
    readError: draft.readError,
    persistenceStatus: draft.persistenceStatus,
    restoredDeliveryUnknown: draft.snapshot().restoredOrigin != null,
    restrictionReason: goalRestrictionReason ?? slashCommandRestrictionReason,
    submissionError: submissionFeedback.submissionError,
    sendWarning: submissionFeedback.sendWarning,
    sendDebugDetails: submissionFeedback.sendDebugDetails,
    deduplicated: submissionFeedback.deduplicated,
  });
  const shouldShowSavedIndicator = composerFocus.isTextareaFocused && draft.isSaved;
  const nonCompactFooterRight =
    compactFooterNotice || remaining < 200 || shouldShowSavedIndicator ? (
      <MessageComposerFooter remaining={remaining} showSaved={shouldShowSavedIndicator}>
        {compactFooterNotice}
      </MessageComposerFooter>
    ) : null;
  const composerFooterRight = isCompactLayout ? compactFooterNotice : nonCompactFooterRight;

  return (
    <ComposerSurface
      className={cn(!isCompactLayout && 'mb-2')}
      style={floatingAdaptiveStyle}
      role="group"
      onBlurCapture={composerFocus.onBlurCapture}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDropWrapper}
      onPaste={handlePasteWrapper}
    >
      <div>
        {goalStatus && !isCrossTeam && isLeadRecipient ? (
          <AutonomousGoalStatusNotice
            key={goalStatus.goalId}
            teamName={teamName}
            goal={goalStatus}
          />
        ) : null}
        <div className="message-composer-flat-toolbar grid min-w-0 grid-cols-[32px_minmax(0,1fr)] items-center gap-2 pl-2">
          <ComposerAttachmentButton
            visible={showAttachmentControl}
            enabled={canAttach}
            member={selectedMember}
            reason={attachmentRestrictionReason}
            inputRef={fileInputRef}
            onChange={handleFileInputChange}
          />

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

                <MessageComposerRecipientSelector
                  members={(isCrossTeam ? selectedTargetMembers : members).map((member) => ({
                    name: member.name,
                    color: isCrossTeam ? member.color : colorMap.get(member.name),
                    avatarUrl: isCrossTeam ? undefined : avatarMap.get(member.name),
                    role:
                      formatAgentRole(member.role) ??
                      (!isCrossTeam
                        ? formatAgentRole((member as ResolvedTeamMember).agentType)
                        : undefined) ??
                      undefined,
                    isLead: isCrossTeam
                      ? member.name === selectedTarget?.leadName
                      : isLeadMember(member as ResolvedTeamMember),
                    draftPreview: isCrossTeam
                      ? selectedTeamDraftsByMember.get(member.name)
                      : undefined,
                  }))}
                  selectedName={
                    isCrossTeam
                      ? crossTeamRecipient
                      : groupChatSelected
                        ? onSelectAll
                          ? groupChatRecipient
                          : null
                        : recipient
                  }
                  allLabel={t(
                    !isCrossTeam && onSelectAll
                      ? 'messageComposer.recipient.all'
                      : 'messages.chats.teamFeed'
                  )}
                  allColor={
                    isCrossTeam
                      ? selectedTarget?.color
                        ? getTeamColorSet(selectedTarget.color).border
                        : nameColorSet(targetDisplayName ?? '').border
                      : currentTeamColor
                  }
                  allDraftPreview={isCrossTeam ? selectedTeamDraftsByMember.get('') : undefined}
                  crossTeam={isCrossTeam}
                  onSelect={(name) => {
                    if (isCrossTeam) setCrossTeamRecipient(name);
                    else if (name === null) {
                      if (onSelectAll) onSelectAll();
                      else selectLocalGroupChat();
                    } else if (onSelectAll && name === groupChatRecipient) selectLocalGroupChat();
                    else {
                      setRecipient(name);
                      setGroupChatSelected(false);
                    }
                    focusComposerTextarea();
                  }}
                />
              </div>
            )}
          </div>
        </div>

        {hasAttachmentPreviewContent ? (
          <div className="px-2 pt-2">
            <AttachmentPreviewList
              attachments={draft.attachments}
              member={selectedMember}
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

      <AttachmentCatalogRefresh
        visible={!!isOpenCodeRecipient && (attachmentsBlocked || !!fileRestrictionError)}
        onRefresh={() => {
          setFileRestrictionError(null);
          refreshDeclarations();
        }}
      />
      {manualQueue.list}
      {nativeSuggestion.row}
      <div className="relative">
        <DropZoneOverlay
          active={isDragOver}
          rejected={!canAttach}
          rejectionReason={attachmentRestrictionReason}
        />
        <MessageComposerInput
          suggestionPlacement={suggestionPlacement}
          textareaRef={textareaRef}
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
          onCompositionStart={nativeSuggestion.onCompositionStart}
          onCompositionEnd={nativeSuggestion.onCompositionEnd}
          onValueChange={nativeSuggestion.onValueChange}
          suggestions={mentionSuggestions}
          teamSuggestions={teamMentionSuggestions}
          taskSuggestions={taskSuggestions}
          commandSuggestions={slashCommandSuggestions}
          chips={draft.chips}
          onChipRemove={draft.removeChip}
          onFocus={composerFocus.onTextareaFocus}
          onBlur={composerFocus.onTextareaBlur}
          projectPath={projectPath}
          onFileChipInsert={draft.addChip}
          onShiftTab={handleCycleActionMode}
          onNativeNextPromptTab={nativeSuggestion.onTab}
          onNativeNextPromptEscape={nativeSuggestion.onEscape}
          dismissMentionsRef={dismissMentionsRef}
          extraTips={[t('messageComposer.input.slashTip')]}
          minRows={isCompactLayout ? 1 : 2}
          maxRows={6}
          maxLength={MAX_TEXT_LENGTH}
          hintText={crossTeamHintText}
          showHint={!isCompactLayout && composerFocus.isComposerFocused}
          footerClassName={!isCompactLayout ? 'empty:flex' : undefined}
          cornerActionLeft={
            <ComposerExecutionControls
              actionMode={actionMode}
              onModeChange={setActionMode}
              canDelegate={canDelegate}
              sending={sending}
              goalEligible={goalEligible}
              draft={draft}
            />
          }
          layout={layout}
          canSend={canSend}
          onSend={handleSend}
          onQueue={manualQueue.onEnqueue}
          cornerActionPrefix={cornerActionPrefix}
          sendUnavailableReason={
            slashCommandRestrictionReason ||
            (isLaunchBlocking && !sending ? startupCopy.sendingUnavailable : undefined)
          }
          footerRight={
            <>
              {composerFooterRight}
              {manualQueue.unavailableReason ? (
                <p role="status" className="text-xs text-[var(--color-text-muted)]">
                  {manualQueue.unavailableReason}
                </p>
              ) : null}
            </>
          }
        />
      </div>
    </ComposerSurface>
  );
};

export type { MemberMessageComposerProps, MessageRevisionRequest } from './MessageComposer.types';
