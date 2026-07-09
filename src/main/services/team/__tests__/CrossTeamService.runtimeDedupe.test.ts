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
    members: [{ name: 'team-lead', agentType: 'team-lead' }],
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
    relayInboxFileToLiveRecipient: vi.fn(async () => ({
      kind: 'opencode_member',
      relayed: 1,
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

  it('keeps runtime retries idempotent when trimmed message id and conversation id match', async () => {
    const { service, inboxWriter, messaging, sentToInbox } = createService();
    const request = runtimeRequest();
    const retry = runtimeRequest({
      messageId: ' runtime-message-1 ',
      conversationId: '\truntime-idempotency-1\n',
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
    expect(messaging.relayInboxFileToLiveRecipient).toHaveBeenCalledTimes(2);
    expect(messaging.relayInboxFileToLiveRecipient).toHaveBeenNthCalledWith(
      2,
      'target-team',
      'team-lead',
      { onlyMessageId: 'runtime-message-1' }
    );
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

  it('delivers distinct runtime messages with identical text and task refs', async () => {
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
});
