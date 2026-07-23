import {
  buildLocationFromJournal,
  buildRuntimeDestinationMessageId,
  hashRuntimeDeliveryEnvelope,
  hashRuntimeDeliveryEnvelopeLegacyTaskRefs,
  hashRuntimeDeliveryEnvelopeLegacyTransport,
  normalizeRuntimeDeliveryEnvelope,
  resolveRuntimeDeliveryDestination,
  type RuntimeDeliveryCanonicalRecoveryMigration,
  type RuntimeDeliveryDestinationRef,
  type RuntimeDeliveryEnvelope,
  RuntimeDeliveryJournalCommitRevalidationError,
  type RuntimeDeliveryJournalRecord,
  type RuntimeDeliveryLocation,
} from './RuntimeDeliveryJournal';

import type { RuntimeDeliveryJournalStore } from './RuntimeDeliveryJournal';

export interface RuntimeDeliveryVerifyResult {
  found: boolean;
  location: RuntimeDeliveryLocation | null;
  diagnostics: string[];
  recoveryEvidence?: RuntimeDeliveryRecoveryEvidence;
}

export interface RuntimeDeliveryRecoveryEvidence {
  fromMemberName: string;
  runtimeSessionId: string;
  text: string;
  createdAt: string;
  summary: string | null;
  taskRefs?: RuntimeDeliveryEnvelope['taskRefs'];
}

export interface RuntimeDeliveryDestinationPort {
  readonly kind: RuntimeDeliveryDestinationRef['kind'];

  write(input: {
    envelope: RuntimeDeliveryEnvelope;
    destinationMessageId: string;
  }): Promise<RuntimeDeliveryLocation>;

  verify(input: {
    destination: RuntimeDeliveryDestinationRef;
    destinationMessageId: string;
    location?: RuntimeDeliveryLocation;
    preCanonicalRecovery?: {
      envelope: RuntimeDeliveryEnvelope;
      canonicalDestination: RuntimeDeliveryDestinationRef;
    };
    includeRecoveryEvidence?: boolean;
  }): Promise<RuntimeDeliveryVerifyResult>;

  buildChangeEvent(input: {
    teamName: string;
    location: RuntimeDeliveryLocation;
  }): RuntimeDeliveryTeamChangeEvent | null;
}

export interface RuntimeDeliveryTeamChangeEvent {
  type: string;
  teamName: string;
  data?: Record<string, unknown>;
}

export interface RuntimeDeliveryRunStateReader {
  getCurrentRunId(teamName: string): Promise<string | null>;
}

export interface RuntimeDeliveryRecipientCanonicalizer {
  canonicalize(envelope: RuntimeDeliveryEnvelope): Promise<RuntimeDeliveryEnvelope>;
}

export interface RuntimeDeliveryJournalRecordCanonicalizer {
  canonicalize(record: RuntimeDeliveryJournalRecord): Promise<RuntimeDeliveryJournalRecord>;
}

export interface RuntimeDeliveryDiagnosticsSink {
  append(event: RuntimeDeliveryDiagnosticEvent): Promise<void>;
}

export interface RuntimeDeliveryDiagnosticEvent {
  type:
    | 'runtime_delivery_conflict'
    | 'runtime_delivery_failed'
    | 'runtime_delivery_recovery_needed'
    | 'runtime_delivery_change_emit_failed';
  providerId: 'opencode';
  teamName: string;
  runId: string;
  severity: 'warning' | 'error';
  message: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface RuntimeDeliveryTeamChangeEmitter {
  emit(event: RuntimeDeliveryTeamChangeEvent): void;
}

export type RuntimeDeliveryAck =
  | {
      ok: true;
      delivered: boolean;
      reason: null | 'duplicate' | 'duplicate_destination_found';
      idempotencyKey: string;
      location: RuntimeDeliveryLocation;
    }
  | {
      ok: false;
      delivered: false;
      reason: 'stale_run' | 'idempotency_conflict';
      idempotencyKey: string;
    };

// The runtime boundary creates a service per request, so in-flight turns must be shared.
const runtimeDeliveryTurns = new Map<string, Promise<void>>();
const CROSS_TEAM_IDEMPOTENCY_CONFLICT = 'CROSS_TEAM_IDEMPOTENCY_CONFLICT';

export class RuntimeDeliveryDestinationRegistry {
  private readonly ports = new Map<
    RuntimeDeliveryDestinationRef['kind'],
    RuntimeDeliveryDestinationPort
  >();

