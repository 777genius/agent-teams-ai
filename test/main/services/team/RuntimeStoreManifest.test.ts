import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildRuntimeStoreReadiness,
  createDefaultRuntimeStoreManifest,
  createRuntimeStoreManifestStore,
  createRuntimeStoreReceiptStore,
  OPENCODE_RUNTIME_STORE_DESCRIPTORS,
  RuntimeStoreBatchWriter,
  RuntimeStoreFileInspector,
  RuntimeStoreRecoveryPlanner,
  validateOpenCodeRuntimeStoreInvariants,
  type RuntimeStoreDescriptor,
  type RuntimeStoreManifest,
} from '../../../../src/main/services/team/opencode/store/RuntimeStoreManifest';

let tempDir: string;
let now: Date;
let batchCounter: number;
let receiptCounter: number;

describe('RuntimeStoreManifest control plane', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-runtime-manifest-'));
    now = new Date('2026-04-21T12:00:00.000Z');
    batchCounter = 1;
    receiptCounter = 1;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes store receipts and updates manifest only after store files are written', async () => {
    const { manifestStore, receiptStore, writer } = createControlPlane();

    const committed = await writer.writeBatch({
      teamName: 'team-a',
      runId: 'run-1',
      capabilitySnapshotId: 'cap-1',
      behaviorFingerprint: 'behavior-1',
      reason: 'launch_checkpoint',
      writes: [
        {
          descriptor: descriptor('opencode.launchState'),
          data: {
            providerId: 'opencode',
            teamName: 'team-a',
            runId: 'run-1',
          },
        },
        {
          descriptor: descriptor('opencode.sessionStore'),
          data: { sessions: [{ teamName: 'team-a', memberName: 'Builder', runId: 'run-1' }] },
        },
      ],
    });

    expect(committed).toMatchObject({
      batchId: 'batch-1',
      state: 'committed',
      receipts: [
        expect.objectContaining({
          receiptId: 'receipt-1',
          schemaName: 'opencode.launchState',
          runId: 'run-1',
          capabilitySnapshotId: 'cap-1',
          behaviorFingerprint: 'behavior-1',
        }),
        expect.objectContaining({
          receiptId: 'receipt-2',
          schemaName: 'opencode.sessionStore',
        }),
      ],
    });

    await expect(receiptStore.list()).resolves.toEqual([
      expect.objectContaining({
        batchId: 'batch-1',
        state: 'committed',
        receipts: expect.any(Array),
      }),
    ]);
    await expect(manifestStore.read()).resolves.toMatchObject({
      activeRunId: 'run-1',
      activeCapabilitySnapshotId: 'cap-1',
      activeBehaviorFingerprint: 'behavior-1',
      highWatermark: 1,
      lastCommittedBatchId: 'batch-1',
      lastPreparingBatchId: null,
      entries: expect.arrayContaining([
        expect.objectContaining({
          schemaName: 'opencode.launchState',
          state: 'healthy',
          lastWriteReceiptId: 'receipt-1',
        }),
        expect.objectContaining({
          schemaName: 'opencode.sessionStore',
          state: 'healthy',
          lastWriteReceiptId: 'receipt-2',
        }),
      ]),
    });
  });

  it('detects crash between store write and manifest commit as readiness blocking', async () => {
    const { manifestStore, receiptStore, planner } = createControlPlane([
      descriptor('opencode.launchState'),
      descriptor('opencode.sessionStore'),
    ]);

    await fs.writeFile(
      path.join(tempDir, descriptor('opencode.sessionStore').relativePath),
      JSON.stringify(
        {
          schemaVersion: 1,
          updatedAt: '2026-04-21T12:00:00.000Z',
          data: { sessions: [{ teamName: 'team-a', memberName: 'Builder', runId: 'run-1' }] },
        },
        null,
        2
      ),
      'utf8'
    );

    const plan = await planner.buildPlan(recoveryInput());

    expect(await manifestStore.read()).toMatchObject({
      highWatermark: 0,
      entries: [],
    });
    await expect(receiptStore.list()).resolves.toEqual([]);
    expect(plan).toMatchObject({
      manifestHealthy: false,
      readinessImpact: 'blocked',
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: 'block_readiness',
        schemaName: 'opencode.launchState',
      })
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: 'rebuild_from_provider',
        schemaName: 'opencode.sessionStore',
      })
    );
    expect(buildRuntimeStoreReadiness({ recoveryPlan: plan, invariantFailures: [] })).toMatchObject({
      ok: false,
      reason: 'runtime_store_recovery_required',
    });
  });

  it('rebuilds permission store from provider after corruption quarantine', async () => {
    const { planner } = createControlPlane([descriptor('opencode.permissionRequests')]);
    await fs.writeFile(path.join(tempDir, descriptor('opencode.permissionRequests').relativePath), '{bad', 'utf8');

    const plan = await planner.buildPlan(recoveryInput());

    expect(plan.readinessImpact).toBe('degraded');
    expect(plan.actions).toContainEqual({
      kind: 'rebuild_from_provider',
      schemaName: 'opencode.permissionRequests',
      reason: 'quarantined',
    });
  });

  it('blocks readiness for future schema readiness-blocking stores', async () => {
    const { planner } = createControlPlane([descriptor('opencode.compatibilitySnapshot')]);
    await fs.writeFile(
      path.join(tempDir, descriptor('opencode.compatibilitySnapshot').relativePath),
      JSON.stringify({
        schemaVersion: 99,
        updatedAt: '2026-04-21T12:00:00.000Z',
        data: { snapshotId: 'cap-1' },
      }),
      'utf8'
    );

    const plan = await planner.buildPlan(recoveryInput());

    expect(plan.readinessImpact).toBe('blocked');
    expect(plan.actions).toContainEqual({
      kind: 'quarantine',
      schemaName: 'opencode.compatibilitySnapshot',
      reason: 'future_schema',
    });
  });

  it('blocks readiness when a manifest entry has a stale run identity', async () => {
    const { writer, planner } = createControlPlane([descriptor('opencode.launchState')]);
    await writer.writeBatch({
      teamName: 'team-a',
      runId: 'old-run',
      capabilitySnapshotId: 'cap-1',
      behaviorFingerprint: 'behavior-1',
      reason: 'launch_checkpoint',
      writes: [
        {
          descriptor: descriptor('opencode.launchState'),
          data: {
            providerId: 'opencode',
            teamName: 'team-a',
            runId: 'old-run',
          },
        },
      ],
    });

    const plan = await planner.buildPlan(recoveryInput());

    expect(plan.readinessImpact).toBe('blocked');
    expect(plan.actions).toContainEqual({
      kind: 'block_readiness',
      schemaName: 'opencode.launchState',
      reason: 'Runtime store opencode.launchState has stale run id',
    });
  });

  it('builds healthy readiness when manifest and invariants match', async () => {
    const { writer, planner } = createControlPlane([descriptor('opencode.launchState')]);
    await writer.writeBatch({
      teamName: 'team-a',
      runId: 'run-1',
      capabilitySnapshotId: 'cap-1',
      behaviorFingerprint: 'behavior-1',
      reason: 'launch_checkpoint',
      writes: [
        {
          descriptor: descriptor('opencode.launchState'),
          data: { providerId: 'opencode', teamName: 'team-a', runId: 'run-1' },
        },
      ],
    });

    const plan = await planner.buildPlan(recoveryInput());

    expect(plan).toMatchObject({
      manifestHealthy: true,
      readinessImpact: 'none',
      actions: [{ kind: 'none', schemaName: 'opencode.launchState' }],
    });
    expect(buildRuntimeStoreReadiness({ recoveryPlan: plan, invariantFailures: [] })).toEqual({
      ok: true,
      reason: 'runtime_store_manifest_valid',
      diagnostics: [],
    });
  });
});

