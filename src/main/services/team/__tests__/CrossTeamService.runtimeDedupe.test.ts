import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CrossTeamService } from '../CrossTeamService';

import type { TeamCrossTeamMessagingApi } from '../contracts/TeamProvisioningApis';
import type { TeamConfigReader } from '../TeamConfigReader';
import type { TeamDataService } from '../TeamDataService';
import type { TeamInboxWriter } from '../TeamInboxWriter';
import type { CrossTeamSendRequest, InboxMessage, TeamConfig } from '@shared/types';

const controllerMocks = vi.hoisted(() => ({
  appendSentMessage: vi.fn(),
  lookupMessage: vi.fn(() => {
    throw new Error('not found');
  }),
}));

vi.mock('agent-teams-controller', () => ({
  createController: vi.fn(() => ({
    messages: {
      appendSentMessage: controllerMocks.appendSentMessage,
      lookupMessage: controllerMocks.lookupMessage,
    },
  })),
  protocols: {
    buildActionModeProtocolText: vi.fn(() => ''),
  },
}));

function teamConfig(name: string): TeamConfig {
  return {
    name,
    members: [
      { name: 'team-lead', agentType: 'team-lead' },
      { name: 'Worker', agentType: 'general-purpose' },
    ],
  };
}

function createService() {
  const sentToInbox: Array<{ teamName: string; message: InboxMessage }> = [];
  const configs = new Map<string, TeamConfig>([
    ['source-team', teamConfig('Source Team')],
    ['target-team', teamConfig('Target Team')],
  ]);
  const configReader = {
    getConfig: vi.fn(async (teamName: string) => configs.get(teamName) ?? null),
  } as unknown as TeamConfigReader;
  const dataService = {
    getLeadMemberName: vi.fn(async () => 'team-lead'),
  } as unknown as TeamDataService;
  const inboxWriter = {
    sendMessage: vi.fn(async (teamName: string, message: InboxMessage) => {
      sentToInbox.push({ teamName, message });
    }),
  } as unknown as TeamInboxWriter;
  const messaging: TeamCrossTeamMessagingApi = {
    resolveCrossTeamReplyMetadata: vi.fn(() => null),
    registerPendingCrossTeamReplyExpectation: vi.fn(),
    clearPendingCrossTeamReplyExpectation: vi.fn(),
    isTeamAlive: vi.fn(() => false),
    relayInboxFileToLiveRecipient: vi.fn<
      TeamCrossTeamMessagingApi['relayInboxFileToLiveRecipient']
    >(async (_teamName, _memberName, options) => ({
      kind: 'native_lead',
      relayed: 1,
      ...(options?.onlyMessageId ? { recentlyDeliveredMessageId: options.onlyMessageId } : {}),
    })),
    relayLeadInboxMessages: vi.fn(async () => 0),
  };

  return {
    service: new CrossTeamService(configReader, dataService, inboxWriter, messaging),
    inboxWriter,
    messaging,
    sentToInbox,
  };
}

function runtimeRequest(overrides: Partial<CrossTeamSendRequest> = {}): CrossTeamSendRequest {
  return {
    fromTeam: 'source-team',
    fromMember: 'team-lead',
    toTeam: 'target-team',
    toMember: 'team-lead',
    text: 'Ship the same payload',
    summary: 'Runtime delivery',
    taskRefs: [{ taskId: 'task-1', displayId: '#1', teamName: 'source-team' }],
    timestamp: new Date().toISOString(),
    messageId: 'runtime-message-1',
    conversationId: 'runtime-idempotency-1',
    requireRuntimeDelivery: true,
    ...overrides,
  };
}

