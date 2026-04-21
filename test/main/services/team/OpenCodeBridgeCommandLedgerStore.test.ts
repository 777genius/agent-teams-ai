import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stableHash } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import {
  createOpenCodeBridgeCommandLeaseStore,
  createOpenCodeBridgeCommandLedgerStore,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandLedgerStore';

describe('OpenCodeBridgeCommandLedgerStore', () => {
  let tempDir: string;
  let now: Date;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-bridge-ledger-'));
    now = new Date('2026-04-21T12:00:00.000Z');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('blocks idempotency key reuse with a different payload', async () => {
    const ledger = createOpenCodeBridgeCommandLedgerStore({
      filePath: path.join(tempDir, 'ledger.json'),
      clock: () => now,
    });

    await expect(
      ledger.begin({
        idempotencyKey: 'same',
        requestId: 'req-1',
        command: 'opencode.launchTeam',
        teamName: 'team-a',
        runId: 'run-1',
        requestHash: stableHash({ prompt: 'first' }),
      })
    ).resolves.toBe('started');

    await expect(
      ledger.begin({
        idempotencyKey: 'same',
        requestId: 'req-2',
        command: 'opencode.launchTeam',
        teamName: 'team-a',
        runId: 'run-1',
        requestHash: stableHash({ prompt: 'second' }),
      })
    ).rejects.toThrow('OpenCode bridge idempotency key reused with different payload');
  });

  it('marks timeout as unknown outcome and blocks retry until recovery', async () => {
    const ledger = createOpenCodeBridgeCommandLedgerStore({
      filePath: path.join(tempDir, 'ledger.json'),
      clock: () => now,
    });
    const requestHash = stableHash({ teamName: 'team-a', runId: 'run-1' });

    await ledger.begin({
      idempotencyKey: 'launch:team-a:run-1',
      requestId: 'req-1',
      command: 'opencode.launchTeam',
      teamName: 'team-a',
      runId: 'run-1',
      requestHash,
    });
    await ledger.markUnknownAfterTimeout({
      idempotencyKey: 'launch:team-a:run-1',
      error: 'timeout',
    });

    await expect(
      ledger.begin({
        idempotencyKey: 'launch:team-a:run-1',
        requestId: 'req-2',
        command: 'opencode.launchTeam',
        teamName: 'team-a',
        runId: 'run-1',
        requestHash,
      })
    ).rejects.toThrow('OpenCode bridge command outcome must be reconciled before retry');

    await expect(ledger.getByIdempotencyKey('launch:team-a:run-1')).resolves.toMatchObject({
      status: 'unknown_after_timeout',
      retryable: false,
      lastError: 'timeout',
    });
  });

  it('allows same-payload duplicate only after a completed command', async () => {
    const ledger = createOpenCodeBridgeCommandLedgerStore({
      filePath: path.join(tempDir, 'ledger.json'),
      clock: () => now,
    });
    const requestHash = stableHash({ body: 'same' });

    await ledger.begin({
      idempotencyKey: 'key-1',
      requestId: 'req-1',
      command: 'opencode.stopTeam',
      teamName: 'team-a',
      runId: 'run-1',
      requestHash,
    });

    await expect(
      ledger.begin({
        idempotencyKey: 'key-1',
        requestId: 'req-2',
        command: 'opencode.stopTeam',
        teamName: 'team-a',
        runId: 'run-1',
        requestHash,
      })
    ).rejects.toThrow('OpenCode bridge command already started');

    await ledger.markCompleted({
      idempotencyKey: 'key-1',
      response: { ok: true, runId: 'run-1' },
    });

    await expect(
      ledger.begin({
        idempotencyKey: 'key-1',
        requestId: 'req-3',
        command: 'opencode.stopTeam',
        teamName: 'team-a',
        runId: 'run-1',
        requestHash,
      })
    ).resolves.toBe('duplicate_same_payload_completed');
  });
});

describe('OpenCodeBridgeCommandLeaseStore', () => {
  let tempDir: string;
  let now: Date;
  let nextId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-bridge-lease-'));
    now = new Date('2026-04-21T12:00:00.000Z');
    nextId = 1;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('serializes state-changing commands per team through an active lease', async () => {
    const leaseStore = createOpenCodeBridgeCommandLeaseStore({
      filePath: path.join(tempDir, 'leases.json'),
      idFactory: () => `lease-${nextId++}`,
      clock: () => now,
    });

    const first = await leaseStore.acquire({
      teamName: 'team-a',
      runId: 'run-1',
      command: 'opencode.launchTeam',
      ttlMs: 10_000,
    });

    expect(first).toMatchObject({
      leaseId: 'lease-1',
      state: 'active',
      expiresAt: '2026-04-21T12:00:10.000Z',
    });

    await expect(
      leaseStore.acquire({
        teamName: 'team-a',
        runId: 'run-1',
        command: 'opencode.stopTeam',
        ttlMs: 10_000,
      })
    ).rejects.toThrow('OpenCode bridge command lease already active: lease-1');

    await leaseStore.release('lease-1');
    await expect(
      leaseStore.acquire({
        teamName: 'team-a',
        runId: 'run-1',
        command: 'opencode.stopTeam',
        ttlMs: 10_000,
      })
    ).resolves.toMatchObject({
      leaseId: 'lease-2',
      command: 'opencode.stopTeam',
      state: 'active',
    });
  });

  it('expires stale active leases before acquiring a new one', async () => {
    const leaseStore = createOpenCodeBridgeCommandLeaseStore({
      filePath: path.join(tempDir, 'leases.json'),
      idFactory: () => `lease-${nextId++}`,
      clock: () => now,
    });

    await leaseStore.acquire({
      teamName: 'team-a',
      runId: 'run-1',
      command: 'opencode.launchTeam',
      ttlMs: 1000,
    });

    now = new Date('2026-04-21T12:00:02.000Z');
    await expect(
      leaseStore.acquire({
        teamName: 'team-a',
        runId: 'run-1',
        command: 'opencode.reconcileTeam',
        ttlMs: 1000,
      })
    ).resolves.toMatchObject({
      leaseId: 'lease-2',
      state: 'active',
    });

    const persisted = JSON.parse(
      await fs.readFile(path.join(tempDir, 'leases.json'), 'utf8')
    ) as {
      data: Array<{ leaseId: string; state: string }>;
    };
    expect(persisted.data).toEqual([
      expect.objectContaining({ leaseId: 'lease-1', state: 'expired' }),
      expect.objectContaining({ leaseId: 'lease-2', state: 'active' }),
    ]);
  });
});
