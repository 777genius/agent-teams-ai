import {
  ApplicationCommandFailureKind,
  type ApplicationCommandJsonValue,
  type ApplicationCommandLedgerRecord,
  ApplicationCommandLedgerStatus,
  type ApplicationCommandRunner,
} from '@features/application-command-ledger';
import { KeyedMutex } from '@features/internal-storage/main';

import { parseBackendOperation } from '../adapters/input/validateBackendOperation';
import { assertBackendRequestGuard, BackendRoutingError } from '../application/backendBinding';

import type { BackendOperationRequest, BackendOperationResult } from '../../contracts/operations';
import type { BackendRequestGuard } from '../application/backendBinding';

type Replacement = Extract<BackendOperationRequest, { operation: 'team.roster.replace' }>;
type Dispatch = (request: BackendOperationRequest) => Promise<BackendOperationResult>;
const namespace = 'captured-team-roster';
const uncertain = () => new BackendRoutingError('hold', 'unknown');
const json = (value: unknown): ApplicationCommandJsonValue => JSON.parse(JSON.stringify(value));
class RosterRefusal extends Error {
  constructor(readonly result: Extract<BackendOperationResult, { ok: false }>) {
    super('Original roster change was not confirmed');
  }
}

/** Existing Main ledger retains only this roster intent; Host remains the authoritative writer. */
export class CapturedRosterCommands {
  private readonly fence = new KeyedMutex();

  constructor(private readonly getRunner: () => ApplicationCommandRunner | null) {}

  invoke(
    request: BackendOperationRequest,
    guard: BackendRequestGuard | undefined,
    dispatch: Dispatch
  ) {
    return this.fence.run(request.handle.handleId, async () => {
      const current = () => assertBackendRequestGuard(guard, 'unknown');
      current();
      const runner = this.getRunner();
      if (!runner) {
        if (request.operation === 'team.roster.read') return dispatch(request);
        throw new BackendRoutingError('unavailable');
      }
      const records = await runner.readScope(namespace, request.handle.handleId);
      current();
      const unresolved = records.filter(
        (row) =>
          row.status === ApplicationCommandLedgerStatus.Started ||
          row.status === ApplicationCommandLedgerStatus.UnknownAfterTimeout
      );
      if (unresolved.length > 1) throw uncertain();
      if (request.operation === 'team.roster.read') {
        for (const record of unresolved) {
          const original = this.original(record, request.handle.handleId);
          await this.run(runner, original, record, current, dispatch);
        }
        current();
        return dispatch(request);
      }
      if (request.operation !== 'team.roster.replace') throw uncertain();
      const original = unresolved[0];
      // A replacement ID cannot conceal a previous uncertain save, even after renderer reload.
      if (original && original.commandId !== request.commandId) throw uncertain();
      const retained = records.find((row) => row.commandId === request.commandId);
      return this.run(runner, request, retained, current, dispatch);
    });
  }

  private original(record: ApplicationCommandLedgerRecord, handleId: string): Replacement {
    let request: BackendOperationRequest;
    try {
      request = parseBackendOperation(JSON.parse(record.metadataJson ?? 'null'));
    } catch {
      throw uncertain();
    }
    if (
      request.operation !== 'team.roster.replace' ||
      request.handle.handleId !== handleId ||
      request.commandId !== record.commandId ||
      record.operation !== request.operation
    )
      throw uncertain();
    return request;
  }

  private async run(
    runner: ApplicationCommandRunner,
    request: Replacement,
    retained: ApplicationCommandLedgerRecord | undefined,
    current: () => void,
    dispatch: Dispatch
  ): Promise<BackendOperationResult> {
    const receipt = (result: BackendOperationResult) => {
      current();
      if (!result.ok) throw new RosterRefusal(result);
      const value = result.value;
      if (
        !value ||
        !('commandId' in value) ||
        value.commandId !== request.commandId ||
        !('revision' in value) ||
        typeof value.revision !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.revision)
      )
        throw uncertain();
      return { commandId: value.commandId, revision: value.revision };
    };
    const lookup = async () => {
      current();
      return receipt(
        await dispatch({
          handle: { ...request.handle },
          commandId: request.commandId,
          operation: 'team.roster.lookup',
          payload: { expected: structuredClone(request.payload) },
        })
      );
    };
    // Cached Main completion is not current permission to reveal a Host outcome.
    let confirmed =
      retained?.status === ApplicationCommandLedgerStatus.Completed ? await lookup() : undefined;
    current();
    try {
      await runner.run(
        {
          namespace,
          scopeKey: request.handle.handleId,
          commandId: request.commandId,
          idempotencyKey: request.commandId,
          operation: request.operation,
          payload: json(request),
          metadata: json(request),
          startedStaleAfterMs: 1,
          classifyError: (error) => ({
            failureKind:
              error instanceof RosterRefusal && error.result.outcome !== 'unknown'
                ? ApplicationCommandFailureKind.Terminal
                : ApplicationCommandFailureKind.UnknownAfterTimeout,
            message: 'Original roster change was not confirmed',
          }),
          reconcile: async () => {
            try {
              confirmed = await lookup();
              return { outcome: 'applied', result: confirmed };
            } catch {
              return { outcome: 'unknown' };
            }
          },
        },
        async () => {
          // An existing intent is lookup-only: no timeout or missing receipt permits redispatch.
          if (retained) throw uncertain();
          current();
          confirmed = receipt(await dispatch(structuredClone(request)));
          return confirmed;
        }
      );
      current();
      if (!confirmed) throw uncertain();
      return { ok: true, value: confirmed };
    } catch (error) {
      current();
      if (error instanceof RosterRefusal && error.result.outcome !== 'unknown') return error.result;
      throw uncertain();
    }
  }
}
