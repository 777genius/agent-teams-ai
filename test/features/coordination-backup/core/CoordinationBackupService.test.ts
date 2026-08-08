import {
  BACKUP_RUN_STATES,
  type BackupCoordinationBarrier,
  type BackupIdentityInventory,
  type BackupManifestEntry,
  type BackupParticipantDescriptor,
  type BackupPublicationInspection,
  type BackupRunId,
  type BackupRunRecord,
  type BackupRunTransitionRequest,
  type BackupVerificationPlan,
  COORDINATION_BACKUP_COMMIT_MARKER_FORMAT,
  type CoordinationBackupParticipant,
  CoordinationBackupService,
  type CoordinationBackupServiceDependencies,
  type CreateBackupRunRequest,
  type FlushedBackupParticipant,
  type ImmutableBackupInspection,
  type MarkBackupFenceCompletedRequest,
  parseBackupRunId,
  parseSha256Digest,
  type PreparedBackupParticipant,
  type SaveBackupVerificationPlanRequest,
  SQLITE_ONLINE_BACKUP_METHOD,
  type StagedBackupParticipant,
} from '@features/coordination-backup';
import { parseDeploymentId, parseWorkspaceId } from '@shared/contracts/hosted/identifiers';
import { describe, expect, it } from 'vitest';

