import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

import { VersionedJsonStore, VersionedJsonStoreError } from './VersionedJsonStore';

export const OPENCODE_RUNTIME_STORE_MANIFEST_SCHEMA_VERSION = 1;
export const OPENCODE_RUNTIME_STORE_RECEIPT_SCHEMA_VERSION = 1;

export type RuntimeStoreSchemaName =
  | 'opencode.launchState'
  | 'opencode.sessionStore'
  | 'opencode.launchTransaction'
  | 'opencode.deliveryJournal'
  | 'opencode.promptDeliveryLedger'
  | 'opencode.permissionRequests'
  | 'opencode.hostLeases'
  | 'opencode.compatibilitySnapshot'
  | 'opencode.runtimeRevision'
  | 'opencode.runtimeDiagnostics'
  | 'opencode.e2eEvidence';

export type RuntimeStoreCriticality =
  | 'readiness_blocking'
  | 'rebuildable_from_provider'
  | 'rebuildable_from_canonical_destination'
  | 'diagnostic_only';

export type RuntimeStoreOwner =
  | 'launch'
  | 'session'
  | 'delivery'
  | 'permission'
  | 'host'
  | 'compatibility'
  | 'ui'
  | 'diagnostics'
  | 'e2e';

export type RuntimeStoreRebuildStrategy =
  | 'none'
  | 'poll_opencode_provider'
  | 'verify_canonical_destinations'
  | 'rerun_capability_discovery'
  | 'rebuild_from_launch_state'
  | 'drop_after_quarantine';

export interface RuntimeStoreDescriptor {
  schemaName: RuntimeStoreSchemaName;
  schemaVersion: number;
  relativePath: string;
  criticality: RuntimeStoreCriticality;
  owner: RuntimeStoreOwner;
  rebuildStrategy: RuntimeStoreRebuildStrategy;
}

export type RuntimeStoreManifestEntryState =
  | 'healthy'
  | 'missing'
  | 'quarantined'
  | 'future_schema'
  | 'hash_mismatch'
  | 'stale_run'
  | 'rebuild_required'
  | 'uncommitted_write';

export interface RuntimeStoreManifestEntry {
  schemaName: RuntimeStoreSchemaName;
  schemaVersion: number;
  relativePath: string;
  contentHash: string | null;
  fileSize: number | null;
  mtimeMs: number | null;
  runId: string | null;
  capabilitySnapshotId: string | null;
  behaviorFingerprint: string | null;
  lastWriteReceiptId: string | null;
  state: RuntimeStoreManifestEntryState;
}

export interface RuntimeStoreManifest {
  schemaVersion: typeof OPENCODE_RUNTIME_STORE_MANIFEST_SCHEMA_VERSION;
  teamName: string;
  activeRunId: string | null;
  activeCapabilitySnapshotId: string | null;
  activeBehaviorFingerprint: string | null;
  highWatermark: number;
  lastCommittedBatchId: string | null;
  lastPreparingBatchId: string | null;
  entries: RuntimeStoreManifestEntry[];
  lastRecoveryPlanId: string | null;
  updatedAt: string;
}

export type RuntimeStoreWriteBatchReason =
  | 'launch_checkpoint'
  | 'permission_reconcile'
  | 'delivery_commit'
  | 'host_lease_update'
  | 'compatibility_discovery'
  | 'stop_tombstone'
  | 'migration'
  | 'recovery';

export interface RuntimeStoreWriteReceipt {
  receiptId: string;
  batchId: string;
  schemaName: RuntimeStoreSchemaName;
  teamName: string;
  runId: string | null;
  capabilitySnapshotId: string | null;
  behaviorFingerprint: string | null;
  schemaVersion: number;
  relativePath: string;
  contentHash: string;
  fileSize: number;
  mtimeMs: number;
  writtenAt: string;
}

export interface RuntimeStoreWriteBatch {
  batchId: string;
  teamName: string;
  runId: string | null;
  capabilitySnapshotId: string | null;
  behaviorFingerprint: string | null;
  reason: RuntimeStoreWriteBatchReason;
  startedAt: string;
  completedAt: string | null;
  state: 'preparing' | 'committing' | 'committed' | 'failed';
  receipts: RuntimeStoreWriteReceipt[];
  lastError: string | null;
}

export interface RuntimeStoreFileInspection {
  descriptor: RuntimeStoreDescriptor;
  state: RuntimeStoreManifestEntryState;
  entry: RuntimeStoreManifestEntry | null;
  manifestEntry: RuntimeStoreManifestEntry | null;
  message: string | null;
}

