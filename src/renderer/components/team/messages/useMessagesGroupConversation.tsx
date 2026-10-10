import { useAppTranslation } from '@features/localization/renderer';
import {
  GroupChatArchiveAction,
  useGroupChatComposer,
  useGroupChatHistory,
  useTeamGroupChats,
} from '@features/team-group-chats/renderer';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import { getInboxMessageQuoteText } from '@renderer/utils/agentMessageFormatting';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberAvatarMap, buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { isLeadMember } from '@shared/utils/leadDetection';

import { getGroupComposerPresentation } from './groupComposerPresentation';
import { ThreadAwareMessageComposer } from './ThreadAwareMessageComposer';

import type { TextMessageComposerProps } from './TextMessageComposer';
import type { ConversationScope } from '@features/team-direct-chats/renderer';
import type { InboxMessage, ResolvedTeamMember } from '@shared/types';

/** Joins the group catalog, durable history and draft for one conversation. */
export function useMessagesGroupConversation(
  teamName: string,
  contextId: string,
  members: ResolvedTeamMember[],
  scope: ConversationScope,
  editorOptions: Pick<
    TextMessageComposerProps,
    'textareaRef' | 'autoFocusKey' | 'suggestionPlacement'
  >
) {
  const { t } = useAppTranslation('team');
  const showGroupTasks = useStore((state) => state.showGroupTasks);
  const groupId = scope.kind === 'group' ? scope.groupChatId : undefined;
  const catalog = useTeamGroupChats(teamName, contextId, members.map((m) => m.name).join('\0'));
  const history = useGroupChatHistory(teamName, contextId, groupId);
  const group = catalog.groups.find((item) => item.id === groupId);
  const composer = useGroupChatComposer(
    teamName,
    contextId,
    groupId ?? '',
    history.refresh,
    group?.name,
    members.find((member) => isLeadMember(member) && group?.memberNames.includes(member.name))
      ?.name ?? null
  );
  const archiveAction = groupId ? (
    <GroupChatArchiveAction key={groupId} group={group} setArchived={catalog.setArchived} />
  ) : undefined;
  const boardAction = groupId ? (
    <div className="flex shrink-0 justify-center px-3 py-2">
      <Button
        variant="secondary"
        size="sm"
        className="h-7 text-xs"
        onClick={() => showGroupTasks(teamName, groupId)}
      >
        {t('messages.groups.showTasksOnBoard')}
      </Button>
    </div>
  ) : null;
  const structuralBlock = !group || !!group.archivedAt || group.memberNames.length < 2;
  const blocked =
    structuralBlock ||
    (composer.recipientName === null
      ? !group?.canSend
      : !group?.availableRecipientNames?.includes(composer.recipientName));
  const colors = buildMemberColorMap(members);
  const avatars = buildMemberAvatarMap(members);
  const renderComposer = (
    options: Pick<TextMessageComposerProps, 'layout' | 'widthMode' | 'cornerActionPrefix'> = {}
  ) => (
    <div data-testid="group-chat-composer">
      {options.widthMode === 'floating-adaptive' ? boardAction : null}
      <ThreadAwareMessageComposer
        {...editorOptions}
        {...options}
        teamName={teamName}
        {...getGroupComposerPresentation({
          snapshot: composer,
          label: group?.name ?? t('messages.groups.unavailable'),
          ariaLabel: t('messages.groups.message'),
          sendLabels: {
            send: t('messages.groups.send'),
            sending: t('messages.groups.sending'),
            retry: t('messages.groups.retrySend'),
          },
          freshSendAllowed: !blocked,
          readOnly: !!group?.archivedAt,
          inputDisabled: !group && !composer.attemptId,
          recipientSelector: {
            members: members
              .filter((member) => group?.memberNames.includes(member.name))
              .map((member) => ({
                name: member.name,
                color: colors.get(member.name),
                avatarUrl: avatars.get(member.name),
                role:
                  formatAgentRole(member.role) ?? formatAgentRole(member.agentType) ?? undefined,
                isLead: isLeadMember(member),
              })),
            selectedName: composer.recipientName,
            allLabel: t('messageComposer.recipient.all'),
            disabled: !group || !!group.archivedAt,
            onSelect: composer.selectRecipient,
          },
          onChange: composer.change,
          onSend: () => void composer.send(),
          notice: blocked ? (
            <p role="status" className="text-xs text-[var(--color-text-muted)]">
              {group?.archivedAt
                ? t('messages.groups.archivedHint')
                : composer.recipientName === null
                  ? t('messages.groups.restartHint')
                  : t('messages.groups.recipientRestartHint', { name: composer.recipientName })}
            </p>
          ) : null,
        })}
      />
    </div>
  );
  const quote =
    composer.hasCurrentSnapshot &&
    composer.ready &&
    group &&
    !group.archivedAt &&
    !composer.pending &&
    !composer.attemptId
      ? (message: InboxMessage) => {
          const quotedText = getInboxMessageQuoteText(message)
            .split('\n')
            .map((line) => '> ' + line)
            .join('\n');
          composer.change(quotedText + '\n\n' + composer.text);
        }
      : undefined;
  return {
    groupId,
    group,
    catalog,
    history,
    composer,
    archiveAction,
    boardAction,
    renderComposer,
    quote,
  };
}
