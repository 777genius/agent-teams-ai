import { LaunchWorktreeError } from './worktreeContracts.js';
import type {
  LaunchWorktreeCapturePort,
  LaunchWorktreePlan,
  LaunchWorktreePort,
  OwnedWorktreeBinding,
} from './worktreeContracts.js';

/** Call after old Runtime obligations are resolved and the immutable launch capture is durable. */
export async function materializeWorktree(
  plan: LaunchWorktreePlan,
  git: LaunchWorktreePort,
  capture: LaunchWorktreeCapturePort
): Promise<OwnedWorktreeBinding> {
  capture.assertCurrent();
  const original = capture.read();
  const planDigest = git.digest(plan);
  if (
    git.digest(original.plan) !== planDigest ||
    (original.receipt && original.receipt.planDigest !== planDigest)
  ) {
    throw new LaunchWorktreeError('capture-plan-changed');
  }
  const receipt = original.receipt;
  if (receipt?.state === 'completed') {
    if (!receipt.binding) throw new LaunchWorktreeError('completed-binding-missing');
    await git.inspect(plan, receipt.binding);
    capture.assertCurrent();
    return receipt.binding;
  }
  // An interrupted checkout or post-checkout hook may still be running. Metadata is no terminal proof.
  if (receipt?.state === 'attempted') throw new LaunchWorktreeError('creation-outcome-uncertain');
  if (plan.reuse) {
    if (receipt) throw new LaunchWorktreeError('reuse-receipt-invalid');
    const proof = await git.inspect(plan, plan.reuse);
    capture.assertCurrent();
    if (proof.head !== plan.proof.head || proof.dirtyDigest !== plan.proof.dirtyDigest) {
      throw new LaunchWorktreeError('workspace-changed-since-capture');
    }
    capture.write({
      planDigest,
      state: 'completed',
      target: plan.reuse.target,
      binding: plan.reuse,
    });
    return plan.reuse;
  }
  const target = receipt?.target ?? git.reserve(plan);
  capture.assertCurrent();
  const reserved = receipt ?? {
    planDigest,
    state: 'reserved' as const,
    target,
  };
  if (!receipt) capture.write(reserved);
  const attempted = { planDigest, state: 'attempted' as const, target };
  capture.write(attempted, reserved);
  const binding = await git.create(plan, target, () => capture.assertCurrent());
  capture.assertCurrent();
  capture.write({ planDigest, state: 'completed', target, binding }, attempted);
  return binding;
}