  constructor(ports: RuntimeDeliveryDestinationPort[]) {
    for (const port of ports) {
      if (this.ports.has(port.kind)) {
        throw new Error(`Duplicate runtime delivery destination port: ${port.kind}`);
      }
      this.ports.set(port.kind, port);
    }
  }

  get(kind: RuntimeDeliveryDestinationRef['kind']): RuntimeDeliveryDestinationPort {
    const port = this.ports.get(kind);
    if (!port) {
      throw new Error(`Runtime delivery destination port not registered: ${kind}`);
    }
    return port;
  }
}

export class RuntimeDeliveryService {
  constructor(
    private readonly runState: RuntimeDeliveryRunStateReader,
    private readonly journal: RuntimeDeliveryJournalStore,
    private readonly destinations: RuntimeDeliveryDestinationRegistry,
    private readonly diagnostics: RuntimeDeliveryDiagnosticsSink,
    private readonly teamChangeEmitter: RuntimeDeliveryTeamChangeEmitter,
    private readonly clock: () => Date = () => new Date(),
    private readonly recipientCanonicalizer?: RuntimeDeliveryRecipientCanonicalizer
  ) {}

  async deliver(raw: unknown): Promise<RuntimeDeliveryAck> {
    const envelope = normalizeRuntimeDeliveryEnvelope(raw);
    return await serializeRuntimeDelivery(envelope, () => this.deliverEnvelope(envelope));
  }

