import {
  buildLocationFromJournal,
  buildRuntimeDestinationMessageId,
  hashRuntimeDeliveryEnvelope,
  hashRuntimeDeliveryEnvelopeLegacyTaskRefs,
  normalizeRuntimeDeliveryEnvelope,
  resolveRuntimeDeliveryDestination,
  type RuntimeDeliveryDestinationRef,
  type RuntimeDeliveryEnvelope,
  type RuntimeDeliveryJournalRecord,
  type RuntimeDeliveryLocation,
} from './RuntimeDeliveryJournal';

import type { RuntimeDeliveryJournalStore } from './RuntimeDeliveryJournal';

export interface RuntimeDeliveryVerifyResult {
  found: boolean;
  location: RuntimeDeliveryLocation | null;
  diagnostics: string[];
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
    private readonly clock: () => Date = () => new Date()
  ) {}

  async deliver(raw: unknown): Promise<RuntimeDeliveryAck> {
    const envelope = normalizeRuntimeDeliveryEnvelope(raw);
    return await serializeRuntimeDelivery(envelope, () => this.deliverEnvelope(envelope));
  }

  private async deliverEnvelope(envelope: RuntimeDeliveryEnvelope): Promise<RuntimeDeliveryAck> {
    const now = this.clock().toISOString();
    const staleRun = await this.rejectIfRunIsStale(envelope);
    if (staleRun) {
      return staleRun;
    }

    const requestedDestination = resolveRuntimeDeliveryDestination(envelope);
    const requestedDestinationMessageId = buildRuntimeDestinationMessageId(envelope);
    const payloadHash = hashRuntimeDeliveryEnvelope(envelope);
    const legacyPayloadHash = hashRuntimeDeliveryEnvelopeLegacyTaskRefs(envelope);
    const begin = await this.journal.begin({
      idempotencyKey: envelope.idempotencyKey,
      payloadHash,
      ...(legacyPayloadHash ? { compatiblePayloadHashes: [legacyPayloadHash] } : {}),
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
          existingPayloadHash: begin.record.payloadHash,
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
    const verifiedDestinationMessageIds = new Set<string>();
    for (const candidate of [...(begin.recoveryRecords ?? []), begin.record]) {
      if (verifiedDestinationMessageIds.has(candidate.destinationMessageId)) {
        continue;
      }
      verifiedDestinationMessageIds.add(candidate.destinationMessageId);
      const candidatePort = this.destinations.get(candidate.destination.kind);
      const preExisting = await candidatePort.verify({
        destination: candidate.destination,
        destinationMessageId: candidate.destinationMessageId,
      });
      if (preExisting.found && preExisting.location) {
        await this.journal.markCommitted({
          idempotencyKey: envelope.idempotencyKey,
          runId: envelope.runId,
          teamName: envelope.teamName,
          location: preExisting.location,
          committedAt: now,
        });
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
      await this.journal.markCommitted({
        idempotencyKey: envelope.idempotencyKey,
        runId: envelope.runId,
        teamName: envelope.teamName,
        location: committedLocation,
        committedAt: this.clock().toISOString(),
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

      await this.journal.markFailed({
        idempotencyKey: envelope.idempotencyKey,
        runId: envelope.runId,
        teamName: envelope.teamName,
        status: 'failed_retryable',
        error: stringifyError(error),
        updatedAt: this.clock().toISOString(),
      });
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
    private readonly clock: () => Date = () => new Date()
  ) {}

  async reconcileTeam(teamName: string): Promise<void> {
    const records = await this.journal.listRecoverable(teamName);
    for (const record of records) {
      await this.reconcileRecord(record);
    }
  }

  private async reconcileRecord(record: RuntimeDeliveryJournalRecord): Promise<void> {
    const port = this.destinations.get(record.destination.kind);
    const verified = await port.verify({
      destination: record.destination,
      destinationMessageId: record.destinationMessageId,
    });

    if (verified.found && verified.location) {
      await this.journal.markCommitted({
        idempotencyKey: record.idempotencyKey,
        runId: record.runId,
        teamName: record.teamName,
        location: verified.location,
        committedAt: this.clock().toISOString(),
      });
      return;
    }

    await this.diagnostics.append({
      type: 'runtime_delivery_recovery_needed',
      providerId: 'opencode',
      teamName: record.teamName,
      runId: record.runId,
      severity: 'warning',
      message: `Runtime delivery ${record.idempotencyKey} is pending and destination write is not visible`,
      data: {
        destination: record.destination,
        attempts: record.attempts,
        lastError: record.lastError,
      },
      createdAt: this.clock().toISOString(),
    });
  }
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
