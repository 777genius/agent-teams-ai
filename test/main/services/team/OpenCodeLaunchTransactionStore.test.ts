import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  canMarkOpenCodeRunReady,
  createOpenCodeLaunchEvidenceHash,
  createOpenCodeLaunchTransactionStore,
  redactOpenCodeLaunchEvidence,
  type OpenCodeLaunchCheckpoint,
  type OpenCodeLaunchTransaction,
} from '../../../../src/main/services/team/opencode/store/OpenCodeLaunchTransactionStore';

let tempDir: string;
let now: Date;

describe('OpenCodeLaunchTransactionStore', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-launch-tx-'));
    now = new Date('2026-04-21T12:00:00.000Z');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('begins a run and blocks duplicate launch while active', async () => {
    const store = createStore();

    await expect(
      store.beginRun({
        teamName: 'team-a',
        runId: 'run-1',
      })
    ).resolves.toMatchObject({
      state: 'created',
      transaction: {
        teamName: 'team-a',
        runId: 'run-1',
        status: 'active',
      },
    });

    await expect(
      store.beginRun({
        teamName: 'team-a',
        runId: 'run-2',
      })
    ).resolves.toMatchObject({
      state: 'already_active',
      transaction: {
        runId: 'run-1',
      },
    });
  });

  it('adds checkpoints idempotently and ignores late checkpoints from old runs', async () => {
    const store = createStore();
    await store.beginRun({ teamName: 'team-a', runId: 'run-1' });
    const checkpoint = buildCheckpoint({
      name: 'member_session_recorded',
      memberName: 'Builder',
      evidenceHash: createOpenCodeLaunchEvidenceHash({ sessionId: 'session-1' }),
    });

    await expect(store.addCheckpoint(checkpoint)).resolves.toBe('created');
    await expect(store.addCheckpoint(checkpoint)).resolves.toBe('unchanged');
    await expect(
      store.hasCheckpoint({
        teamName: 'team-a',
        runId: 'run-1',
        memberName: 'Builder',
        name: 'member_session_recorded',
      })
    ).resolves.toBe(true);

    await expect(
      store.addCheckpoint({
        ...checkpoint,
        runId: 'old-run',
      })
    ).rejects.toThrow('OpenCode launch transaction not found: old-run');
    await expect(store.read('team-a', 'run-1')).resolves.toMatchObject({
      checkpoints: [expect.objectContaining({ name: 'member_session_recorded' })],
    });
  });

  it('finishes active transaction and rejects stale finish for another run', async () => {
    const store = createStore();
    await store.beginRun({ teamName: 'team-a', runId: 'run-1' });

    await expect(
      store.finish({
        teamName: 'team-a',
        runId: 'old-run',
        status: 'failed',
      })
    ).rejects.toThrow('OpenCode launch transaction old-run is stale; active run is run-1');

    await expect(
      store.finish({
        teamName: 'team-a',
        runId: 'run-1',
        status: 'ready',
      })
    ).resolves.toBe('finished');
    await expect(store.readActive('team-a')).resolves.toBeNull();
    await expect(store.read('team-a', 'run-1')).resolves.toMatchObject({
      status: 'ready',
    });
  });

  it('quarantines future or invalid transaction data through VersionedJsonStore', async () => {
    const filePath = path.join(tempDir, 'launch-transactions.json');
    await fs.writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: '2026-04-21T12:00:00.000Z',
        data: [{ teamName: 'team-a', runId: '' }],
      }),
      'utf8'
    );
    const store = createStore(filePath);

    await expect(store.list()).rejects.toMatchObject({
      reason: 'invalid_data',
    });
    const files = await fs.readdir(tempDir);
    expect(files.some((file) => file.includes('invalid_data'))).toBe(true);
  });
});

describe('canMarkOpenCodeRunReady', () => {
  it('lists exact missing readiness checkpoints before run_ready', () => {
    const transaction = transactionWithCheckpoints([
      buildCheckpoint({
        name: 'member_session_recorded',
        memberName: 'Builder',
      }),
    ]);

    expect(
      canMarkOpenCodeRunReady({
        members: [
          { name: 'Builder', launchState: 'confirmed_alive' },
          { name: 'Reviewer', launchState: 'pending' },
        ],
        transaction,
        toolProof: { ok: false },
        deliveryReady: false,
      })
    ).toEqual({
      ok: false,
      missing: [
        'Builder:required_tools_proven',
        'Reviewer:member_session_recorded',
        'Reviewer:required_tools_proven',
        'Reviewer:bootstrap_confirmed',
        'required_runtime_tools',
        'runtime_delivery_service',
      ],
    });
  });

  it('allows ready only when every member and runtime delivery proof exists', () => {
    const transaction = transactionWithCheckpoints([
      buildCheckpoint({ name: 'member_session_recorded', memberName: 'Builder' }),
      buildCheckpoint({ name: 'required_tools_proven', memberName: 'Builder' }),
      buildCheckpoint({ name: 'member_session_recorded', memberName: 'Reviewer' }),
      buildCheckpoint({ name: 'required_tools_proven', memberName: 'Reviewer' }),
    ]);

    expect(
      canMarkOpenCodeRunReady({
        members: [
          { name: 'Builder', launchState: 'confirmed_alive' },
          { name: 'Reviewer', launchState: 'confirmed_alive' },
        ],
        transaction,
        toolProof: { ok: true },
        deliveryReady: true,
      })
    ).toEqual({
      ok: true,
      missing: [],
    });
  });
});

describe('OpenCode launch evidence redaction', () => {
  it('redacts secret fields before hashing evidence', () => {
    const evidence = {
      sessionId: 'session-1',
      token: 'live-token',
      nested: {
        apiKey: 'live-key',
      },
    };

    expect(redactOpenCodeLaunchEvidence(evidence)).toEqual({
      sessionId: 'session-1',
      token: '[redacted]',
      nested: {
        apiKey: '[redacted]',
      },
    });
    expect(createOpenCodeLaunchEvidenceHash(evidence)).toBe(
      createOpenCodeLaunchEvidenceHash({
        sessionId: 'session-1',
        token: 'other-token',
        nested: {
          apiKey: 'other-key',
        },
      })
    );
  });
});

function createStore(filePath = path.join(tempDir, 'launch-transactions.json')) {
  return createOpenCodeLaunchTransactionStore({
    filePath,
    clock: () => now,
  });
}

function buildCheckpoint(
  overrides: Partial<OpenCodeLaunchCheckpoint>
): OpenCodeLaunchCheckpoint {
  return {
    name: 'run_created',
    teamName: 'team-a',
    runId: 'run-1',
    memberName: null,
    runtimeSessionId: null,
    hostKey: null,
    evidenceHash: createOpenCodeLaunchEvidenceHash({ ok: true }),
    createdAt: '2026-04-21T12:00:00.000Z',
    diagnostics: [],
    ...overrides,
  };
}

function transactionWithCheckpoints(
  checkpoints: OpenCodeLaunchCheckpoint[]
): OpenCodeLaunchTransaction {
  return {
    teamName: 'team-a',
    runId: 'run-1',
    providerId: 'opencode',
    startedAt: '2026-04-21T12:00:00.000Z',
    updatedAt: '2026-04-21T12:00:00.000Z',
    status: 'active',
    checkpoints,
  };
}