  private async deliverEnvelope(
    requestedEnvelope: RuntimeDeliveryEnvelope
  ): Promise<RuntimeDeliveryAck> {
    const now = this.clock().toISOString();
    const staleRun = await this.rejectIfRunIsStale(requestedEnvelope);
    if (staleRun) {
      return staleRun;
    }

    const envelope = this.recipientCanonicalizer
      ? normalizeRuntimeDeliveryEnvelope(
          await this.recipientCanonicalizer.canonicalize(requestedEnvelope)
        )
      : requestedEnvelope;

    const preCanonicalDestination = resolveRuntimeDeliveryDestination(requestedEnvelope);
    const requestedDestination = resolveRuntimeDeliveryDestination(envelope);
    const requestedDestinationMessageId = buildRuntimeDestinationMessageId(envelope);
    const payloadHash = hashRuntimeDeliveryEnvelope(envelope);
    const requestedPayloadHash = hashRuntimeDeliveryEnvelope(requestedEnvelope);
    const legacyTransportPayloadHash = hashRuntimeDeliveryEnvelopeLegacyTransport(envelope);
    const legacyPayloadHash = hashRuntimeDeliveryEnvelopeLegacyTaskRefs(envelope);
    const begin = await this.journal.begin({
      idempotencyKey: envelope.idempotencyKey,
      payloadHash,
      preCanonicalPayloadHash:
        requestedPayloadHash === payloadHash ? undefined : requestedPayloadHash,
      preCanonicalDestination:
        requestedPayloadHash === payloadHash ? undefined : preCanonicalDestination,
      compatiblePayloadHashes: [legacyTransportPayloadHash, legacyPayloadHash].filter(
        (candidate): candidate is string => candidate !== null
      ),
      runId: envelope.runId,
      teamName: envelope.teamName,
      fromMemberName: envelope.fromMemberName,
      providerId: envelope.providerId,
      runtimeSessionId: envelope.runtimeSessionId,
      destination: requestedDestination,
      destinationMessageId: requestedDestinationMessageId,
      now,
    });

    const journalCanBeMarkedTerminal =
      begin.state === 'new' ||
      begin.state === 'resume_pending' ||
      (begin.state === 'payload_conflict' && begin.record.status !== 'committed');
    const staleRunAfterJournal = await this.rejectIfRunIsStale(envelope, {
      markJournalRecordTerminal: journalCanBeMarkedTerminal,
    });
    if (staleRunAfterJournal) {
      return staleRunAfterJournal;
    }

    if (begin.state === 'payload_conflict') {
      await this.diagnostics.append({
        type: 'runtime_delivery_conflict',
        providerId: 'opencode',
        teamName: envelope.teamName,
        runId: envelope.runId,
        severity: 'error',
        message: 'Runtime delivery idempotency key was reused with a different payload',
        data: {
          idempotencyKey: envelope.idempotencyKey,
          existingPayloadHash: begin.record.logicalPayloadHash ?? begin.record.payloadHash,
          newPayloadHash: payloadHash,
        },
        createdAt: now,
      });
      return {
        ok: false,
        delivered: false,
        reason: 'idempotency_conflict',
        idempotencyKey: envelope.idempotencyKey,
      };
    }

    if (begin.state === 'already_committed') {
      return {
        ok: true,
        delivered: false,
        reason: 'duplicate',
        idempotencyKey: envelope.idempotencyKey,
        location: buildLocationFromJournal(begin.record),
      };
    }

    const destination = begin.record.destination;
    const destinationMessageId = begin.record.destinationMessageId;
    const port = this.destinations.get(destination.kind);
    const preCanonicalRecoveryRecords = begin.preCanonicalRecoveryRecords ?? [];
    if (preCanonicalRecoveryRecords.length > 0) {
      for (const candidate of preCanonicalRecoveryRecords) {
        const candidatePort = this.destinations.get(candidate.destination.kind);
        const verificationInput: Parameters<RuntimeDeliveryDestinationPort['verify']>[0] = {
          destination: candidate.destination,
          destinationMessageId: candidate.destinationMessageId,
          ...(candidate.committedLocation ? { location: candidate.committedLocation } : {}),
          preCanonicalRecovery: {
            envelope,
            canonicalDestination: requestedDestination,
          },
        };
        const preExisting = await candidatePort.verify(verificationInput);
        if (!preExisting.found || !preExisting.location) {
          continue;
        }
        try {
          const verifiedLocation = preExisting.location;
          await markRuntimeDeliveryCommittedWithBoundProof({
            journal: this.journal,
            port: candidatePort,
            verificationInput,
            isValidProof: (candidateProof) =>
              candidateProof.found &&
              candidateProof.location !== null &&
              hasSameRuntimeDeliveryLocationIdentity(verifiedLocation, candidateProof.location),
            commit: {
              idempotencyKey: envelope.idempotencyKey,
              runId: envelope.runId,
              teamName: envelope.teamName,
              location: verifiedLocation,
              committedAt: now,
              canonicalRecoveryMigration: {
                recoveryRecords: preCanonicalRecoveryRecords,
                fromMemberName: envelope.fromMemberName,
                payloadHash,
                destination: requestedDestination,
                destinationMessageId: requestedDestinationMessageId,
              },
            },
          });
        } catch (error) {
          if (error instanceof RuntimeDeliveryJournalCommitRevalidationError) {
            continue;
          }
          throw error;
        }
        return {
          ok: true,
          delivered: false,
          reason: 'duplicate_destination_found',
          idempotencyKey: envelope.idempotencyKey,
          location: preExisting.location,
        };
      }

      await this.diagnostics.append({
        type: 'runtime_delivery_conflict',
        providerId: 'opencode',
        teamName: envelope.teamName,
        runId: envelope.runId,
        severity: 'error',
        message:
          'Pre-canonical runtime delivery could not be verified at its persisted destination',
        data: {
          idempotencyKey: envelope.idempotencyKey,
          recoveryDestinations: preCanonicalRecoveryRecords.map((record) => ({
            destination: record.destination,
            destinationMessageId: record.destinationMessageId,
            status: record.status,
          })),
        },
        createdAt: now,
      });
      return {
        ok: false,
        delivered: false,
        reason: 'idempotency_conflict',
        idempotencyKey: envelope.idempotencyKey,
      };
    }

    const verifiedDestinationMessageIds = new Set<string>();
    for (const candidate of [...(begin.recoveryRecords ?? []), begin.record]) {
      if (verifiedDestinationMessageIds.has(candidate.destinationMessageId)) {
        continue;
      }
      verifiedDestinationMessageIds.add(candidate.destinationMessageId);
      const candidatePort = this.destinations.get(candidate.destination.kind);
      const verificationInput: Parameters<RuntimeDeliveryDestinationPort['verify']>[0] = {
        destination: candidate.destination,
        destinationMessageId: candidate.destinationMessageId,
      };
      const preExisting = await candidatePort.verify(verificationInput);
      if (preExisting.found && preExisting.location) {
        const verifiedLocation = preExisting.location;
        try {
          await markRuntimeDeliveryCommittedWithBoundProof({
            journal: this.journal,
            port: candidatePort,
            verificationInput,
            isValidProof: (candidateProof) =>
              candidateProof.found &&
              candidateProof.location !== null &&
              hasSameRuntimeDeliveryLocationIdentity(verifiedLocation, candidateProof.location),
            commit: {
              idempotencyKey: envelope.idempotencyKey,
              runId: envelope.runId,
              teamName: envelope.teamName,
              location: verifiedLocation,
              committedAt: now,
            },
          });
        } catch (error) {
          if (error instanceof RuntimeDeliveryJournalCommitRevalidationError) {
            continue;
          }
          throw error;
        }
        return {
          ok: true,
          delivered: false,
          reason: 'duplicate_destination_found',
          idempotencyKey: envelope.idempotencyKey,
          location: preExisting.location,
        };
      }
    }

    const staleRunBeforeWrite = await this.rejectIfRunIsStale(envelope, {
      markJournalRecordTerminal: true,
    });
    if (staleRunBeforeWrite) {
      return staleRunBeforeWrite;
    }

    try {
      const location = await port.write({ envelope, destinationMessageId });
      const verified = await port.verify({ destination, destinationMessageId, location });
      if (!verified.found) {
        throw new Error(
          `Delivery destination write was not verifiable for ${destinationMessageId}`
        );
      }

      const committedLocation = verified.location ?? location;
      const verificationInput = { destination, destinationMessageId, location: committedLocation };
      await markRuntimeDeliveryCommittedWithBoundProof({
        journal: this.journal,
        port,
        verificationInput,
        isValidProof: (candidateProof) =>
          candidateProof.found &&
          candidateProof.location !== null &&
          hasSameRuntimeDeliveryLocationIdentity(committedLocation, candidateProof.location),
        commit: {
          idempotencyKey: envelope.idempotencyKey,
          runId: envelope.runId,
          teamName: envelope.teamName,
          location: committedLocation,
          committedAt: this.clock().toISOString(),
        },
      });

      await this.emitChangeEventBestEffort(port, envelope, committedLocation);

      return {
        ok: true,
        delivered: true,
        reason: null,
        idempotencyKey: envelope.idempotencyKey,
        location: committedLocation,
      };
    } catch (error) {
      const staleRunAfterDeliveryFailure = await this.rejectIfRunIsStale(envelope, {
        markJournalRecordTerminal: true,
      });
      if (staleRunAfterDeliveryFailure) {
        return staleRunAfterDeliveryFailure;
      }

      if (isCrossTeamIdempotencyConflict(error)) {
        await this.journal.markFailed({
          idempotencyKey: envelope.idempotencyKey,
          runId: envelope.runId,
          teamName: envelope.teamName,
          status: 'failed_terminal',
          error: CROSS_TEAM_IDEMPOTENCY_CONFLICT,
          updatedAt: this.clock().toISOString(),
        });
        await this.diagnostics.append({
          type: 'runtime_delivery_conflict',
          providerId: 'opencode',
          teamName: envelope.teamName,
          runId: envelope.runId,
          severity: 'error',
          message: 'Runtime delivery destination reported an idempotency conflict',
          data: {
            idempotencyKey: envelope.idempotencyKey,
            destination,
            error: stringifyError(error),
          },
          createdAt: this.clock().toISOString(),
        });
        return {
          ok: false,
          delivered: false,
          reason: 'idempotency_conflict',
          idempotencyKey: envelope.idempotencyKey,
        };
      }

      if (!(error instanceof RuntimeDeliveryJournalCommitRevalidationError)) {
        await this.journal.markFailed({
          idempotencyKey: envelope.idempotencyKey,
          runId: envelope.runId,
          teamName: envelope.teamName,
          status: 'failed_retryable',
          error: stringifyError(error),
          updatedAt: this.clock().toISOString(),
        });
      }
      await this.diagnostics.append({
        type: 'runtime_delivery_failed',
        providerId: 'opencode',
        teamName: envelope.teamName,
        runId: envelope.runId,
        severity: 'warning',
        message: 'Runtime delivery failed and remains retryable',
        data: {
          idempotencyKey: envelope.idempotencyKey,
          destination,
          error: stringifyError(error),
        },
        createdAt: this.clock().toISOString(),
      });
      throw error;
    }
  }

