// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hostTeamSelectionKey } from '@features/agent-backend/contracts';
import { JsonScheduleRepository } from '@main/services/schedule/JsonScheduleRepository';
import { SchedulerService } from '@main/services/schedule/SchedulerService';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { expect, it } from 'vitest';

import {
  ANNUAL_CRON, ARMED_AT, type CronerTestClock, OBSERVATION_END, TARGET_AT, withCronerTestClock,
} from './CronerTestClock';

/** Track public repository completion without replacing JSON persistence. */
function observedRepository() {
  const pending = new Set<Promise<unknown>>();
  const failures: unknown[] = [];
  const methods = new Set(['listSchedules', 'getSchedule', 'saveSchedule', 'updateSchedule', 'listRuns', 'saveRun']);
  const port = new Proxy(new JsonScheduleRepository(), {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || !methods.has(property) || typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        const operation = Reflect.apply(member, target, args) as Promise<unknown>;
        pending.add(operation);
        operation.then(() => pending.delete(operation), error => { pending.delete(operation); failures.push(error); });
        return operation;
      };
    },
  });
  return { port, async settle() {
    for (let turn = 0; turn < 32; turn++) {
      await Promise.allSettled([...pending]);
      // Drain continuations that start the next repository operation before
      // advancing the controlled clock. No action retry or private service call.
      await new Promise<void>(resolve => setImmediate(resolve));
      if (failures.length) throw failures[0];
      if (pending.size === 0) return;
    }
    throw new Error('Finite repository settlement budget exhausted');
  } };
}

async function fixture(clock: CronerTestClock, directory: string) {
  const repository = observedRepository();
  const dispatches: string[] = [];
  let oneShotCalls = 0;
  const scheduler = new SchedulerService(repository.port, {
    execute() { oneShotCalls++; return Promise.reject(new Error('No provider process is permitted')); },
    cancel() { return false; }, cancelAll() { /* This fixture never starts a one-shot process. */ },
  }, undefined, {
    supportsHost: true,
    assertCanSchedule() { return Promise.resolve(); },
    dispatch(_schedule, runId, isCancelled) {
      expect(isCancelled()).toBe(false);
      dispatches.push(runId);
      return Promise.resolve({ kind: 'dispatched' as const, taskId: `TEST-task-${runId}`, summary: 'TEST original occurrence' });
    },
  });
  clock.cleanup.push(async () => { await repository.settle(); await scheduler.stop(); await repository.settle(); });
  await scheduler.start();
  const target = { kind: 'host' as const, handleId: 'TEST-cron-handle', contextId: 'TEST-clock-context',
    ownerResourceRef: 'TEST-clock-owner', teamResourceRef: 'TEST-clock-team' };
  const admission = { target, isCurrent: () => true };
  const schedule = await scheduler.createSchedule({
    teamName: hostTeamSelectionKey(target.handleId), cronExpression: '0 0 1 1 *', timezone: 'UTC',
    warmUpMinutes: 0, executionMode: 'agent', taskFirst: true, reviewedSavedPrompt: true, targetMember: 'alice',
    launchConfig: { cwd: directory, prompt: 'TEST saved scheduled instructions' },
  }, admission);
  const manual = await scheduler.triggerNow(schedule.id);
  await repository.settle();
  expect(await scheduler.getRuns(schedule.id)).toMatchObject([{ id: manual.id, status: 'dispatched' }]);
  expect(dispatches).toHaveLength(1);
  const armed = await scheduler.updateSchedule(schedule.id, { cronExpression: ANNUAL_CRON }, admission);
  await repository.settle();
  expect(armed.nextRunAt).toBe(new Date(TARGET_AT).toISOString());
  expect(clock.pendingCount()).toBe(1);

  return { scheduler, schedule, manual, admission, dispatches, repository,
    oneShotCalls: () => oneShotCalls,
    async driveUntil(end: number) {
      for (let turn = 0; turn < 12; turn++) {
        await repository.settle();
        const due = clock.nextDue();
        if (due === undefined || due > end) { clock.moveTo(end); return; }
        await clock.fireNextAt(Math.max(clock.now(), due));
      }
      throw new Error('Finite scheduler timer budget exhausted');
    },
  };
}

const scenarios = [
  { name: 'normal automatic occurrence', mode: 'normal' },
  { name: 'clock crossing after the early check', mode: 'early-cross' },
  { name: 'clock crossing between delay and target calculation', mode: 'split-cross' },
  { name: 'Stop', mode: 'stop' },
  { name: 'pause and resume', mode: 'pause' },
  { name: 'replacement', mode: 'replace' },
];

it.each(scenarios)('retains exact public history across $name', async ({ mode }) => {
  const directory = await mkdtemp(join(tmpdir(), 'TEST-croner-scheduler-public-'));
  setClaudeBasePathOverride(directory);
  try {
    await withCronerTestClock(async clock => {
      const f = await fixture(clock, directory);
      if (mode === 'replace') {
        clock.moveTo(ARMED_AT + 5000);
        const updated = await f.scheduler.updateSchedule(f.schedule.id,
          { cronExpression: '53 9 15 21 11 *' }, f.admission);
        await f.repository.settle();
        expect(updated.nextRunAt).toBe('2026-11-21T15:09:53.000Z');
      } else {
        await clock.fireNextAt(ARMED_AT + 30_000);
        await f.repository.settle();
        expect(clock.nextDue()).toBe(TARGET_AT);
        switch (mode) {
          case 'early-cross':
            await clock.fireNextAt(TARGET_AT - 1, [TARGET_AT - 1, TARGET_AT + 1]); break;
          case 'split-cross':
            await clock.fireNextAt(TARGET_AT - 1,
              [TARGET_AT - 1, TARGET_AT - 1, TARGET_AT - 1, TARGET_AT + 1]); break;
          case 'stop': await f.scheduler.stop(); break;
          case 'pause': await f.scheduler.pauseSchedule(f.schedule.id); break;
        }
      }
      await f.driveUntil(OBSERVATION_END);
      if (mode === 'pause') {
        await f.scheduler.resumeSchedule(f.schedule.id);
        await f.driveUntil(OBSERVATION_END + 1000);
      }
      await f.repository.settle();
      const history = await f.scheduler.getRuns(f.schedule.id);
      const shouldRun = mode !== 'stop' && mode !== 'pause';
      expect(history).toHaveLength(shouldRun ? 2 : 1);
      expect(f.dispatches).toHaveLength(shouldRun ? 2 : 1);
      expect(history.filter(row => row.id === f.manual.id)).toHaveLength(1);
      expect(history.every(row => row.status === 'dispatched')).toBe(true);
      expect(f.oneShotCalls()).toBe(0);
      if (shouldRun) {
        const automatic = history.find(row => row.id !== f.manual.id)!;
        const expected = mode === 'replace' ? TARGET_AT + 1000 : TARGET_AT;
        expect(Date.parse(automatic.scheduledFor)).toBeGreaterThanOrEqual(expected);
        expect(Date.parse(automatic.scheduledFor)).toBeLessThan(expected + 15_000);
        expect(automatic.hostTarget).toEqual(f.admission.target);
      }
    });
  } finally {
    setClaudeBasePathOverride(null);
    await rm(directory, { recursive: true, force: true });
  }
});
