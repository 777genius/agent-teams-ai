import { isAbsolute, resolve } from 'node:path';

import { HostClientError } from '../infrastructure/selectedHostProfile';

import {
  assertBackendRequestGuard,
  assertIdentity,
  BackendRoutingError,
  captureBackendPayload,
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
  BackendRequestGuard,
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
  readonly guard?: BackendRequestGuard;
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

  ownerBinding(owner: BackendOwnerRef): BackendOwnerBinding {
    return this.requireOwner(ownerKey(owner)).binding;
  }

  async createHandle(
    handleId: string,
    value: BackendScope,
    capturedOwner?: BackendOwnerRef
  ): Promise<BackendHandle> {
    this.requireAdmission();
    // Capture default before storage awaits: a concurrent preference change is not a rebind.
    const selectedKey = capturedOwner ? ownerKey(capturedOwner) : this.defaultKey;
    const scope = captureScope(value);
    const existing = await this.readBinding(handleId);
    this.requireAdmission();
    if (existing) return this.retain(existing, scope, capturedOwner);
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
      return this.retain(winner, scope, capturedOwner);
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
    const payload = captureBackendPayload(command.payload, command.method);
    const { commandId, method, control, guard } = command;
    const binding = await this.readBinding(handle.handleId);
    if (!binding) throw new BackendRoutingError('hold');
    // Recheck after every asynchronous boundary; shutdown cannot be bypassed by a late read.
    const owner = this.resolveOwner(binding);
    // No await may separate this guard from the captured client's synchronous wire send.
    assertBackendRequestGuard(guard);
    try {
      const response = await owner.client.request(
        method,
        { commandId, binding: binding as unknown as JsonValue, payload },
        { control }
      );
      assertBackendRequestGuard(guard, 'unknown');
      return response;
    } catch (error) {
      assertBackendRequestGuard(guard, 'unknown');
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

  /** Both opaque selections are captured before dispatch; the target is private wire authority. */
  async requestPair(
    source: BackendHandle,
    target: BackendHandle,
    command: BoundBackendCommand
  ): Promise<JsonValue> {
    this.requireAdmission();
    assertIdentity(command.commandId);
    assertIdentity(command.method);
    const sourceHandleId = source.handleId,
      targetHandleId = target.handleId;
    const payload = captureBackendPayload(command.payload, command.method);
    const { commandId, method, control, guard } = command;
    const [sourceBinding, targetBinding] = await Promise.all([
      this.readBinding(sourceHandleId),
      this.readBinding(targetHandleId),
    ]);
    if (!sourceBinding || !targetBinding) throw new BackendRoutingError('hold');
    const owner = this.resolveOwner(sourceBinding),
      targetOwner = this.resolveOwner(targetBinding);
    if (owner !== targetOwner || sourceBinding.scope.teamId === targetBinding.scope.teamId)
      throw new BackendRoutingError('invalid-binding');
    const assertPair = (outcome?: 'unknown') => {
      try {
        this.requireAdmission();
        if (
          this.resolveOwner(sourceBinding) !== owner ||
          this.resolveOwner(targetBinding) !== owner
        )
          throw new BackendRoutingError('unavailable');
      } catch {
        throw new BackendRoutingError('unavailable', outcome);
      }
      assertBackendRequestGuard(guard, outcome);
    };
    assertPair();
    try {
      const response = await owner.client.request(
        method,
        {
          commandId,
          binding: JSON.parse(JSON.stringify(sourceBinding)) as JsonValue,
          payload: {
            request: payload,
            targetBinding: JSON.parse(JSON.stringify(targetBinding)) as JsonValue,
          },
        },
        { control }
      );
      assertPair('unknown');
      return response;
    } catch (error) {
      assertPair('unknown');
      if (
        error instanceof HostClientError &&
        error.outcome === 'not-dispatched' &&
        (error.code === 'shutting-down' || error.code === 'transport-closed')
      ) {
        owner.sealed = true;
        throw new BackendRoutingError('unavailable');
      }
      throw error;
    }
  }

  /** Lookup uses the original owner and caller-supplied identity, with no redispatch. */
  lookup(
    handle: BackendHandle,
    commandId: string,
    lookupMethod: string,
    guard?: BackendRequestGuard
  ): Promise<JsonValue> {
    return this.request(handle, {
      commandId,
      method: lookupMethod,
      payload: null,
      control: true,
      ...(guard ? { guard } : {}),
    });
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

  private retain(
    binding: StoredBackendBinding,
    scope: BackendScope,
    capturedOwner?: BackendOwnerRef
  ): BackendHandle {
    if (JSON.stringify(binding.scope) !== JSON.stringify(scope))
      throw new BackendRoutingError('binding-conflict');
    this.resolveOwner(binding);
    if (
      capturedOwner &&
      JSON.stringify(this.requireOwner(ownerKey(capturedOwner)).binding) !==
        JSON.stringify(binding.owner)
    )
      throw new BackendRoutingError('binding-conflict');
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
