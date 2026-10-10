import { useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { DEFAULT_TEAM_GROUP_CHAT_ID } from '@features/team-group-chats/contracts';
import { useGroupChatComposer } from '@features/team-group-chats/renderer';
import { useStore } from '@renderer/store';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { buildMemberAvatarMap, buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { isLeadMember } from '@shared/utils/leadDetection';

import { getGroupComposerPresentation } from './groupComposerPresentation';
import { TextMessageComposer } from './TextMessageComposer';

import type { MemberMessageComposerProps } from './MessageComposer';

/** Keep the standard feed's All route separate from private/member draft hooks. */
export const TeamFeedMessageComposer = ({
  renderMember,
  ...props
}: Readonly<
  MemberMessageComposerProps & {
    renderMember: (props: MemberMessageComposerProps) => React.JSX.Element;
  }
>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const contextId = useStore((state) => state.activeContextId);
  const refresh = useStore((state) => state.refreshTeamData);
  const composer = useGroupChatComposer(
    props.teamName,
    contextId,
    DEFAULT_TEAM_GROUP_CHAT_ID,
    () => refresh(props.teamName),
    t('messageComposer.recipient.all'),
    null
  );
  const [mode, setMode] = useState<{ identity: string; all: boolean; recipient?: string } | null>(
    null
  );
  const identity = `${contextId}:${props.teamName}`;
  const hasLead = props.members.some(isLeadMember);
  useEffect(() => {
    if (!composer.hasCurrentSnapshot || mode?.identity === identity) return;
    // A recovered broadcast keeps its group address and UUID, including an unknown outcome.
    setMode({
      identity,
      all: !composer.ready || !!composer.text || !!composer.attemptId || !hasLead,
    });
  }, [
    composer.attemptId,
    composer.hasCurrentSnapshot,
    composer.ready,
    composer.text,
    identity,
    mode?.identity,
    hasLead,
  ]);
  const labels = {
    label: t('messageComposer.recipient.all'),
    ariaLabel: t('messages.groups.message'),
    sendLabels: {
      send: t('messages.groups.send'),
      sending: t('messages.groups.sending'),
      retry: t('messages.groups.retrySend'),
    },
  };
  if (!composer.hasCurrentSnapshot || mode?.identity !== identity)
    return (
      <TextMessageComposer
        teamName={props.teamName}
        layout={props.layout}
        widthMode={props.widthMode}
        textareaRef={props.textareaRef}
        autoFocusKey={props.autoFocusKey}
        cornerActionPrefix={props.cornerActionPrefix}
        {...getGroupComposerPresentation({
          ...labels,
          snapshot: composer,
          freshSendAllowed: false,
          readOnly: true,
          onChange: composer.change,
          onSend: () => void composer.send(),
        })}
      />
    );
  if (!mode.all && composer.ready && !composer.pending && !composer.attemptId)
    return renderMember({
      ...props,
      initialRecipient: mode.recipient,
      onSelectAll: () => setMode({ identity, all: true }),
    });
  const members = props.members.filter((member) => member.name !== 'user');
  const colors = buildMemberColorMap(props.members);
  const avatars = buildMemberAvatarMap(props.members);
  const group = props.groupBroadcast?.group;
  const blocked =
    members.length < 2 ||
    !props.isTeamAlive ||
    !!group?.archivedAt ||
    (group ? !group.canSend : false);
  return (
    <div data-testid="group-chat-composer">
      <TextMessageComposer
        teamName={props.teamName}
        layout={props.layout}
        widthMode={props.widthMode}
        textareaRef={props.textareaRef}
        autoFocusKey={props.autoFocusKey}
        suggestionPlacement={props.suggestionPlacement}
        cornerActionPrefix={props.cornerActionPrefix}
        {...getGroupComposerPresentation({
          ...labels,
          snapshot: composer,
          freshSendAllowed: !blocked,
          readOnly: !!group?.archivedAt,
          recipientSelector: {
            members: members.map((member) => ({
              name: member.name,
              color: colors.get(member.name),
              avatarUrl: avatars.get(member.name),
              role: formatAgentRole(member.role) ?? formatAgentRole(member.agentType) ?? undefined,
              isLead: isLeadMember(member),
            })),
            selectedName: null,
            allLabel: t('messageComposer.recipient.all'),
            disabled: !!group?.archivedAt,
            onSelect: (name) => {
              if (name !== null) setMode({ identity, all: false, recipient: name });
            },
          },
          onChange: composer.change,
          onSend: () => void composer.send(),
          notice: (
            <>
              <p role="status" className="text-xs text-[var(--color-text-muted)]">
                {members.length < 2
                  ? t('messages.groups.minimum')
                  : t('messageComposer.recipient.broadcastTextOnly')}
              </p>
              {blocked && members.length >= 2 ? (
                <p role="status" className="text-xs text-[var(--color-text-muted)]">
                  {group?.archivedAt
                    ? t('messages.groups.archivedHint')
                    : t('messages.groups.restartHint')}
                </p>
              ) : null}
            </>
          ),
        })}
      />
    </div>
  );
};
