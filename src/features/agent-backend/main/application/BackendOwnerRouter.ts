import { isAbsolute, resolve } from 'node:path';

import { HostClientError } from '../infrastructure/selectedHostProfile';

import {
  assertIdentity,
  BackendRoutingError,
  captureOwnerBinding,
  captureScope,
  captureStoredBinding,
  ownerKey,
} from './backendBinding';

import type {
  CapturedHostClient,
  CapturedHostShutdown,
} from '../infrastructure/CapturedHostClient';
import type {
  BackendHandle,
  BackendOwnerBinding,
  BackendOwnerRef,
  BackendScope,
  HandleBindingStore,
  StoredBackendBinding,
} from './backendBinding';
import type { HostHandshake, JsonValue } from '@agent-teams/legacy-agent-host/contracts';

interface RegisteredOwner {
  readonly binding: BackendOwnerBinding;
  readonly client: CapturedHostClient;
  sealed: boolean;
}

/** Trusted composition inputs; renderer supplies only opaque handle IDs via validated callers. */
export interface CapturedBackendOwner extends BackendOwnerRef {
  readonly storageRoot: string;
  readonly client: CapturedHostClient;
}

export interface BoundBackendCommand {
  readonly commandId: string;
  readonly method: string;
  readonly payload: JsonValue;
  readonly control?: boolean;
}

/** Routing is independent of Team policy and never owns command outcomes or retries. */
export class BackendOwnerRouter {
  private readonly owners = new Map<string, RegisteredOwner>();
  private defaultKey?: string;
  private sealed = false;

  constructor(private readonly store: HandleBindingStore) {}

  registerOwner(owner: CapturedBackendOwner): void {
    this.requireAdmission();
    if (!isAbsolute(owner.storageRoot)) throw new BackendRoutingError('invalid-binding');
    const key = ownerKey(owner);
    const binding = captureOwnerBinding({
      ownerId: owner.ownerId,
      revision: owner.revision,
      storageRoot: resolve(owner.storageRoot),
      profileId: owner.client.profile.profileId,
      protocolVersion: 1,
      buildId: owner.client.profile.expectedBuildId,
      nodeSha256: owner.client.profile.nodeSha256,
      hostEntrySha256: owner.client.profile.hostEntrySha256,
    });
    if (
      this.owners.has(key) ||
      [...this.owners.values()].some(
        (registered) => registered.binding.storageRoot === binding.storageRoot
      )
    ) {
      throw new BackendRoutingError('binding-conflict');
    }
    this.owners.set(key, { binding, client: owner.client, sealed: false });
  }

  setDefault(owner: BackendOwnerRef): void {
    this.requireAdmission();
    const key = ownerKey(owner);
    this.requireOwner(key);
    this.defaultKey = key;
  }

  startOwner(owner: BackendOwnerRef): Promise<HostHandshake> {
    this.requireAdmission();
    return this.requireOwner(ownerKey(owner)).client.start();
  }

  async createHandle(handleId: string, value: BackendScope): Promise<BackendHandle> {
    this.requireAdmission();
    // Capture default before storage awaits: a concurrent preference change is not a rebind.
    const selectedKey = this.defaultKey;
    const scope = captureScope(value);
    const existing = await this.readBinding(handleId);
    this.requireAdmission();
    if (existing) return this.retain(existing, scope);
    if (!selectedKey) throw new BackendRoutingError('unavailable');
    const owner = this.requireOwner(selectedKey);
    const binding = captureStoredBinding({
      schemaVersion: 1,
      handleId,
      owner: owner.binding,
      scope,
    });
    if (!(await this.store.create(binding))) {
      const winner = await this.readBinding(handleId);
      if (!winner) throw new BackendRoutingError('hold');
      return this.retain(winner, scope);
    }
    this.requireAdmission();
    this.resolveOwner(binding);
    return Object.freeze({ handleId: binding.handleId });
  }

  async readHandle(handleId: string): Promise<BackendHandle> {
    this.requireAdmission();
    const binding = await this.readBinding(handleId);
    if (!binding) throw new BackendRoutingError('hold');
    this.resolveOwner(binding);
    return Object.freeze({ handleId: binding.handleId });
  }

