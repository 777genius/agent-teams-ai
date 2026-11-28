import {
  importRequestSchema,
  stoppedImportReceiptSchema,
} from '@agent-teams/legacy-agent-host/stopped-team-import';

import {
  assertBackendRequestGuard,
  BackendRoutingError,
  captureBackendPayload,
} from '../../application/backendBinding';

import type { BackendOwnerBinding, BackendRequestGuard } from '../../application/backendBinding';
import type { CapturedHostClient } from '../CapturedHostClient';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';
import type { StoppedTeamImportRequest } from '@agent-teams/legacy-agent-host/stopped-team-import';

/** Original captured owner only. Queries never start an import or re-export the source. */
export class CapturedStoppedTeamImport {
  constructor(
    private readonly options: {
      owner: BackendOwnerBinding;
      client: Pick<CapturedHostClient, 'request'>;
      start(): Promise<unknown>;
      available(): boolean;
    }
  ) {}
  private async request(
    method: 'publish' | 'lookup' | 'retry' | 'list',
    commandId: string,
    payload: unknown,
    guard?: BackendRequestGuard
  ) {
    const captured = captureBackendPayload(payload);
    this.current(guard);
    await this.options.start();
    this.current(guard);
    const result = await this.options.client.request(
      `team.import.${method}`,
      { owner: this.options.owner as unknown as JsonValue, commandId, payload: captured },
      { control: method === 'lookup' || method === 'list' }
    );
    this.current(guard, 'unknown');
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.ok !== true)
      throw new BackendRoutingError(
        'hold',
        method === 'lookup' || method === 'list' ? 'not-dispatched' : 'unknown'
      );
    return result.value;
  }
  private current(
    guard?: BackendRequestGuard,
    outcome: 'not-dispatched' | 'unknown' = 'not-dispatched'
  ) {
    if (!this.options.available()) throw new BackendRoutingError('unavailable', outcome);
    assertBackendRequestGuard(guard, outcome);
  }
  async publish(commandId: string, request: StoppedTeamImportRequest, guard?: BackendRequestGuard) {
    const captured = importRequestSchema.parse(structuredClone(request));
    const receipt = stoppedImportReceiptSchema.parse(
      await this.request('publish', commandId, captured, guard)
    );
    if (
      receipt.commandId !== commandId ||
      receipt.record.contextId !== captured.contextId ||
      receipt.record.teamName !== captured.teamName ||
      receipt.source.sourceId !== captured.sourceId ||
      receipt.source.snapshotDigest !== captured.snapshotDigest
    )
      throw new BackendRoutingError('hold', 'unknown');
    return receipt;
  }
  async lookup(commandId: string, contextId: string, guard?: BackendRequestGuard) {
    const result = await this.request('lookup', commandId, { contextId }, guard);
    const receipt = result === null ? null : stoppedImportReceiptSchema.parse(result);
    if (receipt && (receipt.commandId !== commandId || receipt.record.contextId !== contextId))
      throw new BackendRoutingError('hold');
    return receipt;
  }
  async retry(commandId: string, request: StoppedTeamImportRequest, guard?: BackendRequestGuard) {
    const result = await this.request(
      'retry',
      commandId,
      importRequestSchema.parse(structuredClone(request)),
      guard
    );
    const receipt = result === null ? null : stoppedImportReceiptSchema.parse(result);
    if (
      receipt &&
      (receipt.commandId !== commandId ||
        receipt.record.contextId !== request.contextId ||
        receipt.record.teamName !== request.teamName ||
        receipt.source.sourceId !== request.sourceId ||
        receipt.source.snapshotDigest !== request.snapshotDigest)
    )
      throw new BackendRoutingError('hold', 'unknown');
    return receipt;
  }
  async list(queryId: string, contextId: string, guard?: BackendRequestGuard) {
    const result = await this.request('list', queryId, { contextId }, guard);
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      !Array.isArray(result.entries) ||
      result.entries.length > 256
    )
      throw new BackendRoutingError('hold');
    const entries = result.entries.map((entry) => stoppedImportReceiptSchema.parse(entry));
    if (entries.some((entry) => entry.record.contextId !== contextId))
      throw new BackendRoutingError('hold');
    return entries;
  }
}
