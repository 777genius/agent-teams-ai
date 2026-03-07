import { api } from '@renderer/api';
import { createLogger } from '@shared/utils/logger';

import type { AppState } from '../types';
import type { StateCreator } from 'zustand';
import type {
  CreateScheduleInput,
  Schedule,
  ScheduleRun,
  UpdateSchedulePatch,
} from '@shared/types';

const logger = createLogger('scheduleSlice');

// =============================================================================
// Slice Interface
// =============================================================================

export interface ScheduleSlice {
  // --- State ---
  schedules: Schedule[];
  schedulesLoading: boolean;
  schedulesError: string | null;
  scheduleRuns: Record<string, ScheduleRun[]>;
  scheduleRunsLoading: Record<string, boolean>;

  // --- Actions ---
  fetchSchedules(): Promise<void>;
  createSchedule(input: CreateScheduleInput): Promise<Schedule>;
  updateSchedule(id: string, patch: UpdateSchedulePatch): Promise<Schedule>;
  deleteSchedule(id: string): Promise<void>;
  pauseSchedule(id: string): Promise<void>;
  resumeSchedule(id: string): Promise<void>;
  triggerNow(id: string): Promise<ScheduleRun>;
  fetchRunHistory(scheduleId: string): Promise<void>;

  /** Optimistic in-memory update from SCHEDULE_CHANGE events */
  applyScheduleChange(scheduleId: string): Promise<void>;
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createScheduleSlice: StateCreator<AppState, [], [], ScheduleSlice> = (set, get) => ({
  schedules: [],
  schedulesLoading: false,
  schedulesError: null,
  scheduleRuns: {},
  scheduleRunsLoading: {},

  async fetchSchedules(): Promise<void> {
    // Guard: prevent concurrent fetches
    if (get().schedulesLoading) return;
    set({ schedulesLoading: true, schedulesError: null });

    try {
      const schedules = await api.schedules.list();
      set({ schedules, schedulesLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch schedules';
      logger.error('fetchSchedules failed:', message);
      set({ schedulesError: message, schedulesLoading: false });
    }
  },

  async createSchedule(input: CreateScheduleInput): Promise<Schedule> {
    const schedule = await api.schedules.create(input);
    set((state) => ({ schedules: [...state.schedules, schedule] }));
    return schedule;
  },

  async updateSchedule(id: string, patch: UpdateSchedulePatch): Promise<Schedule> {
    const updated = await api.schedules.update(id, patch);
    set((state) => ({
      schedules: state.schedules.map((s) => (s.id === id ? updated : s)),
    }));
    return updated;
  },

  async deleteSchedule(id: string): Promise<void> {
    await api.schedules.delete(id);
    set((state) => ({
      schedules: state.schedules.filter((s) => s.id !== id),
      scheduleRuns: Object.fromEntries(
        Object.entries(state.scheduleRuns).filter(([key]) => key !== id)
      ),
    }));
  },

  async pauseSchedule(id: string): Promise<void> {
    await api.schedules.pause(id);
    // Optimistic update — set status locally, then refetch for accuracy
    set((state) => ({
      schedules: state.schedules.map((s) =>
        s.id === id ? { ...s, status: 'paused' as const, updatedAt: new Date().toISOString() } : s
      ),
    }));
    // Refetch to get server-side state
    void get().applyScheduleChange(id);
  },

  async resumeSchedule(id: string): Promise<void> {
    await api.schedules.resume(id);
    // Optimistic update
    set((state) => ({
      schedules: state.schedules.map((s) =>
        s.id === id ? { ...s, status: 'active' as const, updatedAt: new Date().toISOString() } : s
      ),
    }));
    // Refetch to get server-side state (includes nextRunAt recalculation)
    void get().applyScheduleChange(id);
  },

  async triggerNow(id: string): Promise<ScheduleRun> {
    const run = await api.schedules.triggerNow(id);
    set((state) => ({
      scheduleRuns: {
        ...state.scheduleRuns,
        [id]: [run, ...(state.scheduleRuns[id] ?? [])],
      },
    }));
    return run;
  },

  async fetchRunHistory(scheduleId: string): Promise<void> {
    if (get().scheduleRunsLoading[scheduleId]) return;
    set((state) => ({
      scheduleRunsLoading: { ...state.scheduleRunsLoading, [scheduleId]: true },
    }));

    try {
      const runs = await api.schedules.getRuns(scheduleId);
      set((state) => ({
        scheduleRuns: { ...state.scheduleRuns, [scheduleId]: runs },
        scheduleRunsLoading: { ...state.scheduleRunsLoading, [scheduleId]: false },
      }));
    } catch (err) {
      logger.error(`fetchRunHistory(${scheduleId}) failed:`, err);
      set((state) => ({
        scheduleRunsLoading: { ...state.scheduleRunsLoading, [scheduleId]: false },
      }));
    }
  },

  async applyScheduleChange(scheduleId: string): Promise<void> {
    try {
      // Refresh the specific schedule
      const schedule = await api.schedules.get(scheduleId);
      set((state) => {
        if (!schedule) {
          // Schedule was deleted
          return {
            schedules: state.schedules.filter((s) => s.id !== scheduleId),
          };
        }

        const exists = state.schedules.some((s) => s.id === scheduleId);
        return {
          schedules: exists
            ? state.schedules.map((s) => (s.id === scheduleId ? schedule : s))
            : [...state.schedules, schedule],
        };
      });

      // Also refresh runs if we have them loaded
      if (get().scheduleRuns[scheduleId]) {
        const runs = await api.schedules.getRuns(scheduleId);
        set((state) => ({
          scheduleRuns: { ...state.scheduleRuns, [scheduleId]: runs },
        }));
      }
    } catch (err) {
      logger.error('applyScheduleChange failed:', err);
    }
  },
});