describe('validateOpenCodeRuntimeStoreInvariants', () => {
  it('blocks readiness when launch-state points to missing confirmed session', () => {
    const failures = validateOpenCodeRuntimeStoreInvariants({
      launchState: {
        providerId: 'opencode',
        teamName: 'team-a',
        runId: 'run-1',
        capabilitySnapshotId: 'cap-1',
        aggregateState: 'launching',
        members: [{ name: 'Builder', launchState: 'confirmed_alive' }],
      },
      sessionStore: { sessions: [] },
      transaction: null,
      deliveryJournal: { records: [] },
      permissionStore: { requests: [] },
      compatibilitySnapshot: { snapshotId: 'cap-1' },
      manifest: manifest({ activeRunId: 'run-1', activeCapabilitySnapshotId: 'cap-1' }),
    });

    expect(failures).toContain('confirmed member Builder has no matching OpenCode session record');
  });

  it('reports stale delivery, stale permission, and active transaction conflicts', () => {
    const failures = validateOpenCodeRuntimeStoreInvariants({
      launchState: {
        providerId: 'opencode',
        teamName: 'team-a',
        runId: 'run-1',
        capabilitySnapshotId: 'cap-1',
        aggregateState: 'ready',
        members: [],
      },
      sessionStore: { sessions: [] },
      transaction: { status: 'active' },
      deliveryJournal: {
        records: [{ idempotencyKey: 'k-1', runId: 'old-run', status: 'started' }],
      },
      permissionStore: {
        requests: [{ appRequestId: 'perm-1', runId: 'old-run', status: 'pending' }],
      },
      compatibilitySnapshot: { snapshotId: 'other-cap' },
      manifest: manifest({ activeRunId: 'run-1', activeCapabilitySnapshotId: 'cap-1' }),
    });

    expect(failures).toEqual([
      'launch-state capability snapshot does not match compatibility snapshot',
      'non-committed delivery journal record belongs to stale run: k-1',
      'pending permission belongs to stale run: perm-1',
      'active launch transaction conflicts with ready launch-state',
    ]);
  });
});