describe('CrossTeamService runtime delivery dedupe', () => {
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-team-service-'));
    setClaudeBasePathOverride(tempRoot);
    controllerMocks.appendSentMessage.mockClear();
    controllerMocks.lookupMessage.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    setClaudeBasePathOverride(null);
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps runtime retries idempotent when the trimmed caller message id matches', async () => {
    const { service, inboxWriter, messaging, sentToInbox } = createService();
    const request = runtimeRequest();
    const retry = runtimeRequest({
      messageId: '\truntime-message-1\n',
      conversationId: 'runtime-idempotency-2',
      text: 'Retry payload changed after the caller message id was already recorded',
      summary: 'Retry summary changed',
      taskRefs: [{ taskId: 'task-2', displayId: '#2', teamName: 'source-team' }],
    });

    await expect(service.send(request)).resolves.toMatchObject({
      messageId: 'runtime-message-1',
      deliveredToInbox: true,
    });
    await expect(service.send(retry)).resolves.toMatchObject({
      messageId: 'runtime-message-1',
      deliveredToInbox: true,
      deduplicated: true,
    });

    expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
    expect(sentToInbox.map((entry) => entry.message.messageId)).toEqual(['runtime-message-1']);
    expect(messaging.relayInboxFileToLiveRecipient).toHaveBeenCalledTimes(1);
    expect(messaging.relayInboxFileToLiveRecipient).toHaveBeenNthCalledWith(
      1,
      'target-team',
      'team-lead',
      { onlyMessageId: 'runtime-message-1' }
    );
  });

  it('dedupes runtime retries without caller message ids by conversation identity', async () => {
    const { service, sentToInbox } = createService();
    const request = runtimeRequest({
      messageId: undefined,
      conversationId: 'runtime-idempotency-1',
    });
    const retry = runtimeRequest({
      messageId: undefined,
      conversationId: '\truntime-idempotency-1\n',
      text: 'Retry payload changed after the conversation was already recorded',
      summary: 'Retry summary changed',
      taskRefs: [{ taskId: 'task-2', displayId: '#2', teamName: 'source-team' }],
    });

    const first = await service.send(request);
    await expect(service.send(retry)).resolves.toMatchObject({
      messageId: first.messageId,
      deliveredToInbox: true,
      deduplicated: true,
    });

    expect(first.messageId).not.toBe('');
    expect(sentToInbox.map((entry) => entry.message.messageId)).toEqual([first.messageId]);
  });

  it('does not accept unrelated native-lead relay work as runtime proof', async () => {
    const { service, messaging } = createService();
    vi.mocked(messaging.relayInboxFileToLiveRecipient).mockResolvedValue({
      kind: 'native_lead',
      relayed: 1,
      recentlyDeliveredMessageId: 'unrelated-message',
      diagnostics: ['unrelated native lead relay completed for another message'],
    });

    await expect(service.send(runtimeRequest())).rejects.toThrow(
      'unrelated native lead relay completed for another message'
    );
    expect(messaging.relayInboxFileToLiveRecipient).toHaveBeenCalledWith(
      'target-team',
      'team-lead',
      { onlyMessageId: 'runtime-message-1' }
    );
    expect(controllerMocks.appendSentMessage).not.toHaveBeenCalled();
  });

  it('accepts only exact durable native member inbox proof', async () => {
    const { service, messaging } = createService();
    vi.mocked(messaging.relayInboxFileToLiveRecipient).mockResolvedValue({
      kind: 'native_member_noop',
      relayed: 0,
      durablyStoredMessageId: 'runtime-message-1',
    });

    await expect(service.send(runtimeRequest({ toMember: 'worker' }))).resolves.toMatchObject({
      messageId: 'runtime-message-1',
      deliveredToInbox: true,
      toMember: 'Worker',
    });

    const genericNoop = createService();
    vi.mocked(genericNoop.messaging.relayInboxFileToLiveRecipient).mockResolvedValue({
      kind: 'native_member_noop',
      relayed: 0,
    });
    await expect(
      genericNoop.service.send(
        runtimeRequest({
          messageId: 'runtime-message-2',
          conversationId: 'runtime-key-2',
          toMember: 'Worker',
        })
      )
    ).rejects.toThrow('relay kind native_member_noop relayed 0');

    const mismatched = createService();
    vi.mocked(mismatched.messaging.relayInboxFileToLiveRecipient).mockResolvedValue({
      kind: 'native_member_noop',
      relayed: 0,
      durablyStoredMessageId: 'another-message',
    });
    await expect(
      mismatched.service.send(
        runtimeRequest({
          messageId: 'runtime-message-3',
          conversationId: 'runtime-key-3',
          toMember: 'Worker',
        })
      )
    ).rejects.toThrow('relay kind native_member_noop relayed 0');
  });

  it('uses a durable exact acceptance receipt after restart beyond ordinary body dedupe', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-09T00:00:00.000Z') });
    const firstRuntime = createService();
    await expect(firstRuntime.service.send(runtimeRequest())).resolves.toMatchObject({
      messageId: 'runtime-message-1',
      deliveredToInbox: true,
    });
    expect(firstRuntime.messaging.relayInboxFileToLiveRecipient).toHaveBeenCalledOnce();
    const outboxPath = path.join(tempRoot, 'teams', 'source-team', 'sent-cross-team.json');
    expect(JSON.parse(fs.readFileSync(outboxPath, 'utf8'))).toEqual([
      expect.objectContaining({
        messageId: 'runtime-message-1',
        runtimeDeliveryAcceptedAt: '2026-07-09T00:00:00.000Z',
      }),
    ]);

    vi.advanceTimersByTime(6 * 60 * 1000);
    const restartedRuntime = createService();
    vi.mocked(restartedRuntime.messaging.relayInboxFileToLiveRecipient).mockResolvedValue({
      kind: 'native_lead',
      relayed: 0,
      diagnostics: ['accepted inbox row was already read and cleared'],
    });
    await expect(
      restartedRuntime.service.send(
        runtimeRequest({
          messageId: 'runtime-message-after-restart',
          conversationId: 'runtime-idempotency-1',
          timestamp: '2026-07-09T00:06:00.000Z',
        })
      )
    ).resolves.toMatchObject({
      messageId: 'runtime-message-1',
      deliveredToInbox: true,
      deduplicated: true,
    });

    expect(restartedRuntime.inboxWriter.sendMessage).not.toHaveBeenCalled();
    expect(restartedRuntime.messaging.relayInboxFileToLiveRecipient).not.toHaveBeenCalled();
  });

  it('does not trust a corrupt durable acceptance receipt after restart', async () => {
    const firstRuntime = createService();
    await firstRuntime.service.send(runtimeRequest());

    const outboxPath = path.join(tempRoot, 'teams', 'source-team', 'sent-cross-team.json');
    const rows = JSON.parse(fs.readFileSync(outboxPath, 'utf8')) as Record<string, unknown>[];
    rows[0] = { ...rows[0], runtimeDeliveryAcceptedAt: 'not-an-iso-date' };
    fs.writeFileSync(outboxPath, JSON.stringify(rows, null, 2));

    const restartedRuntime = createService();
    vi.mocked(restartedRuntime.messaging.relayInboxFileToLiveRecipient).mockResolvedValue({
      kind: 'native_lead',
      relayed: 0,
      diagnostics: ['already-read row has no durable acceptance proof'],
    });
    await expect(restartedRuntime.service.send(runtimeRequest())).rejects.toThrow(
      'already-read row has no durable acceptance proof'
    );
    expect(restartedRuntime.messaging.relayInboxFileToLiveRecipient).toHaveBeenCalledOnce();
  });

  it('keeps body-based dedupe for normal callers without stable ids', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-09T00:00:00.000Z') });
    const { service, inboxWriter, messaging, sentToInbox } = createService();
    const request: CrossTeamSendRequest = {
      fromTeam: 'source-team',
      fromMember: 'team-lead',
      toTeam: 'target-team',
      toMember: 'team-lead',
      text: 'Ship the same payload',
      summary: 'Runtime delivery',
      taskRefs: [{ taskId: 'task-1', displayId: '#1', teamName: 'source-team' }],
      timestamp: '2026-07-09T00:00:00.000Z',
    };

    const first = await service.send(request);
    await expect(service.send(request)).resolves.toMatchObject({
      deliveredToInbox: true,
      deduplicated: true,
      messageId: first.messageId,
    });

    expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
    expect(sentToInbox).toHaveLength(1);
    expect(messaging.relayInboxFileToLiveRecipient).not.toHaveBeenCalled();
  });

  it('does not runtime-dedupe normal follow-ups in the same conversation', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-09T00:00:00.000Z') });
    const { service, inboxWriter, messaging, sentToInbox } = createService();
    const request: CrossTeamSendRequest = {
      fromTeam: 'source-team',
      fromMember: 'team-lead',
      toTeam: 'target-team',
      toMember: 'team-lead',
      text: 'First follow-up',
      summary: 'Conversation follow-up',
      conversationId: 'shared-conversation',
      timestamp: '2026-07-09T00:00:00.000Z',
    };

    const first = await service.send(request);
    vi.advanceTimersByTime(3_001);
    const second = await service.send({
      ...request,
      text: 'Second follow-up',
      timestamp: '2026-07-09T00:00:01.000Z',
    });

    expect(first).toMatchObject({ deliveredToInbox: true });
    expect(second).toMatchObject({ deliveredToInbox: true });
    expect(first.deduplicated).toBeUndefined();
    expect(second.deduplicated).toBeUndefined();
    expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(2);
    expect(sentToInbox.map((entry) => entry.message.text)).toEqual([
      expect.stringContaining('First follow-up'),
      expect.stringContaining('Second follow-up'),
    ]);
    expect(messaging.relayInboxFileToLiveRecipient).not.toHaveBeenCalled();
  });

  it('delivers distinct runtime messages that carry distinct conversation identities', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-09T00:00:00.000Z') });
    const { service, inboxWriter, messaging, sentToInbox } = createService();

    await expect(
      service.send(
        runtimeRequest({
          messageId: 'runtime-message-1',
          conversationId: 'runtime-idempotency-1',
        })
      )
    ).resolves.toMatchObject({
      messageId: 'runtime-message-1',
      deliveredToInbox: true,
    });
    vi.advanceTimersByTime(3_001);
    // A genuinely distinct logical delivery carries its own idempotencyKey, hence
    // its own conversationId. It must be delivered, not deduped.
    await expect(
      service.send(
        runtimeRequest({
          messageId: 'runtime-message-2',
          conversationId: 'runtime-idempotency-2',
        })
      )
    ).resolves.toMatchObject({
      messageId: 'runtime-message-2',
      deliveredToInbox: true,
    });

    expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(2);
    expect(sentToInbox.map((entry) => entry.message.messageId)).toEqual([
      'runtime-message-1',
      'runtime-message-2',
    ]);
    expect(messaging.relayInboxFileToLiveRecipient).toHaveBeenCalledTimes(2);
    expect(messaging.relayInboxFileToLiveRecipient).toHaveBeenNthCalledWith(
      2,
      'target-team',
      'team-lead',
      { onlyMessageId: 'runtime-message-2' }
    );
  });

  it('dedupes a cross-run runtime retry that reuses the conversation identity with a new run-scoped message id', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-09T00:00:00.000Z') });
    const { service, inboxWriter, messaging, sentToInbox } = createService();

    // Run R1: destinationMessageId is hash(idempotencyKey, runId, team) - run-scoped.
    await expect(
      service.send(
        runtimeRequest({
          messageId: 'runtime-delivery-run1-abc',
          conversationId: 'runtime-idempotency-1',
        })
      )
    ).resolves.toMatchObject({
      messageId: 'runtime-delivery-run1-abc',
      deliveredToInbox: true,
    });

    // Run R2 relaunch re-delivers the SAME logical message: same idempotencyKey
    // (=conversationId) but a DIFFERENT run-scoped destinationMessageId. The
    // journal does not carry cross-team entries across runs, so the outbox
    // conversationId proof must dedupe it - otherwise the target inbox receives
    // the message twice.
    vi.advanceTimersByTime(3_001);
    await expect(
      service.send(
        runtimeRequest({
          messageId: 'runtime-delivery-run2-def',
          conversationId: 'runtime-idempotency-1',
          text: 'Same logical delivery, relaunched under a new run',
        })
      )
    ).resolves.toMatchObject({
      messageId: 'runtime-delivery-run1-abc',
      deliveredToInbox: true,
      deduplicated: true,
    });

    expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
    expect(sentToInbox.map((entry) => entry.message.messageId)).toEqual([
      'runtime-delivery-run1-abc',
    ]);
    expect(messaging.relayInboxFileToLiveRecipient).toHaveBeenCalledTimes(1);
    expect(messaging.relayInboxFileToLiveRecipient).toHaveBeenNthCalledWith(
      1,
      'target-team',
      'team-lead',
      { onlyMessageId: 'runtime-delivery-run1-abc' }
    );
  });
});