export type RuntimeStoreRecoveryAction =
  | { kind: 'none'; schemaName: RuntimeStoreSchemaName }
  | { kind: 'quarantine'; schemaName: RuntimeStoreSchemaName; reason: string }
  | { kind: 'rebuild_from_provider'; schemaName: RuntimeStoreSchemaName; reason: string }
  | {
      kind: 'rebuild_from_canonical_destination';
      schemaName: RuntimeStoreSchemaName;
      reason: string;
    }
  | { kind: 'rerun_capability_discovery'; schemaName: RuntimeStoreSchemaName; reason: string }
  | { kind: 'block_readiness'; schemaName: RuntimeStoreSchemaName; reason: string };

export interface RuntimeStoreRecoveryPlan {
  planId: string;
  teamName: string;
  runId: string | null;
  createdAt: string;
  manifestHealthy: boolean;
  readinessImpact: 'none' | 'degraded' | 'blocked';
  actions: RuntimeStoreRecoveryAction[];
  diagnostics: string[];
}

export interface RuntimeStoreReadinessCheck {
  ok: boolean;
  reason:
    | 'runtime_store_manifest_valid'
    | 'runtime_store_recovery_required'
    | 'runtime_store_rebuild_in_progress';
  diagnostics: string[];
}

export const OPENCODE_RUNTIME_STORE_DESCRIPTORS: RuntimeStoreDescriptor[] = [
  {
    schemaName: 'opencode.launchState',
    schemaVersion: 1,
    relativePath: 'launch-state.json',
    criticality: 'readiness_blocking',
    owner: 'launch',
    rebuildStrategy: 'none',
  },
  {
    schemaName: 'opencode.sessionStore',
    schemaVersion: 1,
    relativePath: 'opencode-sessions.json',
    criticality: 'rebuildable_from_provider',
    owner: 'session',
    rebuildStrategy: 'poll_opencode_provider',
  },
  {
    schemaName: 'opencode.launchTransaction',
    schemaVersion: 1,
    relativePath: 'opencode-launch-transaction.json',
    criticality: 'readiness_blocking',
    owner: 'launch',
    rebuildStrategy: 'none',
  },
  {
    schemaName: 'opencode.deliveryJournal',
    schemaVersion: 1,
    relativePath: 'opencode-delivery-journal.json',
    criticality: 'rebuildable_from_canonical_destination',
    owner: 'delivery',
    rebuildStrategy: 'verify_canonical_destinations',
  },
  {
    schemaName: 'opencode.promptDeliveryLedger',
    schemaVersion: 1,
    relativePath: 'opencode-prompt-delivery-ledger.json',
    criticality: 'rebuildable_from_canonical_destination',
    owner: 'delivery',
    rebuildStrategy: 'verify_canonical_destinations',
  },
  {
    schemaName: 'opencode.permissionRequests',
    schemaVersion: 1,
    relativePath: 'opencode-permissions.json',
    criticality: 'rebuildable_from_provider',
    owner: 'permission',
    rebuildStrategy: 'poll_opencode_provider',
  },
  {
    schemaName: 'opencode.hostLeases',
    schemaVersion: 1,
    relativePath: 'opencode-host-leases.json',
    criticality: 'rebuildable_from_provider',
    owner: 'host',
    rebuildStrategy: 'poll_opencode_provider',
  },
  {
    schemaName: 'opencode.compatibilitySnapshot',
    schemaVersion: 1,
    relativePath: 'opencode-compatibility.json',
    criticality: 'readiness_blocking',
    owner: 'compatibility',
    rebuildStrategy: 'rerun_capability_discovery',
  },
  {
    schemaName: 'opencode.runtimeRevision',
    schemaVersion: 1,
    relativePath: 'opencode-runtime-revision.json',
    criticality: 'readiness_blocking',
    owner: 'ui',
    rebuildStrategy: 'rebuild_from_launch_state',
  },
  {
    schemaName: 'opencode.runtimeDiagnostics',
    schemaVersion: 1,
    relativePath: 'opencode-diagnostics.json',
    criticality: 'diagnostic_only',
    owner: 'diagnostics',
    rebuildStrategy: 'drop_after_quarantine',
  },
];

async function readStoreDataOrThrow<TData>(store: VersionedJsonStore<TData>): Promise<TData> {
  const result = await store.read();
  if (!result.ok) {
    throw new VersionedJsonStoreError(result.message, result.reason, result.quarantinePath);
  }
  return result.data;
}

