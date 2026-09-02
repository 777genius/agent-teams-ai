import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamInboxWriter } from '../TeamInboxWriter';

import type * as PathDecoderModule from '@main/utils/pathDecoder';
import type { InboxMessage, SendMessageRequest } from '@shared/types';

const hoisted = vi.hoisted(() => ({
  teamsBase: '',
}));

vi.mock('@main/utils/pathDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof PathDecoderModule>();
  return {
    ...actual,
    getTeamsBasePath: () => hoisted.teamsBase,
  };
});

describe('TeamInboxWriter runtime delivery dedup', () => {
  let writer: TeamInboxWriter;

  beforeEach(() => {
    hoisted.teamsBase = fs.mkdtempSync(path.join(os.tmpdir(), 'team-inbox-writer-'));
    writer = new TeamInboxWriter();
  });

  afterEach(() => {
    fs.rmSync(hoisted.teamsBase, { recursive: true, force: true });
  });

  function readInbox(member: string): InboxMessage[] {
    const inboxPath = path.join(hoisted.teamsBase, 'team', 'inboxes', `${member}.json`);
    return JSON.parse(fs.readFileSync(inboxPath, 'utf8')) as InboxMessage[];
  }

  function runtimeDeliveryRequest(overrides: Partial<SendMessageRequest> = {}): SendMessageRequest {
    return {
      member: 'worker',
      from: 'lead',
      to: 'worker',
      text: 'Dependency resolved, you can start task 7 now.',
      summary: 'Dependency resolved',
      source: 'runtime_delivery',
      relayOfMessageId: 'origin-1',
      ...overrides,
    };
  }

  it('drops paraphrased replays with the same relayOfMessageId, from, and to', async () => {
    const first = await writer.sendMessage('team', runtimeDeliveryRequest());
    expect(first.deduplicated).toBeUndefined();

    const replay = await writer.sendMessage(
      'team',
      runtimeDeliveryRequest({
        text: 'FYI: the dependency for task 7 is now resolved — go ahead.',
        summary: 'Dep resolved FYI',
      })
    );

    expect(replay.deduplicated).toBe(true);
    expect(replay.messageId).toBe(first.messageId);
    expect(readInbox('worker')).toHaveLength(1);
  });

  it('keeps runtime deliveries with a different recipient or relayOfMessageId', async () => {
    const first = await writer.sendMessage('team', runtimeDeliveryRequest());
    const otherRecipient = await writer.sendMessage(
      'team',
      runtimeDeliveryRequest({ member: 'user', to: 'user' })
    );
    const otherOrigin = await writer.sendMessage(
      'team',
      runtimeDeliveryRequest({ relayOfMessageId: 'origin-2' })
    );

    expect(otherRecipient.deduplicated).toBeUndefined();
    expect(otherOrigin.deduplicated).toBeUndefined();
    expect(otherOrigin.messageId).not.toBe(first.messageId);
    expect(readInbox('worker')).toHaveLength(2);
    expect(readInbox('user')).toHaveLength(1);
  });

  // Negative control: relayOfMessageId is only a delivery identity for runtime
  // deliveries. A user or teammate message that happens to reference the same
  // origin id is a real, separate message and must survive.
  it('does not dedup non-runtime_delivery messages that share a relayOfMessageId', async () => {
    const first = await writer.sendMessage('team', runtimeDeliveryRequest());
    const teammateMessage = await writer.sendMessage(
      'team',
      runtimeDeliveryRequest({ source: 'inbox', text: 'On it, starting task 7.' })
    );
    const secondTeammateMessage = await writer.sendMessage(
      'team',
      runtimeDeliveryRequest({ source: 'inbox', text: 'Task 7 is done.' })
    );

    expect(teammateMessage.deduplicated).toBeUndefined();
    expect(secondTeammateMessage.deduplicated).toBeUndefined();
    expect(teammateMessage.messageId).not.toBe(first.messageId);
    expect(secondTeammateMessage.messageId).not.toBe(teammateMessage.messageId);
    expect(readInbox('worker')).toHaveLength(3);
  });

  it('keeps text-identity for messages without relayOfMessageId', async () => {
    const request: SendMessageRequest = {
      member: 'worker',
      from: 'lead',
      text: 'first update',
      source: 'runtime_delivery',
    };

    await writer.sendMessage('team', request);
    const second = await writer.sendMessage('team', { ...request, text: 'second update' });

    expect(second.deduplicated).toBeUndefined();
    expect(readInbox('worker')).toHaveLength(2);
  });

  it('silently dedups an explicit messageId replay whose text was paraphrased', async () => {
    const first = await writer.sendMessage(
      'team',
      runtimeDeliveryRequest({ messageId: 'explicit-1' })
    );

    const replay = await writer.sendMessage(
      'team',
      runtimeDeliveryRequest({
        messageId: 'explicit-1',
        text: 'Reworded relay of the same origin message.',
        summary: 'Reworded summary',
      })
    );

    expect(replay.deduplicated).toBe(true);
    expect(replay.messageId).toBe(first.messageId);
    expect(readInbox('worker')).toHaveLength(1);
  });

  it('still rejects explicit messageId collisions for non-relay messages', async () => {
    const request: SendMessageRequest = {
      member: 'worker',
      from: 'lead',
      text: 'original text',
      messageId: 'explicit-2',
    };

    await writer.sendMessage('team', request);

    await expect(
      writer.sendMessage('team', { ...request, text: 'different text' })
    ).rejects.toThrow(/messageId collision/);
  });
});
