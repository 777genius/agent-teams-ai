import { yieldToEventLoop } from '@main/utils/asyncYield';

export interface TeamReconcileTrigger {
  source: 'inbox' | 'task';
  detail: string;
}

interface TeamReconcileDrainState {
  running: boolean;
  pending: boolean;
  lastTrigger: TeamReconcileTrigger | null;
}

const DEFAULT_TEAM_RECONCILE_DRAIN_RUN_TIMEOUT_MS = 2 * 60_000;

export interface TeamReconcileDrainScheduler {
  schedule(teamName: string, trigger: TeamReconcileTrigger): void;
  dispose(): void;
}

class TeamReconcileDrainTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamReconcileDrainTimeoutError';
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

async function runWithTimeout(options: {
  run: () => Promise<void>;
  timeoutMs: number;
  teamName: string;
  trigger: TeamReconcileTrigger;
}): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      options.run(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new TeamReconcileDrainTimeoutError(
              `team reconcile drain timed out for ${options.teamName} source=${options.trigger.source} detail=${options.trigger.detail} after ${options.timeoutMs}ms`
            )
          );
        }, options.timeoutMs);
        unrefTimer(timeout);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function createTeamReconcileDrainScheduler(options: {
  run: (teamName: string, trigger: TeamReconcileTrigger) => Promise<void>;
  runTimeoutMs?: number;
}): TeamReconcileDrainScheduler {
  const states = new Map<string, TeamReconcileDrainState>();
  const runTimeoutMs = Math.max(
    1,
    options.runTimeoutMs ?? DEFAULT_TEAM_RECONCILE_DRAIN_RUN_TIMEOUT_MS
  );
  let disposed = false;

  const drainTeam = async (teamName: string): Promise<void> => {
    const state = states.get(teamName);
    if (!state || state.running || disposed) {
      return;
    }

    state.running = true;
    let failed = false;

    try {
      while (!disposed && state.pending) {
        state.pending = false;
        const trigger = state.lastTrigger;
        if (!trigger) {
          break;
        }

        try {
          await runWithTimeout({
            run: () => options.run(teamName, trigger),
            timeoutMs: runTimeoutMs,
            teamName,
            trigger,
          });
        } catch (error) {
          failed = true;
          if (error instanceof TeamReconcileDrainTimeoutError && !state.pending) {
            state.pending = true;
            state.lastTrigger = trigger;
          }
          throw error;
        } finally {
          if (!disposed) {
            await yieldToEventLoop();
          }
        }
      }
    } finally {
      state.running = false;
      if (disposed || !state.pending) {
        states.delete(teamName);
      } else if (failed) {
        void drainTeam(teamName).catch(() => undefined);
      }
    }
  };

  return {
    schedule(teamName: string, trigger: TeamReconcileTrigger): void {
      if (disposed) {
        return;
      }

      const state = states.get(teamName) ?? {
        running: false,
        pending: false,
        lastTrigger: null,
      };
      state.pending = true;
      state.lastTrigger = trigger;
      states.set(teamName, state);

      if (state.running) {
        return;
      }

      void drainTeam(teamName).catch(() => undefined);
    },

    dispose(): void {
      disposed = true;
      states.clear();
    },
  };
}
