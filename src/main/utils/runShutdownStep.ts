export const SHUTDOWN_STEP_TIMEOUT_MS = 5_000;

export function createShutdownStepRunner(logger: {
  warn(message: string): void;
}): (label: string, action: () => void | Promise<void>, timeoutMs?: number) => Promise<void> {
  return async (label, action, timeoutMs = SHUTDOWN_STEP_TIMEOUT_MS) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;

    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            logger.warn(`Shutdown step timed out after ${timeoutMs}ms: ${label}`);
            resolve();
          }, timeoutMs);
          timeout.unref?.();
        }),
      ]);
    } catch (error) {
      logger.warn(
        `Shutdown step failed (${label}): ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  };
}
