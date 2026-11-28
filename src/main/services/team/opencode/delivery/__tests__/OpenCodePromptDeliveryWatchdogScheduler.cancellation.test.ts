// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS } from '../OpenCodePromptDeliveryWatchdog';
import {
  OpenCodePromptDeliveryWatchdogScheduler,
  type OpenCodePromptDeliveryWatchdogSchedulerDependencies as Dependencies,
} from '../OpenCodePromptDeliveryWatchdogScheduler';

const target = { teamName: 'TEST-team', memberName: 'TEST-member' };
const empty = { timers: 0, queued: 0, inFlight: 0 };
const cleanups: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers();
  vi.useRealTimers();
});
function make(overrides: Partial<Dependencies>) {
  const deps: Dependencies = {
    canDeliverToTeamRuntime: () => true,
    recoverBeforeDelivery: async () => false,
    relay: async () => undefined,
    getInboxMessages: async () => [],
    resolveIdentity: async () => ({ ok: true, laneId: 'TEST-lane' }),
    isLaneActive: async () => true,
    isRecordNotFoundError: () => false,
    info: () => {},
    warn: () => {},
    debug: () => {},
    diagnostic: () => {},
    getErrorMessage: String,
    ...overrides,
  };
  const scheduler = new OpenCodePromptDeliveryWatchdogScheduler(deps);
  cleanups.push(() => scheduler.cancelTeam(target.teamName));
  return { scheduler, facts: () => scheduler.readStoppedTeamImportFacts(target.teamName) };
}
function gate() {
  const value = Promise.withResolvers<void>();
  cleanups.push(() => value.resolve());
  return value;
}

it('cancels pending busy reads and releases their scopes without losing a replacement', () => {
  const f = make({});
  const original = f.scheduler.captureCancellation(target.teamName);
  expect(original.isCurrent()).toBe(true);
  expect(f.facts()).toEqual(empty);
  f.scheduler.cancelTeam(target.teamName);
  expect(original.isCurrent()).toBe(false);
  const replacement = f.scheduler.captureCancellation(target.teamName);
  original.release();
  original.release();
  expect(replacement.isCurrent()).toBe(true);
  f.scheduler.cancelTeam(target.teamName);
  expect(replacement.isCurrent()).toBe(false);
  replacement.release();
  expect(f.facts()).toEqual(empty);
});

it('releases a completed busy read without revoking its admitted unscoped wake', async () => {
  const relay = vi.fn(async () => undefined);
  const f = make({ relay });
  const scope = f.scheduler.captureCancellation(target.teamName);
  f.scheduler.schedule({ ...target, messageId: 'original', delayMs: 500 });
  scope.release();
  expect(f.facts()).toEqual({ ...empty, timers: 1 });
  await vi.advanceTimersByTimeAsync(500);
  expect(relay).toHaveBeenCalledOnce();
  expect(f.facts()).toEqual(empty);
  f.scheduler.cancelTeam(target.teamName);
  expect(scope.isCurrent()).toBe(true); // Released captures are no longer retained by the scheduler.
});

it.each(
  (['inbox', 'recovery', 'relay'] as const).flatMap((boundary) =>
    [false, true].map((cancelled) => ({ boundary, cancelled }))
  )
)(
  'cancel=$cancelled during $boundary keeps real inFlight and admits a fresh replacement',
  async ({ boundary, cancelled }) => {
    const pending = gate(),
      calls: string[] = [],
      effects: string[] = [];
    let current = true,
      recoveries = 0,
      relayCurrent: (() => boolean) | undefined;
    const f = make({
      canDeliverToTeamRuntime: () => boundary !== 'recovery',
      recoverBeforeDelivery: () =>
        ++recoveries === 1 ? pending.promise.then(() => true) : Promise.resolve(true),
      getInboxMessages: () => pending.promise.then(() => [{ messageId: 'original', read: false }]),
      relay: async ({ messageId, isCurrent }) => {
        calls.push(messageId);
        if (messageId === 'original' && boundary === 'relay') {
          relayCurrent = isCurrent;
          await pending.promise;
        }
        if (isCurrent?.() !== false) effects.push(messageId);
      },
    });
    f.scheduler.schedule({
      ...target,
      messageId: 'original',
      delayMs: 500,
      ...(boundary === 'inbox' ? { isCurrent: () => current } : {}),
    });
    current = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.facts()).toEqual({ timers: 0, queued: 0, inFlight: 1 });
    if (cancelled) f.scheduler.cancelTeam(target.teamName);
    expect(f.facts()).toEqual({ timers: 0, queued: 0, inFlight: 1 });
    if (boundary === 'relay') expect(relayCurrent?.() !== false).toBe(!cancelled);
    f.scheduler.schedule({ ...target, messageId: 'replacement', delayMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(f.facts()).toEqual({ timers: 0, queued: 1, inFlight: 1 });
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.facts()).toEqual({ ...empty, timers: boundary === 'inbox' && !cancelled ? 1 : 0 });
    await vi.advanceTimersByTimeAsync(OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS);
    const expected = cancelled
      ? ['replacement']
      : boundary === 'inbox'
        ? ['replacement', 'original']
        : ['original', 'replacement'];
    expect(effects).toEqual(expected);
    expect(calls).toEqual(
      boundary === 'relay' && cancelled ? ['original', 'replacement'] : expected
    );
    expect(f.facts()).toEqual(empty);
  }
);

it('old finally preserves the replacement token and cancelled forwarded guards cannot re-enter', async () => {
  const original = gate(),
    replacement = gate(),
    guards = new Map<string, () => boolean>();
  const f = make({
    relay: async ({ messageId, isCurrent }) => {
      expect(isCurrent).toBeTypeOf('function');
      guards.set(messageId, isCurrent!);
      await (messageId === 'original' ? original : replacement).promise;
    },
  });
  f.scheduler.schedule({ ...target, messageId: 'original', delayMs: 500 });
  await vi.advanceTimersByTimeAsync(500);
  f.scheduler.cancelTeam(target.teamName);
  f.scheduler.schedule({
    ...target,
    messageId: 'refused',
    delayMs: 500,
    isCurrent: guards.get('original')!,
  });
  expect(f.facts()).toEqual({ timers: 0, queued: 0, inFlight: 1 });
  f.scheduler.schedule({ ...target, messageId: 'replacement', delayMs: 500 });
  await vi.advanceTimersByTimeAsync(500);
  original.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(guards.get('replacement')?.()).toBe(true);
  expect(f.facts()).toEqual({ timers: 0, queued: 0, inFlight: 1 });
  f.scheduler.cancelTeam(target.teamName);
  expect(guards.get('replacement')?.()).toBe(false);
  expect(guards.get('original')?.()).toBe(false);
  replacement.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.facts()).toEqual(empty);
});
