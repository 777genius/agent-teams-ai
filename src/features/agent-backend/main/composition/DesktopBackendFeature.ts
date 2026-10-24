import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import {
  crossTeamOwnerResourceRef,
  crossTeamTeamResourceRef,
} from '@agent-teams/legacy-agent-host/cross-team';
import { createdTeamSelectionSignature } from '@shared/utils/createdTeamReadiness';

import { BackendOperationsFacade } from '../adapters/input/BackendOperationsFacade';
import {
  assertBackendRequestGuard,
  BackendRoutingError,
  ownerKey,
} from '../application/backendBinding';
import { BackendOwnerRouter } from '../application/BackendOwnerRouter';
import { createCapturedHostBackup } from '../application/createCapturedHostBackup';
import { prepareCreatedHostTeam } from '../application/createdHostTeam';
import { ForegroundModelChecks } from '../application/ForegroundModelChecks';
import { CapturedHostClient } from '../infrastructure/CapturedHostClient';
import { captureProviderManagement } from '../infrastructure/CapturedProviderManagement';
import { CapturedTeamRegistry } from '../infrastructure/CapturedTeamRegistry';
import { FileHandleBindingStore } from '../infrastructure/FileHandleBindingStore';
import { loadDesktopBackendDescriptor } from '../infrastructure/loadDesktopBackendDescriptor';
import { readCapturedTeamRetirements } from '../infrastructure/readCapturedTeamRetirements';
import { CapturedStoppedTeamImport } from '../infrastructure/stopped-import/CapturedStoppedTeamImport';

import type { BackendHandle } from '../../contracts';
import type { BackendConnectionSnapshot } from '../../contracts/connections';
import type {
  BackendOwnerRef,
  BackendRequestGuard,
  HandleBindingStore,
} from '../application/backendBinding';
import type { CapturedBackendOwner } from '../application/BackendOwnerRouter';
import type { CapturedProviderManagement } from '../infrastructure/CapturedProviderManagement';
import type {
  DesktopBackendDescriptor,
  DesktopBackendDescriptorSelection,
} from '../infrastructure/loadDesktopBackendDescriptor';
import type {
  CreateTeamRegistryPayload,
  TeamRegistryRecord,
} from '@agent-teams/legacy-agent-host/team-registry/contracts';
import type { CreateTeamLaunchPreparationInput } from '@agent-teams/legacy-agent-host/team-registry/create-launch-contracts';
import type { TeamCreateRequest } from '@shared/types/team';

type InitializationPhase =
  | 'descriptor'
  | 'owner-registration'
  | 'handle-read'
  | 'handle-publication'
  | 'default-owner';

export interface DesktopBackendFeatureOptions {
  /** Null is the safe default: no descriptor, handles or process launch. */
  descriptor: DesktopBackendDescriptorSelection | null;
  bindingDirectory: string;
  /** Private composition diagnostics; never serializes paths, payloads or raw errors. */
  onInitializationFailure?: (
    phase: InitializationPhase,
    code: BackendRoutingError['code'] | 'unexpected'
  ) => void;
  /** Existing durable storage port, useful for composing the app's chosen persistence. */
  bindings?: HandleBindingStore;
}

export class DesktopBackendFeature {
  readonly facade: BackendOperationsFacade;
  private readonly store: HandleBindingStore;
  private router?: BackendOwnerRouter;
  private descriptor?: DesktopBackendDescriptor;
  private initializePromise?: Promise<void>;
  private sealed = false;
  private state: BackendConnectionSnapshot['state'] = 'unconfigured';
  private readonly clients = new Map<string, CapturedBackendOwner>();
  private readonly dynamicHandles = new Map<string, DesktopBackendDescriptor['handles'][number]>();
  private readonly retiredHandles = new Set<string>();
  private readonly registryReads = new Map<string, Promise<void>>();
  private readonly creationChecks = new ForegroundModelChecks();

