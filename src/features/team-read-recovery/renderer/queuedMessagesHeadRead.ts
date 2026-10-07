import type { RefreshTeamMessagesHeadResult } from '@renderer/store/team/teamMessagesCache';

export interface QueuedMessagesHeadRead {
  readonly result: Promise<RefreshTeamMessagesHeadResult>;
  start(): Promise<RefreshTeamMessagesHeadResult>;
}

/** Lets an older-page owner hand off to its queued head before awaiting that head. */
export function queueMessagesHeadRead(
  older: Promise<void>,
  read: () => Promise<RefreshTeamMessagesHeadResult>,
  release: () => void
): QueuedMessagesHeadRead {
  let resolve!: (
    value: RefreshTeamMessagesHeadResult | PromiseLike<RefreshTeamMessagesHeadResult>
  ) => void;
  let reject!: (reason: unknown) => void;
  const completion = new Promise<RefreshTeamMessagesHeadResult>((resolveResult, rejectResult) => {
    resolve = resolveResult;
    reject = rejectResult;
  });
  const result = completion.finally(release);
  let started = false;
  const start = (): Promise<RefreshTeamMessagesHeadResult> => {
    if (!started) {
      started = true;
      try {
        resolve(read());
      } catch (error) {
        reject(error);
      }
    }
    return result;
  };
  // Do not adopt result into an ignored derived promise: its rejection belongs to callers.
  void older.then(() => {
    void start();
  }, reject);
  return { result, start };
}