export class RuntimeStoreManifestStore {
  constructor(
    private readonly store: VersionedJsonStore<RuntimeStoreManifest>,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async read(): Promise<RuntimeStoreManifest> {
    return readStoreDataOrThrow(this.store);
  }

  async markBatchPreparing(batch: RuntimeStoreWriteBatch): Promise<void> {
    await this.store.updateLocked((manifest) => ({
      ...manifest,
      lastPreparingBatchId: batch.batchId,
      updatedAt: this.clock().toISOString(),
    }));
  }

  async applyCommittedBatch(batch: RuntimeStoreWriteBatch): Promise<RuntimeStoreManifest> {
    const result = await this.store.updateLocked((manifest) => {
      const entries = new Map(manifest.entries.map((entry) => [entry.schemaName, entry]));
      for (const receipt of batch.receipts) {
        entries.set(receipt.schemaName, {
          schemaName: receipt.schemaName,
          schemaVersion: receipt.schemaVersion,
          relativePath: receipt.relativePath,
          contentHash: receipt.contentHash,
          fileSize: receipt.fileSize,
          mtimeMs: receipt.mtimeMs,
          runId: receipt.runId,
          capabilitySnapshotId: receipt.capabilitySnapshotId,
          behaviorFingerprint: receipt.behaviorFingerprint,
          lastWriteReceiptId: receipt.receiptId,
          state: 'healthy',
        });
      }

      return {
        ...manifest,
        activeRunId: batch.runId,
        activeCapabilitySnapshotId: batch.capabilitySnapshotId,
        activeBehaviorFingerprint: batch.behaviorFingerprint,
        highWatermark: manifest.highWatermark + 1,
        lastCommittedBatchId: batch.batchId,
        lastPreparingBatchId:
          manifest.lastPreparingBatchId === batch.batchId ? null : manifest.lastPreparingBatchId,
        entries: [...entries.values()].sort((a, b) => a.schemaName.localeCompare(b.schemaName)),
        updatedAt: this.clock().toISOString(),
      };
    });
    return result.data;
  }

  async markRecoveryPlan(plan: RuntimeStoreRecoveryPlan): Promise<void> {
    await this.store.updateLocked((manifest) => ({
      ...manifest,
      lastRecoveryPlanId: plan.planId,
      updatedAt: this.clock().toISOString(),
    }));
  }
}

export class RuntimeStoreReceiptStore {
  constructor(
    private readonly store: VersionedJsonStore<RuntimeStoreWriteBatch[]>,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async begin(batch: RuntimeStoreWriteBatch): Promise<void> {
    await this.store.updateLocked((batches) => {
      if (batches.some((item) => item.batchId === batch.batchId)) {
        throw new Error(`Runtime store batch already exists: ${batch.batchId}`);
      }
      return [...batches, batch];
    });
  }

  async commit(batch: RuntimeStoreWriteBatch): Promise<void> {
    await this.replace(batch.batchId, {
      ...batch,
      state: 'committed',
      completedAt: this.clock().toISOString(),
      lastError: null,
    });
  }

  async fail(batch: RuntimeStoreWriteBatch, error: unknown): Promise<void> {
    await this.replace(batch.batchId, {
      ...batch,
      state: 'failed',
      completedAt: this.clock().toISOString(),
      lastError: stringifyError(error),
    });
  }

  async list(): Promise<RuntimeStoreWriteBatch[]> {
    return readStoreDataOrThrow(this.store);
  }

  async listUncommitted(teamName: string): Promise<RuntimeStoreWriteBatch[]> {
    const batches = await this.list();
    return batches.filter((batch) => batch.teamName === teamName && batch.state !== 'committed');
  }

  private async replace(batchId: string, batch: RuntimeStoreWriteBatch): Promise<void> {
    let found = false;
    await this.store.updateLocked((batches) =>
      batches.map((item) => {
        if (item.batchId !== batchId) {
          return item;
        }
        found = true;
        return batch;
      })
    );
    if (!found) {
      throw new Error(`Runtime store batch not found: ${batchId}`);
    }
  }
}

export class RuntimeStoreBatchWriter {
  constructor(
    private readonly teamRuntimeDirectory: string,
    private readonly manifestStore: RuntimeStoreManifestStore,
    private readonly receiptStore: RuntimeStoreReceiptStore,
    private readonly options: {
      batchIdFactory?: () => string;
      receiptIdFactory?: () => string;
      clock?: () => Date;
    } = {}
  ) {}

  async writeBatch(input: {
    teamName: string;
    runId: string | null;
    capabilitySnapshotId: string | null;
    behaviorFingerprint: string | null;
    reason: RuntimeStoreWriteBatchReason;
    writes: {
      descriptor: RuntimeStoreDescriptor;
      data: unknown;
    }[];
  }): Promise<RuntimeStoreWriteBatch> {
    const clock = this.options.clock ?? (() => new Date());
    const batch: RuntimeStoreWriteBatch = {
      batchId: this.options.batchIdFactory?.() ?? `opencode-store-batch-${randomUUID()}`,
      teamName: input.teamName,
      runId: input.runId,
      capabilitySnapshotId: input.capabilitySnapshotId,
      behaviorFingerprint: input.behaviorFingerprint,
      reason: input.reason,
      startedAt: clock().toISOString(),
      completedAt: null,
      state: 'preparing',
      receipts: [],
      lastError: null,
    };

    await this.receiptStore.begin(batch);
    await this.manifestStore.markBatchPreparing(batch);

    try {
      const receipts: RuntimeStoreWriteReceipt[] = [];
      for (const write of input.writes) {
        const receipt = await this.writeStoreFile({
          batch,
          descriptor: write.descriptor,
          data: write.data,
          now: clock().toISOString(),
        });
        receipts.push(receipt);
      }

      const committed: RuntimeStoreWriteBatch = {
        ...batch,
        state: 'committed',
        completedAt: clock().toISOString(),
        receipts,
      };
      await this.receiptStore.commit(committed);
      await this.manifestStore.applyCommittedBatch(committed);
      return committed;
    } catch (error) {
      await this.receiptStore.fail(batch, error);
      throw error;
    }
  }

