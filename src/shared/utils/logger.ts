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

export type LogSinkLevel = 'warn' | 'error';

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