  constructor(private readonly options: DesktopBackendFeatureOptions) {
    // Selection is captured before any asynchronous access; callers cannot swap its path/hash.
    this.options = {
      ...options,
      descriptor: options.descriptor ? Object.freeze({ ...options.descriptor }) : null,
    };
    this.store = options.bindings ?? new FileHandleBindingStore(options.bindingDirectory);
    const target = async (
      handle: BackendHandle,
      guard?: BackendRequestGuard
    ): Promise<BackendOwnerRouter> => {
      await this.initialize();
      if (this.sealed) throw new BackendRoutingError('shutting-down');
      assertBackendRequestGuard(guard);
      const definition = this.handleDefinitions().find(
        (entry) => entry.handleId === handle.handleId
      );
      if (this.state !== 'ready' || !definition || !this.router)
        throw new BackendRoutingError('unavailable');
      // This is the captured client instance, not a recovery/replacement factory.
      await this.router.startOwner(definition.owner);
      if (this.sealed) throw new BackendRoutingError('shutting-down');
      assertBackendRequestGuard(guard);
      return this.router;
    };
    this.facade = new BackendOperationsFacade({
      request: async (handle, command) =>
        (await target(handle, command.guard)).request(handle, command),
      requestPair: async (source, destination, command) => {
        const router = await target(source, command.guard);
        const original = this.handleDefinitions().find(
          (entry) => entry.handleId === source.handleId
        );
        if (!original || !this.authorizeHandle(original.contextId, destination))
          throw new BackendRoutingError('forbidden');
        return router.requestPair(source, destination, command);
      },
      lookup: async (handle, commandId, method, guard) =>
        (await target(handle, guard)).lookup(handle, commandId, method, guard),
    });
  }

  initialize(): Promise<void> {
    if (this.sealed) return Promise.resolve();
    this.initializePromise ??= this.load();
    return this.initializePromise;
  }

  private async load(): Promise<void> {
    const selection = this.options.descriptor;
    if (!selection) return;
    let phase: InitializationPhase = 'descriptor';
    try {
      const descriptor = await loadDesktopBackendDescriptor(selection);
      if (this.sealed) return;
      const router = new BackendOwnerRouter(this.store);
      this.router = router;
      phase = 'owner-registration';
      for (const owner of descriptor.owners) {
        const captured = {
          ownerId: owner.ownerId,
          revision: owner.revision,
          storageRoot: owner.storageRoot,
          client: new CapturedHostClient(owner.profile),
        };
        router.registerOwner(captured);
        this.clients.set(ownerKey(owner), captured);
      }
      for (const handle of descriptor.handles) {
        if (this.sealed) return;
        phase = 'handle-read';
        const existing = await this.store.read(handle.handleId);
        if (this.sealed) return;
        const selected = this.clients.get(ownerKey(handle.owner));
        if (!selected) throw new BackendRoutingError('hold');
        // A changed private descriptor cannot rebind a retained handle under the same public key.
        if (
          existing &&
          (ownerKey(existing.owner) !== ownerKey(handle.owner) ||
            existing.owner.storageRoot !== selected.storageRoot ||
            existing.owner.profileId !== selected.client.profile.profileId ||
            existing.owner.buildId !== selected.client.profile.expectedBuildId ||
            existing.owner.nodeSha256 !== selected.client.profile.nodeSha256 ||
            existing.owner.hostEntrySha256 !== selected.client.profile.hostEntrySha256)
        )
          throw new BackendRoutingError('hold');
        router.setDefault(handle.owner);
        phase = 'handle-publication';
        await router.createHandle(handle.handleId, handle.scope);
      }
      if (this.sealed) return;
      phase = 'default-owner';
      router.setDefault(descriptor.defaultOwner);
      this.descriptor = descriptor;
      this.state = 'ready';
    } catch (error) {
      if (!this.sealed) this.state = 'hold';
      try {
        this.options.onInitializationFailure?.(
          phase,
          error instanceof BackendRoutingError ? error.code : 'unexpected'
        );
      } catch {
        /* Diagnostics cannot alter the original failed admission. */
      }
      await this.router?.shutdown();
    }
  }

