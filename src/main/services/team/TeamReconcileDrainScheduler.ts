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

export interface TeamReconcileDrainScheduler {
  schedule(teamName: string, trigger: TeamReconcileTrigger): void;
  dispose(): void;
}

export function createTeamReconcileDrainScheduler(options: {
  run: (teamName: string, trigger: TeamReconcileTrigger) => Promise<void>;
}): TeamReconcileDrainScheduler {
  const states = new Map<string, TeamReconcileDrainState>();
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
          await options.run(teamName, trigger);
        } catch (error) {
          failed = true;
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
        return;
      }

      if (failed) {
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
