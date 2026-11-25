import { performance } from 'node:perf_hooks';

type ReadPhase = 'initial' | 'after-hover' | 'stable';
type ReadOperation = 'owner' | 'evaluate';
type ActionOperation = 'bringToFront' | 'postInitialOwner' | 'hoverDispatch' | 'pressDispatch' | 'releaseDispatch';
type Stamp = number | null;
interface Span {
  started: number;
  resolved: number;
  firstStartMs: Stamp;
  lastStartMs: Stamp;
  lastEndMs: Stamp;
  totalMs: number;
  maxMs: number;
}
interface Phase {
  phase: ReadPhase;
  waitCalls: number;
  firstDeadlineMs: Stamp;
  lastDeadlineMs: Stamp;
  firstCheckAtMs: Stamp;
  lastCheckAtMs: Stamp;
  firstCheckMonoMs: Stamp;
  lastCheckMonoMs: Stamp;
  owner: Span;
  evaluate: Span;
  overflow: boolean;
}
interface Action extends Record<ActionOperation, Span> {
  action: 'open-team' | 'open-launch';
  originalDeadlineMs: Stamp;
  deadlineRecordedMonoMs: Stamp;
  reads: [Phase, Phase, Phase];
  overflow: boolean;
}
export interface DesktopReadTiming {
  begin(deadline: number): void;
  check(at: number): void;
  start(operation: ReadOperation): void;
  end(operation: ReadOperation): void;
}
export interface DesktopActionTiming {
  deadline(at: number): void;
  start(operation: ActionOperation): void;
  end(operation: ActionOperation): void;
  reads: Record<ReadPhase, DesktopReadTiming>;
}

const COUNTER_CAP = 4096;
const stamp = (value: number): Stamp => Number.isSafeInteger(value) && value >= 0 ? value : null;
const span = (): Span => ({ started: 0, resolved: 0, firstStartMs: null, lastStartMs: null,
  lastEndMs: null, totalMs: 0, maxMs: 0 });
const phase = (name: ReadPhase): Phase => ({ phase: name, waitCalls: 0, firstDeadlineMs: null,
  lastDeadlineMs: null, firstCheckAtMs: null, lastCheckAtMs: null, firstCheckMonoMs: null,
  lastCheckMonoMs: null, owner: span(), evaluate: span(), overflow: false });
const action = (name: Action['action']): Action => ({ action: name, originalDeadlineMs: null,
  deadlineRecordedMonoMs: null, bringToFront: span(), postInitialOwner: span(), hoverDispatch: span(),
  pressDispatch: span(), releaseDispatch: span(), reads: [phase('initial'), phase('after-hover'), phase('stable')],
  overflow: false });

/** Fixed scalar observations only. Overflow also marks an unavailable clock/slot. */
export function createDesktopOriginalActionReadTiming(clock: () => number = () => performance.now()) {
  const data = { schemaVersion: 1, clock: 'node-performance-ms' as const,
    actions: [action('open-team'), action('open-launch')] as [Action, Action] };
  const now = (): Stamp => {
    try { return stamp(Math.round(clock())); } catch { return null; }
  };
  const recorder = <Operation extends string>(spans: Record<Operation, Span>,
    unavailable: () => void, blocked: () => boolean = () => false) => {
    const slots = new Map(Object.entries(spans).map(([key, value]) =>
      [key, { span: value as Span, start: null as Stamp, blocked: false }]));
    const mark = (operation: Operation, finish: boolean): void => {
      let slot: { span: Span; start: Stamp; blocked: boolean } | undefined;
      try {
        slot = slots.get(operation);
        if (!slot || slot.blocked || blocked()) return;
        const count = finish ? slot.span.resolved : slot.span.started;
        if (count >= COUNTER_CAP) { slot.blocked = true; unavailable(); return; }
        const at = now();
        if (at === null) { slot.blocked = true; unavailable(); return; }
        if (!finish) {
          slot.span.started++; slot.span.firstStartMs ??= at; slot.span.lastStartMs = at;
          slot.start = at;
          return;
        }
        if (slot.start === null || at < slot.start) { slot.blocked = true; unavailable(); return; }
        const elapsed = at - slot.start;
        slot.span.resolved++; slot.span.lastEndMs = at; slot.span.maxMs = Math.max(slot.span.maxMs, elapsed);
        slot.start = null;
        if (elapsed > Number.MAX_SAFE_INTEGER - slot.span.totalMs) {
          slot.span.totalMs = Number.MAX_SAFE_INTEGER; slot.blocked = true; unavailable();
        } else slot.span.totalMs += elapsed;
      } catch {
        if (slot) slot.blocked = true;
        // Even a failed observer write must leave the original operation/error alone.
        try { unavailable(); } catch { /* A frozen observation cannot replace the original error. */ }
      }
    };
    return { start: (operation: Operation) => mark(operation, false), end: (operation: Operation) => mark(operation, true) };
  };
  const read = (value: Phase): DesktopReadTiming => {
    let blocked = false;
    const unavailable = () => { value.overflow = true; };
    const spans = recorder<ReadOperation>({ owner: value.owner, evaluate: value.evaluate }, unavailable, () => blocked);
    return {
      ...spans,
      begin(deadline) {
        try {
          if (blocked) return;
          const at = stamp(deadline);
          if (value.waitCalls >= COUNTER_CAP || at === null) { blocked = true; unavailable(); return; }
          value.waitCalls++; value.firstDeadlineMs ??= at; value.lastDeadlineMs = at;
        } catch { blocked = true; try { unavailable(); } catch { /* Observation only. */ } }
      },
      check(at) {
        try {
          if (blocked) return;
          const wall = stamp(at), mono = now();
          if (wall === null || mono === null || value.lastCheckMonoMs !== null && mono < value.lastCheckMonoMs) {
            blocked = true; unavailable(); return;
          }
          value.firstCheckAtMs ??= wall; value.lastCheckAtMs = wall;
          value.firstCheckMonoMs ??= mono; value.lastCheckMonoMs = mono;
        } catch { blocked = true; try { unavailable(); } catch { /* Observation only. */ } }
      },
    };
  };
  const controller = (value: Action): DesktopActionTiming => {
    const unavailable = () => { value.overflow = true; };
    const spans = recorder<ActionOperation>({ bringToFront: value.bringToFront,
      postInitialOwner: value.postInitialOwner, hoverDispatch: value.hoverDispatch,
      pressDispatch: value.pressDispatch, releaseDispatch: value.releaseDispatch }, unavailable);
    let deadlineUnavailable = false;
    return {
      ...spans,
      reads: { initial: read(value.reads[0]), 'after-hover': read(value.reads[1]), stable: read(value.reads[2]) },
      deadline(at) {
        try {
          if (deadlineUnavailable) return;
          const wall = stamp(at), mono = now();
          if (wall === null || mono === null || value.originalDeadlineMs !== null) {
            deadlineUnavailable = true; unavailable(); return;
          }
          value.originalDeadlineMs = wall; value.deadlineRecordedMonoMs = mono;
        } catch { deadlineUnavailable = true; try { unavailable(); } catch { /* Observation only. */ } }
      },
    };
  };
  return { data, openTeam: controller(data.actions[0]), openLaunch: controller(data.actions[1]) };
}

