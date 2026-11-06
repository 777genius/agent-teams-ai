import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest as digest } from '../runtime/identity.js';
import type { MemberActionInput, createLaunchMemberActions } from '../team-launch/memberActions.js';
/** Captured launch has no configured entry. Only the actual launch's unclaimed/no-allocation proof can skip it. */
export function executeUnconfiguredSkip(
  options: {
    actions: ReturnType<typeof createLaunchMemberActions>;
    assertCurrent(): void;
    installSkipped(): void;
  },
  operation: 'prepare' | 'execute',
  input: MemberActionInput
) {
  options.assertCurrent();
  const { actions } = options,
    known = actions.lookup(input.commandId);
  if (known && digest(known.input) !== digest(input)) throw new RuntimeOwnerError('conflict');
  if (known && (operation === 'prepare' || known.phase !== 'prepared')) return known;
  if (input.action !== 'skip') throw new RuntimeOwnerError('hold');
  if (operation === 'prepare')
    return actions.prepare(input, { ...actions.source(input.memberId), skipped: true }).record;
  if (!known) throw new RuntimeOwnerError('conflict');
  if (!actions.proveNoAllocation(input.commandId)) {
    actions.refusePrepared(input.commandId);
    throw new RuntimeOwnerError('hold');
  }
  const requested = actions.request(input.commandId);
  if (!requested.created) return requested.record;
  options.assertCurrent();
  actions.unallocated(input.commandId);
  actions.publish(input.commandId);
  options.installSkipped();
  return actions.lookup(input.commandId);
}
