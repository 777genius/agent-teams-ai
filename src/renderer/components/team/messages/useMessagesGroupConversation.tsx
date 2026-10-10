import { useAppTranslation } from '@features/localization/renderer';
import {
  GroupChatArchiveAction,
  useGroupChatComposer,
  useGroupChatHistory,
  useTeamGroupChats,
} from '@features/team-group-chats/renderer';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberAvatarMap, buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { isLeadMember } from '@shared/utils/leadDetection';

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
      <ThreadAwareMessageComposer
        {...editorOptions}
        {...options}
        teamName={teamName}
        recipientSelector={{
          members: members
            .filter((member) => group?.memberNames.includes(member.name))
            .map((member) => ({
              name: member.name,
              color: colors.get(member.name),
              avatarUrl: avatars.get(member.name),
              role: formatAgentRole(member.role) ?? formatAgentRole(member.agentType) ?? undefined,
              isLead: isLeadMember(member),
            })),
          selectedName: composer.recipientName,
          allLabel: t('messageComposer.recipient.all'),
          disabled:
            !composer.ready ||
            !group ||
            !!group.archivedAt ||
            composer.pending ||
            !!composer.attemptId,
          onSelect: composer.selectRecipient,
        }}
        textInput={{
          label: group?.name ?? t('messages.groups.unavailable'),
          ariaLabel: t('messages.groups.message'),
          value: composer.text,
          readOnly: !!group?.archivedAt || composer.pending || !!composer.attemptId,
          disabled: !composer.ready || (!group && !composer.attemptId),
          canSend:
            (!!composer.attemptId || !blocked) &&
            composer.ready &&
            !composer.pending &&
            !!composer.text.trim(),
          sendLabel: composer.pending
            ? t('messages.groups.sending')
            : composer.attemptId
              ? t('messages.groups.retrySend')
              : t('messages.groups.send'),
          onChange: composer.change,
          onSend: () => void composer.send(),
        }}
        notice={
          <>
            {blocked ? (
              <p role="status" className="text-xs text-[var(--color-text-muted)]">
                {group?.archivedAt
                  ? t('messages.groups.archivedHint')
                  : composer.recipientName === null
                    ? t('messages.groups.restartHint')
                    : t('messages.groups.recipientRestartHint', { name: composer.recipientName })}
              </p>
            ) : null}
            {composer.error ? (
              <p role="alert" className="text-xs text-red-400">
                {composer.error}
              </p>
            ) : null}
          </>
        }
      />
    </div>
  );
  const quote = (message: InboxMessage) => {
    if (composer.ready && group && !composer.attemptId && !composer.pending && !group.archivedAt)
      composer.change(
        `${message.text
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')}\n\n${composer.text}`
      );
  };
  return { groupId, group, catalog, history, composer, archiveAction, renderComposer, quote };
}
