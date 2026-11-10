import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { expect, it, vi } from 'vitest';

import { capturedCrossTeamReply } from '../../../src/renderer/components/team/messages/capturedCrossTeamReply';
import {
  buildPreparedSendRequest,
  preparedCrossTeamReplyArgs,
} from '../../../src/renderer/components/team/messages/composerSendUtils';
import { useMessagesPanelSend } from '../../../src/renderer/components/team/messages/useMessagesPanelSend';

import type { InboxMessage } from '../../../src/shared/types';

it('existing reply/send flow retains only the original captured destination and conversation', async () => {
  const message: InboxMessage = {
    from: 'alpha.lead',
    to: 'lead',
    text: 'TEST original',
    timestamp: 'TEST-time',
    read: false,
    source: 'cross_team',
    conversationId: 'TEST-conversation',
    crossTeamNavigation: {
      fromTeamName: 'alpha',
      toTeamName: 'beta',
      fromTeamKey: 'host-team:original.with.dot',
      toTeamKey: 'host-team:beta',
    },
  };
  const reply = capturedCrossTeamReply(message);
  expect(reply).toEqual({
    toTeam: 'host-team:original.with.dot',
    toMember: 'lead',
    conversationId: 'TEST-conversation',
  });
  const options = {
    attemptId: 'TEST-send',
    teamName: 'host-team:beta',
    selectedTeam: 'host-team:original.with.dot',
    crossTeamRecipient: 'lead',
    localRecipient: 'lead',
    text: 'TEST reply',
    summary: 'TEST reply',
    attachments: [],
    actionMode: 'delegate' as const,
    taskRefs: [],
    ...(reply ? { crossTeamReply: reply } : {}),
  };
  const prepared = structuredClone(buildPreparedSendRequest(options));
  if (prepared.kind !== 'cross-team') throw new Error('TEST wrong request kind');
  expect(prepared.request).toMatchObject({
    conversationId: 'TEST-conversation',
    replyToConversationId: 'TEST-conversation',
  });
  const other = buildPreparedSendRequest({ ...options, selectedTeam: 'host-team:other' });
  if (other.kind !== 'cross-team') throw new Error('TEST wrong request kind');
  expect(other.request.conversationId).toBeUndefined();
  const sendCrossTeamMessage = vi
    .fn()
    .mockResolvedValue({ messageId: 'TEST-send', deliveredToInbox: true });
  let send: ReturnType<typeof useMessagesPanelSend> | undefined;
  function Harness() {
    send = useMessagesPanelSend({
      teamName: 'host-team:beta',
      sendTeamMessage: vi.fn(),
      sendCrossTeamMessage,
      onPendingReplyChange: vi.fn(),
    });
    return null;
  }
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Harness));
  });
  if (!send) throw new Error('TEST hook missing');
  await send.handleCrossTeamSend(
    'host-team:original.with.dot',
    'TEST reply',
    undefined,
    undefined,
    undefined,
    'lead',
    'TEST-send',
    ...preparedCrossTeamReplyArgs(prepared.request)
  );
  expect(sendCrossTeamMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      conversationId: 'TEST-conversation',
      replyToConversationId: 'TEST-conversation',
      toTeam: 'host-team:original.with.dot',
      messageId: 'TEST-send',
    })
  );
  await send.handleCrossTeamSend(
    'host-team:other',
    'TEST new',
    undefined,
    undefined,
    undefined,
    'lead',
    'TEST-other'
  );
  expect(sendCrossTeamMessage).toHaveBeenLastCalledWith(
    expect.not.objectContaining({ conversationId: expect.anything() })
  );
  expect(
    capturedCrossTeamReply({
      ...message,
      crossTeamNavigation: { fromTeamName: 'alpha', toTeamName: 'beta' },
    })
  ).toBeUndefined();
  expect(capturedCrossTeamReply({ ...message, from: 'forged.lead' })).toBeUndefined();
  await act(async () => {
    root.unmount();
  });
  container.remove();
});
