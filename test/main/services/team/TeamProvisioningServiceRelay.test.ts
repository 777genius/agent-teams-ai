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
  });

  return { writeSpy };
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
    const relayed = await service.relayLeadInboxMessages(teamName);

    expect(relayed).toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(payload).toContain('"type":"user"');
    expect(payload).toContain('Please assign this to Alice.');
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

    const first = await service.relayLeadInboxMessages(teamName);
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
    });

    const second = await service.relayLeadInboxMessages(teamName);
    expect(second).toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});