const RUN_ID = parseBackupRunId('backup_service-001');
const DEPLOYMENT_ID = parseDeploymentId('deployment_service');
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'3'.repeat(32)}`);
const HASH_A = parseSha256Digest('a'.repeat(64));
const HASH_B = parseSha256Digest('b'.repeat(64));
const HASH_C = parseSha256Digest('c'.repeat(64));
const PARTICIPANT_DESCRIPTOR = {
  participantId: 'identity',
  kind: 'identity_anchor',
  contractVersion: 1,
  schemaVersion: 1,
  required: true,
} as const satisfies BackupParticipantDescriptor;

describe('CoordinationBackupService', () => {
  it('durably fences, flushes, snapshots, reopens, stages, verifies, writes marker last, and commits', async () => {
    const harness = new BackupHarness();
    const result = await harness.service.createCoordinationBackup({
      backupRunId: RUN_ID,
      deploymentId: DEPLOYMENT_ID,
      purpose: 'coordination_repair',
    });

    expect(result.state).toBe('committed');
    expect(result.publication?.manifestHash).toBe(HASH_C);
    expect(harness.calls).toEqual([
      'run.create',
      'run.requested->fencing',
      'fence.acquire',
      'run.fencing->quiescing',
      'coordination.drain-accepted',
      'participant.prepare',
      'participant.flush',
      'coordination.capture-barrier',
      'identity.capture',
      'run.quiescing->sqlite_snapshot',
      'publication.prepare',
      'sqlite.online-backup',
      'run.sqlite_snapshot->file_stage',
      'participant.stage',
      'run.file_stage->verifying',
      'publication.inspect:staging_unsealed',
      'sqlite.reopen-integrity',
      'participant.verify',
      'manifest.hash',
      'run.save-verification-plan',
      'publication.write-manifest',
      'publication.write-marker-last',
      'immutable.verify:staging',
      'publication.commit-stage',
      'immutable.verify:committed',
      'run.verifying->committed',
      'fence.complete:committed',
      'run.mark-fence-completed',
    ]);
    expect(harness.markerWrites).toBe(1);
    expect(harness.publicationStatus).toBe('committed');
  });

  it('fails closed on Online Backup API BUSY deadline without staging files or using another path', async () => {
    const harness = new BackupHarness();
    harness.onlineBackupFailure = 'busy_timeout';

    await expect(
      harness.service.createCoordinationBackup({
        backupRunId: RUN_ID,
        deploymentId: DEPLOYMENT_ID,
        purpose: 'app_migration',
      })
    ).rejects.toMatchObject({
      code: 'backup_run_failed',
      terminalRecord: expect.objectContaining({ state: 'failed' }),
    });
    expect(harness.calls).toContain('sqlite.online-backup');
    expect(harness.calls).toContain('publication.abort');
    expect(harness.calls).toContain('fence.complete:aborted');
    expect(harness.calls).not.toContain('participant.stage');
    expect(harness.calls).not.toContain('publication.write-marker-last');
  });

  it('does not flush participants when accepted-command drain fails behind the writer fence', async () => {
    const harness = new BackupHarness();
    harness.commandDrainFailure = true;

    await expect(
      harness.service.createCoordinationBackup({
        backupRunId: RUN_ID,
        deploymentId: DEPLOYMENT_ID,
        purpose: 'coordination_repair',
      })
    ).rejects.toMatchObject({ code: 'backup_run_failed' });

    expect(harness.calls).toContain('coordination.drain-accepted');
    expect(harness.calls).not.toContain('participant.prepare');
    expect(harness.calls).not.toContain('participant.flush');
    expect(harness.calls).not.toContain('sqlite.online-backup');
    expect(harness.repository.current?.fenceCompletion).toMatchObject({
      status: 'completed',
      disposition: 'aborted',
    });
  });

  it('rejects a barrier that does not bind the flushed participant recovery point', async () => {
    const harness = new BackupHarness();
    harness.barrierParticipantMismatch = true;

    await expect(
      harness.service.createCoordinationBackup({
        backupRunId: RUN_ID,
        deploymentId: DEPLOYMENT_ID,
        purpose: 'coordination_repair',
      })
    ).rejects.toMatchObject({ code: 'backup_run_operator_required' });

    expect(harness.calls).toContain('participant.flush');
    expect(harness.calls).toContain('coordination.capture-barrier');
    expect(harness.calls).not.toContain('identity.capture');
    expect(harness.calls).not.toContain('sqlite.online-backup');
  });

  it('fails and removes the unpublished stage when independent SQLite reopen rejects it', async () => {
    const harness = new BackupHarness();
    harness.integrityInvalid = true;

    await expect(
      harness.service.createCoordinationBackup({
        backupRunId: RUN_ID,
        deploymentId: DEPLOYMENT_ID,
        purpose: 'coordination_repair',
      })
    ).rejects.toMatchObject({ code: 'backup_run_failed' });
    expect(harness.calls).toContain('sqlite.reopen-integrity');
    expect(harness.calls).toContain('publication.abort');
    expect(harness.calls).not.toContain('publication.write-manifest');
    expect(harness.calls).not.toContain('publication.write-marker-last');
    expect(harness.repository.current?.state).toBe('failed');
  });

  it('recovers a crash after marker fsync and before immutable-directory rename', async () => {
    const harness = new BackupHarness();
    harness.failCommitStageOnce = true;

    const result = await harness.service.createCoordinationBackup({
      backupRunId: RUN_ID,
      deploymentId: DEPLOYMENT_ID,
      purpose: 'coordination_repair',
    });

    expect(result.state).toBe('committed');
    expect(harness.markerWrites).toBe(1);
    expect(harness.calls.filter((call) => call === 'publication.commit-stage')).toHaveLength(2);
    expect(harness.calls).toContain('publication.inspect:staging_sealed');
  });

  it.each(
    BACKUP_RUN_STATES.filter(
      (state) => !['committed', 'failed', 'operator_required', 'artifact_source'].includes(state)
    )
  )('resumes idempotently from durable crash state %s', async (state) => {
    const harness = new BackupHarness();
    harness.seedRecoverableState(state);

    const result = await harness.service.recoverBackupRun(RUN_ID);

    expect(result.state).toBe('committed');
    if (state !== 'requested') expect(harness.calls).not.toContain('run.requested->fencing');
    if (!['requested', 'fencing', 'quiescing'].includes(state)) {
      expect(harness.calls).not.toContain('participant.prepare');
    }
    if (!['requested', 'fencing', 'quiescing'].includes(state)) {
      expect(harness.calls).not.toContain('participant.flush');
    }
    if (!['requested', 'fencing', 'quiescing', 'sqlite_snapshot'].includes(state)) {
      expect(harness.calls).not.toContain('sqlite.online-backup');
    }
    if (state === 'verifying') expect(harness.calls).not.toContain('participant.stage');
  });

  it.each(['before_persist', 'after_persist'] as const)(
    'recovers a crash %s at the final durable committed transition without republishing',
    async (failureMode) => {
      const harness = new BackupHarness();
      harness.repository.commitTransitionFailure = failureMode;

      const result = await harness.service.createCoordinationBackup({
        backupRunId: RUN_ID,
        deploymentId: DEPLOYMENT_ID,
        purpose: 'coordination_repair',
      });

      expect(result.state).toBe('committed');
      expect(harness.markerWrites).toBe(1);
      expect(harness.calls.filter((call) => call === 'publication.commit-stage')).toHaveLength(1);
      if (failureMode === 'before_persist') {
        expect(harness.calls).toContain('publication.inspect:committed');
      } else {
        expect(harness.calls).not.toContain('publication.inspect:committed');
        expect(harness.calls.filter((call) => call === 'immutable.verify:committed')).toHaveLength(
          2
        );
      }
      expect(harness.calls.at(-1)).toBe('run.mark-fence-completed');
    }
  );

  it('durably retries writer-fence completion after the completion port fails', async () => {
    const harness = new BackupHarness();
    harness.fenceCompletionFailures = 1;

    await expect(
      harness.service.createCoordinationBackup({
        backupRunId: RUN_ID,
        deploymentId: DEPLOYMENT_ID,
        purpose: 'coordination_repair',
      })
    ).rejects.toMatchObject({
      code: 'fence_completion_failed',
      terminalRecord: expect.objectContaining({
        state: 'committed',
        fenceCompletion: expect.objectContaining({ status: 'pending' }),
      }),
    });
    expect(harness.repository.current?.fenceCompletion?.status).toBe('pending');

    harness.calls.length = 0;
    const recovered = await harness.service.recoverBackupRun(RUN_ID);

    expect(recovered.fenceCompletion).toMatchObject({
      status: 'completed',
      disposition: 'committed',
      generation: 7,
    });
    expect(harness.calls).toEqual([
      'immutable.verify:committed',
      'fence.complete:committed',
      'run.mark-fence-completed',
    ]);
  });

  it('retries the same durable fence lease after completion succeeded but persistence crashed', async () => {
    const harness = new BackupHarness();
    harness.repository.fenceCompletionPersistenceFailure = 'before_persist';

    await expect(
      harness.service.createCoordinationBackup({
        backupRunId: RUN_ID,
        deploymentId: DEPLOYMENT_ID,
        purpose: 'coordination_repair',
      })
    ).rejects.toMatchObject({ code: 'fence_completion_failed' });
    expect(harness.repository.current?.fenceLeaseId).toBe('lease-1');
    expect(harness.repository.current?.fenceCompletion?.status).toBe('pending');

    const recovered = await harness.service.recoverBackupRun(RUN_ID);

    expect(recovered.fenceCompletion?.status).toBe('completed');
    expect(harness.calls.filter((call) => call === 'fence.complete:committed')).toHaveLength(2);
  });

  it('includes terminal runs with pending fence completion in bulk crash recovery', async () => {
    const harness = new BackupHarness();
    harness.fenceCompletionFailures = 1;
    await expect(
      harness.service.createCoordinationBackup({
        backupRunId: RUN_ID,
        deploymentId: DEPLOYMENT_ID,
        purpose: 'coordination_repair',
      })
    ).rejects.toMatchObject({ code: 'fence_completion_failed' });

    const recovered = await harness.service.recoverAllBackupRuns();

    expect(recovered).toHaveLength(1);
    expect(recovered[0].fenceCompletion?.status).toBe('completed');
  });

  it('reconciles a crash after durable fence-completion persistence without a false failure', async () => {
    const harness = new BackupHarness();
    harness.repository.fenceCompletionPersistenceFailure = 'after_persist';

    const result = await harness.service.createCoordinationBackup({
      backupRunId: RUN_ID,
      deploymentId: DEPLOYMENT_ID,
      purpose: 'coordination_repair',
    });

    expect(result.fenceCompletion?.status).toBe('completed');
    expect(harness.calls.filter((call) => call === 'fence.complete:committed')).toHaveLength(1);
  });

  it('recovers pending aborted-fence completion without rerunning a failed backup', async () => {
    const harness = new BackupHarness();
    harness.onlineBackupFailure = 'busy_timeout';
    harness.fenceCompletionFailures = 1;

    await expect(
      harness.service.createCoordinationBackup({
        backupRunId: RUN_ID,
        deploymentId: DEPLOYMENT_ID,
        purpose: 'coordination_repair',
      })
    ).rejects.toMatchObject({ code: 'fence_completion_failed' });
    harness.calls.length = 0;

    const recovered = await harness.service.recoverBackupRun(RUN_ID);

    expect(recovered).toMatchObject({
      state: 'failed',
      fenceCompletion: { status: 'completed', disposition: 'aborted' },
    });
    expect(harness.calls).toEqual(['fence.complete:aborted', 'run.mark-fence-completed']);
    expect(harness.calls).not.toContain('sqlite.online-backup');
  });

  it('moves an ambiguous publication to operator_required and leaves mutation admission closed', async () => {
    const harness = new BackupHarness();
    harness.forceAmbiguousPublication = true;

    await expect(
      harness.service.createCoordinationBackup({
        backupRunId: RUN_ID,
        deploymentId: DEPLOYMENT_ID,
        purpose: 'coordination_repair',
      })
    ).rejects.toMatchObject({
      code: 'backup_run_operator_required',
      terminalRecord: expect.objectContaining({ state: 'operator_required' }),
    });
    expect(harness.calls).toContain('fence.complete:operator_required');
    expect(harness.calls).not.toContain('publication.write-marker-last');
  });

  it('requires an operator when fence acquisition may have closed mutation admission', async () => {
    const harness = new BackupHarness();
    harness.fenceAcquireFailure = true;

    await expect(
      harness.service.createCoordinationBackup({
        backupRunId: RUN_ID,
        deploymentId: DEPLOYMENT_ID,
        purpose: 'coordination_repair',
      })
    ).rejects.toMatchObject({
      code: 'backup_run_operator_required',
      terminalRecord: expect.objectContaining({ state: 'operator_required' }),
    });
    expect(harness.calls).not.toContain('participant.prepare');
    expect(harness.calls.some((call) => call.startsWith('fence.complete:'))).toBe(false);
  });

  it('leaves a busy fenced run recoverable without aborting the active owner stage', async () => {
    const harness = new BackupHarness();
    harness.fenceBusy = true;

    await expect(
      harness.service.createCoordinationBackup({
        backupRunId: RUN_ID,
        deploymentId: DEPLOYMENT_ID,
        purpose: 'coordination_repair',
      })
    ).rejects.toMatchObject({ code: 'backup_fence_busy' });
    expect(harness.repository.current?.state).toBe('fencing');
    expect(harness.calls).not.toContain('publication.abort');
    expect(harness.calls.some((call) => call.startsWith('fence.complete:'))).toBe(false);
  });

  it('rejects an unsupported durable participant schema before reacquiring a recovery fence', async () => {
    const harness = new BackupHarness();
    await harness.repository.create({
      backupRunId: RUN_ID,
      deploymentId: DEPLOYMENT_ID,
      purpose: 'coordination_repair',
      requestedAt: '2026-07-20T00:00:00.000Z',
      participantDescriptors: [
        { ...PARTICIPANT_DESCRIPTOR, schemaVersion: 2 },
      ] as unknown as readonly BackupParticipantDescriptor[],
    });

    await expect(harness.service.recoverBackupRun(RUN_ID)).rejects.toMatchObject({
      code: 'invalid_record',
    });
    expect(harness.calls).not.toContain('fence.acquire');
  });

  it('verifies a committed artifact on every later read without rewriting or republishing it', async () => {
    const harness = new BackupHarness();
    await harness.service.createCoordinationBackup({
      backupRunId: RUN_ID,
      deploymentId: DEPLOYMENT_ID,
      purpose: 'coordination_repair',
    });
    const markerWrites = harness.markerWrites;
    harness.calls.length = 0;

    const inspection = await harness.service.verifyCommittedBackup(RUN_ID);

    expect(inspection.manifest.backupRunId).toBe(RUN_ID);
    expect(harness.calls).toEqual(['immutable.verify:committed']);
    expect(harness.markerWrites).toBe(markerWrites);
  });

  it('surfaces immutable disagreement on a committed artifact as a typed service failure', async () => {
    const harness = new BackupHarness();
    await harness.service.createCoordinationBackup({
      backupRunId: RUN_ID,
      deploymentId: DEPLOYMENT_ID,
      purpose: 'coordination_repair',
    });
    harness.immutableInvalidLocations.add('committed');

    await expect(harness.service.verifyCommittedBackup(RUN_ID)).rejects.toMatchObject({
      code: 'immutable_verification_failed',
      terminalRecord: expect.objectContaining({ state: 'committed' }),
    });
  });
});

class BackupHarness {
  readonly calls: string[] = [];
  readonly repository = new InMemoryBackupRunRepository(this.calls);
  readonly service: CoordinationBackupService;
  publicationStatus: BackupPublicationInspection['status'] = 'absent';
  onlineBackupFailure: 'busy_timeout' | 'deadline_exceeded' | 'source_corrupt' | null = null;
  integrityInvalid = false;
  forceAmbiguousPublication = false;
  failCommitStageOnce = false;
  fenceAcquireFailure = false;
  fenceBusy = false;
  commandDrainFailure = false;
  barrierParticipantMismatch = false;
  fenceCompletionFailures = 0;
  readonly immutableInvalidLocations = new Set<'staging' | 'committed'>();
  markerWrites = 0;

  constructor() {
    const participant = this.createParticipant();
    const dependencies: CoordinationBackupServiceDependencies = {
      runs: this.repository,
      participants: [participant],
      clock: { nowIso: () => '2026-07-20T00:00:00.000Z' },
      writerFence: {
        acquire: ({ backupRunId, expectedGeneration }) => {
          this.calls.push('fence.acquire');
          if (this.fenceAcquireFailure) return Promise.reject(new Error('fence response lost'));
          if (this.fenceBusy) {
            return Promise.resolve({ status: 'busy' as const, activeRunId: RUN_ID });
          }
          return Promise.resolve({
            status: 'acquired' as const,
            lease: {
              leaseId: 'lease-1',
              evidence: {
                admittedRunId: backupRunId,
                generation: expectedGeneration ?? 7,
              },
            },
          });
        },
        complete: ({ disposition }) => {
          this.calls.push(`fence.complete:${disposition}`);
          if (this.fenceCompletionFailures > 0) {
            this.fenceCompletionFailures -= 1;
            return Promise.reject(new Error('simulated fence completion failure'));
          }
          return Promise.resolve();
        },
      },
      coordinationFlush: {
        drainAcceptedCommands: ({ backupRunId, fence }) => {
          this.calls.push('coordination.drain-accepted');
          if (this.commandDrainFailure) {
            return Promise.reject(new Error('simulated accepted-command drain failure'));
          }
          return Promise.resolve({
            admittedRunId: backupRunId,
            fenceGeneration: fence.generation,
            throughCommandCursor: 'command-10',
            durableBarrier: 'command-drain-10',
          });
        },
        captureBarrier: () => {
          this.calls.push('coordination.capture-barrier');
          const barrier = makeBarrier();
          return Promise.resolve(
            this.barrierParticipantMismatch
              ? {
                  ...barrier,
                  participantRecoveryPoints: [
                    {
                      ...barrier.participantRecoveryPoints[0],
                      durableBarrier: 'wrong-participant-barrier',
                    },
                  ],
                }
              : barrier
          );
        },
      },
      identityInventory: {
        capture: () => {
          this.calls.push('identity.capture');
          return Promise.resolve(makeIdentityInventory());
        },
      },
      onlineBackup: {
        createOnlineSnapshot: ({ backupRunId }) => {
          this.calls.push('sqlite.online-backup');
          if (this.onlineBackupFailure) {
            return Promise.resolve({ status: 'failed', reason: this.onlineBackupFailure } as const);
          }
          return Promise.resolve({
            status: 'completed',
            snapshot: {
              method: SQLITE_ONLINE_BACKUP_METHOD,
              entry: makeSqliteEntry(),
              applicationId: 42,
              userVersion: 3,
              sourceRunId: backupRunId,
            },
          } as const);
        },
      },
      sqliteIntegrity: {
        reopenAndCheck: () => {
          this.calls.push('sqlite.reopen-integrity');
          if (this.integrityInvalid) {
            return Promise.resolve({
              status: 'invalid',
              reason: 'integrity_check_failed',
            } as const);
          }
          return Promise.resolve({
            status: 'valid',
            evidence: {
              integrityCheck: 'ok',
              applicationId: 42,
              userVersion: 3,
              requiredInvariants: { identity_unique: true },
            },
          } as const);
        },
      },
      manifestHash: {
        hashCanonicalManifest: () => {
          this.calls.push('manifest.hash');
          return Promise.resolve(HASH_C);
        },
      },
      publication: {
        preparePrivateStage: () => {
          this.calls.push('publication.prepare');
          this.publicationStatus = 'staging_unsealed';
          return Promise.resolve();
        },
        inspect: () => {
          if (this.forceAmbiguousPublication) this.publicationStatus = 'ambiguous';
          this.calls.push(`publication.inspect:${this.publicationStatus}`);
          if (this.publicationStatus === 'committed') {
            return Promise.resolve({
              status: 'committed' as const,
              publication: this.committedPublication(),
            });
          }
          return Promise.resolve({
            status: this.publicationStatus,
          } as BackupPublicationInspection);
        },
        writeRootManifest: () => {
          this.calls.push('publication.write-manifest');
          return Promise.resolve();
        },
        writeCommitMarkerLast: ({ marker }) => {
          this.calls.push('publication.write-marker-last');
          expect(marker.format).toBe(COORDINATION_BACKUP_COMMIT_MARKER_FORMAT);
          this.markerWrites += 1;
          this.publicationStatus = 'staging_sealed';
          return Promise.resolve();
        },
        commitSealedStage: () => {
          this.calls.push('publication.commit-stage');
          if (this.failCommitStageOnce) {
            this.failCommitStageOnce = false;
            return Promise.reject(new Error('simulated process death before rename'));
          }
          this.publicationStatus = 'committed';
          return Promise.resolve(this.committedPublication());
        },
        abortUncommittedStage: () => {
          this.calls.push('publication.abort');
          this.publicationStatus = 'absent';
          return Promise.resolve();
        },
      },
      immutableVerifier: {
        verify: ({ location, expectedPlan }) => {
          this.calls.push(`immutable.verify:${location}`);
          if (this.immutableInvalidLocations.has(location)) {
            return Promise.resolve({
              status: 'invalid' as const,
              reasons: ['injected_hash_mismatch'],
            });
          }
          return Promise.resolve({
            status: 'verified' as const,
            inspection: makeInspection(expectedPlan),
          });
        },
      },
    };
    this.service = new CoordinationBackupService(dependencies);
  }

  seedRecoverableState(state: BackupRunRecord['state']): void {
    if (['committed', 'failed', 'operator_required', 'artifact_source'].includes(state)) {
      throw new Error('test seed must be recoverable');
    }
    const order = [
      'requested',
      'fencing',
      'quiescing',
      'sqlite_snapshot',
      'file_stage',
      'verifying',
    ];
    const atOrAfter = (candidate: string) => order.indexOf(state) >= order.indexOf(candidate);
    const prepared: PreparedBackupParticipant[] = [
      {
        descriptor: PARTICIPANT_DESCRIPTOR,
        sourceGeneration: 'identity-generation-1',
      },
    ];
    const flushed: FlushedBackupParticipant[] = [
      { ...prepared[0], durableBarrier: 'identity-barrier-1' },
    ];
    this.repository.current = {
      backupRunId: RUN_ID,
      deploymentId: DEPLOYMENT_ID,
      productKind: 'coordination_backup',
      purpose: 'coordination_repair',
      state,
      revision: order.indexOf(state) + 1,
      requestedAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
      participantDescriptors: [PARTICIPANT_DESCRIPTOR],
      fence: atOrAfter('quiescing') ? { generation: 7, admittedRunId: RUN_ID } : null,
      fenceLeaseId: atOrAfter('quiescing') ? 'lease-1' : null,
      fenceCompletion: null,
      preparedParticipants: atOrAfter('sqlite_snapshot') ? prepared : null,
      flushedParticipants: atOrAfter('sqlite_snapshot') ? flushed : null,
      coordinationBarrier: atOrAfter('sqlite_snapshot') ? makeBarrier() : null,
      identityInventory: atOrAfter('sqlite_snapshot') ? makeIdentityInventory() : null,
      sqliteSnapshot: atOrAfter('file_stage')
        ? {
            method: SQLITE_ONLINE_BACKUP_METHOD,
            entry: makeSqliteEntry(),
            applicationId: 42,
            userVersion: 3,
            sourceRunId: RUN_ID,
          }
        : null,
      stagedEntries: atOrAfter('verifying') ? [makeIdentityEntry()] : null,
      exclusions: atOrAfter('verifying') ? [] : null,
      verificationPlan: null,
      publication: null,
      failure: null,
    };
    this.publicationStatus = atOrAfter('file_stage') ? 'staging_unsealed' : 'absent';
  }

  private createParticipant(): CoordinationBackupParticipant {
    const prepared: PreparedBackupParticipant = {
      descriptor: PARTICIPANT_DESCRIPTOR,
      sourceGeneration: 'identity-generation-1',
    };
    const flushed: FlushedBackupParticipant = {
      ...prepared,
      durableBarrier: 'identity-barrier-1',
    };
    return {
      descriptor: PARTICIPANT_DESCRIPTOR,
      prepare: () => {
        this.calls.push('participant.prepare');
        return Promise.resolve(prepared);
      },
      flush: () => {
        this.calls.push('participant.flush');
        return Promise.resolve(flushed);
      },
      stage: (): Promise<StagedBackupParticipant> => {
        this.calls.push('participant.stage');
        return Promise.resolve({
          participantId: PARTICIPANT_DESCRIPTOR.participantId,
          entries: [makeIdentityEntry()],
          exclusions: [
            {
              participantId: PARTICIPANT_DESCRIPTOR.participantId,
              logicalType: 'provider_credential',
              reason: 'credential',
            },
          ],
        });
      },
      verify: () => {
        this.calls.push('participant.verify');
        return Promise.resolve({ status: 'verified' as const });
      },
    };
  }

  private committedPublication() {
    return {
      backupRunId: RUN_ID,
      manifestHash: HASH_C,
      immutableGeneration: 'immutable-1',
    };
  }
}

class InMemoryBackupRunRepository {
  current: BackupRunRecord | null = null;
  commitTransitionFailure: 'before_persist' | 'after_persist' | null = null;
  fenceCompletionPersistenceFailure: 'before_persist' | 'after_persist' | null = null;

  constructor(private readonly calls: string[]) {}

  create(request: CreateBackupRunRequest): Promise<BackupRunRecord> {
    this.calls.push('run.create');
    this.current = {
      backupRunId: request.backupRunId,
      deploymentId: request.deploymentId,
      productKind: 'coordination_backup',
      purpose: request.purpose,
      state: 'requested',
      revision: 1,
      requestedAt: request.requestedAt,
      updatedAt: request.requestedAt,
      participantDescriptors: request.participantDescriptors,
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
    };
    return Promise.resolve(this.current);
  }

  get(backupRunId: BackupRunId): Promise<BackupRunRecord | null> {
    return Promise.resolve(this.current?.backupRunId === backupRunId ? this.current : null);
  }

  listRecoverable(): Promise<readonly BackupRunRecord[]> {
    return Promise.resolve(
      this.current &&
        (this.current.fenceCompletion?.status === 'pending' ||
          !['committed', 'failed', 'operator_required'].includes(this.current.state))
        ? [this.current]
        : []
    );
  }

  transition(request: BackupRunTransitionRequest): Promise<BackupRunRecord> {
    if (!this.current) return Promise.reject(new Error('record missing'));
    if (
      request.from !== this.current.state ||
      request.expectedRevision !== this.current.revision ||
      request.backupRunId !== this.current.backupRunId
    ) {
      return Promise.reject(new Error('compare-and-set failed'));
    }
    this.calls.push(`run.${request.from}->${request.to}`);
    if (request.to === 'committed' && this.commitTransitionFailure === 'before_persist') {
      this.commitTransitionFailure = null;
      return Promise.reject(new Error('simulated crash before commit transaction'));
    }
    const evidence = transitionEvidence(request);
    this.current = {
      ...this.current,
      ...evidence,
      state: request.to,
      revision: this.current.revision + 1,
      updatedAt: request.at,
    };
    if (request.to === 'committed' && this.commitTransitionFailure === 'after_persist') {
      this.commitTransitionFailure = null;
      return Promise.reject(new Error('simulated crash after commit transaction'));
    }
    return Promise.resolve(this.current);
  }

  saveVerificationPlan(request: SaveBackupVerificationPlanRequest): Promise<BackupRunRecord> {
    this.calls.push('run.save-verification-plan');
    if (this.current?.state !== 'verifying' || request.expectedRevision !== this.current.revision) {
      return Promise.reject(new Error('verification-plan compare-and-set failed'));
    }
    this.current = {
      ...this.current,
      verificationPlan: request.plan,
      revision: this.current.revision + 1,
      updatedAt: request.at,
    };
    return Promise.resolve(this.current);
  }

  markFenceCompleted(request: MarkBackupFenceCompletedRequest): Promise<BackupRunRecord> {
    this.calls.push('run.mark-fence-completed');
    const current = this.current;
    const completion = current?.fenceCompletion;
    if (
      request.expectedRevision !== current?.revision ||
      completion?.status !== 'pending' ||
      request.generation !== completion.generation ||
      request.disposition !== completion.disposition
    ) {
      return Promise.reject(new Error('fence-completion compare-and-set failed'));
    }
    if (this.fenceCompletionPersistenceFailure === 'before_persist') {
      this.fenceCompletionPersistenceFailure = null;
      return Promise.reject(new Error('simulated crash before fence completion persistence'));
    }
    this.current = {
      ...current,
      revision: current.revision + 1,
      updatedAt: request.completedAt,
      fenceCompletion: {
        ...completion,
        status: 'completed',
        completedAt: request.completedAt,
      },
    };
    if (this.fenceCompletionPersistenceFailure === 'after_persist') {
      this.fenceCompletionPersistenceFailure = null;
      return Promise.reject(new Error('simulated crash after fence completion persistence'));
    }
    return Promise.resolve(this.current);
  }
}

function transitionEvidence(request: BackupRunTransitionRequest): Partial<BackupRunRecord> {
  switch (request.to) {
    case 'quiescing':
      return { fence: request.fence, fenceLeaseId: request.fenceLeaseId };
    case 'sqlite_snapshot':
      return {
        preparedParticipants: request.preparedParticipants,
        flushedParticipants: request.flushedParticipants,
        coordinationBarrier: request.coordinationBarrier,
        identityInventory: request.identityInventory,
      };
    case 'file_stage':
      return { sqliteSnapshot: request.sqliteSnapshot };
    case 'verifying':
      return { stagedEntries: request.stagedEntries, exclusions: request.exclusions };
    case 'committed':
      return { publication: request.publication, fenceCompletion: request.fenceCompletion };
    case 'failed':
    case 'operator_required':
      return {
        failure: request.failure,
        fence: request.fence,
        fenceLeaseId: request.fenceLeaseId,
        fenceCompletion: request.fenceCompletion,
      };
    default:
      return {};
  }
}

function makeBarrier(): BackupCoordinationBarrier {
  return {
    stateCompatibilityManifest: { manifestId: 'state-v3', schemaVersion: 3, sha256: HASH_A },
    acceptedCommandDrain: {
      admittedRunId: RUN_ID,
      fenceGeneration: 7,
      throughCommandCursor: 'command-10',
      durableBarrier: 'command-drain-10',
    },
    participantRecoveryPoints: [
      {
        participantId: PARTICIPANT_DESCRIPTOR.participantId,
        sourceGeneration: 'identity-generation-1',
        durableBarrier: 'identity-barrier-1',
      },
    ],
    eventCursor: 'event-20',
    eventEpoch: 'epoch-1',
    journalCursors: { outbox: 'outbox-12' },
  };
}

function makeIdentityInventory(): BackupIdentityInventory {
  return {
    schemaVersion: 1,
    deploymentId: DEPLOYMENT_ID,
    identities: [
      {
        kind: 'deployment',
        identityId: DEPLOYMENT_ID,
        parentIdentityId: null,
        state: 'active',
        checksum: HASH_A,
        fileEntryId: 'identity/deployment',
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
}

function makeSqliteEntry(): BackupManifestEntry & { readonly kind: 'sqlite_snapshot' } {
  return {
    entryId: 'sqlite/app.db',
    participantId: 'internal-storage',
    kind: 'sqlite_snapshot',
    logicalOwner: 'internal-storage',
    logicalType: 'application/sqlite3',
    schemaVersion: 3,
    byteLength: 4096,
    mode: 0o600,
    sha256: HASH_B,
    sourceGeneration: 'sqlite-generation-1',
  };
}

function makeIdentityEntry(): BackupManifestEntry {
  return {
    entryId: 'identity/deployment',
    participantId: PARTICIPANT_DESCRIPTOR.participantId,
    kind: 'identity_anchor',
    logicalOwner: 'deployment-identity',
    logicalType: 'application/json',
    schemaVersion: 1,
    byteLength: 128,
    mode: 0o600,
    sha256: HASH_A,
    sourceGeneration: 'identity-generation-1',
  };
}

function makeInspection(plan: BackupVerificationPlan): ImmutableBackupInspection {
  const manifest = plan.manifest;
  return {
    manifest,
    marker: plan.marker,
    computedManifestHash: manifest.manifestHash,
    measuredEntries: manifest.entries.map(({ entryId, byteLength, mode, sha256 }) => ({
      entryId,
      byteLength,
      mode,
      sha256,
    })),
    observedIdentityInventory: manifest.identityInventory,
    copiedSourceRun: {
      backupRunId: manifest.sourceBackupRunId,
      deploymentId: manifest.deploymentId,
      productKind: manifest.productKind,
      purpose: manifest.purpose,
      state: 'sqlite_snapshot',
      fenceGeneration: manifest.fenceGeneration,
      coordinationBarrier: manifest.coordinationBarrier,
      participants: manifest.participants,
      identityInventory: manifest.identityInventory,
    },
  };
}
