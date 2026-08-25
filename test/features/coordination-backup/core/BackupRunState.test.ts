import {
  assertBackupRunRecord,
  BACKUP_RUN_STATES,
  type BackupIdentityInventory,
  type BackupManifest,
  type BackupManifestEntry,
  BackupRunInvariantError,
  type BackupRunRecord,
  COORDINATION_BACKUP_COMMIT_MARKER_FORMAT,
  COORDINATION_BACKUP_FORMAT,
  finalizeCopiedSourceRun,
  type ImmutableBackupInspection,
  isActiveBackupRunState,
  isTerminalBackupRunState,
  parseBackupRunId,
  parseSha256Digest,
  SQLITE_ONLINE_BACKUP_METHOD,
  transitionBackupRunState,
  validateCoordinationBackupRestoreSet,
  validateImmutableBackupInspection,
} from '@features/coordination-backup';
import {
  parseDeploymentId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted/identifiers';
import { describe, expect, it } from 'vitest';

const RUN_ID = parseBackupRunId('backup_run-001');
const DEPLOYMENT_ID = parseDeploymentId('deployment_test');
const TEAM_ID = parseTeamId(`team_${'1'.repeat(32)}`);
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'2'.repeat(32)}`);
const HASH_A = parseSha256Digest('a'.repeat(64));
const HASH_B = parseSha256Digest('b'.repeat(64));
const HASH_C = parseSha256Digest('c'.repeat(64));

const FORWARD_TRANSITIONS = [
  ['requested', 'fencing'],
  ['fencing', 'quiescing'],
  ['quiescing', 'sqlite_snapshot'],
  ['sqlite_snapshot', 'file_stage'],
  ['file_stage', 'verifying'],
  ['verifying', 'committed'],
] as const;

describe('BackupRun state machine', () => {
  it('freezes the durable live, terminal, and restore-source states', () => {
    expect(BACKUP_RUN_STATES).toEqual([
      'requested',
      'fencing',
      'quiescing',
      'sqlite_snapshot',
      'file_stage',
      'verifying',
      'committed',
      'failed',
      'operator_required',
      'artifact_source',
    ]);
    expect(Object.isFrozen(BACKUP_RUN_STATES)).toBe(true);
  });

  it.each(FORWARD_TRANSITIONS)('admits only the forward transition %s -> %s', (from, to) => {
    expect(transitionBackupRunState(from, to)).toBe(to);
  });

  it('admits failed and operator_required from every active state', () => {
    for (const state of BACKUP_RUN_STATES.filter(isActiveBackupRunState)) {
      expect(transitionBackupRunState(state, 'failed')).toBe('failed');
      expect(transitionBackupRunState(state, 'operator_required')).toBe('operator_required');
    }
  });

  it('rejects skips, backward edges, self edges, and every edge out of a terminal state', () => {
    const valid = new Set(FORWARD_TRANSITIONS.map(([from, to]) => `${from}:${to}`));
    for (const from of BACKUP_RUN_STATES) {
      for (const to of BACKUP_RUN_STATES) {
        if (valid.has(`${from}:${to}`)) continue;
        if (isActiveBackupRunState(from) && (to === 'failed' || to === 'operator_required')) {
          continue;
        }
        expect(() => transitionBackupRunState(from, to)).toThrowError(
          expect.objectContaining<Partial<BackupRunInvariantError>>({ code: 'invalid_transition' })
        );
      }
    }
    expect(isTerminalBackupRunState('committed')).toBe(true);
    expect(isTerminalBackupRunState('artifact_source')).toBe(true);
  });

  it('requires durable evidence before a record may claim a later state', () => {
    const invalid = makeRequestedRecord({ state: 'committed' });
    expect(() => assertBackupRunRecord(invalid)).toThrowError(
      expect.objectContaining<Partial<BackupRunInvariantError>>({
        code: 'missing_transition_evidence',
      })
    );
  });

  it.each(['contractVersion', 'schemaVersion'] as const)(
    'rejects unsupported durable participant %s values',
    (field) => {
      const descriptor = {
        participantId: 'identity',
        kind: 'identity_anchor',
        contractVersion: 1,
        schemaVersion: 1,
        required: true,
        [field]: 2,
      };
      const invalid = makeRequestedRecord({
        participantDescriptors: [descriptor],
      } as unknown as Partial<BackupRunRecord>);

      expect(() => assertBackupRunRecord(invalid)).toThrowError(
        expect.objectContaining<Partial<BackupRunInvariantError>>({ code: 'invalid_record' })
      );
    }
  );

  it('finalizes only the matching sqlite_snapshot row copied into its own artifact', () => {
    const source = makeInspection().copiedSourceRun;
    expect(finalizeCopiedSourceRun(source, RUN_ID).state).toBe('artifact_source');
    expect(() => finalizeCopiedSourceRun({ ...source, state: 'file_stage' }, RUN_ID)).toThrowError(
      expect.objectContaining({ code: 'invalid_artifact_source' })
    );
    expect(() => finalizeCopiedSourceRun(source, parseBackupRunId('backup_other'))).toThrowError(
      expect.objectContaining({ code: 'invalid_artifact_source' })
    );
  });
});

describe('immutable backup and restore-set validation', () => {
  it('accepts a complete hash-bound committed v2 coordination backup', () => {
    const inspection = makeInspection();
    expect(validateImmutableBackupInspection(inspection)).toEqual({ status: 'valid' });
    expect(
      validateCoordinationBackupRestoreSet({
        classification: 'committed_v2',
        purpose: 'coordination_repair',
        expectedDeploymentId: DEPLOYMENT_ID,
        inspection,
      })
    ).toEqual({
      status: 'valid',
      mapping: {
        deploymentId: DEPLOYMENT_ID,
        activeTeamIds: [TEAM_ID],
        tombstonedIdentityIds: [],
        workspaceRegistrations: { 'workspace.primary': WORKSPACE_ID },
        sourceRunFinalization: {
          backupRunId: RUN_ID,
          from: 'sqlite_snapshot',
          to: 'artifact_source',
        },
      },
    });
  });

  it('binds the requested restore purpose to the purpose sealed in the manifest', () => {
    const result = validateCoordinationBackupRestoreSet({
      classification: 'committed_v2',
      purpose: 'app_migration',
      expectedDeploymentId: DEPLOYMENT_ID,
      inspection: makeInspection(),
    });

    expect(result).toMatchObject({
      status: 'invalid',
      reasons: expect.arrayContaining(['restore_purpose_mismatch']),
    });
    expect(result).not.toHaveProperty('mapping');
  });

  it('omits disabled workspace registrations from the active restore mapping', () => {
    const inspection = makeInspection();
    const disabledInventory: BackupIdentityInventory = {
      ...inspection.manifest.identityInventory,
      workspaceRegistrations: inspection.manifest.identityInventory.workspaceRegistrations.map(
        (registration) => ({ ...registration, state: 'disabled' as const })
      ),
    };
    const result = validateCoordinationBackupRestoreSet({
      classification: 'committed_v2',
      purpose: 'coordination_repair',
      expectedDeploymentId: DEPLOYMENT_ID,
      inspection: {
        ...inspection,
        manifest: { ...inspection.manifest, identityInventory: disabledInventory },
        observedIdentityInventory: disabledInventory,
        copiedSourceRun: {
          ...inspection.copiedSourceRun,
          identityInventory: disabledInventory,
        },
      },
    });

    expect(result).toMatchObject({ status: 'valid', mapping: { workspaceRegistrations: {} } });
  });

  it.each([
    [
      'identity inventory',
      'unsupported_identity_inventory_schema_version',
      (inspection: ImmutableBackupInspection) => {
        const inventory = { ...inspection.manifest.identityInventory, schemaVersion: 2 };
        return {
          ...inspection,
          manifest: { ...inspection.manifest, identityInventory: inventory },
          observedIdentityInventory: inventory,
        } as unknown as ImmutableBackupInspection;
      },
    ],
    [
      'participant contract',
      'unsupported_participant_contract_version',
      (inspection: ImmutableBackupInspection) => {
        const participants = inspection.manifest.participants.map((participant) => ({
          ...participant,
          descriptor: { ...participant.descriptor, contractVersion: 2 },
        }));
        return {
          ...inspection,
          manifest: { ...inspection.manifest, participants },
          copiedSourceRun: { ...inspection.copiedSourceRun, participants },
        } as unknown as ImmutableBackupInspection;
      },
    ],
    [
      'participant schema',
      'unsupported_participant_schema_version',
      (inspection: ImmutableBackupInspection) => {
        const participants = inspection.manifest.participants.map((participant) => ({
          ...participant,
          descriptor: { ...participant.descriptor, schemaVersion: 2 },
        }));
        return {
          ...inspection,
          manifest: { ...inspection.manifest, participants },
          copiedSourceRun: { ...inspection.copiedSourceRun, participants },
        } as unknown as ImmutableBackupInspection;
      },
    ],
    [
      'state compatibility manifest',
      'unsupported_compatibility_schema_version',
      (inspection: ImmutableBackupInspection) => {
        const coordinationBarrier = {
          ...inspection.manifest.coordinationBarrier,
          stateCompatibilityManifest: {
            ...inspection.manifest.coordinationBarrier.stateCompatibilityManifest,
            schemaVersion: 4,
          },
        };
        return {
          ...inspection,
          manifest: { ...inspection.manifest, coordinationBarrier },
          copiedSourceRun: { ...inspection.copiedSourceRun, coordinationBarrier },
        } as unknown as ImmutableBackupInspection;
      },
    ],
  ] as const)('rejects an unsupported nested %s version', (_label, reason, mutate) => {
    expect(validateImmutableBackupInspection(mutate(makeInspection()))).toMatchObject({
      status: 'invalid',
      reasons: expect.arrayContaining([reason]),
    });
  });

  it('rejects a participant barrier that is not bound into the SQLite coordination point', () => {
    const inspection = makeInspection();
    const coordinationBarrier = {
      ...inspection.manifest.coordinationBarrier,
      participantRecoveryPoints: [
        {
          ...inspection.manifest.coordinationBarrier.participantRecoveryPoints[0],
          durableBarrier: 'different-barrier',
        },
      ],
    };
    const result = validateImmutableBackupInspection({
      ...inspection,
      manifest: { ...inspection.manifest, coordinationBarrier },
      copiedSourceRun: { ...inspection.copiedSourceRun, coordinationBarrier },
    });

    expect(result).toMatchObject({
      status: 'invalid',
      reasons: expect.arrayContaining(['participant_recovery_point_mismatch']),
    });
  });

  it('rejects a copied SQLite row whose durable barrier differs from the sealed manifest', () => {
    const inspection = makeInspection();
    const result = validateImmutableBackupInspection({
      ...inspection,
      copiedSourceRun: {
        ...inspection.copiedSourceRun,
        coordinationBarrier: {
          ...inspection.copiedSourceRun.coordinationBarrier,
          eventCursor: 'event-from-another-recovery-point',
        },
      },
    });

    expect(result).toMatchObject({
      status: 'invalid',
      reasons: expect.arrayContaining(['copied_source_coordination_barrier_mismatch']),
    });
  });

  it.each([
    [
      'manifest hash',
      (value: ImmutableBackupInspection) => ({ ...value, computedManifestHash: HASH_B }),
    ],
    [
      'commit marker',
      (value: ImmutableBackupInspection) => ({
        ...value,
        marker: { ...value.marker, manifestHash: HASH_B },
      }),
    ],
    [
      'measured entry',
      (value: ImmutableBackupInspection) => ({
        ...value,
        measuredEntries: value.measuredEntries.slice(1),
      }),
    ],
    [
      'identity inventory',
      (value: ImmutableBackupInspection) => ({
        ...value,
        observedIdentityInventory: {
          ...value.observedIdentityInventory,
          identities: value.observedIdentityInventory.identities.slice(1),
        },
      }),
    ],
    [
      'copied source row',
      (value: ImmutableBackupInspection) => ({
        ...value,
        copiedSourceRun: { ...value.copiedSourceRun, state: 'file_stage' as const },
      }),
    ],
  ] as const)('rejects disagreement in the %s', (_label, mutate) => {
    expect(validateImmutableBackupInspection(mutate(makeInspection())).status).toBe('invalid');
  });

  it('rejects duplicate identity and workspace registrations with no mapping', () => {
    const inspection = makeInspection();
    const inventory = inspection.manifest.identityInventory;
    const duplicated: BackupIdentityInventory = {
      ...inventory,
      identities: [...inventory.identities, inventory.identities[1]],
      workspaceRegistrations: [
        ...inventory.workspaceRegistrations,
        inventory.workspaceRegistrations[0],
      ],
    };
    const result = validateCoordinationBackupRestoreSet({
      classification: 'committed_v2',
      purpose: 'app_migration',
      expectedDeploymentId: DEPLOYMENT_ID,
      inspection: {
        ...inspection,
        manifest: { ...inspection.manifest, identityInventory: duplicated },
        observedIdentityInventory: duplicated,
      },
    });
    expect(result.status).toBe('invalid');
    expect(result).not.toHaveProperty('mapping');
  });

  it('preserves a row-only tombstone without exposing it as an active identity mapping', () => {
    const inspection = makeInspection();
    const identities = inspection.manifest.identityInventory.identities.map((identity) =>
      identity.kind === 'team'
        ? { ...identity, state: 'tombstoned' as const, fileEntryId: null }
        : identity
    );
    const identityInventory = { ...inspection.manifest.identityInventory, identities };
    const entries = inspection.manifest.entries.filter(
      (entry) => entry.entryId !== 'identity/team-1'
    );
    const tombstoneInspection: ImmutableBackupInspection = {
      ...inspection,
      manifest: { ...inspection.manifest, identityInventory, entries },
      measuredEntries: inspection.measuredEntries.filter(
        (entry) => entry.entryId !== 'identity/team-1'
      ),
      observedIdentityInventory: identityInventory,
      copiedSourceRun: { ...inspection.copiedSourceRun, identityInventory },
    };

    expect(
      validateCoordinationBackupRestoreSet({
        classification: 'committed_v2',
        purpose: 'coordination_repair',
        expectedDeploymentId: DEPLOYMENT_ID,
        inspection: tombstoneInspection,
      })
    ).toMatchObject({
      status: 'valid',
      mapping: {
        activeTeamIds: [],
        tombstonedIdentityIds: [TEAM_ID],
      },
    });
  });

  it.each([
    ['legacy_unverified', 'coordination_repair'],
    ['partial', 'coordination_repair'],
    ['committed_v2', 'replace_deployment'],
  ] as const)('never restores %s for %s', (classification, purpose) => {
    const result = validateCoordinationBackupRestoreSet({
      classification,
      purpose,
      expectedDeploymentId: DEPLOYMENT_ID,
      inspection: makeInspection(),
    });
    expect(result.status).toBe('invalid');
    expect(result).not.toHaveProperty('mapping');
  });
});

function makeRequestedRecord(overrides: Partial<BackupRunRecord> = {}): BackupRunRecord {
  return {
    backupRunId: RUN_ID,
    deploymentId: DEPLOYMENT_ID,
    productKind: 'coordination_backup',
    purpose: 'coordination_repair',
    state: 'requested',
    revision: 1,
    requestedAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    participantDescriptors: [],
    fence: null,
    fenceLeaseId: null,
    fenceCompletion: null,
    preparedParticipants: null,
    flushedParticipants: null,
    coordinationBarrier: null,
    identityInventory: null,
    sqliteSnapshot: null,
    stagedEntries: null,
    exclusions: null,
    verificationPlan: null,
    publication: null,
    failure: null,
    ...overrides,
  };
}

function makeInspection(): ImmutableBackupInspection {
  const sqliteEntry: BackupManifestEntry & { kind: 'sqlite_snapshot' } = {
    entryId: 'sqlite/app.db',
    participantId: 'internal-storage',
    kind: 'sqlite_snapshot',
    logicalOwner: 'internal-storage',
    logicalType: 'application/sqlite3',
    schemaVersion: 3,
    byteLength: 4096,
    mode: 0o600,
    sha256: HASH_A,
    sourceGeneration: 'sqlite-generation-1',
  };
  const deploymentEntry = identityEntry('identity/deployment', HASH_B);
  const teamEntry = identityEntry('identity/team-1', HASH_C);
  const identityInventory: BackupIdentityInventory = {
    schemaVersion: 1,
    deploymentId: DEPLOYMENT_ID,
    identities: [
      {
        kind: 'deployment',
        identityId: DEPLOYMENT_ID,
        parentIdentityId: null,
        state: 'active',
        checksum: HASH_B,
        fileEntryId: deploymentEntry.entryId,
      },
      {
        kind: 'team',
        identityId: TEAM_ID,
        parentIdentityId: DEPLOYMENT_ID,
        state: 'active',
        checksum: HASH_C,
        fileEntryId: teamEntry.entryId,
      },
    ],
    workspaceRegistrations: [
      {
        workspaceId: WORKSPACE_ID,
        registrationKey: 'workspace.primary',
        state: 'registered',
      },
    ],
  };
  const entries = [deploymentEntry, sqliteEntry, teamEntry].sort((left, right) =>
    left.entryId.localeCompare(right.entryId)
  );
  const manifest: BackupManifest = {
    format: COORDINATION_BACKUP_FORMAT,
    backupRunId: RUN_ID,
    sourceBackupRunId: RUN_ID,
    productKind: 'coordination_backup',
    purpose: 'coordination_repair',
    deploymentId: DEPLOYMENT_ID,
    requestedAt: '2026-07-20T00:00:00.000Z',
    sealedAt: '2026-07-20T00:01:00.000Z',
    fenceGeneration: 7,
    coordinationBarrier: {
      stateCompatibilityManifest: { manifestId: 'state-v3', schemaVersion: 3, sha256: HASH_A },
      acceptedCommandDrain: {
        admittedRunId: RUN_ID,
        fenceGeneration: 7,
        throughCommandCursor: 'command-10',
        durableBarrier: 'command-drain-10',
      },
      participantRecoveryPoints: [
        {
          participantId: 'identity',
          sourceGeneration: 'identity-generation-1',
          durableBarrier: 'identity-barrier-1',
        },
      ],
      eventCursor: 'event-20',
      eventEpoch: 'epoch-1',
      journalCursors: { outbox: 'outbox-12' },
    },
    identityInventory,
    participants: [
      {
        descriptor: {
          participantId: 'identity',
          kind: 'identity_anchor',
          contractVersion: 1,
          schemaVersion: 1,
          required: true,
        },
        sourceGeneration: 'identity-generation-1',
        durableBarrier: 'identity-barrier-1',
      },
    ],
    sqliteSnapshot: {
      method: SQLITE_ONLINE_BACKUP_METHOD,
      entry: sqliteEntry,
      applicationId: 42,
      userVersion: 3,
      sourceRunId: RUN_ID,
    },
    sqliteIntegrity: {
      integrityCheck: 'ok',
      applicationId: 42,
      userVersion: 3,
      requiredInvariants: { backup_run_present: true, identity_unique: true },
    },
    entries,
    exclusions: [],
    manifestHash: HASH_A,
  };
  return {
    manifest,
    marker: {
      format: COORDINATION_BACKUP_COMMIT_MARKER_FORMAT,
      backupRunId: RUN_ID,
      deploymentId: DEPLOYMENT_ID,
      manifestHash: HASH_A,
      sealedAt: manifest.sealedAt,
    },
    computedManifestHash: HASH_A,
    measuredEntries: entries.map(({ entryId, byteLength, mode, sha256 }) => ({
      entryId,
      byteLength,
      mode,
      sha256,
    })),
    observedIdentityInventory: identityInventory,
    copiedSourceRun: {
      backupRunId: RUN_ID,
      deploymentId: DEPLOYMENT_ID,
      productKind: 'coordination_backup',
      purpose: manifest.purpose,
      state: 'sqlite_snapshot',
      fenceGeneration: manifest.fenceGeneration,
      coordinationBarrier: manifest.coordinationBarrier,
      participants: manifest.participants,
      identityInventory: manifest.identityInventory,
    },
  };
}

function identityEntry(entryId: string, sha256: typeof HASH_A): BackupManifestEntry {
  return {
    entryId,
    participantId: 'identity',
    kind: 'identity_anchor',
    logicalOwner: 'team-identity',
    logicalType: 'application/json',
    schemaVersion: 1,
    byteLength: 128,
    mode: 0o600,
    sha256,
    sourceGeneration: 'identity-generation-1',
  };
}
