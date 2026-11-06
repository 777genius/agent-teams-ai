import { digest } from '../../team/identity.js';
import { TeamOwnerError } from '../../team/contracts.js';
import { assertTeamExecutionAllowed } from '../../team/teamLifecycleAdmission.js';
import type { TeamBinding } from '../../team/contracts.js';
import type { OwnerState } from '../../team/ownerState.js';
import type { TeamOwnerStore } from '../team/TeamOwnerStore.js';
import type { TeamPermanentDeletionCoordinator } from './TeamPermanentDeletionCoordinator.js';

/** Fixed Team incarnation and original lifecycle marker; never a native generation or caller-supplied identity. */
export function createOwnerLifecycleIdentity(options: {
  store: TeamOwnerStore;
  binding: TeamBinding;
  coordinator: TeamPermanentDeletionCoordinator;
  assertWriter(): void;
  /** Bound actual native/viewer principal; original Team read fence is held only for synchronous callbacks. */
  withReadAuthority<T>(operation: () => T): T;
}) {
  const { store, binding, coordinator } = options;
  function rawState(): OwnerState {
    const state = store.read<OwnerState>('state.json');
    if (!state || state.schemaVersion !== 1 || !state.ready || digest(state.binding) !== digest(binding)) throw new TeamOwnerError('hold');
    return state;
  }
  function assertTeam(teamName: string): void {
    if (teamName !== binding.teamName) throw new TeamOwnerError('forbidden');
  }
  function currentRead<T>(operation: () => T): T {
    return options.withReadAuthority(() => { rawState(); return operation(); });
  }
  return {
    /** Trusted bootstrap/backup composition only. Do not expose this method to a tool or adoptLegacy caller. */
    async publish(): Promise<void> {
      options.assertWriter();
      await coordinator.withTeamIdentityFence(binding.teamName, async () => store.fenced(() => {
        options.assertWriter();
        if (rawState().rosterProjection) throw new TeamOwnerError('hold');
        if (coordinator.isPermanentDeletionFencedSync(binding.teamName, binding.teamId)) throw new TeamOwnerError('hold');
        const config = store.read<Record<string, unknown>>('../config.json');
        if (!config || config.name !== binding.teamName) throw new TeamOwnerError('hold');
        if (config._backupIdentityId !== undefined && config._backupIdentityId !== binding.teamId) throw new TeamOwnerError('conflict');
        if (config._backupIdentityId === undefined) store.write('../config.json', { ...config, _backupIdentityId: binding.teamId });
      }));
    },
    async readCurrent(teamName: string) {
      assertTeam(teamName); currentRead(() => undefined);
      const observed = await coordinator.workSyncIdentity.readCurrent(teamName);
      return currentRead(() => observed.status === 'identified' && observed.identityId !== binding.teamId
        ? { status: 'unavailable' as const } : observed);
    },
    /** Identity only; the feature separately authorizes its report/apply use case before this exact synchronous commit. */
    withCurrent<T>(teamName: string, identityId: string, operation: () => T) {
      assertTeam(teamName);
      if (identityId !== binding.teamId) return Promise.resolve({ current: false as const, identity: { status: 'unavailable' as const } });
      return coordinator.workSyncIdentity.withCurrent(teamName, identityId, async () => currentRead(() => {
        const value: unknown = operation();
        if (value && typeof (value as { then?: unknown }).then === 'function') {
          void Promise.resolve(value).catch(() => {}); throw new TeamOwnerError('hold');
        }
        return value as T;
      }));
    },
    /** Finite local journal I/O only; physical incarnation stays fenced, Team authority is re-entered at every commit. */
    withCurrentPublication<T>(teamName: string, identityId: string, operation: (assertCurrent: () => void) => Promise<T>) {
      assertTeam(teamName);
      if (identityId !== binding.teamId) return Promise.resolve({ current: false as const, identity: { status: 'unavailable' as const } });
      return coordinator.workSyncIdentity.withCurrent(teamName, identityId, async () => {
        const assertCurrent = () => currentRead(() => {
          if (coordinator.isPermanentDeletionFencedSync(teamName, identityId)) throw new TeamOwnerError('hold');
          const config = store.read<Record<string, unknown>>('../config.json');
          if (!config || config.name !== teamName || config._backupIdentityId !== identityId) throw new TeamOwnerError('hold');
        });
        assertCurrent();
        const value = await operation(assertCurrent);
        assertCurrent();
        return value;
      });
    },
    /** Privileged storage publication; missing product config is not missing authoritative owner state. */
    assertProductPublicationCurrent(): void {
      options.assertWriter();
      store.fenced(() => {
        rawState();
        if (coordinator.isPermanentDeletionFencedSync(binding.teamName, binding.teamId)) throw new TeamOwnerError('hold');
        const config = store.read<Record<string, unknown>>('../config.json');
        if (config && (config.name !== binding.teamName || (config._backupIdentityId !== undefined && config._backupIdentityId !== binding.teamId))) throw new TeamOwnerError('hold');
      });
    },
    /** Shared new-work gate inside the same actual principal read fence; this grants no feature write permission. */
    assertWorkAllowed(): void { currentRead(() => assertTeamExecutionAllowed(rawState(), store)); },
  };
}