  private handleDefinitions(): readonly DesktopBackendDescriptor['handles'][number][] {
    return [...(this.descriptor?.handles ?? []), ...this.dynamicHandles.values()];
  }

  private async registry(
    contextId: string,
    guard?: BackendRequestGuard
  ): Promise<{ client: CapturedTeamRegistry; owner: BackendOwnerRef }> {
    assertBackendRequestGuard(guard);
    await this.initialize();
    assertBackendRequestGuard(guard);
    const selected = this.descriptor?.creation,
      router = this.router;
    if (this.sealed || this.state !== 'ready' || !selected || !router)
      throw new BackendRoutingError('unavailable');
    if (!selected.contextIds.includes(contextId)) throw new BackendRoutingError('forbidden');
    const captured = this.clients.get(ownerKey(selected.owner));
    if (!captured) throw new BackendRoutingError('hold');
    return {
      owner: selected.owner,
      client: new CapturedTeamRegistry({
        owner: router.ownerBinding(selected.owner),
        client: captured.client,
        start: () => router.startOwner(selected.owner),
        available: () =>
          !this.sealed &&
          this.state === 'ready' &&
          this.clients.get(ownerKey(selected.owner)) === captured,
      }),
    };
  }

  private async registerDynamic(
    record: TeamRegistryRecord,
    owner: BackendOwnerRef,
    contextId: string,
    guard?: BackendRequestGuard
  ): Promise<void> {
    assertBackendRequestGuard(guard);
    if (record.contextId !== contextId || !this.router || this.sealed)
      throw new BackendRoutingError('forbidden');
    const entry: DesktopBackendDescriptor['handles'][number] = {
      handleId: record.binding.handleId,
      owner,
      contextId,
      label: record.displayName || record.teamName,
      members: record.members,
      scope: record.binding.scope,
    };
    const prior = this.handleDefinitions().find((row) => row.handleId === entry.handleId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(entry))
      throw new BackendRoutingError('binding-conflict');
    await this.router.createHandle(entry.handleId, entry.scope, owner);
    assertBackendRequestGuard(guard, 'unknown');
    if (this.sealed) throw new BackendRoutingError('shutting-down');
    this.dynamicHandles.set(entry.handleId, entry);
  }

  /** Main-only transfer authority for this exact configured owner/profile/principal. */
  async captureStoppedImport(contextId: string, guard: BackendRequestGuard) {
    await this.initialize();
    assertBackendRequestGuard(guard);
    const selected = this.descriptor?.creation,
      router = this.router;
    if (this.sealed || this.state !== 'ready' || !selected?.importAuthority || !router)
      throw new BackendRoutingError('unavailable');
    if (!selected.contextIds.includes(contextId)) throw new BackendRoutingError('forbidden');
    const captured = this.clients.get(ownerKey(selected.owner));
    if (!captured) throw new BackendRoutingError('hold');
    const available = () =>
      !this.sealed &&
      this.state === 'ready' &&
      this.clients.get(ownerKey(selected.owner)) === captured;
    const owner = router.ownerBinding(selected.owner);
    return {
      client: new CapturedStoppedTeamImport({
        owner,
        client: captured.client,
        start: () => router.startOwner(selected.owner),
        available,
      }),
      authority: {
        root: owner.storageRoot,
        ownerId: owner.ownerId,
        profileId: owner.profileId,
        principalId: selected.importAuthority.principalId,
        contextIds: [...selected.contextIds],
        assertCurrent: () => {
          assertBackendRequestGuard(guard);
          if (!available()) throw new BackendRoutingError('unavailable');
        },
      },
      registerPublished: (record: TeamRegistryRecord) =>
        this.registerDynamic(record, selected.owner, contextId, guard),
    };
  }