/** The original read loop; observation never supplies readiness or deadline inputs. */
export function createDesktopReadWait(
  cdp: { evaluate(expression: string): Promise<unknown> },
  options: { assertOwnedRenderer(): void }
) {
  return async (
    expression: string,
    label: string,
    timeoutMs = 30_000,
    isReady: (value: unknown) => boolean = Boolean,
    readOptions?: { deadline: number; beforeRead?(): Promise<void> },
    diagnosticPhase: 'initial' | 'after-hover' | 'stable' | 'other' = 'other',
    timing?: DesktopReadTiming
  ): Promise<unknown> => {
    const deadline = readOptions?.deadline ?? Date.now() + timeoutMs;
    timing?.begin(deadline);
    const observation = {
      phase: ['initial', 'after-hover', 'stable'].includes(diagnosticPhase) ? diagnosticPhase : 'other',
      boundary: 'loop', cutoff: 'none', firstCheckAtMs: null as number | null, lastCheckAtMs: null as number | null,
      ownerStarted: 0, ownerResolved: 0, preparationStarted: 0, preparationResolved: 0,
      readsStarted: 0, readsResolved: 0, postReadLate: 0, contextRetries: 0,
    };
    const checkTime = (): number => {
      const now = Date.now();
      observation.firstCheckAtMs ??= now; observation.lastCheckAtMs = now;
      timing?.check(now);
      return now;
    };
    try {
      while (checkTime() < deadline) {
        observation.boundary = 'owner'; observation.ownerStarted = Math.min(observation.ownerStarted + 1, 4096);
        timing?.start('owner');
        options.assertOwnedRenderer();
        timing?.end('owner');
        observation.ownerResolved = Math.min(observation.ownerResolved + 1, 4096);
        if (readOptions?.beforeRead) {
          // Preparation failures are terminal, including context-like input errors.
          observation.boundary = 'preparation'; observation.preparationStarted = Math.min(observation.preparationStarted + 1, 4096);
          await readOptions.beforeRead();
          observation.preparationResolved = Math.min(observation.preparationResolved + 1, 4096);
          observation.boundary = 'owner'; observation.ownerStarted = Math.min(observation.ownerStarted + 1, 4096);
          timing?.start('owner');
          options.assertOwnedRenderer();
          timing?.end('owner');
          observation.ownerResolved = Math.min(observation.ownerResolved + 1, 4096);
          if (checkTime() >= deadline) { observation.cutoff = 'after-preparation'; break; }
        }
        try {
          observation.boundary = 'evaluate'; observation.readsStarted = Math.min(observation.readsStarted + 1, 4096);
          timing?.start('evaluate');
          const value = await cdp.evaluate(expression);
          timing?.end('evaluate');
          observation.readsResolved = Math.min(observation.readsResolved + 1, 4096);
          if (checkTime() >= deadline) { observation.cutoff = 'after-evaluate'; observation.postReadLate++; break; }
          observation.boundary = 'predicate';
          if (isReady(value)) return value;
        } catch (error) {
          if (
            !/execution context was destroyed|cannot find (?:default )?execution context|cannot find context with specified id/i.test(
              String(error)
            )
          )
            throw error;
          observation.contextRetries = Math.min(observation.contextRetries + 1, 4096);
        }
        observation.boundary = 'pause';
        await new Promise<void>((done) => setTimeout(done, 100));
      }
      if (observation.cutoff === 'none') observation.cutoff = 'loop';
      throw new Error(`UI read timed out: ${label}; no mutation retry`);
    } catch (error) {
      try {
        const stamp = (value: number | null): number | null =>
          typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
        console.log(JSON.stringify({ kind: 'TEST_DESKTOP_READ_WAIT', read: {
          ...observation, deadlineMs: stamp(deadline),
          firstCheckAtMs: stamp(observation.firstCheckAtMs), lastCheckAtMs: stamp(observation.lastCheckAtMs),
        } }));
      } catch {
        // Reporting uses no extra clock, owner or DOM read and cannot replace the original refusal.
      }
      throw error;
    }
  };
}
