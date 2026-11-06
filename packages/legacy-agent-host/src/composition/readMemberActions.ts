import { runtimeDigest as digest } from '../runtime/identity.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { RuntimeBinding } from '../runtime/contracts.js';
import type {
  createLaunchMemberActions,
  MemberActionRecord,
} from '../team-launch/memberActions.js';
export type MemberActionObservation =
  | { availability: 'unavailable' }
  | { availability: 'no-allocation' }
  | { availability: 'absent'; generation: string }
  | {
      availability: 'observed';
      generation: string;
      phase: 'unopened' | 'opening' | 'allocated' | 'closing' | 'closed' | 'held';
      custody: 'owned' | 'released' | 'unknown';
      attached: boolean;
    };
/** Read exact immutable source/selected records. Missing read authority/backing never means released. */
export function readMemberActionView(
  read: ReturnType<ReturnType<typeof createLaunchMemberActions>['read']>,
  action: MemberActionRecord,
  runtime: Pick<RuntimeOwner, 'readSession'>
) {
  const observe = (binding: RuntimeBinding): MemberActionObservation => {
    try {
      const state = runtime.readSession(binding);
      return state.record
        ? {
            availability: 'observed',
            generation: binding.generation,
            phase: state.record.phase,
            custody: state.record.custody,
            attached: state.attached,
          }
        : { availability: 'absent', generation: binding.generation };
    } catch {
      return { availability: 'unavailable' };
    }
  };
  const selected = action.phase === 'selected';
  return {
    commandId: action.input.commandId,
    launchId: action.input.launchId,
    memberId: action.input.memberId,
    action: action.input.action,
    rosterRevision: action.input.rosterRevision,
    allocation: action.noAllocation ? ('none' as const) : ('runtime' as const),
    sourceGeneration: action.source.binding?.generation ?? null,
    selectedGeneration: selected ? (action.selected.binding?.generation ?? null) : null,
    stage:
      action.phase === 'closed'
        ? ('source-closed' as const)
        : action.phase === 'unallocated'
          ? ('source-unallocated' as const)
          : action.phase,
    current: digest(read.member) === digest(selected ? action.selected : action.source),
    source: action.source.binding
      ? observe(action.source.binding)
      : { availability: 'no-allocation' as const },
    selected: selected
      ? action.selected.binding
        ? observe(action.selected.binding)
        : { availability: 'no-allocation' as const }
      : null,
  };
}

export function readMemberActions(
  actions: ReturnType<typeof createLaunchMemberActions>,
  memberId: string,
  runtime: Pick<RuntimeOwner, 'readSession'>
) {
  const captured = actions.read(memberId);
  return {
    launchId: captured.launchId,
    rosterRevision: captured.rosterRevision,
    memberId,
    retries: captured.retries,
    actions: captured.actions.map((action) => readMemberActionView(captured, action, runtime)),
  };
}