  /** Read creation metadata from its original Host; Main stores only immutable routing bindings. */
  async discoverBindings(
    contextId: string,
    guard?: BackendRequestGuard
  ): Promise<BackendConnectionSnapshot> {
    await this.initialize();
    assertBackendRequestGuard(guard);
    if (this.descriptor?.creation?.contextIds.includes(contextId)) {
      let reading = this.registryReads.get(contextId);
      if (!reading) {
        reading = (async () => {
          const target = await this.registry(contextId, guard);
          const catalog = await target.client.list(contextId, guard);
          for (const record of catalog.teams)
            await this.registerDynamic(record, target.owner, contextId, guard);
        })();
        this.registryReads.set(contextId, reading);
        void reading
          .finally(() => {
            if (this.registryReads.get(contextId) === reading) this.registryReads.delete(contextId);
          })
          .catch(() => undefined);
      }
      await reading;
    }
    assertBackendRequestGuard(guard);
    await this.refreshRetirements(contextId, guard);
    return this.listBindings(contextId);
  }

  private async refreshRetirements(contextId: string, guard?: BackendRequestGuard): Promise<void> {
    const router = this.router;
    if (!router || this.sealed || this.state !== 'ready') return;
    const entries = this.handleDefinitions().filter((entry) => entry.contextId === contextId);
    const owners = new Map(entries.map((entry) => [ownerKey(entry.owner), entry.owner]));
    const retired = new Set<string>();
    for (const [key, owner] of owners) {
      const captured = this.clients.get(key);
      if (!captured) throw new BackendRoutingError('hold');
      const teamIds = await readCapturedTeamRetirements({
        owner: router.ownerBinding(owner),
        contextId,
        client: captured.client,
        start: () => router.startOwner(owner),
        available: () =>
          !this.sealed &&
          this.state === 'ready' &&
          this.router === router &&
          this.clients.get(key) === captured,
        ...(guard ? { guard } : {}),
      });
      for (const entry of entries)
        if (ownerKey(entry.owner) === key && teamIds.includes(entry.scope.teamId))
          retired.add(entry.handleId);
    }
    assertBackendRequestGuard(guard);
    if (this.sealed || this.router !== router) throw new BackendRoutingError('unavailable');
    for (const entry of entries) this.retiredHandles.delete(entry.handleId);
    for (const handle of retired) this.retiredHandles.add(handle);
  }

  async createConfiguredTeam(
    contextId: string,
    commandId: string,
    payload: CreateTeamRegistryPayload,
    guard?: BackendRequestGuard
  ): Promise<BackendHandle> {
    const captured = structuredClone(payload);
    if (captured.contextId !== contextId) throw new BackendRoutingError('forbidden');
    const target = await this.registry(contextId, guard);
    let receipt;
    try {
      receipt = await target.client.create(commandId, captured, guard);
    } catch (originalError) {
      // An uncertain response permits one original read, never a replacement create.
      receipt = await target.client.lookup(commandId, captured, guard);
      if (!receipt) throw originalError;
    }
    if (receipt.commandId !== commandId || receipt.phase !== 'published')
      throw new BackendRoutingError('hold', 'unknown');
    await this.registerDynamic(receipt.record, target.owner, contextId, guard);
    return { handleId: receipt.record.binding.handleId };
  }

  /** Captures one creation owner for preparation, polling and original cleanup. */
  async captureTeamCreation(contextId: string, guard: BackendRequestGuard) {
    const target = await this.registry(contextId, guard);
    return {
      prepare: (
        action: 'prepare' | 'probe.read' | 'probe.cancel',
        input: CreateTeamLaunchPreparationInput
      ) => {
        if (input.draft.contextId !== contextId) throw new BackendRoutingError('forbidden');
        return target.client.prepareCreation(
          action,
          input,
          action === 'probe.cancel' ? undefined : guard
        );
      },
      submit: async (commandId: string, input: CreateTeamLaunchPreparationInput) => {
        if (input.draft.contextId !== contextId) throw new BackendRoutingError('forbidden');
        const result = await target.client.submitCreation(commandId, input, guard);
        if (result.creation.commandId !== commandId || result.creation.phase !== 'published')
          throw new BackendRoutingError('hold', 'unknown');
        await this.registerDynamic(result.creation.record, target.owner, contextId, guard);
        return result;
      },
    };
  }

