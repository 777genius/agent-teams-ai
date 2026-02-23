import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const files = new Map<string, string>();
  let atomicWriteShouldFail = false;

  // Normalize path separators so tests pass on Windows (backslash → forward slash)
  const norm = (p: string): string => p.replace(/\\/g, '/');

  const readFile = vi.fn(async (filePath: string) => {
    const data = files.get(norm(filePath));
    if (data === undefined) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return data;
  });

  const atomicWrite = vi.fn(async (filePath: string, data: string) => {
    if (atomicWriteShouldFail) {
      throw new Error('atomic write failed');
    }
    files.set(norm(filePath), data);
  });

  return {
    files,
    readFile,
    atomicWrite,
    setAtomicWriteShouldFail: (next: boolean) => {
      atomicWriteShouldFail = next;
    },
  };
});

vi.mock('fs', () => ({
  promises: {
    readFile: hoisted.readFile,
  },
}));

vi.mock('../../../../src/main/services/team/atomicWrite', () => ({
  atomicWriteAsync: hoisted.atomicWrite,
}));

vi.mock('../../../../src/main/utils/pathDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/utils/pathDecoder')>();
  return {
    ...actual,
    getTeamsBasePath: () => '/mock/teams',
  };
});

import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';

function seedConfig(teamName: string): void {
  hoisted.files.set(
    `/mock/teams/${teamName}/config.json`,
    JSON.stringify({
      name: 'My Team',
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    })
  );
}

function seedLeadInbox(teamName: string, messages: unknown[]): void {
  hoisted.files.set(`/mock/teams/${teamName}/inboxes/team-lead.json`, JSON.stringify(messages));
}

function attachAliveRun(
  service: TeamProvisioningService,
  teamName: string,
  opts?: { writable?: boolean }
): { writeSpy: ReturnType<typeof vi.fn> } {
  const runId = 'run-1';
  const writeSpy = vi.fn();
  const writable = opts?.writable ?? true;

  (service as unknown as { activeByTeam: Map<string, string> }).activeByTeam.set(teamName, runId);
  (service as unknown as { runs: Map<string, unknown> }).runs.set(runId, {
    runId,
    teamName,
    child: {
      stdin: {
        writable,
        write: writeSpy,
      },
    },
    processKilled: false,
    cancelRequested: false,
    provisioningComplete: true,
    leadRelayCapture: null,
  });

  return { writeSpy };
}

async function waitForCapture(service: TeamProvisioningService): Promise<any> {
  const runs = (service as unknown as { runs: Map<string, unknown> }).runs;
  const run = runs.get('run-1') as any;
  for (let i = 0; i < 50; i++) {
    if (run?.leadRelayCapture) return run;
    // Progress async awaits in relayLeadInboxMessages
    await Promise.resolve();
  }
  for (let i = 0; i < 50; i++) {
    if (run?.leadRelayCapture) return run;
    await new Promise((r) => setTimeout(r, 0));
  }
  return run;
}

describe('TeamProvisioningService relayLeadInboxMessages', () => {
  beforeEach(() => {
    hoisted.files.clear();
    hoisted.readFile.mockClear();
    hoisted.atomicWrite.mockClear();
    hoisted.setAtomicWriteShouldFail(false);
  });

  it('relays unread lead inbox messages into stdin', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'bob',
        text: 'Please assign this to Alice.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: 'Need delegation',
        messageId: 'm-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName);

    const relayPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    expect(run?.leadRelayCapture).toBeTruthy();
    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'OK, will do.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });

    const relayed = await relayPromise;

    expect(relayed).toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(payload).toContain('"type":"user"');
    expect(payload).toContain('Please assign this to Alice.');
    expect(service.getLiveLeadProcessMessages(teamName)).toHaveLength(1);
  });

  it('dedups by messageId even if markRead fails', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'bob',
        text: 'Ping leader',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        summary: 'Ping',
        messageId: 'm-1',
      },
    ]);

    hoisted.setAtomicWriteShouldFail(true);
    const { writeSpy } = attachAliveRun(service, teamName);

    const firstPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    expect(run?.leadRelayCapture).toBeTruthy();
    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Acknowledged.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });
    const first = await firstPromise;
    const second = await service.relayLeadInboxMessages(teamName);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not mark as relayed when stdin is not writable', async () => {
    const service = new TeamProvisioningService();
    const teamName = 'my-team';
    seedConfig(teamName);
    seedLeadInbox(teamName, [
      {
        from: 'bob',
        text: 'Hello',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: false,
        messageId: 'm-1',
      },
    ]);

    const { writeSpy } = attachAliveRun(service, teamName, { writable: false });
    const first = await service.relayLeadInboxMessages(teamName);
    expect(first).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(0);

    (service as unknown as { runs: Map<string, unknown> }).runs.set('run-1', {
      runId: 'run-1',
      teamName,
      child: { stdin: { writable: true, write: writeSpy } },
      processKilled: false,
      cancelRequested: false,
      provisioningComplete: true,
      leadRelayCapture: null,
    });

    const secondPromise = service.relayLeadInboxMessages(teamName);
    const run = await waitForCapture(service);
    expect(run?.leadRelayCapture).toBeTruthy();
    (service as any).handleStreamJsonMessage(run, {
      type: 'assistant',
      content: [{ type: 'text', text: 'Hi.' }],
    });
    (service as any).handleStreamJsonMessage(run, { type: 'result', subtype: 'success' });
    const second = await secondPromise;
    expect(second).toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});
