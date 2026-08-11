import {
  orchestratorLifecycleAuthorizationKey as authorizationKey,
  type OrchestratorLifecycleOwnerBinding,
  sameHostedLifecycleAuthorization,
  sameOrchestratorLifecycleOwnerBinding,
} from '../../../application/ExecuteHostedLifecycleCommand';

import type { HostedLifecycleCommandAuthorization } from '../../../../core/application/ports/HostedLifecycleCommandGatewayPort';

const AUTHORIZATION_RETENTION_MS = 60_000;

export interface OrchestratorLifecycleAuthorizationIssuance {
  readonly authorization: HostedLifecycleCommandAuthorization;
  readonly ownerBinding: OrchestratorLifecycleOwnerBinding;
  readonly executable: boolean;
}

export class OrchestratorLifecycleAuthorizationRegistry {
  private readonly bindings = new Map<string, OrchestratorLifecycleAuthorizationIssuance>();
  private readonly evictions = new Map<string, ReturnType<typeof setTimeout>>();

  issued(
    authorization: HostedLifecycleCommandAuthorization
  ): OrchestratorLifecycleAuthorizationIssuance | null {
    const issued = this.bindings.get(authorizationKey(authorization));
    return issued !== undefined &&
      sameHostedLifecycleAuthorization(issued.authorization, authorization)
      ? issued
      : null;
  }

  current(
    authorization: HostedLifecycleCommandAuthorization,
    binding: OrchestratorLifecycleOwnerBinding | null
  ): OrchestratorLifecycleAuthorizationIssuance | null {
    const issued = this.issued(authorization);
    return issued !== null &&
      binding !== null &&
      issued.executable &&
      sameOrchestratorLifecycleOwnerBinding(issued.ownerBinding, binding)
      ? issued
      : null;
  }

  remember(
    authorization: HostedLifecycleCommandAuthorization,
    ownerBinding: OrchestratorLifecycleOwnerBinding
  ): void {
    const key = authorizationKey(authorization);
    this.forget(key);
    this.bindings.set(key, Object.freeze({ authorization, ownerBinding, executable: true }));
    const eviction = setTimeout(() => this.forget(key), AUTHORIZATION_RETENTION_MS);
    eviction.unref?.();
    this.evictions.set(key, eviction);
  }

  forget(key: string): void {
    this.bindings.delete(key);
    const eviction = this.evictions.get(key);
    if (eviction !== undefined) clearTimeout(eviction);
    this.evictions.delete(key);
  }

  retire(key: string): void {
    const issued = this.bindings.get(key);
    if (issued === undefined || !issued.executable) return;
    this.bindings.set(key, Object.freeze({ ...issued, executable: false }));
  }

  clear(): void {
    this.bindings.clear();
    for (const eviction of this.evictions.values()) clearTimeout(eviction);
    this.evictions.clear();
  }
}
