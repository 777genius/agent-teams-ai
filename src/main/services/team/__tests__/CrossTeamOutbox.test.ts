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

  it('dedupes a retry with the same message id and conversation id', async () => {
    const outbox = new CrossTeamOutbox();
    const onBeforeAppend = vi.fn(async () => {});
    const message = makeMessage();

    await expect(outbox.appendIfNotRecent('source-team', message, onBeforeAppend)).resolves.toEqual(
      { duplicate: null }
    );
    await expect(
      outbox.appendIfNotRecent('source-team', makeMessage(), onBeforeAppend)
    ).resolves.toEqual({ duplicate: message });

    await expect(outbox.read('source-team')).resolves.toEqual([message]);
    expect(onBeforeAppend).toHaveBeenCalledTimes(1);
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

  it('does not dedupe distinct runtime deliveries that reuse the same body', async () => {
    const outbox = new CrossTeamOutbox();
    const onBeforeAppend = vi.fn(async () => {});
    const first = makeMessage({
      messageId: 'runtime-message-1',
      conversationId: 'runtime-idempotency-1',
    });
    const second = makeMessage({
      messageId: 'runtime-message-2',
      conversationId: 'runtime-idempotency-2',
    });

    await expect(outbox.appendIfNotRecent('source-team', first, onBeforeAppend)).resolves.toEqual({
      duplicate: null,
    });
    await expect(
      outbox.appendIfNotRecent('source-team', second, onBeforeAppend, undefined, {
        stableIdentity: true,
      })
    ).resolves.toEqual({ duplicate: null });

    await expect(outbox.read('source-team')).resolves.toEqual([first, second]);
    expect(onBeforeAppend).toHaveBeenCalledTimes(2);
  });
});
