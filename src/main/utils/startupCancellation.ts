/** A shutdown interrupting startup is an expected lifecycle outcome. */
export class StartupCancelledError extends Error {
  constructor() {
    super('Application startup cancelled during shutdown');
    this.name = 'StartupCancelledError';
  }
}

export function assertStartupActive(isShutdownStarted: () => boolean): void {
  if (isShutdownStarted()) throw new StartupCancelledError();
}

type StartupStage = <T>(
  stage: () => Promise<T>,
  disposeCancelledResult?: (result: T) => void | Promise<void>
) => Promise<T>;

export function createStartupStage(isShutdownStarted: () => boolean): StartupStage {
  return <T>(
    stage: () => Promise<T>,
    disposeCancelledResult?: (result: T) => void | Promise<void>
  ): Promise<T> => runStartupStage(isShutdownStarted, stage, disposeCancelledResult);
}

/** Admit a stage only while active and never publish its result after shutdown. */
export async function runStartupStage<T>(
  isShutdownStarted: () => boolean,
  stage: () => Promise<T>,
  disposeCancelledResult?: (result: T) => void | Promise<void>
): Promise<T> {
  assertStartupActive(isShutdownStarted);
  let result: T;
  try {
    result = await stage();
  } catch (error) {
    assertStartupActive(isShutdownStarted);
    throw error;
  }
  if (isShutdownStarted()) {
    await disposeCancelledResult?.(result);
    throw new StartupCancelledError();
  }
  return result;
}