  prepareCreatedTeam(
    contextId: string,
    preparationId: string,
    draft: TeamCreateRequest,
    guard: BackendRequestGuard
  ) {
    const captured = structuredClone(draft);
    const identity = JSON.stringify([
      contextId,
      preparationId,
      createdTeamSelectionSignature(captured),
    ]);
    return this.creationChecks.run(identity, async (isLatest) => {
      const current = { isCurrent: () => isLatest() && guard.isCurrent() };
      const target = await this.captureTeamCreation(contextId, current);
      return prepareCreatedHostTeam({
        target,
        contextId,
        preparationId,
        draft: captured,
        guard: current,
      });
    });
  }

  /** Existing backup scheduler captures one exact foreground owner set per invocation. */
  async captureBackup(contextId: string, guard: BackendRequestGuard) {
    const selected = await this.discoverBindings(contextId, guard);
    assertBackendRequestGuard(guard);
    const router = this.router;
    if (selected.state !== 'ready' || !router) throw new BackendRoutingError('hold');
    const handles = selected.bindings.map((entry) => ({ ...entry.handle }));
    return createCapturedHostBackup({
      handles,
      router,
      guard: {
        isCurrent: () =>
          !this.sealed &&
          this.router === router &&
          guard.isCurrent() &&
          handles.every((handle) => this.authorizeHandle(contextId, handle)),
      },
    });
  }

  listBindings(contextId: string): BackendConnectionSnapshot {
    const router = this.router;
    return {
      state: this.sealed ? 'shutting-down' : this.state,
      bindings:
        this.state !== 'ready' || this.sealed || !router
          ? []
          : this.handleDefinitions()
              .filter(
                (entry) => entry.contextId === contextId && !this.retiredHandles.has(entry.handleId)
              )
              .map((entry) => ({
                handle: { handleId: entry.handleId },
                label: entry.label,
                ownerResourceRef: crossTeamOwnerResourceRef(router.ownerBinding(entry.owner)),
                teamResourceRef: crossTeamTeamResourceRef(
                  crossTeamOwnerResourceRef(router.ownerBinding(entry.owner)),
                  entry.scope
                ),
                members: entry.members.map((member) => ({
                  memberId: member.memberId,
                  label: member.label,
                })),
              })),
    };
  }

  authorizeHandle(contextId: string, handle: BackendHandle): boolean {
    return (
      !this.sealed &&
      this.state === 'ready' &&
      this.handleDefinitions().some(
        (entry) => entry.contextId === contextId && entry.handleId === handle.handleId
      )
    );
  }

  /** Native Host health, independent of provider authentication and any fork installation. */
  async readRuntimeHealth(
    contextId: string,
    guard?: BackendRequestGuard
  ): Promise<{ buildId: string }> {
    assertBackendRequestGuard(guard);
    await this.initialize();
    assertBackendRequestGuard(guard);
    const descriptor = this.descriptor,
      router = this.router;
    if (this.sealed || this.state !== 'ready' || !descriptor || !router)
      throw new BackendRoutingError('unavailable');
    const key = ownerKey(descriptor.defaultOwner);
    const permitted = [...descriptor.handles, ...(descriptor.management ?? [])].some(
      (entry) => entry.contextId === contextId && ownerKey(entry.owner) === key
    );
    if (!permitted) throw new BackendRoutingError('forbidden');
    const handshake = await router.startOwner(descriptor.defaultOwner);
    assertBackendRequestGuard(guard);
    if (this.sealed) throw new BackendRoutingError('shutting-down');
    return { buildId: handshake.buildId };
  }

  async captureProviderManagement(
    contextId: string,
    projectPath: string | null,
    guard?: BackendRequestGuard,
    runtimeId: 'opencode' | 'codex' | 'claude' = 'opencode'
  ): Promise<CapturedProviderManagement> {
    if (
      projectPath !== null &&
      (typeof projectPath !== 'string' || !isAbsolute(projectPath) || projectPath.includes('\0'))
    )
      throw new BackendRoutingError('invalid-binding');
    const selectedPath = projectPath === null ? null : resolve(projectPath);
    assertBackendRequestGuard(guard);
    await this.initialize();
    assertBackendRequestGuard(guard);
    if (this.sealed) throw new BackendRoutingError('shutting-down');
    const selected = this.descriptor?.management?.find(
      (entry) =>
        entry.runtimeId === runtimeId &&
        entry.contextId === contextId &&
        entry.projectPath === selectedPath
    );
    return this.captureManagementTarget(selected, guard);
  }

