import { createOpenCodePromptDeliveryLedgerStore } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import { OpenCodePromptDeliveryWatchdogCoordinator } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdogCoordinator';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenCodePromptDeliveryWatchdogCoordinatorPorts } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdogCoordinator';

describe('inline observation cancellation', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-cancellation-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  it.each(['sleep', 'result', 'error', 'successor'] as const)(
    'fences late %s side effects',
    async (boundary) => {
      const ledger = createOpenCodePromptDeliveryLedgerStore({
        filePath: path.join(root, 'ledger.json'),
      });
      const ledgerRecord = await ledger.ensurePending({
        teamName: 'sandbox',
        memberName: 'worker',
        laneId: 'primary',
        inboxMessageId: 'message',
        inboxTimestamp: new Date().toISOString(),
        source: 'manual',
        replyRecipient: 'user',
        payloadHash: 'hash',
        now: new Date().toISOString(),
      });
      const cancel = () =>
        ledger.cancelNonTerminalRecords({
          now: new Date().toISOString(),
          reason: 'force_stop_requested: test',
        });
      let runId = 'run-a';
      const observeMessageDelivery = vi.fn(async () => {
        if (boundary === 'successor') runId = 'run-b';
        else await cancel();
        if (boundary === 'error') throw new Error('runtime gone');
        return { ok: true, diagnostics: [], runtimePid: 4141 };
      });
      const rememberRuntimePidFromBridge = vi.fn();
      const maybeSyncRuntimePermissionsAfterDelivery = vi.fn();
      const applyDestinationProof = vi.fn();
      const materializePlainTextReplyIfNeeded = vi.fn();
      const coordinator = new OpenCodePromptDeliveryWatchdogCoordinator({
        sleep: async () => {
          if (boundary === 'sleep') await cancel();
        },
        resolveCurrentRuntimeRunId: async () => runId,
        rememberRuntimePidFromBridge,
        maybeSyncRuntimePermissionsAfterDelivery,
        visibleReplyProofService: { applyDestinationProof, materializePlainTextReplyIfNeeded },
        taskRefsIncludeAll: () => false,
      } as unknown as OpenCodePromptDeliveryWatchdogCoordinatorPorts);
      const result = await coordinator.observeDirectUserDeliveryInlineIfNeeded({
        adapter: { observeMessageDelivery } as never,
        ledger,
        ledgerRecord,
        teamName: 'sandbox',
        memberName: 'worker',
        laneId: 'primary',
        runtimeRunId: 'run-a',
        cwd: root,
        text: 'test',
        messageId: 'message',
        promptAccepted: true,
      });
      expect(observeMessageDelivery).toHaveBeenCalledTimes(boundary === 'sleep' ? 0 : 1);
      expect(rememberRuntimePidFromBridge).not.toHaveBeenCalled();
      expect(maybeSyncRuntimePermissionsAfterDelivery).not.toHaveBeenCalled();
      expect(applyDestinationProof).not.toHaveBeenCalled();
      expect(materializePlainTextReplyIfNeeded).not.toHaveBeenCalled();
      expect(result.visibleReply).toBeNull();
      if (boundary !== 'successor') expect(result.ledgerRecord.cancelledAt).toBeTruthy();
    }
  );
});