  private async writeStoreFile(input: {
    batch: RuntimeStoreWriteBatch;
    descriptor: RuntimeStoreDescriptor;
    data: unknown;
    now: string;
  }): Promise<RuntimeStoreWriteReceipt> {
    const filePath = path.join(this.teamRuntimeDirectory, input.descriptor.relativePath);
    const raw = `${JSON.stringify(
      {
        schemaVersion: input.descriptor.schemaVersion,
        updatedAt: input.now,
        data: input.data,
      },
      null,
      2
    )}\n`;
    await atomicWriteAsync(filePath, raw);
    const stat = await fs.stat(filePath);
    return {
      receiptId: this.options.receiptIdFactory?.() ?? `opencode-store-receipt-${randomUUID()}`,
      batchId: input.batch.batchId,
      schemaName: input.descriptor.schemaName,
      teamName: input.batch.teamName,
      runId: input.batch.runId,
      capabilitySnapshotId: input.batch.capabilitySnapshotId,
      behaviorFingerprint: input.batch.behaviorFingerprint,
      schemaVersion: input.descriptor.schemaVersion,
      relativePath: input.descriptor.relativePath,
      contentHash: computeRuntimeStoreContentHash(raw),
      fileSize: stat.size,
      mtimeMs: stat.mtimeMs,
      writtenAt: input.now,
    };
  }
}

export class RuntimeStoreFileInspector {
  constructor(private readonly teamRuntimeDirectory: string) {}

  async inspect(input: {
    descriptor: RuntimeStoreDescriptor;
    manifest: RuntimeStoreManifest;
  }): Promise<RuntimeStoreFileInspection> {
    const filePath = path.join(this.teamRuntimeDirectory, input.descriptor.relativePath);
    const manifestEntry =
      input.manifest.entries.find((entry) => entry.schemaName === input.descriptor.schemaName) ??
      null;
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          descriptor: input.descriptor,
          state: 'missing',
          entry: manifestEntry ? { ...manifestEntry, state: 'missing' } : null,
          manifestEntry,
          message: `Runtime store missing: ${input.descriptor.schemaName}`,
        };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.failedInspection(input.descriptor, manifestEntry, 'quarantined', 'invalid_json');
    }

    if (!isRecord(parsed) || !Number.isInteger(parsed.schemaVersion)) {
      return this.failedInspection(
        input.descriptor,
        manifestEntry,
        'quarantined',
        'invalid_envelope'
      );
    }

    const schemaVersion = parsed.schemaVersion as number;
    if (schemaVersion > input.descriptor.schemaVersion) {
      return this.failedInspection(
        input.descriptor,
        manifestEntry,
        'future_schema',
        'future_schema'
      );
    }

    const stat = await fs.stat(filePath);
    const contentHash = computeRuntimeStoreContentHash(raw);
    const actualEntry: RuntimeStoreManifestEntry = {
      schemaName: input.descriptor.schemaName,
      schemaVersion,
      relativePath: input.descriptor.relativePath,
      contentHash,
      fileSize: stat.size,
      mtimeMs: stat.mtimeMs,
      runId: manifestEntry?.runId ?? null,
      capabilitySnapshotId: manifestEntry?.capabilitySnapshotId ?? null,
      behaviorFingerprint: manifestEntry?.behaviorFingerprint ?? null,
      lastWriteReceiptId: manifestEntry?.lastWriteReceiptId ?? null,
      state: 'healthy',
    };

    if (!manifestEntry) {
      return {
        descriptor: input.descriptor,
        state: 'uncommitted_write',
        entry: { ...actualEntry, state: 'uncommitted_write' },
        manifestEntry,
        message: `Runtime store has no manifest entry: ${input.descriptor.schemaName}`,
      };
    }

    if (manifestEntry.contentHash !== contentHash) {
      return {
        descriptor: input.descriptor,
        state: 'hash_mismatch',
        entry: { ...actualEntry, state: 'hash_mismatch' },
        manifestEntry,
        message: `Runtime store hash mismatch: ${input.descriptor.schemaName}`,
      };
    }

