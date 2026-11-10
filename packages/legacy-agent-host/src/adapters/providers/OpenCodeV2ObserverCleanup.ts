/**
 * Guards abandonment of a single-claim native V2 EventFeed observer.
 * A native close failure cannot bypass generator finalization, and the
 * captured physical-stop confirmation remains authoritative.
 */
export function guardOpenCodeV2ObserverCleanup<Event>(
  stream: AsyncGenerator<Event, void, unknown>,
  closeNativeFeed: () => Promise<unknown>,
  finishOwned: () => Promise<boolean>,
): AsyncGenerator<Event, void, unknown> {
  const finalizeAfterClose = <Result>(finalize: () => Promise<Result> | Result) =>
    finalizeOpenCodeV2ObserverAfterClose(closeNativeFeed, finalize);

  // return() queues behind pending next() and may skip finally before the
  // first next(); wake the private feed and stop the owner first.
  const underlyingReturn = stream.return.bind(stream);
  stream.return = async () => {
    const stopping = finishOwned();
    try {
      await finalizeAfterClose(() => underlyingReturn(undefined));
    } finally {
      if (!await stopping) throw new Error('opencode.v2.owner-cleanup-unknown');
    }
    return { done: true as const, value: undefined };
  };

  const underlyingThrow = stream.throw.bind(stream);
  stream.throw = async (error) => {
    const stopping = finishOwned();
    try {
      return await finalizeAfterClose(() => underlyingThrow(error));
    } finally {
      if (!await stopping)
        throw new Error('opencode.v2.owner-cleanup-unknown', { cause: error });
    }
  };
  return stream;
}

/**
 * Finalize a private single-claim iterator even when closing its native feed
 * rejects. The first close error is retained unless physical cleanup itself
 * is UNKNOWN (which the caller must report as the stronger custody failure).
 */
export async function finalizeOpenCodeV2ObserverAfterClose<Result>(
  closeNativeFeed: () => Promise<unknown>,
  finalize: () => Promise<Result> | Result,
): Promise<Result> {
  let closeFailure: { error: unknown } | undefined;
  try {
    await closeNativeFeed();
  } catch (error) {
    closeFailure = { error };
  }
  try {
    return await finalize();
  } finally {
    if (closeFailure) throw closeFailure.error;
  }
}
