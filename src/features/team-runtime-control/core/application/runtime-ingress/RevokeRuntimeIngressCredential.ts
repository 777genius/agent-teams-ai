import {
  isExactRuntimeIngressCredentialScope,
  isRuntimeIngressCredentialRecoverable,
  revokeRuntimeIngressCredential,
  type RuntimeIngressCredentialId,
  type RuntimeIngressCredentialScope,
} from '../../domain/runtime-ingress';

import type {
  LoadRuntimeIngressCredentialResult,
  RevokeRuntimeIngressCredentialAtomicallyResult,
  RuntimeIngressDurableRecoveryPort,
} from './ports';

const RUNTIME_INGRESS_REVOCATION_RECONCILE_LIMIT = 3;

export interface RevokeRuntimeIngressCredentialRequest {
  readonly credentialId: RuntimeIngressCredentialId;
  /** Fixed server-side relay scope; never provider body authority. */
  readonly expectedScope: RuntimeIngressCredentialScope;
  readonly revokedAtIso: string;
  readonly reason: string;
}

export type RevokeRuntimeIngressCredentialOutcome =
  | { readonly status: 'revoked' | 'already_revoked' }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'credential_missing'
        | 'credential_invalid'
        | 'credential_scope_mismatch'
        | 'revocation_invalid'
        | 'concurrency_conflict'
        | 'storage_unavailable';
    };

export class RevokeRuntimeIngressCredential {
  constructor(private readonly recovery: RuntimeIngressDurableRecoveryPort) {}

  async execute(
    request: RevokeRuntimeIngressCredentialRequest
  ): Promise<RevokeRuntimeIngressCredentialOutcome> {
    for (let attempt = 0; attempt < RUNTIME_INGRESS_REVOCATION_RECONCILE_LIMIT; attempt += 1) {
      const loaded = await this.loadCredential(request.credentialId);
      if (loaded.status !== 'found') {
        return {
          status: 'rejected',
          reason: loaded.status === 'missing' ? 'credential_missing' : 'storage_unavailable',
        };
      }
      if (!isRuntimeIngressCredentialRecoverable(loaded.credential)) {
        return { status: 'rejected', reason: 'credential_invalid' };
      }
      if (!isExactRuntimeIngressCredentialScope(loaded.credential.scope, request.expectedScope)) {
        return { status: 'rejected', reason: 'credential_scope_mismatch' };
      }
      const transition = revokeRuntimeIngressCredential(
        loaded.credential,
        request.revokedAtIso,
        request.reason
      );
      if (transition.status === 'already_revoked') {
        return { status: 'already_revoked' };
      }
      if (transition.status === 'rejected') {
        return { status: 'rejected', reason: 'revocation_invalid' };
      }

      const persisted = await this.revokeAtomically({
        expectedCredential: loaded.credential,
        nextCredential: transition.next,
      });
      switch (persisted.status) {
        case 'revoked':
          return { status: 'revoked' };
        case 'already_revoked':
          return { status: 'already_revoked' };
        case 'missing':
          return { status: 'rejected', reason: 'credential_missing' };
        case 'unavailable':
          return { status: 'rejected', reason: 'storage_unavailable' };
        case 'conflict':
          break;
      }
    }
    return { status: 'rejected', reason: 'concurrency_conflict' };
  }

  private async loadCredential(
    credentialId: RuntimeIngressCredentialId
  ): Promise<LoadRuntimeIngressCredentialResult> {
    try {
      return await this.recovery.loadCredential(credentialId);
    } catch {
      return { status: 'unavailable' as const };
    }
  }

  private async revokeAtomically(
    request: Parameters<RuntimeIngressDurableRecoveryPort['revokeCredentialAtomically']>[0]
  ): Promise<RevokeRuntimeIngressCredentialAtomicallyResult> {
    try {
      return await this.recovery.revokeCredentialAtomically(request);
    } catch {
      return { status: 'unavailable' as const };
    }
  }
}