    return {
      descriptor: input.descriptor,
      state: 'healthy',
      entry: actualEntry,
      manifestEntry,
      message: null,
    };
  }

  private failedInspection(
    descriptor: RuntimeStoreDescriptor,
    manifestEntry: RuntimeStoreManifestEntry | null,
    state: RuntimeStoreManifestEntryState,
    message: string
  ): RuntimeStoreFileInspection {
    return {
      descriptor,
      state,
      entry: manifestEntry ? { ...manifestEntry, state } : null,
      manifestEntry,
      message: `Runtime store ${descriptor.schemaName} failed inspection: ${message}`,
    };
  }
}

export class RuntimeStoreRecoveryPlanner {
  constructor(
    private readonly descriptors: RuntimeStoreDescriptor[],
    private readonly manifestStore: RuntimeStoreManifestStore,
    private readonly receiptStore: RuntimeStoreReceiptStore,
    private readonly inspector: RuntimeStoreFileInspector,
    private readonly options: {
      planIdFactory?: () => string;
      clock?: () => Date;
    } = {}
  ) {}

  async buildPlan(input: {
    teamName: string;
    expectedRunId: string | null;
    expectedCapabilitySnapshotId: string | null;
    expectedBehaviorFingerprint: string | null;
  }): Promise<RuntimeStoreRecoveryPlan> {
    const clock = this.options.clock ?? (() => new Date());
    const manifest = await this.manifestStore.read();
    const diagnostics: string[] = [];
    const actions: RuntimeStoreRecoveryAction[] = [];
    const descriptorBySchemaName = new Map(
      this.descriptors.map((descriptor) => [descriptor.schemaName, descriptor])
    );

    if (manifest.teamName !== input.teamName) {
      diagnostics.push(`Runtime store manifest team mismatch: ${manifest.teamName}`);
      actions.push({
        kind: 'block_readiness',
        schemaName: 'opencode.launchState',
        reason: 'manifest_team_mismatch',
      });
    }

    for (const descriptor of this.descriptors) {
      const inspected = await this.inspector.inspect({ descriptor, manifest });
      if (inspected.message) {
        diagnostics.push(inspected.message);
      }

      if (inspected.state === 'healthy' && inspected.entry) {
        const identityFailure = validateManifestEntryIdentity({
          descriptor,
          entry: inspected.entry,
          expectedRunId: input.expectedRunId,
          expectedCapabilitySnapshotId: input.expectedCapabilitySnapshotId,
          expectedBehaviorFingerprint: input.expectedBehaviorFingerprint,
        });
        if (!identityFailure) {
          actions.push({ kind: 'none', schemaName: descriptor.schemaName });
          continue;
        }
        diagnostics.push(identityFailure);
        actions.push({
          kind: 'block_readiness',
          schemaName: descriptor.schemaName,
          reason: identityFailure,
        });
        continue;
      }

      actions.push(buildRecoveryAction({ descriptor, inspected }));
    }

    for (const batch of await this.receiptStore.listUncommitted(input.teamName)) {
      diagnostics.push(`Uncommitted runtime store batch detected: ${batch.batchId}`);
      actions.push({
        kind: 'block_readiness',
        schemaName: 'opencode.launchTransaction',
        reason: `uncommitted_batch:${batch.batchId}`,
      });
    }

    const readinessImpact = computeRecoveryReadinessImpact(actions, descriptorBySchemaName);
    return {
      planId: this.options.planIdFactory?.() ?? `opencode-recovery-plan-${randomUUID()}`,
      teamName: input.teamName,
      runId: input.expectedRunId,
      createdAt: clock().toISOString(),
      manifestHealthy: actions.every((action) => action.kind === 'none'),
      readinessImpact,
      actions,
      diagnostics,
    };
  }
}

export function buildRecoveryAction(input: {
  descriptor: RuntimeStoreDescriptor;
  inspected: RuntimeStoreFileInspection;
}): RuntimeStoreRecoveryAction {
  if (input.inspected.state === 'future_schema' || input.inspected.state === 'hash_mismatch') {
    return {
      kind: 'quarantine',
      schemaName: input.descriptor.schemaName,
      reason: input.inspected.state,
    };
  }

  if (input.inspected.state === 'quarantined') {
    if (input.descriptor.rebuildStrategy === 'poll_opencode_provider') {
      return {
        kind: 'rebuild_from_provider',
        schemaName: input.descriptor.schemaName,
        reason: input.inspected.state,
      };
    }
    if (input.descriptor.rebuildStrategy === 'verify_canonical_destinations') {
      return {
        kind: 'rebuild_from_canonical_destination',
        schemaName: input.descriptor.schemaName,
        reason: input.inspected.state,
      };
    }
    return {
      kind: 'quarantine',
      schemaName: input.descriptor.schemaName,
      reason: input.inspected.state,
    };
  }

  switch (input.descriptor.rebuildStrategy) {
    case 'poll_opencode_provider':
      return {
        kind: 'rebuild_from_provider',
        schemaName: input.descriptor.schemaName,
        reason: input.inspected.state,
      };
    case 'verify_canonical_destinations':
      return {
        kind: 'rebuild_from_canonical_destination',
        schemaName: input.descriptor.schemaName,
        reason: input.inspected.state,
      };
    case 'rerun_capability_discovery':
      return {
        kind: 'rerun_capability_discovery',
        schemaName: input.descriptor.schemaName,
        reason: input.inspected.state,
      };
    case 'drop_after_quarantine':
      return {
        kind: 'quarantine',
        schemaName: input.descriptor.schemaName,
        reason: input.inspected.state,
      };
    case 'rebuild_from_launch_state':
    case 'none':
    default:
      return {
        kind: 'block_readiness',
        schemaName: input.descriptor.schemaName,
        reason: input.inspected.state,
      };
  }
}

