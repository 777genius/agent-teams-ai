import { runtimeDigest as digest } from '../runtime/identity.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { RuntimeBinding } from '../runtime/contracts.js';
import type { ExpectedLaunchMember } from '../team-launch/contracts.js';
import type { MemberActionInput, createLaunchMemberActions } from '../team-launch/memberActions.js';

type Actions = ReturnType<typeof createLaunchMemberActions>;
export interface MemberTransitionTarget {
  input: MemberActionInput;
  sourceBinding: RuntimeBinding;
  selected: ExpectedLaunchMember;
  actions: Actions;
  runtime: Pick<RuntimeOwner, 'stopSession' | 'readSession'>;
  /** Captured operator grant + original Team/run/member identity, exact epoch across awaits. */
  assertOriginalAuthority(): void;
  /** TeamLifecycleTransitions guard; restart only, cleanup/read remain usable while trashed. */
  assertNewWorkAllowed(): void;
  verifyNewWorkAllowed?(): Promise<void>;
  /** Original provider cleanup/endpoint revoke only, not current-member lookup after await. */
  retireOriginal(): Promise<boolean>;
  /** SDK-free endpoint retirement only when no Runtime allocation was proved. */
  retireUnallocated?(): Promise<boolean>;
  /** Synchronous rekey installs only the captured selected member; peers are never iterated. */
  installSelected(): void;
  /** Existing TeamLaunchOwner.startMember publishes its claim before Runtime native allocation. */
  startSelected(): Promise<void> | undefined;
}
const flights = new WeakMap<
  MemberTransitionTarget['runtime'],
  Map<string, { fingerprint: string; pending: Promise<ReturnType<Actions['lookup']>> }>
>();
/** No aggregate relaunch or checkpoint substitution. One original Stop, then one fresh selected entry. */
export function transitionRuntimeMember(target: MemberTransitionTarget) {
  const key = digest(target.sourceBinding),
    fingerprint = digest(target.input);
  let byMember = flights.get(target.runtime);
  if (!byMember) {
    byMember = new Map();
    flights.set(target.runtime, byMember);
  }
  const current = byMember.get(key);
  if (current)
    return current.fingerprint === fingerprint
      ? current.pending
      : Promise.reject(new RuntimeOwnerError('hold'));
  const pending = execute(target);
  byMember.set(key, { fingerprint, pending });
  const clear = () => {
    if (byMember.get(key)?.pending === pending) byMember.delete(key);
  };
  void pending.then(clear, clear);
  return pending;
}
async function execute(target: MemberTransitionTarget) {
  const { input, actions, runtime, sourceBinding } = target;
  target.assertOriginalAuthority();
  if (
    digest(sourceBinding) !== digest({ ...sourceBinding, generation: input.expectedGeneration }) ||
    sourceBinding.memberId !== input.memberId
  )
    throw new RuntimeOwnerError('conflict');
  // Reopened/lostACK calls are query-only. Never select a later generation or repeat native Stop/open.
  const known = actions.lookup(input.commandId);
  if (!known) throw new RuntimeOwnerError('conflict');
  if (digest(known.input) !== digest(input) || digest(known.selected) !== digest(target.selected))
    throw new RuntimeOwnerError('conflict');
  if (known.phase !== 'prepared') return known;
  if (input.action === 'restart') {
    target.assertNewWorkAllowed();
    await target.verifyNewWorkAllowed?.();
    target.assertOriginalAuthority();
  }
  if (known.noAllocation) {
    if (!actions.proveNoAllocation(input.commandId)) {
      actions.refusePrepared(input.commandId);
      throw new RuntimeOwnerError('hold');
    }
    const admitted = actions.request(input.commandId);
    if (!admitted.created) return admitted.record;
    // No original allocation exists: do not fabricate a Stop or physical closure.
    const metadata = runtime.readSession(sourceBinding);
    if (metadata.record?.phase === 'unopened')
      await runtime.stopSession(sourceBinding, target.assertOriginalAuthority);
    if (target.retireUnallocated && !(await target.retireUnallocated()))
      throw new RuntimeOwnerError('hold');
    target.assertOriginalAuthority();
    actions.unallocated(input.commandId);
    actions.publish(input.commandId);
    target.installSelected();
    return actions.lookup(input.commandId);
  }
  const before = runtime.readSession(sourceBinding);
  const record = before.record;
  // Definitive preselection refusal must not become an eternal requested action.
  // Never join/reissue an unrelated closing or abandoned close claim.
  if (
    !record ||
    !(
      (record.phase === 'allocated' && record.custody === 'owned' && before.attached) ||
      ((record.phase === 'closed' || record.phase === 'unopened') &&
        record.custody === 'released' &&
        !before.attached)
    )
  ) {
    actions.refusePrepared(input.commandId);
    throw new RuntimeOwnerError('hold');
  }
  const admitted = actions.request(input.commandId);
  if (!admitted.created) return admitted.record;
  // stopSession synchronously seals only this original Runtime before its first cleanup await.
  await runtime.stopSession(sourceBinding, target.assertOriginalAuthority);
  target.assertOriginalAuthority();
  const closed = () => {
    const observed = runtime.readSession(sourceBinding);
    return (
      observed.record?.phase === 'closed' &&
      observed.record.custody === 'released' &&
      !observed.attached
    );
  };
  if (!closed()) throw new RuntimeOwnerError('hold');
  // D cleanup and endpoint closure may fail even after logical stop; publication must wait for both.
  if (!(await target.retireOriginal())) throw new RuntimeOwnerError('hold');
  target.assertOriginalAuthority();
  if (input.action === 'restart') {
    target.assertNewWorkAllowed();
    await target.verifyNewWorkAllowed?.();
    target.assertOriginalAuthority();
  }
  actions.closed(input.commandId, closed);
  actions.publish(input.commandId);
  target.installSelected();
  if (input.action === 'restart') {
    target.assertNewWorkAllowed();
    await target.verifyNewWorkAllowed?.();
    target.assertNewWorkAllowed();
    const opening = target.startSelected();
    if (opening) await opening;
  }
  return actions.lookup(input.commandId);
}
