import {
  clearPendingOpenCodePromptDeliveriesForTeam,
  readOwnedOpenCodeRuntimeRunIdsForTeam,
  runTeamForceStopFlow,
} from '@main/services/team/lifecycle/teamForceStopFlow';
import { createOpenCodePromptDeliveryLedgerStore } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import {
  clearOpenCodeRuntimeLaneStorage,
  getOpenCodeLaneScopedRuntimeFilePath,
  prepareOpenCodeRuntimeLaneForLaunchGeneration,
  setOpenCodeRuntimeActiveRunManifest,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, expect, it, vi } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const teamsBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-lane-durability-'));
  roots.push(teamsBasePath);
  const ctx = { teamsBasePath, teamName: 'sandbox', laneId: 'primary' };
  await upsertOpenCodeRuntimeLaneIndexEntry({ ...ctx, state: 'active' });
  await setOpenCodeRuntimeActiveRunManifest({ ...ctx, runId: 'run-a' });
  const filePath = getOpenCodeLaneScopedRuntimeFilePath({
    ...ctx,
    fileName: 'opencode-prompt-delivery-ledger.json',
  });
  const ledger = createOpenCodePromptDeliveryLedgerStore({ filePath });
  const message = {
    ...ctx,
    memberName: 'worker',
    inboxMessageId: 'old-message',
    inboxTimestamp: new Date().toISOString(),
    source: 'manual' as const,
    replyRecipient: 'user',
    payloadHash: 'same',
    now: new Date().toISOString(),
  };
  await ledger.ensurePending({ ...message, runId: 'run-a' });
  return { ctx, filePath, ledger, message };
}
it('successful real scoped storage stop retains a force cancellation for the unread message', async () => {
  const { ctx, ledger, message } = await fixture();
  const result = await runTeamForceStopFlow(ctx.teamName, {
    observeOwnedRuntimeRunIds: () => readOwnedOpenCodeRuntimeRunIdsForTeam(ctx),
    stopTeam: async () => {
      expect(await clearOpenCodeRuntimeLaneStorage({ ...ctx, expectedRunId: 'run-a' })).toBe(true);
    },
    killRetainedRuntimeProcesses: vi.fn(async () => ({ killedPids: [], diagnostics: [] })),
    clearPendingPromptDeliveries: (_, fence) =>
      clearPendingOpenCodePromptDeliveriesForTeam({ ...ctx, ...fence }),
    logWarning: vi.fn(),
  });
  expect(result.stopOutcome).toBe('stopped');
  const rebuilt = await ledger.ensurePending({
    ...message,
    runId: 'run-b',
    now: new Date().toISOString(),
  });
  expect({ cleared: result.clearedPendingDeliveries, replayStatus: rebuilt.status }).toEqual({
    cleared: 1,
    replayStatus: 'failed_terminal',
  });
});
it('a cancellation tombstone survives the next real scoped storage cleanup', async () => {
  const { ctx, ledger, message } = await fixture();
  await ledger.cancelNonTerminalRecords({
    now: new Date().toISOString(),
    reason: 'force_stop_requested: test',
  });
  expect((await ledger.getByInboxMessage(message))?.cancelledAt).toBeTruthy();
  expect(await clearOpenCodeRuntimeLaneStorage({ ...ctx, expectedRunId: 'run-a' })).toBe(true);
  const rebuilt = await ledger.ensurePending({
    ...message,
    runId: 'run-b',
    now: new Date().toISOString(),
  });
  expect(rebuilt.cancelledAt).toBeTruthy();
  expect(rebuilt.status).toBe('failed_terminal');
});

it('retains normal delivery recovery and cancellation across forced successor preparation', async () => {
  const { ctx, ledger, message } = await fixture();
  await ledger.cancelNonTerminalRecords({ now: message.now, reason: 'force_stop_requested: test' });
  const pending = await ledger.ensurePending({
    ...message,
    inboxMessageId: 'recoverable',
    runId: 'run-a',
  });
  await ledger.applyDeliveryResult({
    id: pending.id,
    accepted: true,
    runtimePromptMessageId: 'accepted-prompt',
    now: message.now,
  });
  const before = await ledger.list();
  await prepareOpenCodeRuntimeLaneForLaunchGeneration({
    ...ctx,
    runId: 'run-b',
    forceReset: true,
    reason: 'sandbox-relaunch',
  });
  expect(await ledger.list()).toEqual(before);
  expect(await ledger.ensurePending({ ...message, runId: 'run-b' })).toMatchObject({
    status: 'failed_terminal',
    cancelledAt: message.now,
  });
  expect(await ledger.listDue({ now: new Date(), limit: 10 })).toEqual([
    before.find((record) => record.id === pending.id),
  ]);
});
