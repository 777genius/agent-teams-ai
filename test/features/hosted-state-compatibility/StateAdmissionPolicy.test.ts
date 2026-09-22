import {
  evaluateHostedStateAdmission,
  type EvaluateHostedStateAdmissionInput,
} from '@features/hosted-state-compatibility';

import { artifactManifest, DIGEST_B, migrationJournal, stateHeader } from './fixtures';

describe('hosted state admission policy', () => {
  it('admits N state for N read/write', () => {
    const result = evaluateHostedStateAdmission({
      artifactManifest: artifactManifest({
        hostedStateSchemaVersion: 1,
        minimumReadableHostedStateVersion: 1,
        orderedMigrations: [],
      }),
      artifactIntegrity: 'verified',
      stateHeader: stateHeader(1),
      migrationJournal: null,
    });

    expect(result).toEqual({ status: 'read_write', hostedStateSchemaVersion: 1 });
  });

  it('admits the ordered N to N+1 migration and requires its offline backup', () => {
    const result = evaluateHostedStateAdmission({
      artifactManifest: artifactManifest(),
      artifactIntegrity: 'verified',
      stateHeader: stateHeader(1),
      migrationJournal: null,
    });

    expect(result).toMatchObject({
      status: 'migration_required',
      fromVersion: 1,
      toVersion: 2,
      backupRequired: true,
    });
    if (result.status === 'migration_required') {
      expect(result.orderedMigrations.map((migration) => migration.migrationId)).toEqual([
        'hosted-state-1-to-2',
      ]);
    }
  });

  it('selects only the remaining portion of a valid ordered chain', () => {
    const result = evaluateHostedStateAdmission({
      artifactManifest: artifactManifest({
        hostedStateSchemaVersion: 3,
        orderedMigrations: [
          ...artifactManifest().orderedMigrations,
          {
            migrationId: 'hosted-state-2-to-3',
            fromVersion: 2,
            toVersion: 3,
            sha256: DIGEST_B,
            backupRequirement: 'none',
          },
        ],
      }),
      artifactIntegrity: 'verified',
      stateHeader: stateHeader(2),
      migrationJournal: null,
    });

    expect(result).toMatchObject({
      status: 'migration_required',
      fromVersion: 2,
      toVersion: 3,
      backupRequired: false,
    });
  });

  it('refuses future state without diagnostic read/write admission', () => {
    expect(
      evaluateHostedStateAdmission({
        artifactManifest: artifactManifest(),
        artifactIntegrity: 'verified',
        stateHeader: stateHeader(3),
        migrationJournal: null,
      })
    ).toEqual({ status: 'refused', reason: 'future_state_version' });
  });

  it('refuses state older than the readable floor', () => {
    expect(
      evaluateHostedStateAdmission({
        artifactManifest: artifactManifest({
          hostedStateSchemaVersion: 2,
          minimumReadableHostedStateVersion: 2,
          orderedMigrations: [],
        }),
        artifactIntegrity: 'verified',
        stateHeader: stateHeader(1),
        migrationJournal: null,
      })
    ).toEqual({ status: 'refused', reason: 'state_version_too_old' });
  });

  it.each([
    [
      'artifact integrity',
      { artifactIntegrity: 'failed' as const },
      'artifact_manifest_integrity_failed',
    ],
    [
      'artifact shape',
      { artifactManifest: { ...artifactManifest(), schemaVersion: 2 } },
      'artifact_manifest_invalid',
    ],
    [
      'state header',
      { stateHeader: { ...stateHeader(1), schemaVersion: 2 } },
      'state_header_invalid',
    ],
  ])('refuses invalid %s evidence', (_label, overrides, reason) => {
    const result = evaluateHostedStateAdmission({
      artifactManifest: artifactManifest(),
      artifactIntegrity: 'verified',
      stateHeader: stateHeader(1),
      migrationJournal: null,
      ...overrides,
    });

    expect(result).toEqual({ status: 'refused', reason });
  });

  it.each(['prepared', 'applying', 'verifying'] as const)(
    'resumes an interrupted %s migration idempotently while state remains N',
    (phase) => {
      const result = evaluateHostedStateAdmission({
        artifactManifest: artifactManifest(),
        artifactIntegrity: 'verified',
        stateHeader: stateHeader(1),
        migrationJournal: migrationJournal({ phase }),
      });

      expect(result).toMatchObject({
        status: 'migration_recovery_required',
        recovery: 'resume_idempotently',
        journalPhase: phase,
      });
    }
  );

  it('verifies before commit when state reached N+1 but the journal remains', () => {
    const result = evaluateHostedStateAdmission({
      artifactManifest: artifactManifest(),
      artifactIntegrity: 'verified',
      stateHeader: stateHeader(2),
      migrationJournal: migrationJournal({ phase: 'applying' }),
    });

    expect(result).toMatchObject({
      status: 'migration_recovery_required',
      recovery: 'verify_before_commit',
    });
  });

  it.each([
    ['deployment', migrationJournal({ deploymentId: 'another-deployment' })],
    ['migration identity', migrationJournal({ migrationId: 'another-migration' })],
    ['checksum', migrationJournal({ migrationSha256: DIGEST_B })],
    ['version', migrationJournal({ fromVersion: 2, toVersion: 3 })],
  ])('refuses an interrupted journal with mismatched %s', (_label, journal) => {
    const result = evaluateHostedStateAdmission({
      artifactManifest: artifactManifest(),
      artifactIntegrity: 'verified',
      stateHeader: stateHeader(1),
      migrationJournal: journal,
    });

    expect(result).toEqual({ status: 'refused', reason: 'migration_journal_mismatch' });
  });

  it('refuses a corrupt interrupted journal', () => {
    const result = evaluateHostedStateAdmission({
      artifactManifest: artifactManifest(),
      artifactIntegrity: 'verified',
      stateHeader: stateHeader(1),
      migrationJournal: { ...migrationJournal(), phase: 'completed' },
    });

    expect(result).toEqual({ status: 'refused', reason: 'migration_journal_invalid' });
  });

  it('fails closed without integrity evidence before read/write, migration, or recovery', () => {
    const untrustedInputs: readonly unknown[] = [
      {
        artifactManifest: artifactManifest({
          hostedStateSchemaVersion: 1,
          minimumReadableHostedStateVersion: 1,
          orderedMigrations: [],
        }),
        stateHeader: stateHeader(1),
        migrationJournal: null,
      },
      {
        artifactManifest: artifactManifest(),
        stateHeader: stateHeader(1),
        migrationJournal: null,
      },
      {
        artifactManifest: artifactManifest(),
        stateHeader: stateHeader(1),
        migrationJournal: migrationJournal(),
      },
    ];

    for (const untrustedInput of untrustedInputs) {
      expect(
        evaluateHostedStateAdmission(untrustedInput as EvaluateHostedStateAdmissionInput)
      ).toEqual({ status: 'refused', reason: 'artifact_manifest_integrity_failed' });
    }
  });

  it('fails closed for unverified integrity evidence from an unknown boundary', () => {
    const untrustedInput: unknown = {
      artifactManifest: artifactManifest(),
      artifactIntegrity: 'unverified',
      stateHeader: stateHeader(1),
      migrationJournal: null,
    };

    expect(
      evaluateHostedStateAdmission(untrustedInput as EvaluateHostedStateAdmissionInput)
    ).toEqual({ status: 'refused', reason: 'artifact_manifest_integrity_failed' });
  });
});
