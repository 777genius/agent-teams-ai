import { createTeamAliveListReadPort } from '@renderer/composition/team/createTeamAliveListReadPort';
import { afterEach, describe, expect, it, vi } from 'vitest';

function setElectronApiForTest(value: unknown): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value,
  });
}

describe('createTeamAliveListReadPort', () => {
  afterEach(() => {
    setElectronApiForTest(undefined);
  });

  it('maps the legacy alive-list API to the narrow read-only lifecycle capability', async () => {
    const aliveList = vi.fn().mockResolvedValue(['team-alpha', 'team-beta']);
    setElectronApiForTest({ teams: { aliveList } });

    const port = createTeamAliveListReadPort();

    expect(Object.keys(port)).toEqual(['listAliveTeams']);
    expect('stopRunningTeam' in port).toBe(false);
    await expect(port.listAliveTeams()).resolves.toEqual(['team-alpha', 'team-beta']);
    expect(aliveList).toHaveBeenCalledOnce();
  });

  it('preserves legacy read failures for consumers to handle best-effort', async () => {
    const failure = new Error('offline');
    const aliveList = vi.fn().mockRejectedValue(failure);
    setElectronApiForTest({ teams: { aliveList } });

    const port = createTeamAliveListReadPort();

    await expect(port.listAliveTeams()).rejects.toBe(failure);
  });
});
