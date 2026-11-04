import type { FastifyInstance, FastifyRequest } from 'fastify';

type ProfileResume = (() => Promise<void>) & {
  unchanged?(assertUnchanged: () => void): Promise<void>;
};
interface ProfileParticipant {
  /** Synchronously seal this registration without restarting or joining the transition tail. */
  closeAdmission?(): void;
  pause(request?: FastifyRequest): Promise<ProfileResume>;
}
/** No caller error, credential, configuration or path is included in an owner notification. */
export type ApiProfileTransitionFailure = Readonly<{
  code: 'API_PROFILE_TRANSITION_FAILED';
  phase: 'resume' | 'unchanged-restoration';
}>;
const participants = new Set<ProfileParticipant>();
let onOwnerFailure: ((status: ApiProfileTransitionFailure) => void) | undefined;
let afterMutation: () => Promise<void> | void = () => {};
let tail: Promise<void> = Promise.resolve();
let queued = 0;
let rootChangesSupported = true;
let ownerRevision = 0;
let ownerStopped = false;

export function configureApiProfileChanges(
  callback: () => Promise<void> | void,
  reportFailure?: (status: ApiProfileTransitionFailure) => void
): void {
  ++ownerRevision;
  ownerStopped = false;
  afterMutation = callback;
  onOwnerFailure = reportFailure;
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
  commit: (rejectBeforeMutation: (reason: unknown) => never) => T | Promise<T>,
  request?: FastifyRequest,
  lifecycle: {
    beforePause?(): void | Promise<void>;
    assertUnchanged?(): void;
    beforeResume?(): void | Promise<void>;
    afterResume?(): void | Promise<void>;
    /** Synchronous checkpoint after every resume and final owner validation succeeded. */
    onSuccess?(): void;
  } = {}
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
  const reportFailure = onOwnerFailure;
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
  let resumeStarted = false;
  tail = tail.then(async () => {
    const resumes: ProfileResume[] = [];
    const unchangedRejection = new Error('API profile change rejected before mutation');
    let rejectionReason: unknown;
    // Only a read-only guard inside the caller's exclusive commit section may use this signal.
    const rejectBeforeMutation = (reason: unknown): never => {
      rejectionReason = reason;
      throw unchangedRejection;
    };
    try {
      assertActive();
      await lifecycle.beforePause?.();
      assertActive();
      for (const participant of participants) {
        resumes.push(await participant.pause(request));
        assertActive();
      }
      const value = await commit(rejectBeforeMutation);
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
      resumeStarted = true;
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
      lifecycle.onSuccess?.();
      if (!request) resolve(value);
    } catch (error) {
      failed = true;
      failure = error === unchangedRejection ? rejectionReason : error;
      // Release the initiating HTTP handler before any unchanged resume joins its response drain.
      reject(failure);
      let restorationFailed = false;
      if (error === unchangedRejection) {
        try {
          assertActive();
          if (!lifecycle.assertUnchanged || resumes.some((resume) => !resume.unchanged))
            throw new Error('API profile unchanged restoration is unavailable');
          lifecycle.assertUnchanged();
          const outcomes = await Promise.allSettled(
            resumes.map(async (resume) => {
              assertActive();
              lifecycle.assertUnchanged!();
              await resume.unchanged!(() => {
                assertActive();
                lifecycle.assertUnchanged!();
              });
            })
          );
          const errors = outcomes.flatMap((outcome) =>
            outcome.status === 'rejected' ? [outcome.reason as unknown] : []
          );
          if (errors.length)
            throw new AggregateError(errors, 'API profile unchanged restoration failed');
          assertActive();
          lifecycle.assertUnchanged();
        } catch (restoreError) {
          restorationFailed = true;
          failure = new AggregateError(
            [failure, restoreError],
            'API profile rejection restoration failed'
          );
        }
      }
      if ((resumeStarted || restorationFailed) && !ownerStopped && revision === ownerRevision) {
        // Resuming can replace registrations. Seal the current participants, not captured old drains.
        let admissionClosureFailed = false;
        for (const participant of [...participants]) {
          try {
            participant.closeAdmission?.();
          } catch {
            admissionClosureFailed = true;
          }
        }
        if (admissionClosureFailed)
          failure = new AggregateError([failure], 'API profile admission closure failed');
        try {
          // A seal hook can synchronously dispose or replace the owner; never notify that old owner.
          if (ownerStopped || revision !== ownerRevision) return;
          // Synchronous state publication only: never join/cancel this same transition tail here.
          reportFailure?.(
            Object.freeze({
              code: 'API_PROFILE_TRANSITION_FAILED',
              phase: restorationFailed ? 'unchanged-restoration' : 'resume',
            })
          );
        } catch {
          // Reporter bugs cannot poison the queue or expose their arbitrary error contents.
          failure = new AggregateError([failure], 'API profile owner failure reporting failed');
        }
      }
      // Mutation, unknown failure and cancellation never reopen admission.
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