  private async rejectIfRunIsStale(
    envelope: RuntimeDeliveryEnvelope,
    options: { markJournalRecordTerminal?: boolean } = {}
  ): Promise<RuntimeDeliveryAck | null> {
    const currentRunId = await this.runState.getCurrentRunId(envelope.teamName);
    if (currentRunId === envelope.runId) {
      return null;
    }

    if (options.markJournalRecordTerminal) {
      await this.journal.markFailed({
        idempotencyKey: envelope.idempotencyKey,
        runId: envelope.runId,
        teamName: envelope.teamName,
        status: 'failed_terminal',
        error: 'stale_run',
        updatedAt: this.clock().toISOString(),
      });
    }

    return {
      ok: false,
      delivered: false,
      reason: 'stale_run',
      idempotencyKey: envelope.idempotencyKey,
    };
  }

  private async emitChangeEventBestEffort(
    port: RuntimeDeliveryDestinationPort,
    envelope: RuntimeDeliveryEnvelope,
    location: RuntimeDeliveryLocation
  ): Promise<void> {
    try {
      const change = port.buildChangeEvent({
        teamName: envelope.teamName,
        location,
      });
      if (change) {
        this.teamChangeEmitter.emit(change);
      }
    } catch (error) {
      try {
        await this.diagnostics.append({
          type: 'runtime_delivery_change_emit_failed',
          providerId: 'opencode',
          teamName: envelope.teamName,
          runId: envelope.runId,
          severity: 'warning',
          message: 'Runtime delivery committed but change event emission failed',
          data: {
            idempotencyKey: envelope.idempotencyKey,
            location,
            error: stringifyError(error),
          },
          createdAt: this.clock().toISOString(),
        });
      } catch {
        // Delivery is already committed; diagnostics emission is also best-effort here.
      }
    }
  }
}

async function serializeRuntimeDelivery<T>(
  envelope: RuntimeDeliveryEnvelope,
  operation: () => Promise<T>
): Promise<T> {
  const key = JSON.stringify([envelope.teamName, envelope.idempotencyKey]);
  const previousTurn = runtimeDeliveryTurns.get(key) ?? Promise.resolve();
  let releaseTurn = (): void => {};
  const currentTurn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  runtimeDeliveryTurns.set(key, currentTurn);

  await previousTurn;
  try {
    return await operation();
  } finally {
    releaseTurn();
    if (runtimeDeliveryTurns.get(key) === currentTurn) {
      runtimeDeliveryTurns.delete(key);
    }
  }
}

export class RuntimeDeliveryReconciler {
  constructor(
    private readonly journal: RuntimeDeliveryJournalStore,
    private readonly destinations: RuntimeDeliveryDestinationRegistry,
    private readonly diagnostics: RuntimeDeliveryDiagnosticsSink,
    private readonly clock: () => Date = () => new Date(),
    private readonly recordCanonicalizer?: RuntimeDeliveryJournalRecordCanonicalizer
  ) {}

