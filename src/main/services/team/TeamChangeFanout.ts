import type { TeamChangeEvent } from '@shared/types';

export interface TeamChangeFanoutLogger {
  warn(message: string, metadata?: Record<string, unknown>): void;
}

export interface TeamChangeObserver {
  name: string;
  notify(event: TeamChangeEvent): void;
}

export function notifyTeamChangeObserversSafely(
  event: TeamChangeEvent,
  observers: readonly TeamChangeObserver[],
  logger?: TeamChangeFanoutLogger
): void {
  for (const observer of observers) {
    try {
      observer.notify(event);
    } catch (error) {
      try {
        logger?.warn('team change observer failed', {
          observer: observer.name,
          teamName: event.teamName,
          type: event.type,
          detail: event.detail,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Keep fanout best-effort even if logging fails.
      }
    }
  }
}
