import { pruneDeletedTeamBackups } from '../adapters/lifecycle/pruneDeletedTeamBackups.js';
import { createOwnerScopedTeamPurge, continueOwnerScopedTeamPurge } from '../adapters/lifecycle/OwnerScopedTeamPurge.js';
import { createOwnerPurgeRequest } from '../adapters/lifecycle/ownerPurgeRequest.js';
import { join } from 'node:path';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import { createOwnerLifecycleIdentity } from '../adapters/lifecycle/createOwnerLifecycleIdentity.js';
import { createOwnerBackupRegistry } from '../adapters/lifecycle/createOwnerBackupRegistry.js';
import { OwnerScopedTeamBackup } from '../adapters/lifecycle/OwnerScopedTeamBackup.js';
import { TeamPermanentDeletionCoordinator } from '../adapters/lifecycle/TeamPermanentDeletionCoordinator.js';
import { getBackupManifestPath, readBackupManifestStrict, writeBackupManifest } from '../adapters/lifecycle/teamBackupManifest.js';
import type { LifecycleDirectories } from '../adapters/lifecycle/lifecycleRoots.js';
import type { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import type { FileStoppedTeamImport } from '../stopped-team-import/FileStoppedTeamImport.js';
import type { TeamOwner } from '../team/TeamOwner.js';
import type { TeamBinding } from '../team/contracts.js';

/** Existing Main scheduler calls finite captured-owner work; this composition creates no timer or independent queue. */
export function createTeamBackupComposition(options: {
  directories: LifecycleDirectories; principalId: string; ownerId: string;
  /** Exact originally injected store, so actor and resource checks use the same re-entrant Team fence. */
  resources(teamId: string): { team: { owner: TeamOwner; definition: { binding: TeamBinding; scope: unknown } }; store: TeamOwnerStore };
  assertCurrent(): void;
  /** Exact profile lease remains usable only for final storage maintenance after ingress seal. */
  assertWriter(): void;
  teamIds(): readonly string[];
  isShuttingDown(): boolean;
  /** Actual retained evidence/native/import owners; unavailable proof retains the backup. */
  assertBackupPrunable(teamName: string, identityId: string): void;
  importer?(): Pick<FileStoppedTeamImport, 'publication'> | undefined;
  purge?: { assertReferencesReleased(teamId: string): void; onPurged(teamId: string): void };
}) {
  const roots = options.directories;
  let initialized = false, initialization: Promise<void> | undefined;
  const registry = createOwnerBackupRegistry({ directory: roots.backups, assertWriter: options.assertWriter,
    withSharedLock: (scope, operation) => coordinator.withSharedLock(scope, operation) });
  const directory = (teamName: string) => join(roots.backups, 'teams', teamName);
  const coordinator = new TeamPermanentDeletionCoordinator({ awaitInitialization: () => initialized ? Promise.resolve() : initialize(), isInitialized: () => initialized,
    isShuttingDown: options.isShuttingDown, withTeamMutex: async (_name, operation) => operation(), registry: registry.entries,
    loadManifest: name => readBackupManifestStrict(getBackupManifestPath(directory(name)), name),
    saveManifest: (name, manifest) => writeBackupManifest(directory(name), manifest, { strict: true, beforeCommit: async () => options.assertWriter() }),
    saveRegistryEntry: async (_name, entry) => registry.publish(entry),
  }, roots);
  function initialize(): Promise<void> {
    return initialization ??= (async () => {
      options.assertWriter(); await registry.initialize(); await coordinator.initialize();
      options.assertWriter(); initialized = true;
      for (const intent of await coordinator.listPendingPermanentDeletions()) {
        const request = intent.ownerRequest;
        if (!request || request.binding.backendId !== options.ownerId || request.principalId !== options.principalId || !options.purge) continue;
        try {
          await continueOwnerScopedTeamPurge({ binding: request.binding, roots, principalId: options.principalId, coordinator,
            assertWriter: options.assertWriter, onPurged: () => options.purge!.onPurged(request.binding.teamId) }, intent);
        } catch { /* Original target/release proof remains held; unrelated Teams stay readable. */ }
      }
      await pruneDeletedTeamBackups({ entries: registry.entries, directory,
        withIdentityFence: (name, operation) => coordinator.withTeamIdentityFence(name, operation),
        assertPrunable: (name, identity) => { options.assertCurrent(); options.assertBackupPrunable(name, identity); },
        onPruned: (_name, entry) => registry.remove(entry, () => { options.assertCurrent(); options.assertBackupPrunable(entry.teamName, entry.identityId); }),
        log() {},
      });
    })();
  }
  function resources(teamId: string, closing = false) {
    const current = closing ? options.assertWriter : options.assertCurrent;
    current();
    const selected = options.resources(teamId), binding = selected.team.definition.binding;
    if (binding.teamId !== teamId || selected.store.root !== join(roots.teams, '..') ||
      selected.store.directory !== join(roots.teams, binding.teamName, '.host-owner')) throw new TeamOwnerError('hold');
    const assertWriter = () => selected.team.owner.withLaunchAuthority(options.principalId, 'control', () => {
      current();
      const latest = options.resources(teamId);
      if (latest.team !== selected.team || latest.store !== selected.store || digest(latest.team.definition.binding) !== digest(binding)) throw new TeamOwnerError('hold');
    });
    const identity = createOwnerLifecycleIdentity({ store: selected.store, binding, coordinator, assertWriter,
      withReadAuthority: operation => selected.team.owner.withLaunchAuthority(options.principalId, 'read', operation) });
    const imported = options.importer?.()?.publication(teamId, operation => selected.store.fenced(operation));
    const backup = new OwnerScopedTeamBackup({ binding, store: selected.store, roots, backupDirectory: directory(binding.teamName),
      assertWriter, withIdentityFence: operation => coordinator.withTeamIdentityFence(binding.teamName, operation),
      assertPublicationCurrent: identity.assertProductPublicationCurrent, publishRegistryEntry: registry.publish,
      ...(imported ? { importPublication: imported } : {}) });
    return { ...selected, binding, identity, backup, imported, assertWriter };
  }
  return {
    initialize,
    /** Trusted native/feature composition binds the actual principal; never substitute the profile's human grant. */
    async identity(teamId: string, actualPrincipalId: string) {
      await initialize();
      const selected = resources(teamId);
      const withReadAuthority = <T>(operation: () => T): T => selected.team.owner.withLaunchAuthority(actualPrincipalId, 'read', () => {
        options.assertCurrent();
        const latest = options.resources(teamId);
        if (latest.team !== selected.team || latest.store !== selected.store) throw new TeamOwnerError('hold');
        return operation();
      });
      const identity = createOwnerLifecycleIdentity({ store: selected.store, binding: selected.binding, coordinator,
        assertWriter: () => withReadAuthority(() => {}), withReadAuthority });
      await identity.publish(); withReadAuthority(() => {});
      return { readCurrent: identity.readCurrent, withCurrentPublication: identity.withCurrentPublication, assertWorkAllowed: identity.assertWorkAllowed };
    },
    /** The original startup caller reconciles only this admitted current Team, never a human-name scan. */
    async run(teamId: string, mode: 'snapshot' | 'reconcile') {
      await initialize();
      const selected = resources(teamId);
      selected.assertWriter(); await selected.identity.publish(); selected.assertWriter();
      const restored = mode === 'reconcile' ? await selected.backup.restoreMissing() : { restored: 0, held: [] };
      selected.assertWriter();
      const snapshot = await selected.backup.snapshot(); selected.assertWriter();
      return { copied: snapshot.copied, restored: restored.restored, heldCount: new Set([...restored.held, ...snapshot.held]).size };
    },
    /** After original Runtime/provider drain, before original profile lease release; snapshot only, never restore/replay. */
    async shutdown(): Promise<{ heldTeamIds: string[] }> {
      await initialize();
      const heldTeamIds: string[] = [];
      for (const teamId of [...options.teamIds()]) {
        try {
          const selected = resources(teamId, true);
          selected.assertWriter(); await selected.identity.publish();
          const result = await selected.backup.snapshot();
          if (result.held.length) heldTeamIds.push(teamId);
        } catch { heldTeamIds.push(teamId); }
      }
      return { heldTeamIds };
    },
    /** Product restore and destructive boundary use one original physical incarnation fence. */
    async changeLifecycle(teamId: string, command: unknown) {
      await initialize();
      const selected = resources(teamId);
      return coordinator.withTeamIdentityFence(selected.binding.teamName, async () => {
        selected.assertWriter();
        if (coordinator.isPermanentDeletionFencedSync(selected.binding.teamName, selected.binding.teamId)) throw new TeamOwnerError('hold');
        return selected.team.owner.lifecycleCommands(options.principalId).execute(command);
      });
    },
    async purge(teamId: string, commandId: string, expectedRevision: string) {
      await initialize();
      const hooks = options.purge;
      if (!hooks) throw new TeamOwnerError('hold');
      const selected = resources(teamId);
      const original = await coordinator.lookupOwnerPermanentDeletion(createOwnerPurgeRequest(selected.binding, options.principalId, commandId, expectedRevision, selected.team.definition.scope));
      selected.assertWriter();
      // A prepared original already owns its marker and fences new publication.
      if (!original) await selected.identity.publish();
      selected.assertWriter();
      const purge = createOwnerScopedTeamPurge({ binding: selected.binding, capturedScope: selected.team.definition.scope, store: selected.store, roots,
        principalId: options.principalId, lifecycle: selected.team.owner.lifecycleContinuation(), coordinator,
        assertWriter: options.assertCurrent, authorizePurge: selected.assertWriter,
        assertReferencesReleased: () => hooks.assertReferencesReleased(teamId),
        ...(selected.imported ? { importPublication: selected.imported } : {}),
        onPurged: () => hooks.onPurged(teamId) });
      const result = await purge.purge(commandId, expectedRevision);
      return { kind: 'team_purge', commandId, transactionId: result.transactionId, phase: 'deleted' };
    },
    async lookupPurge(teamId: string, commandId: string, expectedRevision: string) {
      await initialize();
      const selected = resources(teamId); selected.assertWriter();
      const intent = await coordinator.lookupOwnerPermanentDeletion(createOwnerPurgeRequest(selected.binding, options.principalId, commandId, expectedRevision, selected.team.definition.scope));
      selected.assertWriter();
      return intent ? { kind: 'team_purge', commandId, transactionId: intent.transactionId, phase: intent.phase } : null;
    },
    pendingPurge(teamId: string) {
      options.assertCurrent();
      const selected = options.resources(teamId), binding = selected.team.definition.binding;
      return selected.team.owner.withLaunchAuthority(options.principalId, 'read', () => {
        options.assertCurrent();
        const latest = options.resources(teamId);
        if (latest.team !== selected.team || latest.store !== selected.store) throw new TeamOwnerError('hold');
        const intent = coordinator.readOwnerDeletionIntentSync(binding.teamName, teamId), request = intent?.ownerRequest;
        if (!request || intent?.phase !== 'prepared' || request.principalId !== options.principalId ||
          digest(request.binding) !== digest(binding) || request.scopeDigest !== digest(selected.team.definition.scope)) return undefined;
        return { commandId: request.commandId, expectedRevision: request.expectedRevision };
      });
    },
    /** Trusted purge/work-sync composition uses the same existing lifecycle coordinator and exact store. */
    resources,
    coordinator,
  };
}
