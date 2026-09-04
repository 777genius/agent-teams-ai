import {
  clearPendingOpenCodePromptDeliveriesForTeam,
  readOwnedOpenCodeRuntimeRunIdsForTeam,
} from '@main/services/team/lifecycle/teamForceStopFlow';
import { createOpenCodePromptDeliveryLedgerStore } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import {
  getOpenCodeLaneScopedRuntimeFilePath,
  setOpenCodeRuntimeActiveRunManifest,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A force stop of one team and a relaunch of the same team can overlap: nothing
 * holds a lock across the flow, and the relaunch is exactly what a user does
 * when the regular stop hangs. Both runs write into the same lane ledger,
 * because a lane is named after the member and is reused. These cases prove the
 * cleanup cancels the stopped run's work and leaves the successor's alone.
 */
describe('clearPendingOpenCodePromptDeliveriesForTeam', () => {
  const teamName = 'fixteam';
  const laneId = 'secondary:opencode:jack';
  const requestedAt = new Date('2026-04-25T10:05:00.000Z');
  let teamsBasePath = '';

  beforeEach(async () => {
    teamsBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'force-stop-deliveries-'));
  });

  afterEach(async () => {
    if (teamsBasePath) {
      await fs.rm(teamsBasePath, { recursive: true, force: true });
    }
  });

  function createLedger() {
    return createOpenCodePromptDeliveryLedgerStore({
      filePath: getOpenCodeLaneScopedRuntimeFilePath({
        teamsBasePath,
        teamName,
        laneId,
        fileName: 'opencode-prompt-delivery-ledger.json',
      }),
    });
  }

  async function seedDelivery(input: {
    inboxMessageId: string;
    runId: string;
    now: string;
  }): Promise<string> {
    const record = await createLedger().ensurePending({
      teamName,
      memberName: 'jack',
      laneId,
      runId: input.runId,
      inboxMessageId: input.inboxMessageId,
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: `sha256:${input.inboxMessageId}`,
      now: input.now,
    });
    return record.id;
  }

  async function publishRun(runId: string): Promise<void> {
    await upsertOpenCodeRuntimeLaneIndexEntry({ teamsBasePath, teamName, laneId, state: 'active' });
    await setOpenCodeRuntimeActiveRunManifest({ teamsBasePath, teamName, laneId, runId });
  }

  it('cancels the stopped run and keeps the run that took the lane after it', async () => {
    await publishRun('run-a');
    const stoppedRun = await seedDelivery({
      inboxMessageId: 'msg-a',
      runId: 'run-a',
      now: '2026-04-25T10:04:00.000Z',
    });

    // Read while run-a still owns the lane, which is what the flow does before
    // it asks for the regular stop.
    const ownedRunIds = await readOwnedOpenCodeRuntimeRunIdsForTeam({ teamName, teamsBasePath });
    expect(ownedRunIds).toEqual(['run-a']);

    // The relaunch takes the lane and queues its own delivery while the stop is
    // still hanging.
    await publishRun('run-b');
    const relaunchedRun = await seedDelivery({
      inboxMessageId: 'msg-b',
      runId: 'run-b',
      now: '2026-04-25T10:06:00.000Z',
    });

    const result = await clearPendingOpenCodePromptDeliveriesForTeam({
      teamName,
      teamsBasePath,
      ownedRunIds,
      requestedAtMs: requestedAt.getTime(),
      now: () => new Date('2026-04-25T10:07:00.000Z'),
    });

    expect(result.cleared).toBe(1);
    expect(result.diagnostics).toEqual([
      'Cancelled 1 pending prompt delivery record(s)',
      'Kept 1 pending prompt delivery record(s) that a later run owns',
    ]);
    const statuses = new Map(
      (await createLedger().list()).map((record) => [record.id, record.status])
    );
    expect(statuses.get(stoppedRun)).toBe('failed_terminal');
    expect(statuses.get(relaunchedRun)).toBe('pending');
    await expect(
      createLedger().listDue({ now: new Date('2026-04-25T10:08:00.000Z'), limit: 10 })
    ).resolves.toMatchObject([{ id: relaunchedRun }]);
  });

  it('cancels the whole lane when the caller passes no fence', async () => {
    // Negative control: the successor survives because of the fence, not
    // because of anything in the ledger itself.
    await publishRun('run-a');
    await seedDelivery({
      inboxMessageId: 'msg-a',
      runId: 'run-a',
      now: '2026-04-25T10:04:00.000Z',
    });
    await publishRun('run-b');
    await seedDelivery({
      inboxMessageId: 'msg-b',
      runId: 'run-b',
      now: '2026-04-25T10:06:00.000Z',
    });

    const result = await clearPendingOpenCodePromptDeliveriesForTeam({
      teamName,
      teamsBasePath,
      now: () => new Date('2026-04-25T10:07:00.000Z'),
    });

    expect(result.cleared).toBe(2);
    expect(result.diagnostics).toEqual(['Cancelled 2 pending prompt delivery record(s)']);
  });

  it('reads no run id for a team that never published a lane', async () => {
    await expect(
      readOwnedOpenCodeRuntimeRunIdsForTeam({ teamName, teamsBasePath })
    ).resolves.toEqual([]);
    await expect(
      clearPendingOpenCodePromptDeliveriesForTeam({ teamName, teamsBasePath })
    ).resolves.toEqual({ cleared: 0, diagnostics: [] });
  });
});
