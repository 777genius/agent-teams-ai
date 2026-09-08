import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createOpenCodePromptDeliveryLedgerStore,
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
} from '../OpenCodePromptDeliveryLedger';
import { decideOpenCodePromptDeliveryTurnActivity } from '../OpenCodePromptDeliveryWatchdog';

import type { OpenCodeDeliveryResponseObservation } from '../../bridge/OpenCodeBridgeCommandContract';

const OBSERVED_TOOLS = ['task_create', 'task_create', 'glob'];

function observation(
  overrides: Partial<OpenCodeDeliveryResponseObservation> = {}
): OpenCodeDeliveryResponseObservation {
  return {
    state: 'responded_tool_call',
    deliveredUserMessageId: 'runtime-prompt-1',
    assistantMessageId: 'assistant-1',
    toolCallNames: [...OBSERVED_TOOLS],
    visibleMessageToolCallId: null,
    visibleReplyMessageId: null,
    visibleReplyCorrelation: null,
    latestAssistantPreview: 'Building the board.',
    reason: null,
    ...overrides,
  };
}

describe('OpenCodePromptDeliveryLedger applyObservation', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-prompt-ledger-observation-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function createPendingRecord(): Promise<{
    store: OpenCodePromptDeliveryLedgerStore;
    record: OpenCodePromptDeliveryLedgerRecord;
  }> {
    const store = createOpenCodePromptDeliveryLedgerStore({
      filePath: path.join(tempDir, 'opencode-prompt-delivery-ledger.json'),
      clock: () => new Date('2026-04-25T10:00:00.000Z'),
    });
    const record = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-1',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      actionMode: 'ask',
      taskRefs: [],
      payloadHash: 'sha256:payload',
      now: '2026-04-25T10:00:00.000Z',
    });
    return { store, record };
  }

  it('keeps the observed tool list when a failed observation carries none', async () => {
    const { store, record } = await createPendingRecord();
    const observed = await store.applyObservation({
      id: record.id,
      responseObservation: observation(),
      observedAt: '2026-04-25T10:00:10.000Z',
    });
    expect(observed.observedToolCallNames).toEqual(OBSERVED_TOOLS);

    // The bridge observe failed, so the service substitutes an empty fallback.
    const afterFailure = await store.applyObservation({
      id: record.id,
      responseObservation: observation({
        state: 'reconcile_failed',
        deliveredUserMessageId: null,
        assistantMessageId: null,
        toolCallNames: [],
        latestAssistantPreview: null,
        reason: 'reconcile_failed',
      }),
      observedAt: '2026-04-25T10:00:20.000Z',
    });

    expect(afterFailure.responseState).toBe('reconcile_failed');
    expect(afterFailure.observedToolCallNames).toEqual(OBSERVED_TOOLS);
  });

  it('does not let a failed observation fake tool progress on the next pass', async () => {
    const { store, record } = await createPendingRecord();
    await store.applyObservation({
      id: record.id,
      responseObservation: observation(),
      observedAt: '2026-04-25T10:00:10.000Z',
    });
    const afterFailure = await store.applyObservation({
      id: record.id,
      responseObservation: observation({
        state: 'not_observed',
        deliveredUserMessageId: null,
        assistantMessageId: null,
        toolCallNames: [],
        latestAssistantPreview: null,
        reason: 'not_observed',
      }),
      observedAt: '2026-04-25T10:00:20.000Z',
    });

    // The recovered observation reports the same finished turn; nothing moved.
    expect(
      decideOpenCodePromptDeliveryTurnActivity({
        previousAssistantMessageId: afterFailure.observedAssistantMessageId ?? '',
        previousToolCallCount: afterFailure.observedToolCallNames.length,
        previousAssistantPreview: afterFailure.observedAssistantPreview ?? '',
        observation: observation(),
        observedDiagnostics: [],
        pendingAgeMs: 120_000,
      })
    ).toEqual({ active: false, reason: 'turn_idle' });
  });
});
