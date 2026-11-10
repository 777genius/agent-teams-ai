import { AGENT_BLOCK_CLOSE, AGENT_BLOCK_OPEN } from '@shared/constants/agentBlocks';
import { describe, expect, it, vi } from 'vitest';

import {
  buildUserDmRelayMessage,
  forwardUserDmToTeammateWithPorts,
  type TeamProvisioningUserDmRelayRun,
} from '../TeamProvisioningUserDmRelay';

function createRun(
  overrides: Partial<TeamProvisioningUserDmRelayRun> = {}
): TeamProvisioningUserDmRelayRun {
  return {
    teamName: 'team-a',
    provisioningComplete: true,
    child: { stdin: { writable: true } } as TeamProvisioningUserDmRelayRun['child'],
    silentUserDmForward: null,
    silentUserDmForwardClearHandle: null,
    ...overrides,
  };
}

function clearSilentForwardTimer(run: TeamProvisioningUserDmRelayRun): void {
  if (run.silentUserDmForwardClearHandle) {
    clearTimeout(run.silentUserDmForwardClearHandle);
    run.silentUserDmForwardClearHandle = null;
  }
}

describe('TeamProvisioningUserDmRelay', () => {
  it('builds the internal user-DM relay message with canonical SendMessage rules', () => {
    const message = buildUserDmRelayMessage({
      teammateName: 'Builder',
      userSummary: '  Needs status  ',
      userText: 'Can you summarize progress?',
    });

    expect(message).toContain(`User DM relay (internal).\n${AGENT_BLOCK_OPEN}\n`);
    expect(message).toContain('UI relay request — forward a direct message to teammate "Builder".');
    expect(message).toContain('MUST: Use the SendMessage tool with to="Builder".');
    expect(message).toContain(
      'CRITICAL: The SendMessage tool input must use the actual tool field names'
    );
    expect(message).toContain(`${AGENT_BLOCK_CLOSE}\n\nMessage to forward:\n`);
    expect(message).toContain('\nSummary: Needs status\nCan you summarize progress?');
  });

  it('omits a blank summary from the relay message', () => {
    expect(
      buildUserDmRelayMessage({
        teammateName: 'Builder',
        userSummary: '   ',
        userText: 'No summary here',
      })
    ).not.toContain('Summary:');
  });

  it('arms silent forwarding and sends the relay message to the active run', async () => {
    const run = createRun();
    const sendMessageToRun = vi.fn(async () => undefined);

    await forwardUserDmToTeammateWithPorts(
      {
        teamName: 'team-a',
        teammateName: 'Builder',
        userText: 'Please handle this',
        userSummary: '  Quick ask ',
      },
      {
        getAliveRunId: vi.fn(() => 'run-1'),
        getRun: vi.fn(() => run),
        sendMessageToRun,
        nowIso: () => '2026-07-07T00:00:00.000Z',
      }
    );

    expect(run.silentUserDmForward).toEqual({
      target: 'Builder',
      startedAt: '2026-07-07T00:00:00.000Z',
      mode: 'user_dm',
    });
    expect(sendMessageToRun).toHaveBeenCalledWith(
      run,
      expect.stringContaining('Summary: Quick ask\nPlease handle this')
    );

    clearSilentForwardTimer(run);
  });

  it('does not inject an extra turn while provisioning is still running', async () => {
    const run = createRun({ provisioningComplete: false });
    const sendMessageToRun = vi.fn(async () => undefined);

    await forwardUserDmToTeammateWithPorts(
      { teamName: 'team-a', teammateName: 'Builder', userText: 'Wait' },
      {
        getAliveRunId: () => 'run-1',
        getRun: () => run,
        sendMessageToRun,
        nowIso: () => '2026-07-07T00:00:00.000Z',
      }
    );

    expect(run.silentUserDmForward).toBeNull();
    expect(sendMessageToRun).not.toHaveBeenCalled();
  });

  it('preserves the existing no-active-run error', async () => {
    await expect(
      forwardUserDmToTeammateWithPorts(
        { teamName: 'team-a', teammateName: 'Builder', userText: 'Hello' },
        {
          getAliveRunId: () => null,
          getRun: vi.fn(),
          sendMessageToRun: vi.fn(),
          nowIso: () => '2026-07-07T00:00:00.000Z',
        }
      )
    ).rejects.toThrow('No active process for team "team-a"');
  });
});
