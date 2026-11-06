import { randomUUID } from 'node:crypto';

import { BackendRoutingError } from '@features/agent-backend/main';
import { FORCED_TOKEN_REFRESH_REUSE_WINDOW_MS } from '@features/codex-account/main';

import { managementValue } from './capturedManagementCatalog';

import type {
  CodexAuthIntent,
  CodexAuthIntentStore,
} from '../../infrastructure/FileCodexAuthIntentStore';
import type { CaptureCodexMetadata } from './capturedCodexMetadata';
import type { CapturedProviderManagement } from '@features/agent-backend/main';

const held = () =>
  new Error(
    'Unable to confirm the original Codex account change. Its intent was retained; no new auth command was started.'
  );
// These exact Host command errors are emitted before journal admission/effects. Unknown
// transport responses and held outcomes retain the original intent for lookup-only recovery.
function knownPreAdmissionRefusal(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const result = raw as Record<string, unknown>;
  return (
    result.ok === false &&
    ['busy', 'invalid', 'conflict'].includes(String(result.code)) &&
    Object.keys(result).length === 2
  );
}
function completed(
  raw: unknown,
  target: CapturedProviderManagement,
  intent: CodexAuthIntent
): boolean {
  const value = managementValue(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw held();
  const receipt = value as Record<string, unknown>;
  if (
    receipt.commandId !== intent.commandId ||
    receipt.profileId !== target.profileId ||
    receipt.configRevision !== target.configRevision ||
    receipt.providerId !== 'codex' ||
    receipt.kind !== intent.kind ||
    !['completed', 'held'].includes(String(receipt.phase)) ||
    Object.keys(receipt).some(
      (key) =>
        !['commandId', 'profileId', 'configRevision', 'providerId', 'kind', 'phase'].includes(key)
    )
  )
    throw held();
  return receipt.phase === 'completed';
}

/** Auth effects use a durable original target/id; metadata refresh never reselects a foreground profile. */
export class CapturedCodexAuthCommands {
  private readonly active = new Map<
    string,
    { kind: CodexAuthIntent['kind']; promise: Promise<CapturedProviderManagement> }
  >();
  constructor(
    private readonly capture: CaptureCodexMetadata,
    private readonly intents: CodexAuthIntentStore
  ) {}

  async execute(kind: CodexAuthIntent['kind']): Promise<CapturedProviderManagement> {
    const target = await this.capture(null);
    const running = this.active.get(target.targetId);
    if (running) {
      if (running.kind !== kind)
        throw new Error('Another change to this Codex account is still in progress.');
      return running.promise;
    }
    const promise = this.perform(target, kind);
    const entry = { kind, promise };
    this.active.set(target.targetId, entry);
    try {
      return await promise;
    } finally {
      if (this.active.get(target.targetId) === entry) this.active.delete(target.targetId);
    }
  }

  private async perform(
    target: CapturedProviderManagement,
    kind: CodexAuthIntent['kind']
  ): Promise<CapturedProviderManagement> {
    let rejectedBeforeAdmission = false;
    try {
      const previous = await this.intents.read(target.targetId);
      if (previous) {
        if (previous.targetId !== target.targetId) throw held();
        const result = await target.request('credential.lookup', { commandId: previous.commandId });
        if (!completed(result, target, previous)) throw held();
        await this.intents.retire(previous);
        if (previous.kind === kind) return target; // Recover the original result, never resubmit it.
      }
      const intent: CodexAuthIntent = {
        schemaVersion: 1,
        commandId: 'codex-auth-' + randomUUID(),
        targetId: target.targetId,
        kind,
      };
      if (!(await this.intents.create(intent))) throw held();
      let result: unknown;
      try {
        result = await target.request('credential', {
          commandId: intent.commandId,
          kind,
          providerId: 'codex',
          ...(kind === 'credential.refresh'
            ? { reuseWindowMs: FORCED_TOKEN_REFRESH_REUSE_WINDOW_MS }
            : {}),
        });
      } catch (error) {
        if (error instanceof BackendRoutingError && error.outcome === 'not-dispatched')
          await this.intents.retire(intent);
        throw held();
      }
      if (knownPreAdmissionRefusal(result)) {
        await this.intents.retire(intent);
        rejectedBeforeAdmission = true;
        throw held();
      }
      if (!completed(result, target, intent)) throw held();
      await this.intents.retire(intent);
      return target;
    } catch {
      if (rejectedBeforeAdmission)
        throw new Error(
          'The Codex account change was rejected before it started. Try again after the active account operation finishes.'
        );
      throw held();
    }
  }
}
