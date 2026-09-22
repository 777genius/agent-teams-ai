import { MemberWorkSyncTeamOperationGate } from '@features/member-work-sync/core/application';
import { startScheduledDispatch } from '@features/member-work-sync/main/infrastructure/memberWorkSyncScheduledDispatchLifetime';
import { expect, it } from 'vitest';

it('drains descendants registered after logical result without waiting on its own team gate', async () => {
  const gate = new MemberWorkSyncTeamOperationGate();
  let releaseParent!: () => void;
  let releaseChild!: () => void;
  const parent = new Promise<void>((resolve) => {
    releaseParent = resolve;
  });
  const child = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const call = startScheduledDispatch((track) =>
    gate.run('sandbox', async (admission) => {
      const tail = parent.then(() => {
        track(child);
        admission.trackSettling(child);
      });
      track(tail);
      admission.trackSettling(tail);
      return 'logical result';
    })
  );
  expect(await call.result).toBe('logical result');
  let settled = false;
  void call.settled.then(() => {
    settled = true;
  });
  gate.beginTeamQuiesce('sandbox');
  let drained = false;
  const drain = gate.awaitTeamIdle('sandbox').then(() => {
    drained = true;
  });
  releaseParent();
  await parent;
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(drained).toBe(false);
  releaseChild();
  await Promise.all([call.settled, drain]);
  expect(settled).toBe(true);
  expect(drained).toBe(true);
});
