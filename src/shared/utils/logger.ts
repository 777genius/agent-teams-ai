/**
 * Centralized logging utility for the application.
 *
 * Provides namespace-prefixed logging with environment-based filtering:
 * - Development: All log levels (DEBUG, INFO, WARN, ERROR)
 * - Production: Only ERROR logs are shown
 *
 * Usage:
 * ```typescript
 * import { createLogger } from '@shared/utils/logger';
 * const logger = createLogger('IPC:config');
 * logger.info('Config loaded');
 * logger.error('Failed to load config', error);
 * ```
 */

enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

/**
 * `diagnostic` is durable-only: it reaches every registered sink and never the
 * console. Use it for evidence that has to survive the process (a join key
 * another log line is correlated against, a decision an operator reconstructs
 * afterwards) but is not a problem report a developer should be shown.
 */
export type LogSinkLevel = 'diagnostic' | 'warn' | 'error';

export interface LogSinkEntry {
  timestamp: string;
  level: LogSinkLevel;
  namespace: string;
  args: readonly unknown[];
}

export type LogSink = (entry: LogSinkEntry) => void;

const logSinks = new Set<LogSink>();

/**
 * Register a process-local sink for durable warning/error diagnostics.
 *
 * Shared modules are bundled separately for Electron main and renderer, so a
 * sink installed by main cannot expose filesystem access to the renderer.
 */
export function addLogSink(sink: LogSink): () => void {
  logSinks.add(sink);
  return () => {
    logSinks.delete(sink);
  };
}

function emitToLogSinks(entry: LogSinkEntry): void {
  for (const sink of logSinks) {
    try {
      sink(entry);
    } catch {
      // Logging must never interfere with application behavior.
    }
  }
}

class Logger {
  private static level: LogLevel =
    process.env.NODE_ENV === 'production' ? LogLevel.ERROR : LogLevel.WARN;

  constructor(private namespace: string) {}

  debug(...args: unknown[]): void {
    if (Logger.level <= LogLevel.DEBUG) {
      console.debug(`[${this.namespace}]`, ...args);
    }
  }

  info(...args: unknown[]): void {
    if (Logger.level <= LogLevel.INFO) {
      console.log(`[${this.namespace}]`, ...args);
    }
  }

  /**
   * Durable diagnostic. Written to the log sinks at every log level and never
   * to the console.
   *
   * `info` cannot carry this: it is filtered out at the default level in both
   * development and production, and it never reaches a sink, so the evidence is
   * gone by the time anyone looks for it. `warn` can carry it, but only by
   * telling every developer about a line that is not a warning.
   */
  diagnostic(...args: unknown[]): void {
    emitToLogSinks({
      timestamp: new Date().toISOString(),
      level: 'diagnostic',
      namespace: this.namespace,
      args,
    });
  }

  warn(...args: unknown[]): void {
    emitToLogSinks({
      timestamp: new Date().toISOString(),
      level: 'warn',
      namespace: this.namespace,
      args,
    });
    if (Logger.level <= LogLevel.WARN) {
      console.warn(`[${this.namespace}]`, ...args);
    }
  }

  error(...args: unknown[]): void {
    emitToLogSinks({
      timestamp: new Date().toISOString(),
      level: 'error',
      namespace: this.namespace,
      args,
    });
    if (Logger.level <= LogLevel.ERROR) {
      console.error(`[${this.namespace}]`, ...args);
    }
  }

  /** Allow runtime level changes (for testing/debugging) */
  static setLevel(level: LogLevel): void {
    Logger.level = level;
  }

  static getLevel(): LogLevel {
    return Logger.level;
  }
}

export function createLogger(namespace: string): Logger {
  return new Logger(namespace);
}

export type { Logger };