  /** Main Skills choices derive solely from the original authorized descriptor, including optional runtimes. */
  async captureSkillsManagement(
    contextId: string,
    projectPath: string | null,
    guard: BackendRequestGuard
  ) {
    assertBackendRequestGuard(guard);
    await this.initialize();
    assertBackendRequestGuard(guard);
    if (this.sealed || this.state !== 'ready') throw new BackendRoutingError('unavailable');
    const selected =
      this.descriptor?.management?.filter(
        (entry) => entry.contextId === contextId && entry.projectPath === projectPath
      ) ?? [];
    const byRuntime = (runtime: 'claude' | 'codex' | 'opencode') => {
      const matches = selected.filter((entry) => entry.runtimeId === runtime);
      if (matches.length > 1) throw new BackendRoutingError('invalid-binding');
      return matches[0];
    };
    const claude = byRuntime('claude'),
      codex = byRuntime('codex');
    const common = claude ?? codex ?? byRuntime('opencode');
    if (!common) throw new BackendRoutingError('unavailable');
    const choices = [
      ...(claude ? [{ rootKind: 'claude' as const, selected: claude }] : []),
      ...(codex ? [{ rootKind: 'codex' as const, selected: codex }] : []),
      { rootKind: 'agents' as const, selected: common },
      { rootKind: 'cursor' as const, selected: common },
    ];
    return choices.map(({ rootKind, selected }) => ({
      rootKind,
      owner: this.captureManagementTarget(selected, guard),
    }));
  }

  /** Restore an original private intent; a changed descriptor cannot silently retarget it. */
  async restoreProviderManagement(
    contextId: string,
    targetId: string,
    guard?: BackendRequestGuard
  ): Promise<CapturedProviderManagement> {
    await this.initialize();
    if (!/^[a-f0-9]{64}$/.test(targetId)) throw new BackendRoutingError('invalid-binding');
    const selected = this.descriptor?.management?.find(
      (entry) => this.managementTargetId(entry) === targetId
    );
    return this.captureManagementTarget(selected, {
      isCurrent: () => selected?.contextId === contextId && (guard?.isCurrent() ?? true),
    });
  }

  private managementTargetId(
    selected: NonNullable<DesktopBackendDescriptor['management']>[number]
  ): string {
    const owner = this.descriptor?.owners.find(
      (entry) => ownerKey(entry) === ownerKey(selected.owner)
    );
    if (!owner) throw new BackendRoutingError('hold');
    return createHash('sha256').update(JSON.stringify({ selected, owner })).digest('hex');
  }

  private captureManagementTarget(
    selected: NonNullable<DesktopBackendDescriptor['management']>[number] | undefined,
    guard?: BackendRequestGuard
  ): CapturedProviderManagement {
    const router = this.router;
    if (this.state !== 'ready' || !selected || !router)
      throw new BackendRoutingError('unavailable');
    const owner = this.clients.get(ownerKey(selected.owner));
    if (!owner) throw new BackendRoutingError('hold');
    return captureProviderManagement({
      targetId: this.managementTargetId(selected),
      profileId: selected.profileId,
      configRevision: selected.configRevision,
      ...(selected.preferences ? { preferences: selected.preferences } : {}),
      client: owner.client,
      start: () => router.startOwner(selected.owner),
      ownerAvailable: () =>
        !this.sealed &&
        this.state === 'ready' &&
        this.clients.get(ownerKey(selected.owner)) === owner,
      foregroundCurrent: () => guard?.isCurrent() ?? true,
    });
  }

  shutdown(): ReturnType<BackendOwnerRouter['shutdown']> {
    this.sealed = true;
    this.state = 'shutting-down';
    return this.router?.shutdown() ?? Promise.resolve([]);
  }
}