export function buildRuntimeStoreReadiness(input: {
  recoveryPlan: RuntimeStoreRecoveryPlan;
  invariantFailures: string[];
}): RuntimeStoreReadinessCheck {
  const diagnostics = [...input.recoveryPlan.diagnostics, ...input.invariantFailures];
  if (input.recoveryPlan.readinessImpact === 'blocked' || input.invariantFailures.length > 0) {
    return {
      ok: false,
      reason: 'runtime_store_recovery_required',
      diagnostics,
    };
  }

  if (input.recoveryPlan.readinessImpact === 'degraded') {
    return {
      ok: false,
      reason: 'runtime_store_rebuild_in_progress',
      diagnostics,
    };
  }

  return {
    ok: true,
    reason: 'runtime_store_manifest_valid',
    diagnostics: [],
  };
}

export interface RuntimeStoreCrossStoreInvariantInput {
  launchState: {
    providerId?: string;
    teamName: string;
    runId: string | null;
    capabilitySnapshotId: string | null;
    aggregateState?: string;
    members?: { name: string; launchState?: string }[];
  };
  sessionStore: {
    sessions?: { teamName: string; memberName: string; runId: string | null }[];
  };
  transaction: { status?: string } | null;
  deliveryJournal: {
    records?: { idempotencyKey: string; runId: string | null; status: string }[];
  };
  permissionStore: {
    requests?: { appRequestId: string; runId: string | null; status: string }[];
  };
  compatibilitySnapshot: { snapshotId: string | null };
  manifest: RuntimeStoreManifest;
}

export function validateOpenCodeRuntimeStoreInvariants(
  input: RuntimeStoreCrossStoreInvariantInput
): string[] {
  const failures: string[] = [];
  if (input.launchState.providerId !== 'opencode') {
    return failures;
  }

  if (input.launchState.runId !== input.manifest.activeRunId) {
    failures.push('launch-state runId does not match runtime store manifest activeRunId');
  }

  if (input.launchState.capabilitySnapshotId !== input.compatibilitySnapshot.snapshotId) {
    failures.push('launch-state capability snapshot does not match compatibility snapshot');
  }

  for (const member of input.launchState.members ?? []) {
    const session = (input.sessionStore.sessions ?? []).find(
      (item) =>
        item.teamName === input.launchState.teamName &&
        item.memberName === member.name &&
        item.runId === input.launchState.runId
    );

    if (!session && member.launchState === 'confirmed_alive') {
      failures.push(`confirmed member ${member.name} has no matching OpenCode session record`);
    }
  }

  for (const record of input.deliveryJournal.records ?? []) {
    if (record.runId !== input.launchState.runId && record.status !== 'committed') {
      failures.push(
        `non-committed delivery journal record belongs to stale run: ${record.idempotencyKey}`
      );
    }
  }

  for (const request of input.permissionStore.requests ?? []) {
    if (request.runId !== input.launchState.runId && request.status === 'pending') {
      failures.push(`pending permission belongs to stale run: ${request.appRequestId}`);
    }
  }

  if (input.transaction?.status === 'active' && input.launchState.aggregateState === 'ready') {
    failures.push('active launch transaction conflicts with ready launch-state');
  }

  return failures;
}

export function createRuntimeStoreManifestStore(options: {
  filePath: string;
  teamName: string;
  clock?: () => Date;
}): RuntimeStoreManifestStore {
  const clock = options.clock ?? (() => new Date());
  return new RuntimeStoreManifestStore(
    new VersionedJsonStore<RuntimeStoreManifest>({
      filePath: options.filePath,
      schemaVersion: OPENCODE_RUNTIME_STORE_MANIFEST_SCHEMA_VERSION,
      defaultData: () => createDefaultRuntimeStoreManifest(options.teamName, clock().toISOString()),
      validate: validateRuntimeStoreManifest,
      clock,
    }),
    clock
  );
}