function createControlPlane(descriptors: RuntimeStoreDescriptor[] = OPENCODE_RUNTIME_STORE_DESCRIPTORS) {
  const manifestStore = createRuntimeStoreManifestStore({
    filePath: path.join(tempDir, 'opencode-runtime-manifest.json'),
    teamName: 'team-a',
    clock: () => now,
  });
  const receiptStore = createRuntimeStoreReceiptStore({
    filePath: path.join(tempDir, 'opencode-runtime-receipts.json'),
    clock: () => now,
  });
  const writer = new RuntimeStoreBatchWriter(tempDir, manifestStore, receiptStore, {
    batchIdFactory: () => `batch-${batchCounter++}`,
    receiptIdFactory: () => `receipt-${receiptCounter++}`,
    clock: () => now,
  });
  const planner = new RuntimeStoreRecoveryPlanner(
    descriptors,
    manifestStore,
    receiptStore,
    new RuntimeStoreFileInspector(tempDir),
    {
      planIdFactory: () => 'plan-1',
      clock: () => now,
    }
  );
  return { manifestStore, receiptStore, writer, planner };
}

function descriptor(schemaName: RuntimeStoreDescriptor['schemaName']): RuntimeStoreDescriptor {
  const found = OPENCODE_RUNTIME_STORE_DESCRIPTORS.find((item) => item.schemaName === schemaName);
  if (!found) {
    throw new Error(`Missing descriptor ${schemaName}`);
  }
  return found;
}

function recoveryInput(): Parameters<RuntimeStoreRecoveryPlanner['buildPlan']>[0] {
  return {
    teamName: 'team-a',
    expectedRunId: 'run-1',
    expectedCapabilitySnapshotId: 'cap-1',
    expectedBehaviorFingerprint: 'behavior-1',
  };
}

function manifest(
  overrides: Partial<RuntimeStoreManifest> = {}
): RuntimeStoreManifest {
  return {
    ...createDefaultRuntimeStoreManifest('team-a', '2026-04-21T12:00:00.000Z'),
    ...overrides,
  };
}
