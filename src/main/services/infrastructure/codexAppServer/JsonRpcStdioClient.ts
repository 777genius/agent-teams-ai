import { once } from 'node:events';
import readline from 'node:readline';

import { killProcessTree, spawnCli } from '@main/utils/childProcess';

interface JsonRpcLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

interface JsonRpcErrorPayload {
  code?: number;
  message?: string;
}

interface JsonRpcResponse<T> {
  id?: number;
  result?: T;
  error?: JsonRpcErrorPayload;
}

interface JsonRpcNotificationMessage {
  method?: string;
  params?: unknown;
}

export interface JsonRpcSession {
  request<TResult>(method: string, params?: unknown, timeoutMs?: number): Promise<TResult>;
  notify(method: string, params?: unknown): Promise<void>;
  onNotification(listener: (method: string, params: unknown) => void): () => void;
  close(): Promise<void>;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }) as Promise<T>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 8_000;

export class JsonRpcStdioClient {
  constructor(private readonly logger: JsonRpcLogger) {}

  async withSession<T>(
    options: {
      binaryPath: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
      requestTimeoutMs?: number;
      totalTimeoutMs?: number;
      label: string;
    },
    handler: (session: JsonRpcSession) => Promise<T>
  ): Promise<T> {
    const session = await this.openSession(options);
    const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;

    try {
      return await withTimeout(handler(session), totalTimeoutMs, options.label);
    } finally {
      await session.close();
    }
  }

  async openSession(options: {
    binaryPath: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    requestTimeoutMs?: number;
  }): Promise<JsonRpcSession> {
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const child = spawnCli(options.binaryPath, options.args, {
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const lineReader = readline.createInterface({ input: child.stdout! });
    child.stderr?.on('data', () => {
      // Keep stderr drained so warnings never block the pipe.
    });

    const pending = new Map<
      number,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timeoutId: ReturnType<typeof setTimeout>;
      }
    >();
    const notificationListeners = new Set<(method: string, params: unknown) => void>();

    let nextRequestId = 1;
    let closed = false;

    const rejectAll = (error: Error): void => {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timeoutId);
        entry.reject(error);
        pending.delete(id);
      }
    };

    const handleNotification = (message: JsonRpcNotificationMessage): void => {
      if (typeof message.method !== 'string' || message.method.length === 0) {
        return;
      }

      for (const listener of notificationListeners) {
        try {
          listener(message.method, message.params);
        } catch (error) {
          this.logger.warn('json-rpc notification listener failed', {
            error: error instanceof Error ? error.message : String(error),
            method: message.method,
          });
        }
      }
    };

    lineReader.on('line', (line) => {
      let message: JsonRpcResponse<unknown> & JsonRpcNotificationMessage;
      try {
        message = JSON.parse(line) as JsonRpcResponse<unknown> & JsonRpcNotificationMessage;
      } catch (error) {
        this.logger.warn('json-rpc stdio emitted non-json line', {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      if (typeof message.id === 'number') {
        const entry = pending.get(message.id);
        if (!entry) {
          return;
        }

        clearTimeout(entry.timeoutId);
        pending.delete(message.id);

        if (message.error) {
          entry.reject(new Error(message.error.message ?? 'Unknown JSON-RPC error'));
          return;
        }

        entry.resolve(message.result);
        return;
      }

      handleNotification(message);
    });

    child.once('error', (error) => {
      rejectAll(error instanceof Error ? error : new Error(String(error)));
    });

    child.once('exit', (code, signal) => {
      if (pending.size === 0) {
        return;
      }

      rejectAll(
        new Error(
          `JSON-RPC process exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'null'})`
        )
      );
    });

    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;

      rejectAll(new Error('JSON-RPC session closed'));
      notificationListeners.clear();
      lineReader.close();

      if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
        await new Promise<void>((resolve) => {
          try {
            child.stdin!.end(() => resolve());
          } catch {
            resolve();
          }
        });
      }

      killProcessTree(child);
      try {
        await once(child, 'close');
      } catch {
        this.logger.warn('json-rpc close wait failed');
      }
    };

    return {
      request: <TResult>(
        method: string,
        params?: unknown,
        timeoutMs = requestTimeoutMs
      ): Promise<TResult> =>
        new Promise<TResult>((resolve, reject) => {
          if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
            reject(new Error('JSON-RPC stdin is not available'));
            return;
          }

          const id = nextRequestId++;
          const timeoutId = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`JSON-RPC request timed out: ${method}`));
          }, timeoutMs);

          pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeoutId });

          child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
            if (!error) {
              return;
            }

            clearTimeout(timeoutId);
            pending.delete(id);
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        }),

      notify: async (method: string, params?: unknown): Promise<void> => {
        if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
          throw new Error('JSON-RPC stdin is not available');
        }

        await new Promise<void>((resolve, reject) => {
          child.stdin!.write(`${JSON.stringify({ method, params })}\n`, (error) => {
            if (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
              return;
            }
            resolve();
          });
        });
      },

      onNotification: (listener) => {
        notificationListeners.add(listener);
        return (): void => {
          notificationListeners.delete(listener);
        };
      },

      close,
    };
  }
}