  async request(handle: BackendHandle, command: BoundBackendCommand): Promise<JsonValue> {
    this.requireAdmission();
    assertIdentity(command.commandId);
    assertIdentity(command.method);
    let payload: JsonValue;
    try {
      const serialized = JSON.stringify(command.payload, (_key, value: unknown) => {
        if (
          (typeof value === 'number' && !Number.isFinite(value)) ||
          value === undefined ||
          typeof value === 'bigint' ||
          typeof value === 'function' ||
          typeof value === 'symbol'
        ) {
          throw new BackendRoutingError('invalid-binding');
        }
        return value;
      });
      if (serialized.length > 1024 * 1024) throw new BackendRoutingError('invalid-binding');
      payload = JSON.parse(serialized) as JsonValue;
    } catch {
      throw new BackendRoutingError('invalid-binding');
    }
    const { commandId, method, control } = command;
    const binding = await this.readBinding(handle.handleId);
    if (!binding) throw new BackendRoutingError('hold');
    // Recheck after every asynchronous boundary; shutdown cannot be bypassed by a late read.
    const owner = this.resolveOwner(binding);
    try {
      return await owner.client.request(
        method,
        { commandId, binding: binding as unknown as JsonValue, payload },
        { control }
      );
    } catch (error) {
      if (
        error instanceof HostClientError &&
        error.outcome === 'not-dispatched' &&
        (error.code === 'shutting-down' || error.code === 'transport-closed')
      ) {
        owner.sealed = true;
        throw new BackendRoutingError('unavailable');
      }
      // Response loss may follow effects. Keep the original UNKNOWN outcome untouched.
      throw error;
    }
  }

  /** Lookup uses the original owner and caller-supplied identity, with no redispatch. */
  lookup(handle: BackendHandle, commandId: string, lookupMethod: string): Promise<JsonValue> {
    return this.request(handle, { commandId, method: lookupMethod, payload: null, control: true });
  }

  /** Synchronous owner fence includes pending client startup; no automatic recovery is installed. */
  shutdownOwner(owner: BackendOwnerRef): Promise<CapturedHostShutdown> {
    const registered = this.owners.get(ownerKey(owner));
    if (!registered) return Promise.reject(new BackendRoutingError('unavailable'));
    registered.sealed = true;
    return registered.client.shutdown();
  }

  shutdown(): Promise<PromiseSettledResult<CapturedHostShutdown>[]> {
    this.sealed = true;
    for (const owner of this.owners.values()) owner.sealed = true;
    return Promise.allSettled([...this.owners.values()].map((owner) => owner.client.shutdown()));
  }

  private requireAdmission(): void {
    if (this.sealed) throw new BackendRoutingError('shutting-down');
  }

  private requireOwner(key: string): RegisteredOwner {
    this.requireAdmission();
    const owner = this.owners.get(key);
    if (!owner || owner.sealed) throw new BackendRoutingError('unavailable');
    return owner;
  }

  private resolveOwner(binding: StoredBackendBinding): RegisteredOwner {
    const owner = this.requireOwner(ownerKey(binding.owner));
    if (JSON.stringify(owner.binding) !== JSON.stringify(binding.owner))
      throw new BackendRoutingError('hold');
    return owner;
  }

  private retain(binding: StoredBackendBinding, scope: BackendScope): BackendHandle {
    if (JSON.stringify(binding.scope) !== JSON.stringify(scope))
      throw new BackendRoutingError('binding-conflict');
    this.resolveOwner(binding);
    return Object.freeze({ handleId: binding.handleId });
  }

  private async readBinding(handleId: string): Promise<StoredBackendBinding | null> {
    try {
      const binding = await this.store.read(handleId);
      if (binding === null) return null;
      const captured = captureStoredBinding(binding);
      if (captured.handleId !== handleId) throw new BackendRoutingError('hold');
      return captured;
    } catch {
      throw new BackendRoutingError('hold');
    }
  }
}
