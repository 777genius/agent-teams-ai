import { describe, expect, it, vi } from 'vitest';

import {
  createHostTeamsApi,
  hostTeamSelectionKey,
} from '../../../src/features/agent-backend/renderer/createHostTeamsApi';

import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { TeamsAPI } from '../../../src/shared/types/api';

function fixture() {
  const backend: AgentBackendApi = { getConnections: vi.fn(), invoke: vi.fn() };
  const methods = [
    'launchTeam',
    'createTeam',
    'createConfig',
    'updateMemberSettings',
    'showMessageNotification',
  ] as const satisfies readonly (keyof TeamsAPI)[];
  const legacy = Object.fromEntries(
    methods.map((method) => [method, vi.fn().mockResolvedValue({ legacy: method })])
  ) as unknown as TeamsAPI;
  return { backend, legacy, methods, teams: createHostTeamsApi(Object.freeze(legacy), backend) };
}

describe('request-shaped Host Team authority', () => {
  it('keeps unsupported request-shaped Host config operations away from legacy filesystem routing', async () => {
    const f = fixture();
    for (const method of ['createTeam', 'createConfig', 'updateMemberSettings'] as const) {
      for (const teamName of [hostTeamSelectionKey('TEST-missing-owner'), 'host-team:%']) {
        await expect(Reflect.apply(f.teams[method], f.teams, [{ teamName }])).rejects.toThrow(
          'not supported for Host teams'
        );
      }
      expect(f.legacy[method]).not.toHaveBeenCalled();
    }
    expect(f.backend.getConnections).not.toHaveBeenCalled();
    expect(f.backend.invoke).not.toHaveBeenCalled();
  });

  it('requires an original saved-roster launch intent before any Host or legacy dispatch', async () => {
    const f = fixture();
    await expect(Reflect.apply(f.teams.launchTeam, f.teams, [{
      teamName: hostTeamSelectionKey('TEST-missing-owner'),
    }])).rejects.toMatchObject({ code: 'launch-source-required', outcome: 'not-dispatched' });
    await expect(Reflect.apply(f.teams.launchTeam, f.teams, [{ teamName: 'host-team:%' }])).rejects.toThrow(URIError);
    expect(f.legacy.launchTeam).not.toHaveBeenCalled();
    expect(f.backend.getConnections).not.toHaveBeenCalled();
    expect(f.backend.invoke).not.toHaveBeenCalled();
  });

  it('captures a target-only Host notification for the existing Desktop transport with its original handle', async () => {
    const f = fixture();
    const target = { kind: 'team' as const, teamName: hostTeamSelectionKey('TEST-original/owner') };
    const request = { teamDisplayName: 'Team', from: 'alice', body: 'Message', target };
    await expect(f.teams.showMessageNotification(request)).resolves.toBeUndefined();
    // This shared bridge is the Desktop notification transport; Main validates
    // the captured Host destination rather than treating a Team name as a path.
    expect(f.legacy.showMessageNotification).toHaveBeenCalledExactlyOnceWith({
      ...request, teamName: target.teamName, target: { ...target },
    });
    const captured = vi.mocked(f.legacy.showMessageNotification).mock.calls[0][0];
    expect(captured).not.toBe(request);
    expect(captured.target).not.toBe(target);
    expect(vi.mocked(f.legacy.showMessageNotification).mock.contexts[0]).toBe(f.legacy);
    expect(f.backend.getConnections).not.toHaveBeenCalled();
    expect(f.backend.invoke).not.toHaveBeenCalled();
    for (const method of ['launchTeam', 'createTeam', 'createConfig', 'updateMemberSettings'] as const)
      expect(f.legacy[method]).not.toHaveBeenCalled();
  });

  it('refuses conflicting or malformed Host notification destinations before Desktop transport', async () => {
    const f = fixture();
    for (const teamName of ['same-display-legacy', hostTeamSelectionKey('TEST-another-owner')]) {
      await expect(f.teams.showMessageNotification({
        teamName, teamDisplayName: 'Team', from: 'alice', body: 'Message',
        target: { kind: 'team', teamName: hostTeamSelectionKey('TEST-original') },
      })).rejects.toThrow('Invalid captured Host notification');
    }
    await expect(f.teams.showMessageNotification({
      teamName: 'host-team:%', teamDisplayName: 'Team', from: 'alice', body: 'Message',
    })).rejects.toThrow(URIError);
    await expect(Reflect.apply(f.teams.showMessageNotification, f.teams, [{
      teamName: hostTeamSelectionKey('TEST-original'),
    }])).rejects.toThrow('Invalid captured Host notification');
    expect(f.legacy.showMessageNotification).not.toHaveBeenCalled();
    expect(f.backend.getConnections).not.toHaveBeenCalled();
    expect(f.backend.invoke).not.toHaveBeenCalled();
  });

  it('preserves legacy object arguments, identity and the original frozen bridge receiver', async () => {
    const f = fixture();
    for (const method of f.methods) {
      const request = { teamName: 'same-display-legacy', cwd: '/TEST-only' };
      expect(await Reflect.apply(f.teams[method], f.teams, [request])).toEqual({ legacy: method });
      expect(f.legacy[method]).toHaveBeenCalledExactlyOnceWith(request);
      expect(vi.mocked(f.legacy[method]).mock.contexts[0]).toBe(f.legacy);
    }
    expect(f.backend.getConnections).not.toHaveBeenCalled();
    expect(f.backend.invoke).not.toHaveBeenCalled();
  });
});