  async reconcileTeam(teamName: string): Promise<void> {
    const records = await this.journal.listRecoverable(teamName);
    for (const record of records) {
      await this.reconcileRecord(record);
    }
  }

  private async reconcileRecord(record: RuntimeDeliveryJournalRecord): Promise<void> {
    const canonicalRecord = this.recordCanonicalizer
      ? await this.recordCanonicalizer.canonicalize(record)
      : record;
    assertSameRuntimeDeliveryJournalIdentity(record, canonicalRecord);
    const identityWasCanonicalized = hasCanonicalRuntimeDeliveryIdentityChange(
      record,
      canonicalRecord
    );
    const port = this.destinations.get(canonicalRecord.destination.kind);
    const verificationInput: Parameters<RuntimeDeliveryDestinationPort['verify']>[0] = {
      destination: canonicalRecord.destination,
      destinationMessageId: canonicalRecord.destinationMessageId,
      ...(canonicalRecord.committedLocation ? { location: canonicalRecord.committedLocation } : {}),
      ...(identityWasCanonicalized ? { includeRecoveryEvidence: true } : {}),
    };
    const verified = await port.verify(verificationInput);
    const canonicalRecoveryMigration = identityWasCanonicalized
      ? deriveCanonicalRecoveryMigration(record, canonicalRecord, verified.recoveryEvidence)
      : null;
    const recoveryDiagnostics = [...verified.diagnostics];

    if (
      verified.found &&
      verified.location &&
      (!identityWasCanonicalized || canonicalRecoveryMigration !== null)
    ) {
      const verifiedLocation = verified.location;
      try {
        const commit = {
          idempotencyKey: canonicalRecord.idempotencyKey,
          runId: canonicalRecord.runId,
          teamName: canonicalRecord.teamName,
          location: verifiedLocation,
          committedAt: this.clock().toISOString(),
          ...(canonicalRecoveryMigration ? { canonicalRecoveryMigration } : {}),
        };
        await markRuntimeDeliveryCommittedWithBoundProof({
          journal: this.journal,
          port,
          verificationInput,
          isValidProof: (candidateProof) => {
            if (
              !candidateProof.found ||
              candidateProof.location === null ||
              !hasSameRuntimeDeliveryLocationIdentity(verifiedLocation, candidateProof.location)
            ) {
              return false;
            }
            if (!identityWasCanonicalized) {
              return true;
            }
            const candidateMigration = deriveCanonicalRecoveryMigration(
              record,
              canonicalRecord,
              candidateProof.recoveryEvidence
            );
            return (
              candidateMigration !== null &&
              canonicalRecoveryMigration !== null &&
              hasSameCanonicalRecoveryMigration(candidateMigration, canonicalRecoveryMigration)
            );
          },
          commit,
        });
        return;
      } catch (error) {
        if (!(error instanceof RuntimeDeliveryJournalCommitRevalidationError)) {
          throw error;
        }
        recoveryDiagnostics.push(error.message);
      }
    }

    await this.diagnostics.append({
      type: 'runtime_delivery_recovery_needed',
      providerId: 'opencode',
      teamName: canonicalRecord.teamName,
      runId: canonicalRecord.runId,
      severity: 'warning',
      message: `Runtime delivery ${canonicalRecord.idempotencyKey} is pending and destination write is not visible`,
      data: {
        destination: canonicalRecord.destination,
        attempts: canonicalRecord.attempts,
        lastError: canonicalRecord.lastError,
        diagnostics: recoveryDiagnostics,
        ...(identityWasCanonicalized && canonicalRecoveryMigration === null
          ? { canonicalRecoveryEvidenceInvalid: true }
          : {}),
      },
      createdAt: this.clock().toISOString(),
    });
  }
}

async function markRuntimeDeliveryCommittedWithBoundProof(input: {
  journal: RuntimeDeliveryJournalStore;
  port: RuntimeDeliveryDestinationPort;
  verificationInput: Parameters<RuntimeDeliveryDestinationPort['verify']>[0];
  isValidProof: (proof: RuntimeDeliveryVerifyResult) => boolean;
  commit: Parameters<RuntimeDeliveryJournalStore['markCommitted']>[0];
}): Promise<void> {
  // Every commit uses a fail-closed compare/revalidation contract: the destination proof must
  // match immediately before the journal CAS and again after persistence. If the postcheck fails,
  // the journal restores the exact pre-commit logical lineage. Destination callbacks never run
  // while the journal lock is held, avoiding cross-store lock inversion.
  const preCommitProof = await input.port.verify(input.verificationInput).catch(() => null);
  if (!preCommitProof || !input.isValidProof(preCommitProof)) {
    throw new RuntimeDeliveryJournalCommitRevalidationError();
  }

  const journalCommit = await input.journal.markCommitted(input.commit);
  const postCommitProof = await input.port.verify(input.verificationInput).catch(() => null);
  if (postCommitProof && input.isValidProof(postCommitProof)) {
    return;
  }

  await journalCommit.rollback();
  throw new RuntimeDeliveryJournalCommitRevalidationError();
}

function deriveCanonicalRecoveryMigration(
  record: RuntimeDeliveryJournalRecord,
  canonicalRecord: RuntimeDeliveryJournalRecord,
  evidence: RuntimeDeliveryRecoveryEvidence | undefined
): RuntimeDeliveryCanonicalRecoveryMigration | null {
  if (
    !evidence ||
    record.logicalPayloadHash === null ||
    evidence.fromMemberName.trim().toLowerCase() !== record.fromMemberName.trim().toLowerCase() ||
    evidence.runtimeSessionId !== record.runtimeSessionId
  ) {
    return null;
  }

  try {
    const persistedEnvelope = normalizeRuntimeDeliveryEnvelope({
      idempotencyKey: record.idempotencyKey,
      runId: record.runId,
      teamName: record.teamName,
      fromMemberName: record.fromMemberName,
      providerId: record.providerId,
      runtimeSessionId: record.runtimeSessionId,
      to: getRuntimeDeliveryTarget(record.destination),
      text: evidence.text,
      createdAt: evidence.createdAt,
      summary: evidence.summary,
      ...(evidence.taskRefs ? { taskRefs: evidence.taskRefs } : {}),
    });
    if (hashRuntimeDeliveryEnvelope(persistedEnvelope) !== record.logicalPayloadHash) {
      return null;
    }
    const canonicalEnvelope = normalizeRuntimeDeliveryEnvelope({
      ...persistedEnvelope,
      fromMemberName: canonicalRecord.fromMemberName,
      to: getRuntimeDeliveryTarget(canonicalRecord.destination),
    });
    return {
      recoveryRecords: [record],
      fromMemberName: canonicalEnvelope.fromMemberName,
      payloadHash: hashRuntimeDeliveryEnvelope(canonicalEnvelope),
      destination: canonicalRecord.destination,
      destinationMessageId: canonicalRecord.destinationMessageId,
    };
  } catch {
    return null;
  }
}

function hasSameCanonicalRecoveryMigration(
  left: RuntimeDeliveryCanonicalRecoveryMigration,
  right: RuntimeDeliveryCanonicalRecoveryMigration
): boolean {
  return (
    left.payloadHash === right.payloadHash &&
    left.fromMemberName === right.fromMemberName &&
    hasSameRuntimeDeliveryDestinationIdentity(left.destination, right.destination) &&
    left.destinationMessageId === right.destinationMessageId
  );
}

// eslint-disable-next-line sonarjs/function-return-type -- destination kinds map to the target union by design
function getRuntimeDeliveryTarget(
  destination: RuntimeDeliveryDestinationRef
): RuntimeDeliveryEnvelope['to'] {
  switch (destination.kind) {
    case 'user_sent_messages':
      return 'user';
    case 'member_inbox':
      return { memberName: destination.memberName };
    case 'cross_team_outbox':
      return { teamName: destination.toTeamName, memberName: destination.toMemberName };
  }
}

function hasCanonicalRuntimeDeliveryIdentityChange(
  record: RuntimeDeliveryJournalRecord,
  canonicalRecord: RuntimeDeliveryJournalRecord
): boolean {
  return (
    record.fromMemberName !== canonicalRecord.fromMemberName ||
    !hasSameRuntimeDeliveryDestinationIdentity(record.destination, canonicalRecord.destination)
  );
}

function hasSameRuntimeDeliveryLocationIdentity(
  left: RuntimeDeliveryLocation,
  right: RuntimeDeliveryLocation
): boolean {
  if (left.kind !== right.kind || left.messageId !== right.messageId) {
    return false;
  }
  if (left.kind === 'user_sent_messages' && right.kind === 'user_sent_messages') {
    return left.teamName === right.teamName;
  }
  if (left.kind === 'member_inbox' && right.kind === 'member_inbox') {
    return left.teamName === right.teamName && left.memberName === right.memberName;
  }
  return (
    left.kind === 'cross_team_outbox' &&
    right.kind === 'cross_team_outbox' &&
    left.fromTeamName === right.fromTeamName &&
    left.toTeamName === right.toTeamName &&
    left.toMemberName === right.toMemberName
  );
}

function hasSameRuntimeDeliveryDestinationIdentity(
  left: RuntimeDeliveryDestinationRef,
  right: RuntimeDeliveryDestinationRef
): boolean {
  if (left.kind === 'user_sent_messages' && right.kind === 'user_sent_messages') {
    return left.teamName === right.teamName;
  }
  if (left.kind === 'member_inbox' && right.kind === 'member_inbox') {
    return left.teamName === right.teamName && left.memberName === right.memberName;
  }
  return (
    left.kind === 'cross_team_outbox' &&
    right.kind === 'cross_team_outbox' &&
    left.fromTeamName === right.fromTeamName &&
    left.toTeamName === right.toTeamName &&
    left.toMemberName === right.toMemberName
  );
}

function assertSameRuntimeDeliveryJournalIdentity(
  record: RuntimeDeliveryJournalRecord,
  canonicalRecord: RuntimeDeliveryJournalRecord
): void {
  if (
    canonicalRecord.idempotencyKey !== record.idempotencyKey ||
    canonicalRecord.runId !== record.runId ||
    canonicalRecord.teamName !== record.teamName ||
    canonicalRecord.providerId !== record.providerId ||
    canonicalRecord.runtimeSessionId !== record.runtimeSessionId ||
    canonicalRecord.payloadHash !== record.payloadHash ||
    canonicalRecord.logicalPayloadHash !== record.logicalPayloadHash ||
    canonicalRecord.destinationMessageId !== record.destinationMessageId ||
    canonicalRecord.status !== record.status ||
    !hasSameRuntimeDeliveryDestinationScope(record.destination, canonicalRecord.destination) ||
    !hasSameRuntimeDeliveryLocationScope(
      record.committedLocation,
      canonicalRecord.committedLocation
    )
  ) {
    throw new Error('Runtime delivery journal canonicalizer changed immutable record identity');
  }
}

function hasSameRuntimeDeliveryDestinationScope(
  left: RuntimeDeliveryDestinationRef,
  right: RuntimeDeliveryDestinationRef
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'user_sent_messages' && right.kind === 'user_sent_messages') {
    return left.teamName === right.teamName;
  }
  if (left.kind === 'member_inbox' && right.kind === 'member_inbox') {
    return left.teamName === right.teamName;
  }
  return (
    left.kind === 'cross_team_outbox' &&
    right.kind === 'cross_team_outbox' &&
    left.fromTeamName === right.fromTeamName &&
    left.toTeamName === right.toTeamName
  );
}

function hasSameRuntimeDeliveryLocationScope(
  left: RuntimeDeliveryLocation | null,
  right: RuntimeDeliveryLocation | null
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  if (left.kind !== right.kind || left.messageId !== right.messageId) {
    return false;
  }
  if (left.kind === 'user_sent_messages' && right.kind === 'user_sent_messages') {
    return left.teamName === right.teamName;
  }
  if (left.kind === 'member_inbox' && right.kind === 'member_inbox') {
    return left.teamName === right.teamName;
  }
  return (
    left.kind === 'cross_team_outbox' &&
    right.kind === 'cross_team_outbox' &&
    left.fromTeamName === right.fromTeamName &&
    left.toTeamName === right.toTeamName
  );
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCrossTeamIdempotencyConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const structuredError = error as { code?: unknown; name?: unknown; message?: unknown };
  return [structuredError.code, structuredError.name, structuredError.message].some(
    (value) => value === CROSS_TEAM_IDEMPOTENCY_CONFLICT
  );
}
