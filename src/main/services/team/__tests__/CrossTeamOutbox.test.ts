import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CrossTeamOutbox } from '../CrossTeamOutbox';

import type { CrossTeamMessage } from '@shared/types';

function makeMessage(overrides: Partial<CrossTeamMessage> = {}): CrossTeamMessage {
  return {
    messageId: 'runtime-message-1',
    conversationId: 'runtime-idempotency-1',
    fromTeam: 'source-team',
    fromMember: 'team-lead',
    toTeam: 'target-team',
    toMember: 'team-lead',
    text: 'Ship the same payload',
    taskRefs: [{ taskId: 'task-1', displayId: '#1', teamName: 'source-team' }],
    summary: 'Runtime delivery',
    chainDepth: 0,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('CrossTeamOutbox runtime delivery dedupe', () => {
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-team-outbox-'));
    setClaudeBasePathOverride(tempRoot);
  });

  afterEach(() => {
    setClaudeBasePathOverride(null);
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('dedupes a runtime retry with the same trimmed caller message id', async () => {
    const outbox = new CrossTeamOutbox();
    const onBeforeAppend = vi.fn(async () => {});
    const message = makeMessage();
    const retry = makeMessage({
      messageId: '\truntime-message-1\n',
      conversationId: 'runtime-idempotency-2',
      text: 'Retry payload changed after the caller message id was already recorded',
      summary: 'Retry summary changed',
      taskRefs: [{ taskId: 'task-2', displayId: '#2', teamName: 'source-team' }],
    });

    await expect(
      outbox.appendIfNotRecent('source-team', message, onBeforeAppend, undefined, {
        stableIdentity: true,
        callerMessageId: message.messageId,
      })
    ).resolves.toEqual({ duplicate: null });
    await expect(
      outbox.appendIfNotRecent('source-team', retry, onBeforeAppend, undefined, {
        stableIdentity: true,
        callerMessageId: retry.messageId,
      })
    ).resolves.toEqual({
      duplicate: message,
    });

    await expect(outbox.read('source-team')).resolves.toEqual([message]);
    expect(onBeforeAppend).toHaveBeenCalledTimes(1);
  });

  it('dedupes a runtime retry without a caller message id by conversation identity', async () => {
    const outbox = new CrossTeamOutbox();
    const onBeforeAppend = vi.fn(async () => {});
    const message = makeMessage({
      messageId: 'generated-message-1',
      conversationId: 'runtime-idempotency-1',
    });
    const retry = makeMessage({
      messageId: 'generated-message-2',
      conversationId: '\truntime-idempotency-1\n',
      text: 'Retry payload changed after the conversation was already recorded',
      summary: 'Retry summary changed',
      taskRefs: [{ taskId: 'task-2', displayId: '#2', teamName: 'source-team' }],
    });

    await expect(
      outbox.appendIfNotRecent('source-team', message, onBeforeAppend, undefined, {
        stableIdentity: true,
      })
    ).resolves.toEqual({ duplicate: null });
    await expect(
      outbox.appendIfNotRecent('source-team', retry, onBeforeAppend, undefined, {
        stableIdentity: true,
      })
    ).resolves.toEqual({ duplicate: message });

    await expect(outbox.read('source-team')).resolves.toEqual([message]);
    expect(onBeforeAppend).toHaveBeenCalledTimes(1);
  });

  it('dedupes a runtime retry behind an out-of-order stale message', async () => {
    const outbox = new CrossTeamOutbox();
    const onBeforeAppend = vi.fn(async () => {});
    const message = makeMessage();
    const staleInterveningMessage = makeMessage({
      messageId: 'runtime-message-stale',
      conversationId: 'runtime-idempotency-stale',
      text: 'Older message appended after the original delivery',
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    const retry = makeMessage({
      messageId: 'runtime-message-retry',
      text: 'Retry payload changed after the original delivery',
    });

    for (const nextMessage of [message, staleInterveningMessage]) {
      await expect(
        outbox.appendIfNotRecent('source-team', nextMessage, onBeforeAppend, undefined, {
          stableIdentity: true,
        })
      ).resolves.toEqual({ duplicate: null });
    }

    await expect(
      outbox.appendIfNotRecent('source-team', retry, onBeforeAppend, undefined, {
        stableIdentity: true,
      })
    ).resolves.toEqual({ duplicate: message });
    await expect(outbox.read('source-team')).resolves.toEqual([message, staleInterveningMessage]);
    expect(onBeforeAppend).toHaveBeenCalledTimes(2);
  });

  it('dedupes body-identical messages when stable identity is not requested', async () => {
    const outbox = new CrossTeamOutbox();
    const onBeforeAppend = vi.fn(async () => {});
    const first = makeMessage({
      messageId: 'generated-message-1',
      conversationId: 'generated-conversation-1',
    });
    const second = makeMessage({
      messageId: 'generated-message-2',
      conversationId: 'generated-conversation-2',
    });

    await expect(outbox.appendIfNotRecent('source-team', first, onBeforeAppend)).resolves.toEqual({
      duplicate: null,
    });
    await expect(outbox.appendIfNotRecent('source-team', second, onBeforeAppend)).resolves.toEqual({
      duplicate: first,
    });
    expect(onBeforeAppend).toHaveBeenCalledTimes(1);
  });

  it('dedupes a cross-run retry that reuses the conversation identity with a new run-scoped caller message id', async () => {
    const outbox = new CrossTeamOutbox();
    const onBeforeAppend = vi.fn(async () => {});
    // Runtime cross-team caller messageId is the run-scoped destinationMessageId
    // (hash of idempotencyKey + runId + team); conversationId is the stable
    // idempotencyKey. A relaunch re-delivers the SAME logical message with a new
    // run-scoped id but the same conversationId - it must dedupe.
    const first = makeMessage({
      messageId: 'runtime-delivery-run1-abc',
      conversationId: 'runtime-idempotency-1',
    });
    const second = makeMessage({
      messageId: 'runtime-delivery-run2-def',
      conversationId: 'runtime-idempotency-1',
    });

    await expect(
      outbox.appendIfNotRecent('source-team', first, onBeforeAppend, undefined, {
        stableIdentity: true,
        callerMessageId: first.messageId,
      })
    ).resolves.toEqual({ duplicate: null });
    await expect(
      outbox.appendIfNotRecent('source-team', second, onBeforeAppend, undefined, {
        stableIdentity: true,
        callerMessageId: second.messageId,
      })
    ).resolves.toEqual({ duplicate: first });

    await expect(outbox.read('source-team')).resolves.toEqual([first]);
    expect(onBeforeAppend).toHaveBeenCalledTimes(1);
  });

  it('delivers distinct runtime messages that carry distinct conversation identities', async () => {
    const outbox = new CrossTeamOutbox();
    const onBeforeAppend = vi.fn(async () => {});
    const first = makeMessage({
      messageId: 'runtime-delivery-run1-abc',
      conversationId: 'runtime-idempotency-1',
    });
    const second = makeMessage({
      messageId: 'runtime-delivery-run1-def',
      conversationId: 'runtime-idempotency-2',
    });

    for (const message of [first, second]) {
      await expect(
        outbox.appendIfNotRecent('source-team', message, onBeforeAppend, undefined, {
          stableIdentity: true,
          callerMessageId: message.messageId,
        })
      ).resolves.toEqual({ duplicate: null });
    }

    await expect(outbox.read('source-team')).resolves.toEqual([first, second]);
    expect(onBeforeAppend).toHaveBeenCalledTimes(2);
  });
});