export function createRuntimeStoreReceiptStore(options: {
  filePath: string;
  clock?: () => Date;
}): RuntimeStoreReceiptStore {
  const clock = options.clock ?? (() => new Date());
  return new RuntimeStoreReceiptStore(
    new VersionedJsonStore<RuntimeStoreWriteBatch[]>({
      filePath: options.filePath,
      schemaVersion: OPENCODE_RUNTIME_STORE_RECEIPT_SCHEMA_VERSION,
      defaultData: () => [],
      validate: validateRuntimeStoreWriteBatches,
      clock,
    }),
    clock
  );
}

export function createDefaultRuntimeStoreManifest(
  teamName: string,
  updatedAt: string
): RuntimeStoreManifest {
  return {
    schemaVersion: OPENCODE_RUNTIME_STORE_MANIFEST_SCHEMA_VERSION,
    teamName,
    activeRunId: null,
    activeCapabilitySnapshotId: null,
    activeBehaviorFingerprint: null,
    highWatermark: 0,
    lastCommittedBatchId: null,
    lastPreparingBatchId: null,
    entries: [],
    lastRecoveryPlanId: null,
    updatedAt,
  };
}

export function computeRuntimeStoreContentHash(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

export function validateRuntimeStoreManifest(value: unknown): RuntimeStoreManifest {
  if (!isRecord(value)) {
    throw new Error('Runtime store manifest must be an object');
  }
  if (value.schemaVersion !== OPENCODE_RUNTIME_STORE_MANIFEST_SCHEMA_VERSION) {
    throw new Error('Runtime store manifest has unsupported schemaVersion');
  }
  if (
    !isNonEmptyString(value.teamName) ||
    !isNullableString(value.activeRunId) ||
    !isNullableString(value.activeCapabilitySnapshotId) ||
    !isNullableString(value.activeBehaviorFingerprint) ||
    !Number.isInteger(value.highWatermark) ||
    (value.highWatermark as number) < 0 ||
    !isNullableString(value.lastCommittedBatchId) ||
    !isNullableString(value.lastPreparingBatchId) ||
    !Array.isArray(value.entries) ||
    !isNullableString(value.lastRecoveryPlanId) ||
    !isNonEmptyString(value.updatedAt)
  ) {
    throw new Error('Runtime store manifest envelope is invalid');
  }

  const seen = new Set<string>();
  const entries = value.entries.map((entry, index) => {
    if (!isManifestEntry(entry)) {
      throw new Error(`Invalid runtime store manifest entry at index ${index}`);
    }
    if (seen.has(entry.schemaName)) {
      throw new Error(`Duplicate runtime store manifest entry: ${entry.schemaName}`);
    }
    seen.add(entry.schemaName);
    return entry;
  });

  return {
    schemaVersion: OPENCODE_RUNTIME_STORE_MANIFEST_SCHEMA_VERSION,
    teamName: value.teamName,
    activeRunId: value.activeRunId,
    activeCapabilitySnapshotId: value.activeCapabilitySnapshotId,
    activeBehaviorFingerprint: value.activeBehaviorFingerprint,
    highWatermark: value.highWatermark as number,
    lastCommittedBatchId: value.lastCommittedBatchId,
    lastPreparingBatchId: value.lastPreparingBatchId,
    entries,
    lastRecoveryPlanId: value.lastRecoveryPlanId,
    updatedAt: value.updatedAt,
  };
}

export function validateRuntimeStoreWriteBatches(value: unknown): RuntimeStoreWriteBatch[] {
  if (!Array.isArray(value)) {
    throw new Error('Runtime store write batches must be an array');
  }
  const seen = new Set<string>();
  return value.map((batch, index) => {
    if (!isWriteBatch(batch)) {
      throw new Error(`Invalid runtime store write batch at index ${index}`);
    }
    if (seen.has(batch.batchId)) {
      throw new Error(`Duplicate runtime store write batch: ${batch.batchId}`);
    }
    seen.add(batch.batchId);
    return batch;
  });
}

function validateManifestEntryIdentity(input: {
  descriptor: RuntimeStoreDescriptor;
  entry: RuntimeStoreManifestEntry;
  expectedRunId: string | null;
  expectedCapabilitySnapshotId: string | null;
  expectedBehaviorFingerprint: string | null;
}): string | null {
  if (input.descriptor.criticality === 'diagnostic_only') {
    return null;
  }
  if (input.entry.runId !== input.expectedRunId) {
    return `Runtime store ${input.descriptor.schemaName} has stale run id`;
  }
  if (input.entry.capabilitySnapshotId !== input.expectedCapabilitySnapshotId) {
    return `Runtime store ${input.descriptor.schemaName} has stale capability snapshot`;
  }
  if (input.entry.behaviorFingerprint !== input.expectedBehaviorFingerprint) {
    return `Runtime store ${input.descriptor.schemaName} has stale behavior fingerprint`;
  }
  return null;
}

function computeRecoveryReadinessImpact(
  actions: RuntimeStoreRecoveryAction[],
  descriptors: Map<RuntimeStoreSchemaName, RuntimeStoreDescriptor>
): RuntimeStoreRecoveryPlan['readinessImpact'] {
  let degraded = false;
  for (const action of actions) {
    if (action.kind === 'none') {
      continue;
    }
    const descriptor = descriptors.get(action.schemaName);
    if (action.kind === 'block_readiness' || descriptor?.criticality === 'readiness_blocking') {
      return 'blocked';
    }
    if (descriptor?.criticality !== 'diagnostic_only') {
      degraded = true;
    }
  }
  return degraded ? 'degraded' : 'none';
}

function isManifestEntry(value: unknown): value is RuntimeStoreManifestEntry {
  return (
    isRecord(value) &&
    isRuntimeStoreSchemaName(value.schemaName) &&
    Number.isInteger(value.schemaVersion) &&
    (value.schemaVersion as number) >= 1 &&
    isNonEmptyString(value.relativePath) &&
    isNullableString(value.contentHash) &&
    isNullableNumber(value.fileSize) &&
    isNullableNumber(value.mtimeMs) &&
    isNullableString(value.runId) &&
    isNullableString(value.capabilitySnapshotId) &&
    isNullableString(value.behaviorFingerprint) &&
    isNullableString(value.lastWriteReceiptId) &&
    isManifestEntryState(value.state)
  );
}

function isWriteBatch(value: unknown): value is RuntimeStoreWriteBatch {
  return (
    isRecord(value) &&
    isNonEmptyString(value.batchId) &&
    isNonEmptyString(value.teamName) &&
    isNullableString(value.runId) &&
    isNullableString(value.capabilitySnapshotId) &&
    isNullableString(value.behaviorFingerprint) &&
    isWriteBatchReason(value.reason) &&
    isNonEmptyString(value.startedAt) &&
    isNullableString(value.completedAt) &&
    (value.state === 'preparing' ||
      value.state === 'committing' ||
      value.state === 'committed' ||
      value.state === 'failed') &&
    Array.isArray(value.receipts) &&
    value.receipts.every(isWriteReceipt) &&
    isNullableString(value.lastError)
  );
}

function isWriteReceipt(value: unknown): value is RuntimeStoreWriteReceipt {
  return (
    isRecord(value) &&
    isNonEmptyString(value.receiptId) &&
    isNonEmptyString(value.batchId) &&
    isRuntimeStoreSchemaName(value.schemaName) &&
    isNonEmptyString(value.teamName) &&
    isNullableString(value.runId) &&
    isNullableString(value.capabilitySnapshotId) &&
    isNullableString(value.behaviorFingerprint) &&
    Number.isInteger(value.schemaVersion) &&
    (value.schemaVersion as number) >= 1 &&
    isNonEmptyString(value.relativePath) &&
    isNonEmptyString(value.contentHash) &&
    typeof value.fileSize === 'number' &&
    Number.isFinite(value.fileSize) &&
    typeof value.mtimeMs === 'number' &&
    Number.isFinite(value.mtimeMs) &&
    isNonEmptyString(value.writtenAt)
  );
}

function isRuntimeStoreSchemaName(value: unknown): value is RuntimeStoreSchemaName {
  return (
    value === 'opencode.launchState' ||
    value === 'opencode.sessionStore' ||
    value === 'opencode.launchTransaction' ||
    value === 'opencode.deliveryJournal' ||
    value === 'opencode.promptDeliveryLedger' ||
    value === 'opencode.permissionRequests' ||
    value === 'opencode.hostLeases' ||
    value === 'opencode.compatibilitySnapshot' ||
    value === 'opencode.runtimeRevision' ||
    value === 'opencode.runtimeDiagnostics' ||
    value === 'opencode.e2eEvidence'
  );
}

function isManifestEntryState(value: unknown): value is RuntimeStoreManifestEntryState {
  return (
    value === 'healthy' ||
    value === 'missing' ||
    value === 'quarantined' ||
    value === 'future_schema' ||
    value === 'hash_mismatch' ||
    value === 'stale_run' ||
    value === 'rebuild_required' ||
    value === 'uncommitted_write'
  );
}

function isWriteBatchReason(value: unknown): value is RuntimeStoreWriteBatchReason {
  return (
    value === 'launch_checkpoint' ||
    value === 'permission_reconcile' ||
    value === 'delivery_commit' ||
    value === 'host_lease_update' ||
    value === 'compatibility_discovery' ||
    value === 'stop_tombstone' ||
    value === 'migration' ||
    value === 'recovery'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
