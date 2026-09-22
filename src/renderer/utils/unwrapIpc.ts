import { createLogger } from '@shared/utils/logger';

const logger = createLogger('Renderer:unwrapIpc');

export class IpcError extends Error {
  constructor(
    public readonly operation: string,
    message: string,
    public readonly causeError?: unknown
  ) {
    super(message);
    this.name = 'IpcError';
  }
}

/** Error messages that represent expected transient states, not real failures. */
const EXPECTED_IPC_SIGNALS = ['TEAM_PROVISIONING', 'TEAM_DRAFT'];

export async function unwrapIpc<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (EXPECTED_IPC_SIGNALS.some((sig) => message.includes(sig))) {
      logger.debug(`[${operation}] ${message}`);
    } else {
      logger.error(`[${operation}] ${message}`);
    }
    throw new IpcError(operation, message, error);
  }
}
