import { describe, expect, it, vi } from 'vitest';

import {
  injectGeminiPostLaunchHydration,
  injectPostCompactReminder,
  type TeamProvisioningIdlePromptInjectionPorts,
  type TeamProvisioningIdlePromptInjectionRun,
} from '../TeamProvisioningIdlePromptInjection';

import type { LeadActivityState } from '../TeamProvisioningLeadActivity';
import type { TeamCreateRequest, TeamTask } from '@shared/types';

type TestRun = TeamProvisioningIdlePromptInjectionRun & {
  child: { stdin: { writable: boolean } };
};

type TestPorts = TeamProvisioningIdlePromptInjectionPorts<TestRun>;

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
    child: { stdin: { writable: true } },
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

function makePorts(overrides: Partial<TestPorts> = {}): TestPorts {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    readConfigForObservation: vi.fn(async () => ({
      members: [
        { name: 'lead', role: 'Lead' },
        { name: 'worker', role: 'Engineer' },
      ],
    })),
    readTasks: vi.fn(async () => [] as TeamTask[]),
    isLeadMember: vi.fn((member) => member.role?.toLowerCase().includes('lead') === true),
    buildPersistentLeadContext: vi.fn(() => 'persistent context'),
    buildTaskBoardSnapshot: vi.fn(() => 'task board snapshot'),
    buildGeminiPostLaunchHydrationPrompt: vi.fn(() => 'gemini hydration prompt'),
    getPromptSizeSummary: vi.fn(() => ({ chars: 23, lines: 1 })),
    writeLeadStdin: vi.fn(async () => undefined),
    setLeadActivity: vi.fn((run, state: LeadActivityState) => {
      run.leadActivityState = state;
    }),
    resetRuntimeToolActivity: vi.fn(),
    getRunLeadName: vi.fn(() => 'lead'),
    ...overrides,
  };
}

describe('idle prompt injection helpers', () => {
  it('re-arms pending flags when deferred by activity guards', async () => {
    const deferredRuns: Array<Partial<TestRun>> = [
      { leadActivityState: 'active' },
      { leadRelayCapture: {} },
      { silentUserDmForward: {} },
    ];

    for (const deferredRun of deferredRuns) {
      const postCompactRun = makeRun(deferredRun);
      const postCompactPorts = makePorts();
      await injectPostCompactReminder(postCompactRun, postCompactPorts);

      expect(postCompactRun.pendingPostCompactReminder).toBe(true);
      expect(postCompactPorts.writeLeadStdin).not.toHaveBeenCalled();

      const geminiRun = makeRun(deferredRun);
      const geminiPorts = makePorts();
      await injectGeminiPostLaunchHydration(geminiRun, geminiPorts);

      expect(geminiRun.pendingGeminiPostLaunchHydration).toBe(true);
      expect(geminiPorts.writeLeadStdin).not.toHaveBeenCalled();
    }
  });

  it('sets post-compact in-flight, suppresses output, and marks lead active after a write', async () => {
    const targetRun = makeRun();
    const ports = makePorts();

    await injectPostCompactReminder(targetRun, ports);

    expect(targetRun.pendingPostCompactReminder).toBe(false);
    expect(targetRun.postCompactReminderInFlight).toBe(true);
    expect(targetRun.suppressPostCompactReminderOutput).toBe(true);
    expect(targetRun.leadActivityState).toBe('active');
    expect(ports.setLeadActivity).toHaveBeenCalledWith(targetRun, 'active');
    expect(ports.writeLeadStdin).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(vi.mocked(ports.writeLeadStdin).mock.calls[0][1]) as {
      type: string;
      message: { role: string; content: Array<{ type: string; text: string }> };
    };
    expect(payload).toMatchObject({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text' }],
      },
    });
    expect(payload.message.content[0].text).toContain('persistent context');
    expect(payload.message.content[0].text).toContain('task board snapshot');
  });

  it('clears post-compact state and resets activity after a write failure', async () => {
    const targetRun = makeRun();
    const ports = makePorts({
      writeLeadStdin: vi.fn(async () => {
        throw new Error('stdin failed');
      }),
    });

    await injectPostCompactReminder(targetRun, ports);

    expect(targetRun.pendingPostCompactReminder).toBe(false);
    expect(targetRun.postCompactReminderInFlight).toBe(false);
    expect(targetRun.suppressPostCompactReminderOutput).toBe(false);
    expect(targetRun.leadActivityState).toBe('idle');
    expect(ports.resetRuntimeToolActivity).toHaveBeenCalledWith(targetRun, 'lead');
    expect(ports.setLeadActivity).toHaveBeenNthCalledWith(1, targetRun, 'active');
    expect(ports.setLeadActivity).toHaveBeenNthCalledWith(2, targetRun, 'idle');
  });

  it('marks Gemini hydration sent, in-flight, suppresses output, and marks lead active after a write', async () => {
    const targetRun = makeRun();
    const ports = makePorts();

    await injectGeminiPostLaunchHydration(targetRun, ports);

    expect(targetRun.pendingGeminiPostLaunchHydration).toBe(false);
    expect(targetRun.geminiPostLaunchHydrationInFlight).toBe(true);
    expect(targetRun.geminiPostLaunchHydrationSent).toBe(true);
    expect(targetRun.suppressGeminiPostLaunchHydrationOutput).toBe(true);
    expect(targetRun.leadActivityState).toBe('active');
    expect(ports.setLeadActivity).toHaveBeenCalledWith(targetRun, 'active');
    expect(ports.writeLeadStdin).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(vi.mocked(ports.writeLeadStdin).mock.calls[0][1]) as {
      type: string;
      message: { role: string; content: Array<{ type: string; text: string }> };
    };
    expect(payload).toMatchObject({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'gemini hydration prompt' }],
      },
    });
  });

  it('rolls Gemini flags back and resets activity after a write failure', async () => {
    const targetRun = makeRun();
    const ports = makePorts({
      writeLeadStdin: vi.fn(async () => {
        throw new Error('stdin failed');
      }),
    });

    await injectGeminiPostLaunchHydration(targetRun, ports);

    expect(targetRun.pendingGeminiPostLaunchHydration).toBe(false);
    expect(targetRun.geminiPostLaunchHydrationInFlight).toBe(false);
    expect(targetRun.geminiPostLaunchHydrationSent).toBe(false);
    expect(targetRun.suppressGeminiPostLaunchHydrationOutput).toBe(false);
    expect(targetRun.leadActivityState).toBe('idle');
    expect(ports.resetRuntimeToolActivity).toHaveBeenCalledWith(targetRun, 'lead');
    expect(ports.setLeadActivity).toHaveBeenNthCalledWith(1, targetRun, 'active');
    expect(ports.setLeadActivity).toHaveBeenNthCalledWith(2, targetRun, 'idle');
  });
});
