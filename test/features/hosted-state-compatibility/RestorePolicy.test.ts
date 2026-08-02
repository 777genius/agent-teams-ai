import {
  evaluateOfflineRestoreAdmission,
  type HostedStateAdmission,
  inspectRestoreArchive,
  type OfflineRestoreAdmissionInput,
} from '@features/hosted-state-compatibility';

import { checksum, DIGEST_A, DIGEST_B, restoreEvidence, restoreSet } from './fixtures';

const READ_WRITE: HostedStateAdmission = {
  status: 'read_write',
  hostedStateSchemaVersion: 1,
};

function admissionInput(
  overrides: Partial<OfflineRestoreAdmissionInput> = {}
): OfflineRestoreAdmissionInput {
  return {
    mode: 'replace_deployment',
    controllerState: 'stopped',
    sourceOfflineAttested: true,
    targetState: 'empty',
    archive: restoreEvidence(),
    stateAdmission: READ_WRITE,
    ...overrides,
  };
}

describe('restore archive integrity policy', () => {
  it('verifies one committed checksum- and topology-bound restore set', () => {
    const result = inspectRestoreArchive(restoreEvidence());

    expect(result).toEqual({ status: 'verified', restoreSet: restoreSet() });
  });

  it('compares checksums by entry identity rather than array order', () => {
    const first = checksum();
    const second = checksum({ entryId: 'identity/team.json', sha256: DIGEST_A });
    const result = inspectRestoreArchive(
      restoreEvidence({
        expectedChecksums: [first, second],
        observedChecksums: [second, first],
      })
    );

    expect(result).toMatchObject({ status: 'verified' });
  });

  it.each([
    [
      'content checksum',
      { observedChecksums: [checksum({ sha256: DIGEST_A })] },
      ['archive_checksum_mismatch'],
    ],
    ['entry set', { observedChecksums: [] }, ['archive_entry_set_mismatch']],
    [
      'duplicate entry',
      { observedChecksums: [checksum(), checksum()] },
      ['archive_entry_set_mismatch'],
    ],
    [
      'restore-set manifest',
      { observedRestoreSet: restoreSet({ manifestHash: DIGEST_A }) },
      ['restore_set_identity_mismatch'],
    ],
    [
      'restore-set format',
      {
        observedRestoreSet: {
          ...restoreSet(),
          format: 'hosted-state-restore-set/v2' as never,
        },
      },
      ['restore_set_identity_mismatch'],
    ],
    [
      'snapshot epoch',
      {
        observedRestoreSet: restoreSet({
          snapshot: { ...restoreSet().snapshot, eventEpoch: 'another-epoch' },
        }),
      },
      ['snapshot_topology_mismatch'],
    ],
    [
      'manifest-to-snapshot topology',
      {
        manifestSnapshot: {
          ...restoreSet().snapshot,
          replayCursor: 'another-snapshot-cursor',
        },
      },
      ['snapshot_topology_mismatch'],
    ],
    ['SQLite integrity', { sqliteIntegrity: 'failed' }, ['sqlite_integrity_failed']],
    ['publication', { publication: 'partial' }, ['archive_incomplete']],
    [
      'checksum record',
      { observedChecksums: [checksum({ byteLength: -1 })] },
      ['archive_entry_set_mismatch'],
    ],
    [
      'immutable verifier',
      { immutableVerification: { status: 'invalid', reasons: ['marker-missing'] } },
      ['archive_integrity_failed'],
    ],
  ] as const)('refuses a mismatched %s', (_label, overrides, reasons) => {
    const result = inspectRestoreArchive(restoreEvidence(overrides));

    expect(result).toEqual({ status: 'invalid', reasons });
  });

  it('reports independent checksum and topology faults in stable order', () => {
    const result = inspectRestoreArchive(
      restoreEvidence({
        observedRestoreSet: restoreSet({ manifestHash: DIGEST_A }),
        manifestSnapshot: { ...restoreSet().snapshot, eventEpoch: 'another-epoch' },
        observedChecksums: [checksum({ sha256: DIGEST_B })],
      })
    );

    expect(result).toEqual({
      status: 'invalid',
      reasons: [
        'restore_set_identity_mismatch',
        'snapshot_topology_mismatch',
        'archive_checksum_mismatch',
      ],
    });
  });
});

describe('offline restore admission policy', () => {
  it('admits only an offline whole-deployment replacement into an empty target', () => {
    const result = evaluateOfflineRestoreAdmission(admissionInput());

    expect(result).toEqual({
      status: 'admitted',
      restoreSet: restoreSet(),
      postRestore: {
        preserveLogicalIdentities: true,
        rotateBootId: true,
        rotateEventEpoch: true,
        revokeBrowserAuthority: true,
        revokeRuntimeAuthority: true,
        establishFreshMountBindings: true,
      },
    });
  });

  it('admits a compatible forward migration after restore', () => {
    const result = evaluateOfflineRestoreAdmission(
      admissionInput({
        stateAdmission: {
          status: 'migration_required',
          fromVersion: 1,
          toVersion: 2,
          orderedMigrations: [],
          backupRequired: true,
        },
      })
    );

    expect(result.status).toBe('admitted');
  });

  it.each([
    ['running controller', { controllerState: 'running' }, 'controller_not_stopped'],
    ['unknown controller', { controllerState: 'unknown' }, 'controller_not_stopped'],
    ['missing source attestation', { sourceOfflineAttested: false }, 'source_offline_not_attested'],
    ['fork mode', { mode: 'fork_deployment' }, 'restore_mode_unsupported'],
    ['non-empty target', { targetState: 'non_empty' }, 'target_not_empty'],
    ['unavailable target', { targetState: 'unavailable' }, 'target_unavailable'],
  ] as const)('refuses %s', (_label, overrides, reason) => {
    const result = evaluateOfflineRestoreAdmission(admissionInput(overrides));

    expect(result).toEqual({ status: 'refused', reasons: [reason] });
  });

  it('refuses future source state', () => {
    const result = evaluateOfflineRestoreAdmission(
      admissionInput({
        stateAdmission: { status: 'refused', reason: 'future_state_version' },
      })
    );

    expect(result).toEqual({ status: 'refused', reasons: ['future_state_version'] });
  });

  it('refuses a restore set captured during an interrupted migration', () => {
    const result = evaluateOfflineRestoreAdmission(
      admissionInput({
        stateAdmission: {
          status: 'migration_recovery_required',
          recovery: 'resume_idempotently',
          migration: {
            migrationId: 'hosted-state-1-to-2',
            fromVersion: 1,
            toVersion: 2,
            sha256: DIGEST_A,
            backupRequirement: 'verified_offline_archive',
          },
          journalPhase: 'applying',
        },
      })
    );

    expect(result).toEqual({ status: 'refused', reasons: ['source_migration_interrupted'] });
  });

  it('collects all independent preflight failures without admitting a writer', () => {
    const result = evaluateOfflineRestoreAdmission(
      admissionInput({
        mode: 'fork_deployment',
        controllerState: 'running',
        sourceOfflineAttested: false,
        targetState: 'non_empty',
        archive: restoreEvidence({ publication: 'partial' }),
      })
    );

    expect(result).toEqual({
      status: 'refused',
      reasons: [
        'restore_mode_unsupported',
        'controller_not_stopped',
        'source_offline_not_attested',
        'target_not_empty',
        'archive_incomplete',
      ],
    });
  });
});
