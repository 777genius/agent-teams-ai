import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProcessExitEvidence, ProcessStartEvidence, SupervisorPlan } from '../processes';
import type { SelectedPlanAdmission } from './selected-plan-admission';
import type { SelectedProcessHandle } from './selected-kernel';
import { assertSelectedDirectProducerExit, assertSelectedDirectProducerObservation,
  observeSelectedDirectProducer, observeSelectedDirectProducerExit } from './selected-producer-observation';

test('direct producer start/exit claims cannot substitute a retained kernel handle', () => {
  let invoked = false;
  const forged: SelectedProcessHandle = {
    pid: process.pid, startTicks: '1', pidfdInode: '2', observedMonotonicNs: '3',
    isExited() { invoked = true; return true; },
    signal() { invoked = true; return true; },
    close() { invoked = true; },
  };
  const start = { pid: process.pid, startTime: '1', pidfdInode: '2' } as ProcessStartEvidence;
  const exit = { pidfdInode: '2' } as ProcessExitEvidence;
  assert.throws(() => assertSelectedDirectProducerObservation(start, forged),
    { message: 'selected_kernel_process_receipt' });
  assert.throws(() => assertSelectedDirectProducerExit(exit, forged),
    { message: 'selected_kernel_process_receipt' });
  assert.equal(invoked, false);
});

test('producer observation refuses deserialized plan admission before process inspection', async () => {
  const plan = {} as SupervisorPlan;
  const admission = {} as SelectedPlanAdmission;
  const handle = {} as SelectedProcessHandle;
  await assert.rejects(observeSelectedDirectProducer(plan, admission, 'opencode', handle,
    new AbortController().signal), { message: 'selected_supervisor_admission_receipt' });
  assert.throws(() => observeSelectedDirectProducerExit(plan, admission,
    {} as ProcessStartEvidence, handle), { message: 'selected_supervisor_admission_receipt' });
});
