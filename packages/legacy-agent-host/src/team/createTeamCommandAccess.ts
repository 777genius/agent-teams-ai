import { createTeamWorkSyncCommands } from '../work-sync/TeamWorkSyncCommands.js';
import { continueTeamLifecycleCleanup } from './continueTeamLifecycleCleanup.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import { TeamQueuedMessages } from './TeamQueuedMessages.js';
import type { CommandReceipt, DeliveryIntent, TeamRuntimeDeliveryPort } from './contracts.js';
import { TeamLifecycleTransitions } from './TeamLifecycleTransitions.js';
import { assertTeamExecutionAllowed } from './teamLifecycleAdmission.js';
import { memberBinding } from './DeliveryRecovery.js';
import type { TeamRuntimeBindings } from './ports.js';
import type { ImmutableDelivery } from './contracts.js';
import { createTeamReviewCommands } from './TeamReviewCommands.js';
import { createTeamCrossTeamCommands } from '../cross-team/TeamCrossTeamCommands.js';
import { createTeamProcessCommands } from '../process/TeamProcessCommands.js';
import { listTeamCommandEntries } from './commandEntries.js';
import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';
import type { TeamBinding, TeamGrant } from './contracts.js';
import type { OwnerState } from './ownerState.js';
import type { TeamStore, TeamPolicyPort } from './ports.js';
import type {
  RegisteredProcessNative,
  RegistrarBinding,
} from '../process/registeredProcessContracts.js';

export interface TeamProcessRuntimeAccess {
  native?: RegisteredProcessNative;
  registrar?(): RegistrarBinding;
  assertCurrent?(): void;
}
/** Existing Team command families share the same original namespace/grant fence. */
export function createTeamCommandAccess(options: {
  store: TeamStore;
  binding: TeamBinding;
  policy: TeamPolicyPort;
  state(): OwnerState;
  authorize(principalId: string, permission: TeamGrant['permissions'][number]): TeamGrant;
  invalidate(): void;
  recoverConfig(state: OwnerState): void;
  ownsTaskIntent(intent: DeliveryIntent, receipt: CommandReceipt): boolean;
  runtimeBindings?: TeamRuntimeBindings | undefined;
}) {
  const reserved = (id: string) =>
    !!options.state().rosterCommands?.some((row) => row.commandId === id) ||
    !!options.state().runtimeCaptures?.some((row) => row.commandId === id);
  const lifecycle = new TeamLifecycleTransitions({ ...options, reserved,
    state() {
      options.state(); // Run existing validation/projection recovery, then retain the stored original delivery roots.
      const raw = options.store.read<OwnerState>('state.json');
      if (!raw || raw.ready !== true || digest(raw.binding) !== digest(options.binding)) throw new TeamOwnerError('hold');
      return raw;
    },
    captureRuntimeBindings(state) {
      const initial = [...state.members, ...(state.removedMembers ?? [])].flatMap(member => member.delivery ? [memberBinding(member.delivery)] : []);
      const captures = (state.runtimeCaptures ?? []).flatMap(capture => capture.members.map(member => memberBinding(member.delivery)));
      const current = initial.flatMap(binding => { const selected = options.runtimeBindings?.current(binding); return selected ? [selected.binding] : []; });
      return [...new Map([...initial, ...captures, ...current].map(binding => [digest(binding), binding])).values()];
    },
  });
  const queued = new TeamQueuedMessages({ ...options, reserved });
  const common = (principalId: string) => ({
    store: options.store,
    binding: options.binding,
    principalId,
    policy: options.policy,
    invalidate: options.invalidate,
    reserved,
    canReadAll: () => options.authorize(principalId, 'read').permissions.includes('admin'),
    authorize: (action: 'read' | 'control' | 'write') =>
      options.store.fenced(
        () =>
          options.authorize(
            principalId,
            action === 'control' ? 'admin' : action === 'write' ? 'message.write' : 'read'
          ).revision ?? 1
      ),
  });
  return {
    lifecycle: (principalId: string) => ({
      view: () => lifecycle.view(principalId),
      execute: (raw: unknown) => lifecycle.execute(principalId, raw),
      lookup: (commandId: string, expected: unknown) => lifecycle.lookup(principalId, commandId, expected),
    }),
    lifecycleContinuation: lifecycle,
    continueLifecycleCleanup: (commandId: string, runtime: Pick<RuntimeOwner, 'stopCapturedSession' | 'readCapturedSession'>, delivery: TeamRuntimeDeliveryPort) =>
      continueTeamLifecycleCleanup({ commandId, lifecycle, store: options.store, runtime, delivery }),
    recoverQueuedMessages: (runtime: TeamRuntimeDeliveryPort) => queued.recover(runtime),
    queuedMessages: (principalId: string, runtime: TeamRuntimeDeliveryPort) => ({
      list: (member: string) => queued.list(principalId, member, runtime),
      discard: (raw: unknown) => queued.discard(principalId, raw, runtime),
      lookup: (commandId: string, expected: unknown) => queued.lookup(principalId, commandId, expected),
    }),
    authorizeRetainedCancellation: (raw: ImmutableDelivery) => lifecycle.authorizeCancellation(raw) || queued.authorizeCancellation(raw),
    retractingRetainedDelivery: (raw: ImmutableDelivery) => queued.authorizeCancellation(raw, true),
    workSync: (principalId: string) => createTeamWorkSyncCommands(common(principalId)),
    review: (principalId: string) => createTeamReviewCommands(common(principalId)),
    crossTeam: (principalId: string) => createTeamCrossTeamCommands(common(principalId)),
    process(principalId: string, runtime: TeamProcessRuntimeAccess = {}) {
      const registry = options.policy.processes;
      if (!registry) throw new TeamOwnerError('hold');
      return createTeamProcessCommands({
        store: options.store,
        binding: options.binding,
        principalId,
        registry,
        digest,
        invalidate: options.invalidate,
        reserved,
        commandEntries: () => listTeamCommandEntries(options.store),
        authorize(action) {
          const grant = options.authorize(principalId, action);
          return { revision: grant.revision ?? 1, memberName: grant.memberName };
        },
        registrar() {
          assertTeamExecutionAllowed(options.state(), options.store);
          if (!runtime.registrar) throw new TeamOwnerError('forbidden');
          return runtime.registrar();
        },
        assertCurrent() {
          runtime.assertCurrent?.();
        },
        ...(runtime.native ? { native: runtime.native } : {}),
      });
    },
  };
}
