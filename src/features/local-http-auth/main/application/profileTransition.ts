import type { FastifyInstance, FastifyRequest } from 'fastify';

interface ProfileParticipant {
  pause(request?: FastifyRequest): Promise<() => Promise<void>>;
}
const participants = new Set<ProfileParticipant>();
let afterMutation: () => Promise<void> | void = () => {};
let tail: Promise<void> = Promise.resolve();
let queued = 0;
let rootChangesSupported = true;
let ownerRevision = 0;
let ownerStopped = false;

export function configureApiProfileChanges(callback: () => Promise<void> | void): void {
  ++ownerRevision;
  ownerStopped = false;
  afterMutation = callback;
}
/** Close owner admission synchronously and join callbacks/resumes before disposing their services. */
export function cancelApiProfileChanges(): Promise<void> {
  ownerStopped = true;
  ++ownerRevision;
  return tail;
}
export function disableApiProfileChanges(): void {
  rootChangesSupported = false;
}
export function registerProfileParticipant(participant: ProfileParticipant): () => void {
  participants.add(participant);
  return () => participants.delete(participant);
}

/** Existing callers observe the config response; lifecycle owners also join physical completion. */
export function runApiProfileChange<T>(
  commit: () => T | Promise<T>,
  request?: FastifyRequest
): Promise<T> {
  const change = scheduleApiProfileChange(commit, request);
  // HTTP responses can precede resume failure, which remains closed and is visible to the owner.
  void change.settled.catch(() => undefined);
  return change.result;
}

/** Serialize root changes; drain old handlers/streams before any global root or service mutation. */
export function scheduleApiProfileChange<T>(
  commit: () => T | Promise<T>,
  request?: FastifyRequest,
  lifecycle: { beforeResume?(): void | Promise<void>; afterResume?(): void | Promise<void> } = {}
): { result: Promise<T>; settled: Promise<void> } {
  const refused = (error: Error) => ({
    result: Promise.reject<T>(error),
    settled: Promise.resolve(),
  });
  if (ownerStopped) return refused(new Error('API profile changes have been cancelled'));
  if (!rootChangesSupported)
    return refused(
      new Error('Changing the profile root requires restarting the standalone server')
    );
  // A second HTTP root update cannot wait inside a handler that the first transition must drain.
  if (request && queued) return refused(new Error('An API profile change is already in progress'));
  const revision = ownerRevision;
  const callback = afterMutation;
  const assertActive = (): void => {
    if (ownerStopped || revision !== ownerRevision) throw new Error('API profile change cancelled');
  };
  ++queued;
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const result = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let failed = false;
  let failure: unknown;
  tail = tail.then(async () => {
    const resumes: Array<() => Promise<void>> = [];
    try {
      assertActive();
      for (const participant of participants) {
        resumes.push(await participant.pause(request));
        assertActive();
      }
      const value = await commit();
      assertActive();
      await callback();
      assertActive();
      await lifecycle.beforeResume?.();
      assertActive();
      if (request) {
        // The changing HTTP handler can now return its result; restart waits for that response too.
        resolve(value);
      }
      // A failing participant must not detach another participant's outstanding resume from the tail.
      const settled = await Promise.allSettled(
        resumes.map(async (resume) => {
          assertActive();
          await resume();
        })
      );
      const failures = settled.flatMap((outcome) =>
        outcome.status === 'rejected' ? [outcome.reason as unknown] : []
      );
      if (failures.length) throw new AggregateError(failures, 'API profile resume failed');
      assertActive();
      await lifecycle.afterResume?.();
      assertActive();
      if (!request) resolve(value);
    } catch (error) {
      failed = true;
      failure = error;
      reject(error);
      // A failed transition stays closed. Reopening requires an explicit successful start.
    } finally {
      --queued;
    }
  });
  const settled = tail.then(() => {
    if (failed) throw failure;
  });
  return { result, settled };
}

export class ProfileRequestDrain {
  private readonly active = new Set<FastifyRequest>();
  private readonly executing = new Set<FastifyRequest>();
  private readonly completedResponses = new WeakSet<FastifyRequest>();
  private readonly waiters = new Set<() => void>();
  paused = false;
  constructor(app: FastifyInstance) {
    app.addHook('onRequest', async (request, reply) => {
      if (this.paused) return reply.code(503).send({ error: 'API profile changing' });
      this.active.add(request);
    });
    const release = (request: FastifyRequest): void => {
      this.completedResponses.add(request);
      if (this.executing.has(request)) return;
      this.active.delete(request);
      for (const waiter of this.waiters) waiter();
    };
    // Socket completion is independent of async handler completion (abort or early send).
    // Preserve Fastify's child instance `this`, return values, and exception handling.
    const executing = this.executing;
    const completedResponses = this.completedResponses;
    app.addHook('onRoute', (route) => {
      const handler = route.handler;
      route.handler = async function (request, reply) {
        executing.add(request);
        try {
          return await handler.call(this, request, reply);
        } finally {
          executing.delete(request);
          if (completedResponses.has(request)) release(request);
        }
      };
    });
    app.addHook('onResponse', async (request) => release(request));
    app.addHook('onRequestAbort', async (request) => release(request));
  }
  wait(except?: FastifyRequest): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if ([...this.active].every((request) => request === except)) {
          this.waiters.delete(check);
          resolve();
        }
      };
      this.waiters.add(check);
      check();
    });
  }
}
