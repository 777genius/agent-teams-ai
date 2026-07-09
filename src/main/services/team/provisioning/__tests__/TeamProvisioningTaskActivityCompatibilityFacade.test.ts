import { describe, expect, it, vi } from 'vitest';

import { type TeamTaskActivityIntervalService } from '../../TeamTaskActivityIntervalService';
import { TeamProvisioningTaskActivityCompatibilityFacade } from '../TeamProvisioningTaskActivityCompatibilityFacade';

import type { TeamProvisioningCompatibilityDelegation } from '../TeamProvisioningCompatibilityFacade';
import type { TeamProvisioningMemberLifecyclePublicFacade } from '../TeamProvisioningMemberLifecycleCompatibilityFacade';
import type { ProvisioningRun } from '../TeamProvisioningRunModel';
import type { InboxMessage, TeamChangeEvent } from '@shared/types';

class TestTaskActivityCompatibilityFacade extends TeamProvisioningTaskActivityCompatibilityFacade<ProvisioningRun> {
  readonly resumeActiveIntervalsForMember = vi.fn(() => ({}));
  readonly pauseActiveIntervalsForMember = vi.fn(() => ({}));
  readonly events: TeamChangeEvent[] = [];
  currentRunId = 'run-1';

  protected readonly compatibilityDelegation =
    {} as TeamProvisioningCompatibilityDelegation<ProvisioningRun>;
  protected readonly memberLifecycleFacade = {} as TeamProvisioningMemberLifecyclePublicFacade;
  protected readonly inboxReader = {
    getMessagesFor: vi.fn(async () => [] as InboxMessage[]),
  };
  protected readonly memberSpawnStatusMutationPorts = {} as never;
  protected readonly memberSpawnStatusAuditPorts = {} as never;
  protected readonly taskActivityIntervalService = {
    resumeActiveIntervalsForMember: this.resumeActiveIntervalsForMember,
    pauseActiveIntervalsForMember: this.pauseActiveIntervalsForMember,
  } as unknown as TeamTaskActivityIntervalService;
  protected readonly teamChangeEmitter = (event: TeamChangeEvent) => {
    this.events.push(event);
  };

  setLead(run: ProvisioningRun, state: 'active' | 'idle' | 'offline'): void {
    this.setLeadActivity(run, state);
  }

  syncLead(
    run: ProvisioningRun,
    state: 'active' | 'idle' | 'offline',
    previousState: 'active' | 'idle' | 'offline',
    at: string
  ): void {
    this.syncLeadTaskActivityForState(run, state, previousState, at);
  }

  emitLeadContext(run: ProvisioningRun): void {
    this.emitLeadContextUsage(run);
  }

  protected isCurrentTrackedRun(run: ProvisioningRun): boolean {
    return run.runId === this.currentRunId;
  }

  protected getRunLeadName(): string {
    return 'Lead';
  }
}

function createRun(overrides: Partial<ProvisioningRun> = {}): ProvisioningRun {
  return {
    teamName: 'alpha',
    runId: 'run-1',
    leadActivityState: 'idle',
    provisioningComplete: false,
    request: {},
    ...overrides,
  } as ProvisioningRun;
}

describe('TeamProvisioningTaskActivityCompatibilityFacade', () => {
  it('moves lead task-activity state transitions behind the extracted facade', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T12:00:00.000Z'));
    const facade = new TestTaskActivityCompatibilityFacade();
    const run = createRun();

    facade.setLead(run, 'active');
    facade.setLead(run, 'active');
    facade.setLead(run, 'idle');

    expect(run.leadActivityState).toBe('idle');
    expect(facade.resumeActiveIntervalsForMember).toHaveBeenCalledTimes(1);
    expect(facade.resumeActiveIntervalsForMember).toHaveBeenCalledWith(
      'alpha',
      'Lead',
      '2026-07-09T12:00:00.000Z'
    );
    expect(facade.pauseActiveIntervalsForMember).toHaveBeenCalledWith(
      'alpha',
      'Lead',
      '2026-07-09T12:00:00.000Z'
    );
    expect(facade.events.map((event) => event.detail)).toEqual(['active', 'idle']);
    vi.useRealTimers();
  });

  it('keeps read-repair lead activity sync on the same interval service port', () => {
    const facade = new TestTaskActivityCompatibilityFacade();
    const run = createRun({ leadActivityState: 'active' });

    facade.syncLead(run, 'active', 'idle', '2026-07-09T12:00:01.000Z');
    facade.syncLead(run, 'active', 'active', '2026-07-09T12:00:02.000Z');
    facade.syncLead(run, 'offline', 'active', '2026-07-09T12:00:03.000Z');

    expect(facade.resumeActiveIntervalsForMember).toHaveBeenCalledTimes(1);
    expect(facade.pauseActiveIntervalsForMember).toHaveBeenCalledWith(
      'alpha',
      'Lead',
      '2026-07-09T12:00:03.000Z'
    );
  });

  it('keeps lead context usage emission with task-activity compatibility wiring', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T12:00:05.000Z'));
    const facade = new TestTaskActivityCompatibilityFacade();
    const run = createRun({
      provisioningComplete: true,
      leadContextUsage: {
        promptInputTokens: 100,
        outputTokens: 20,
        contextUsedTokens: 120,
        contextWindowTokens: 1_000,
        promptInputSource: 'anthropic_usage',
        lastUsageMessageId: 'msg-1',
        lastEmittedAt: 0,
      },
    });

    facade.emitLeadContext(run);

    expect(facade.events).toHaveLength(1);
    expect(facade.events[0]).toMatchObject({
      type: 'lead-context',
      teamName: 'alpha',
      runId: 'run-1',
    });
    expect(JSON.parse(facade.events[0]?.detail ?? '{}')).toMatchObject({
      promptInputTokens: 100,
      contextUsedPercent: 12,
      updatedAt: '2026-07-09T12:00:05.000Z',
    });
    vi.useRealTimers();
  });
});
