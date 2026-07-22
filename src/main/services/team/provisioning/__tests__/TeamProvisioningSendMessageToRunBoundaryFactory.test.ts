import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningSendMessageToRunBoundary,
  type TeamProvisioningSendMessageToRunRun,
  type TeamProvisioningSendMessageToRunWritableStdin,
} from '../TeamProvisioningSendMessageToRunBoundaryFactory';

import type { AttachmentPayload } from '@shared/types';

type TestRun = TeamProvisioningSendMessageToRunRun;

function createWritableStdin(): {
  stdin: TeamProvisioningSendMessageToRunWritableStdin;
  chunks: string[];
} {
  const chunks: string[] = [];
  return {
    chunks,
    stdin: {
      writable: true,
      write: vi.fn((chunk: string, callback: (error?: Error | null) => void) => {
        chunks.push(chunk);
        callback(null);
        return true;
      }),
    },
  };
}

function createRun(overrides: Partial<TestRun> = {}): TestRun {
  const { stdin } = createWritableStdin();
  return {
    teamName: 'alpha',
    runId: 'run-1',
    processKilled: false,
    cancelRequested: false,
    request: { providerId: 'claude' },
    child: { stdin },
    ...overrides,
  };
}

describe('TeamProvisioningSendMessageToRunBoundaryFactory', () => {
  it('throws the stale run error before writing to stdin', async () => {
    const { stdin } = createWritableStdin();
    const run = createRun({ child: { stdin } });
    const setLeadActivity = vi.fn();
    const boundary = createTeamProvisioningSendMessageToRunBoundary({
      isCurrentTrackedRun: () => false,
      setLeadActivity,
      buildLeadMessageStdinPayload: vi.fn(async () => 'payload'),
    });

    await expect(boundary.sendMessageToRun(run, 'hello')).rejects.toThrow(
      'Team "alpha" run "run-1" is no longer current'
    );

    expect(stdin.write).not.toHaveBeenCalled();
    expect(setLeadActivity).not.toHaveBeenCalled();
  });

  it('throws when stdin is not writable', async () => {
    const stdin: TeamProvisioningSendMessageToRunWritableStdin = {
      writable: false,
      write: vi.fn(),
    };
    const run = createRun({ child: { stdin } });
    const setLeadActivity = vi.fn();
    const boundary = createTeamProvisioningSendMessageToRunBoundary({
      isCurrentTrackedRun: () => true,
      setLeadActivity,
      buildLeadMessageStdinPayload: vi.fn(async () => 'payload'),
    });

    await expect(boundary.sendMessageToRun(run, 'hello')).rejects.toThrow(
      'Team "alpha" process stdin is not writable'
    );

    expect(stdin.write).not.toHaveBeenCalled();
    expect(setLeadActivity).not.toHaveBeenCalled();
  });

  it('passes normalized attachments to the payload builder', async () => {
    const attachmentPayloads: AttachmentPayload[] = [
      {
        id: 'lead_att_1',
        filename: 'note.txt',
        mimeType: 'text/plain',
        size: 5,
        data: 'aGVsbG8=',
      },
    ];
    const attachments = [{ data: 'aGVsbG8=', mimeType: 'text/plain', filename: 'note.txt' }];
    const toLeadAttachmentPayloads = vi.fn(() => attachmentPayloads);
    const buildLeadMessageStdinPayload = vi.fn(async () => 'payload');
    const boundary = createTeamProvisioningSendMessageToRunBoundary({
      isCurrentTrackedRun: () => true,
      setLeadActivity: vi.fn(),
      toLeadAttachmentPayloads,
      buildLeadMessageStdinPayload,
    });
    const run = createRun({ request: { providerId: 'codex' } });

    await boundary.sendMessageToRun(run, 'hello', attachments);

    expect(toLeadAttachmentPayloads).toHaveBeenCalledWith(attachments);
    expect(buildLeadMessageStdinPayload).toHaveBeenCalledWith({
      teamName: 'alpha',
      runId: 'run-1',
      providerId: 'codex',
      text: 'hello',
      attachments: attachmentPayloads,
    });
  });

  it('writes the stdin payload and marks the lead active after a successful write', async () => {
    const { stdin, chunks } = createWritableStdin();
    const run = createRun({ child: { stdin } });
    const setLeadActivity = vi.fn();
    const boundary = createTeamProvisioningSendMessageToRunBoundary({
      isCurrentTrackedRun: () => true,
      setLeadActivity,
      buildLeadMessageStdinPayload: vi.fn(async () => 'payload'),
    });

    await boundary.sendMessageToRun(run, 'hello');

    expect(chunks).toEqual(['payload\n']);
    expect(stdin.write).toHaveBeenCalledTimes(1);
    expect(setLeadActivity).toHaveBeenCalledWith(run, 'active');
  });
});
