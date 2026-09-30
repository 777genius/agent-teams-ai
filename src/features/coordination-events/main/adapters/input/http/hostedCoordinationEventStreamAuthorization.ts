const ABORTED_AUTHORIZATION = Symbol('aborted_authorization');

export interface HostedCoordinationEventStreamCurrentAuthorization {
  isCurrent(): boolean | Promise<boolean>;
}

export async function hostedCoordinationEventStreamAuthorizationIsCurrent(
  authorization: HostedCoordinationEventStreamCurrentAuthorization,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) return false;
  try {
    const current = await new Promise<boolean | typeof ABORTED_AUTHORIZATION>((resolve, reject) => {
      const onAbort = (): void => resolve(ABORTED_AUTHORIZATION);
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(authorization.isCurrent())
        .then(resolve, reject)
        .finally(() => {
          signal.removeEventListener('abort', onAbort);
        });
      if (signal.aborted) onAbort();
    });
    return current !== ABORTED_AUTHORIZATION && current;
  } catch {
    return false;
  }
}
