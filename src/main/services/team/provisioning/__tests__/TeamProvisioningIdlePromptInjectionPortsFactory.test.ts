import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningIdlePromptInjectionBoundary,
  createTeamProvisioningIdlePromptInjectionPorts,
  type TeamProvisioningIdlePromptInjectionPortsFactoryRun,
  type TeamProvisioningIdlePromptInjectionServiceAdapter,
} from '../TeamProvisioningIdlePromptInjectionPortsFactory';

import type { LeadActivityState } from '../TeamProvisioningLeadActivity';
import type { TeamCreateRequest, TeamTask } from '@shared/types';

type TestRun = TeamProvisioningIdlePromptInjectionPortsFactoryRun & {
  child: {
    stdin: {
      writable: boolean;
      write: ReturnType<typeof vi.fn>;
    };
  };
};

function makeRequest(): TeamCreateRequest {
  return {
    teamName: 'team-a',
    cwd: '/repo/team-a',
    members: [
      { name: 'lead', role: 'Lead' },
      { name: 'worker', role: 'Engineer' },
    ],
    prompt: 'Original task',
  } as TeamCreateRequest;
}

function makeRun(overrides: Partial<TestRun> = {}): TestRun {
  const request = makeRequest();

  return {
    teamName: 'team-a',
    request,
    effectiveMembers: request.members,
    memberSpawnStatuses: new Map(),
    child: {
      stdin: {
        writable: true,
        write: vi.fn((_payload: string, callback: (err?: Error | null) => void) => {
          callback();
          return true;
        }),
      },
    },
    processKilled: false,
    cancelRequested: false,
    leadActivityState: 'idle',
    leadRelayCapture: null,
    silentUserDmForward: null,
    pendingPostCompactReminder: true,
    postCompactReminderInFlight: false,
    suppressPostCompactReminderOutput: false,
    pendingGeminiPostLaunchHydration: true,
    geminiPostLaunchHydrationInFlight: false,
    geminiPostLaunchHydrationSent: false,
    suppressGeminiPostLaunchHydrationOutput: false,
    ...overrides,
  };
}

function makeServiceAdapter(
  overrides: Partial<TeamProvisioningIdlePromptInjectionServiceAdapter<TestRun>> = {}
): TeamProvisioningIdlePromptInjectionServiceAdapter<TestRun> {
  return {
    readConfigForObservation: vi.fn(async () => ({
      members: [
        { name: 'lead', role: 'Lead' },
        { name: 'worker', role: 'Engineer' },
      ],
    })),
    setLeadActivity: vi.fn((run, state: LeadActivityState) => {
      run.leadActivityState = state;
    }),
    resetRuntimeToolActivity: vi.fn(),
    getRunLeadName: vi.fn(() => 'lead'),
    ...overrides,
  };
}

describe('TeamProvisioningIdlePromptInjectionPortsFactory', () => {
  it('wires service callbacks and preserves stdin payload newline writes', async () => {
    const service = makeServiceAdapter();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const run = makeRun();
    const ports = createTeamProvisioningIdlePromptInjectionPorts({
      logger,
      service,
      readTasks: vi.fn(async () => [] as TeamTask[]),
      isLeadMember: vi.fn((member) => member.role?.toLowerCase().includes('lead') === true),
      buildPersistentLeadContext: vi.fn(() => 'persistent context'),
      buildTaskBoardSnapshot: vi.fn(() => 'task board snapshot'),
      buildGeminiPostLaunchHydrationPrompt: vi.fn(() => 'gemini hydration prompt'),
      getPromptSizeSummary: vi.fn(() => ({ chars: 23, lines: 1 })),
    });

    await expect(ports.readConfigForObservation('team-a')).resolves.toEqual({
      members: [
        { name: 'lead', role: 'Lead' },
        { name: 'worker', role: 'Engineer' },
      ],
    });
    await ports.writeLeadStdin(run, 'payload');
    ports.setLeadActivity(run, 'active');
    ports.resetRuntimeToolActivity(run, 'lead');

    expect(service.readConfigForObservation).toHaveBeenCalledWith('team-a');
    expect(run.child.stdin.write).toHaveBeenCalledWith('payload\n', expect.any(Function));
    expect(service.setLeadActivity).toHaveBeenCalledWith(run, 'active');
    expect(service.resetRuntimeToolActivity).toHaveBeenCalledWith(run, 'lead');
    expect(ports.getRunLeadName(run)).toBe('lead');
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('builds a boundary that delegates both idle prompt injections through shared ports', async () => {
    const service = makeServiceAdapter();
    const tasks = [{ id: 'task-1', title: 'Task 1' }] as unknown as TeamTask[];
    const readTasks = vi.fn(async () => tasks);
    const buildPersistentLeadContext = vi.fn(() => 'persistent context');
    const buildTaskBoardSnapshot = vi.fn(() => 'task board snapshot');
    const buildGeminiPostLaunchHydrationPrompt = vi.fn(() => 'gemini hydration prompt');
    const boundary = createTeamProvisioningIdlePromptInjectionBoundary({
      logger: { info: vi.fn(), warn: vi.fn() },
      service,
      readTasks,
      isLeadMember: vi.fn((member) => member.role?.toLowerCase().includes('lead') === true),
      buildPersistentLeadContext,
      buildTaskBoardSnapshot,
      buildGeminiPostLaunchHydrationPrompt,
      getPromptSizeSummary: vi.fn(() => ({ chars: 23, lines: 1 })),
    });

    const postCompactRun = makeRun();
    await boundary.injectPostCompactReminder(postCompactRun);

    expect(postCompactRun.postCompactReminderInFlight).toBe(true);
    expect(buildPersistentLeadContext).toHaveBeenCalledWith({
      teamName: 'team-a',
      leadName: 'lead',
      isSolo: false,
      members: [{ name: 'worker', role: 'Engineer' }],
      compact: true,
    });
    expect(buildTaskBoardSnapshot).toHaveBeenCalledWith(tasks);
    const postCompactPayload = JSON.parse(
      postCompactRun.child.stdin.write.mock.calls[0][0].trim()
    ) as {
      message: { content: Array<{ text: string }> };
    };
    expect(postCompactPayload.message.content[0].text).toContain('persistent context');
    expect(postCompactPayload.message.content[0].text).toContain('task board snapshot');

    const geminiRun = makeRun();
    await boundary.injectGeminiPostLaunchHydration(geminiRun);

    expect(geminiRun.geminiPostLaunchHydrationInFlight).toBe(true);
    expect(geminiRun.geminiPostLaunchHydrationSent).toBe(true);
    expect(buildGeminiPostLaunchHydrationPrompt).toHaveBeenCalledWith(
      geminiRun,
      'lead',
      [{ name: 'worker', role: 'Engineer' }],
      tasks
    );
    expect(geminiRun.child.stdin.write.mock.calls[0][0]).toContain('gemini hydration prompt');
  });
});
