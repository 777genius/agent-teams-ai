import { CrossTeamOutbox } from '@main/services/team/CrossTeamOutbox';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrossTeamMessage } from '@shared/types';

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => tmpDir,
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-test-'));
  fs.mkdirSync(path.join(tmpDir, 'test-team'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeMessage(overrides: Partial<CrossTeamMessage> = {}): CrossTeamMessage {
  return {
    messageId: 'msg-1',
    fromTeam: 'team-a',
    fromMember: 'lead',
    toTeam: 'team-b',
    text: 'hello',
    chainDepth: 0,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('CrossTeamOutbox', () => {
  let outbox: CrossTeamOutbox;

  beforeEach(() => {
    outbox = new CrossTeamOutbox();
  });

  it('returns empty array when no outbox file exists', async () => {
    const result = await outbox.read('test-team');
    expect(result).toEqual([]);
  });

  it('appends a message and reads it back', async () => {
    const msg = makeMessage();
    await outbox.append('test-team', msg);

    const result = await outbox.read('test-team');
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('msg-1');
    expect(result[0].fromTeam).toBe('team-a');
  });

  it('appends multiple messages', async () => {
    await outbox.append('test-team', makeMessage({ messageId: 'msg-1' }));
    await outbox.append('test-team', makeMessage({ messageId: 'msg-2' }));

    const result = await outbox.read('test-team');
    expect(result).toHaveLength(2);
  });

  it('returns only an exact durably accepted runtime delivery proof', async () => {
    const timestamp = '2026-07-22T00:00:00.000Z';
    const message = makeMessage({
      messageId: 'runtime-message-1',
      fromMember: 'Builder',
      toMember: 'Captain',
      conversationId: 'runtime-key-1',
      text: 'recover this exact delivery',
      summary: 'Recovery proof',
      taskRefs: [{ taskId: 'task-1', displayId: '#1', teamName: 'team-a' }],
      timestamp,
    });
    await outbox.append('test-team', message);
    await outbox.markRuntimeDeliveryAccepted('test-team', {
      messageId: message.messageId,
      toTeam: message.toTeam,
      toMember: message.toMember ?? '',
      acceptedAt: '2026-07-22T00:00:01.000Z',
    });
    const expected = {
      messageId: message.messageId,
      fromTeam: message.fromTeam,
      fromMember: message.fromMember,
      toTeam: message.toTeam,
      toMember: message.toMember ?? '',
      conversationId: message.conversationId ?? '',
      text: message.text,
      taskRefs: message.taskRefs,
      summary: message.summary,
      timestamp,
    };

    await expect(outbox.findAcceptedRuntimeDelivery('test-team', expected)).resolves.toMatchObject({
      messageId: 'runtime-message-1',
      toMember: 'Captain',
      runtimeDeliveryAcceptedAt: '2026-07-22T00:00:01.000Z',
    });
    await expect(
      outbox.findAcceptedRuntimeDelivery('test-team', { ...expected, text: 'changed payload' })
    ).resolves.toBeNull();
    await expect(
      outbox.findAcceptedRuntimeDelivery('test-team', {
        ...expected,
        conversationId: 'different-logical-delivery',
      })
    ).resolves.toBeNull();
    await expect(
      outbox.findAcceptedRuntimeDelivery('test-team', { ...expected, toMember: 'Reviewer' })
    ).resolves.toBeNull();

    const corruptReceipt = {
      ...message,
      messageId: 'runtime-message-corrupt-receipt',
      runtimeDeliveryAcceptedAt: 'corrupt',
    };
    await outbox.append('test-team', corruptReceipt);
    await expect(
      outbox.findAcceptedRuntimeDelivery('test-team', {
        ...expected,
        messageId: corruptReceipt.messageId,
      })
    ).resolves.toBeNull();
  });

  it('appendIfNotRecent returns duplicate for recent equivalent message', async () => {
    const existing = makeMessage({
      messageId: 'msg-existing',
      text: 'Please   review this API',
      summary: ' Review request ',
    });
    await outbox.append('test-team', existing);

    const onBeforeAppend = vi.fn(() => Promise.resolve());
    const result = await outbox.appendIfNotRecent(
      'test-team',
      makeMessage({
        messageId: 'msg-new',
        text: 'please review this api',
        summary: 'review request',
      }),
      onBeforeAppend
    );

    expect(result.duplicate?.messageId).toBe('msg-existing');
    expect(onBeforeAppend).not.toHaveBeenCalled();

    const list = await outbox.read('test-team');
    expect(list).toHaveLength(1);
  });

  it('does not deduplicate equivalent messages sent to different target members', async () => {
    await outbox.append(
      'test-team',
      makeMessage({
        messageId: 'msg-lead',
        toMember: 'team-lead',
        text: 'Please review this API',
      })
    );

    const onBeforeAppend = vi.fn(() => Promise.resolve());
    const result = await outbox.appendIfNotRecent(
      'test-team',
      makeMessage({
        messageId: 'msg-worker',
        toMember: 'worker',
        text: 'please review this api',
      }),
      onBeforeAppend
    );

    expect(result.duplicate).toBeNull();
    expect(onBeforeAppend).toHaveBeenCalledTimes(1);

    const list = await outbox.read('test-team');
    expect(list.map((message) => message.messageId)).toEqual(['msg-lead', 'msg-worker']);
  });

  it('maps legacy member-blind rows only to the resolved lead recipient', async () => {
    const legacy = makeMessage({
      messageId: 'legacy-lead',
      toMember: undefined,
      text: 'Legacy route',
    });
    await outbox.append('test-team', legacy);

    const sameRecipientAppend = vi.fn(() => Promise.resolve());
    const sameRecipient = await outbox.appendIfNotRecent(
      'test-team',
      makeMessage({
        messageId: 'lead-retry',
        toMember: 'team-lead',
        text: 'Legacy route',
      }),
      sameRecipientAppend,
      undefined,
      { legacyToMember: 'team-lead' }
    );
    expect(sameRecipient.duplicate).toEqual(legacy);
    expect(sameRecipientAppend).not.toHaveBeenCalled();

    const secondRecipientAppend = vi.fn(() => Promise.resolve());
    const secondRecipient = await outbox.appendIfNotRecent(
      'test-team',
      makeMessage({
        messageId: 'worker-delivery',
        toMember: 'worker',
        text: 'Legacy route',
      }),
      secondRecipientAppend,
      undefined,
      { legacyToMember: 'team-lead' }
    );
    expect(secondRecipient.duplicate).toBeNull();
    expect(secondRecipientAppend).toHaveBeenCalledTimes(1);
    expect((await outbox.read('test-team')).map((message) => message.messageId)).toEqual([
      'legacy-lead',
      'worker-delivery',
    ]);
  });

  it('scans past corrupt, partial, timestamp-less, and stale rows without rewriting them', async () => {
    const now = Date.parse('2026-07-16T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const outboxPath = path.join(tmpDir, 'test-team', 'sent-cross-team.json');
    const matchingPartialRow = {
      messageId: 'recent-partial-row',
      fromTeam: 'team-a',
      fromMember: 'lead',
      toTeam: 'team-b',
      toMember: 'team-lead',
      text: 'Find the valid row behind corruption',
      timestamp: new Date(now - 1_000).toISOString(),
    };
    const rows: unknown[] = [
      matchingPartialRow,
      {
        ...matchingPartialRow,
        messageId: 'stale-row',
        timestamp: new Date(now - 6 * 60 * 1_000).toISOString(),
      },
      { ...matchingPartialRow, messageId: 'timestamp-less-row', timestamp: undefined },
      null,
      'malformed-row',
      { timestamp: new Date(now - 500).toISOString() },
    ];
    const originalState = JSON.stringify(rows, null, 2);
    fs.writeFileSync(outboxPath, originalState);
    const delivery = vi.fn(() => Promise.resolve());

    const result = await outbox.appendIfNotRecent(
      'test-team',
      makeMessage({
        messageId: 'retry',
        toMember: 'team-lead',
        text: 'Find the valid row behind corruption',
      }),
      delivery
    );

    expect(result.duplicate).toMatchObject({
      messageId: matchingPartialRow.messageId,
      chainDepth: 0,
    });
    expect(delivery).not.toHaveBeenCalled();
    expect(fs.readFileSync(outboxPath, 'utf8')).toBe(originalState);
    expect((await outbox.read('test-team')).map((message) => message.messageId)).toEqual([
      'recent-partial-row',
      'stale-row',
    ]);
  });

  it('deduplicates at five minutes and appends immediately after the boundary', async () => {
    const now = Date.parse('2026-07-16T12:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const boundaryMessage = makeMessage({
      messageId: 'boundary-message',
      toMember: 'team-lead',
      timestamp: new Date(now - 5 * 60 * 1000).toISOString(),
    });
    await outbox.append('test-team', boundaryMessage);

    const boundaryAppend = vi.fn(() => Promise.resolve());
    const boundaryRetry = await outbox.appendIfNotRecent(
      'test-team',
      makeMessage({ messageId: 'boundary-retry', toMember: 'team-lead' }),
      boundaryAppend
    );
    expect(boundaryRetry.duplicate).toEqual(boundaryMessage);
    expect(boundaryAppend).not.toHaveBeenCalled();

    nowSpy.mockReturnValue(now + 1);
    const afterBoundaryAppend = vi.fn(() => Promise.resolve());
    const afterBoundary = await outbox.appendIfNotRecent(
      'test-team',
      makeMessage({ messageId: 'after-boundary', toMember: 'team-lead' }),
      afterBoundaryAppend
    );
    expect(afterBoundary.duplicate).toBeNull();
    expect(afterBoundaryAppend).toHaveBeenCalledTimes(1);
  });

  it('does not append sent state when delivery fails after a partial side effect', async () => {
    const sideEffects: string[] = [];
    const delivery = vi.fn(() => {
      sideEffects.push('inbox-written');
      return Promise.reject(new Error('delivery failed after inbox write'));
    });

    await expect(outbox.appendIfNotRecent('test-team', makeMessage(), delivery)).rejects.toThrow(
      'delivery failed after inbox write'
    );

    expect(sideEffects).toEqual(['inbox-written']);
    expect(await outbox.read('test-team')).toEqual([]);
  });
});
