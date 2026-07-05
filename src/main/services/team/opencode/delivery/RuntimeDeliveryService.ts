import {
  buildLocationFromJournal,
  buildRuntimeDestinationMessageId,
  hashRuntimeDeliveryEnvelope,
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
    | 'runtime_delivery_recovery_needed';
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
    const now = this.clock().toISOString();
    const currentRunId = await this.runState.getCurrentRunId(envelope.teamName);
    if (currentRunId !== envelope.runId) {
      return {
        ok: false,
        delivered: false,
        reason: 'stale_run',
        idempotencyKey: envelope.idempotencyKey,
      };
    }

    const destination = resolveRuntimeDeliveryDestination(envelope);
    const destinationMessageId = buildRuntimeDestinationMessageId(envelope);
    const payloadHash = hashRuntimeDeliveryEnvelope(envelope);
    const begin = await this.journal.begin({
      idempotencyKey: envelope.idempotencyKey,
      payloadHash,
      runId: envelope.runId,
      teamName: envelope.teamName,
      fromMemberName: envelope.fromMemberName,
      providerId: envelope.providerId,
      runtimeSessionId: envelope.runtimeSessionId,
      destination,
      destinationMessageId,
      now,
    });

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

    const port = this.destinations.get(destination.kind);
    const preExisting = await port.verify({ destination, destinationMessageId });
    if (preExisting.found && preExisting.location) {
      await this.journal.markCommitted({
        idempotencyKey: envelope.idempotencyKey,
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

    try {
      const location = await port.write({ envelope, destinationMessageId });
      const verified = await port.verify({ destination, destinationMessageId });
      if (!verified.found) {
        throw new Error(
          `Delivery destination write was not verifiable for ${destinationMessageId}`
        );
      }

      const committedLocation = verified.location ?? location;
      await this.journal.markCommitted({
        idempotencyKey: envelope.idempotencyKey,
        location: committedLocation,
        committedAt: this.clock().toISOString(),
      });

      const change = port.buildChangeEvent({
        teamName: envelope.teamName,
        location: committedLocation,
      });
      if (change) {
        this.teamChangeEmitter.emit(change);
      }

      return {
        ok: true,
        delivered: true,
        reason: null,
        idempotencyKey: envelope.idempotencyKey,
        location: committedLocation,
      };
    } catch (error) {
      await this.journal.markFailed({
        idempotencyKey: envelope.idempotencyKey,
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
