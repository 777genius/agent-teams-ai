import { isHostTeamSelectionKey } from '@features/agent-backend/contracts';

import { assertScheduledTeamTarget } from './scheduledTeamTarget';
import { SmartScheduleDispatcher } from './SmartScheduleDispatcher';

import type { SmartScheduleOutcome, SmartScheduleRuntimePort } from './SmartScheduleDispatcher';
import type { Schedule, ScheduleRun } from '@shared/types';

type ScheduleAdmission = Pick<Schedule, 'teamName' | 'hostTarget' | 'executionMode' | 'taskFirst' | 'launchConfig'>;
export interface ScheduleDispatcher {
  readonly supportsHost?: boolean;
  assertCanSchedule(schedule: ScheduleAdmission): Promise<void>;
  dispatch(schedule: Schedule, runId: string, isCancelled: () => boolean): Promise<SmartScheduleOutcome>;
  cancel?(runId: string): Promise<void>;
  cancelAll?(): Promise<void>;
}

/** Composition only. Native work and durable state remain with the captured Host owners. */
export interface HostScheduleRuntimeFactory {
  create(options: {
    schedule: ScheduleAdmission;
    runId?: string;
    isCancelled?(): boolean;
    getPreviousRuns(scheduleId: string, runId: string): Promise<ScheduleRun[]>;
  }): Promise<SmartScheduleRuntimePort>;
  cancel?(runId: string): Promise<void>;
  cancelAll?(): Promise<void>;
}

export class SelectedScheduleDispatcher implements ScheduleDispatcher {
  private readonly dispatchingTeams = new Set<string>();
  readonly supportsHost: boolean;

  constructor(
    private readonly legacy: Pick<SmartScheduleDispatcher, 'assertCanSchedule' | 'dispatch'>,
    private readonly getPreviousRuns: (scheduleId: string, runId: string) => Promise<ScheduleRun[]>,
    private readonly host?: HostScheduleRuntimeFactory
  ) { this.supportsHost = Boolean(host); }

  async assertCanSchedule(schedule: ScheduleAdmission): Promise<void> {
    assertScheduledTeamTarget(schedule, this.supportsHost);
    if (!isHostTeamSelectionKey(schedule.teamName)) return this.legacy.assertCanSchedule(schedule);
    const runtime = await this.host!.create({ schedule, getPreviousRuns: this.getPreviousRuns });
    const saved = await runtime.getSavedRequest(schedule.teamName);
    if (!saved || !(await runtime.hasLaunchConfig(schedule.teamName)))
      throw new Error('Finish team setup before scheduling');
    await new SmartScheduleDispatcher(runtime, this.dispatchingTeams).assertCanSchedule(schedule);
  }

  async dispatch(schedule: Schedule, runId: string, isCancelled: () => boolean): Promise<SmartScheduleOutcome> {
    assertScheduledTeamTarget(schedule, this.supportsHost);
    if (!isHostTeamSelectionKey(schedule.teamName)) return this.legacy.dispatch(schedule, runId, isCancelled);
    const runtime = await this.host!.create({ schedule, runId, isCancelled, getPreviousRuns: this.getPreviousRuns });
    if (isCancelled()) return { kind: 'skipped', summary: 'Schedule was cancelled before dispatch' };
    if (!schedule.executionMode) return { kind: 'one_shot', result: await runtime.runOneShot({
      runId, config: schedule.launchConfig, maxTurns: schedule.maxTurns, maxBudgetUsd: schedule.maxBudgetUsd,
    }) };
    return new SmartScheduleDispatcher(runtime, this.dispatchingTeams).dispatch(schedule, runId, isCancelled);
  }

  async cancel(runId: string): Promise<void> { await this.host?.cancel?.(runId); }
  async cancelAll(): Promise<void> { await this.host?.cancelAll?.(); }
}
