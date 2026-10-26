import { createLogger } from '@shared/utils/logger';

const logger = createLogger('App');
export const SHUTDOWN_STEP_TIMEOUT_MS = 5_000;

export async function runShutdownStep(
  label: string,
  action: () => void | Promise<void>,
  timeoutMs: number | null = SHUTDOWN_STEP_TIMEOUT_MS
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  logger.diagnostic('Shutdown step wait started', { label });
  try {
    if (timeoutMs === null) return void (await action()); // Caller already supplies a finite drain.
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
    logger.diagnostic('Shutdown step wait finished', { label });
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
