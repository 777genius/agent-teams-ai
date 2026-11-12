import { createHash, randomUUID } from 'node:crypto';

import { managementValue } from './capturedManagementCatalog';

import type { ProviderCredentialReceipt } from '@agent-teams/legacy-agent-host/management/contracts';
import type { CapturedProviderManagement } from '@features/agent-backend/main';

interface CredentialInput {
  providerId: string;
  kind: 'credential.set' | 'credential.forget';
  key?: string;
  metadata?: Record<string, string>;
}
interface AuthSelection { authMethodIndex?: number | null; authOptionId?: string | null }

export class CapturedCredentialVerificationRejected extends Error {}

function receipt(
  raw: unknown,
  target: CapturedProviderManagement,
  input: CredentialInput,
  commandId?: string
): ProviderCredentialReceipt {
  const value = managementValue(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !('commandId' in value) || typeof value.commandId !== 'string' || !value.commandId || value.commandId.length > 256 ||
      commandId !== undefined && value.commandId !== commandId ||
      !('profileId' in value) || value.profileId !== target.profileId ||
      !('configRevision' in value) || value.configRevision !== target.configRevision ||
      !('providerId' in value) || value.providerId !== input.providerId ||
      !('kind' in value) || value.kind !== input.kind ||
      !('phase' in value) || !['completed', 'held'].includes(String(value.phase)))
    throw new Error('Original credential receipt unavailable');
  return value as ProviderCredentialReceipt;
}

/** Main retains transport routing only. The existing Host ledger owns every durable credential intent. */
export class CapturedProviderCredentials {
  private readonly active = new Map<string, { fingerprint: string; result: Promise<void> }>();

  execute(target: CapturedProviderManagement, input: CredentialInput, selection: AuthSelection = {}): Promise<void> {
    const captured = { ...input, ...(input.metadata ? { metadata: { ...input.metadata } } : {}) };
    const authSelection = { ...selection };
    const owner = target.targetId + ':' + captured.providerId;
    const fingerprint = createHash('sha256').update(JSON.stringify([captured, authSelection])).digest('hex');
    const active = this.active.get(owner);
    if (active) {
      if (active.fingerprint !== fingerprint) return Promise.reject(new Error('Original credential intent conflicts'));
      return active.result;
    }
    const result = this.run(target, captured, authSelection);
    this.active.set(owner, { fingerprint, result });
    void result.finally(() => {
      if (this.active.get(owner)?.result === result) this.active.delete(owner);
    }).catch(() => {});
    return result;
  }

  private async run(target: CapturedProviderManagement, input: CredentialInput, selection: AuthSelection): Promise<void> {
    const pending = managementValue(await target.request('credential.pending', { providerId: input.providerId }));
    if (!pending || typeof pending !== 'object' || Array.isArray(pending) ||
        !('generation' in pending) || !['v1', 'v2'].includes(String(pending.generation)) ||
        !('receipt' in pending)) throw new Error('Original credential owner unavailable');
    if (pending.generation === 'v2' && (input.kind !== 'credential.set' || input.metadata && Object.keys(input.metadata).length ||
        selection.authMethodIndex != null || selection.authOptionId != null && selection.authOptionId !== 'api:native'))
      throw new Error('This OpenCode V2 credential action is unavailable');
    let commandId: string = randomUUID();
    const retained = pending.receipt !== null;
    if (retained) commandId = receipt({ ok: true, value: pending.receipt }, target, input).commandId;
    let raw: unknown;
    try {
      // Existing intent checks the submitted fingerprint and only reads its original
      // receipt. A new UUID reaches native work only after the Host durably claims it.
      raw = await target.request(retained ? 'credential.resume' : 'credential', { ...input, commandId });
    } catch {
      // A transport failure is neither rejection nor permission to submit another key.
      raw = await target.request('credential.resume', { ...input, commandId });
    }
    const result = receipt(raw, target, input, commandId);
    if (result.phase === 'held' && result.reason === 'verification-rejected')
      throw new CapturedCredentialVerificationRejected('The saved key could not verify a model');
    if (result.phase !== 'completed')
      throw new Error('The original credential operation or model verification remains unconfirmed');
  }
}
