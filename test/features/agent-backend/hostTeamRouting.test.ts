import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { runDesktopHostRoutingProof } from '../../../scripts/legacy-agent-host/desktop-host-routing-proof';
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

function desktopProof(teams: TeamsAPI) {
  const evidence: Record<string, unknown> = {};
  const imports: string[] = [];
  const cdp = {
    send: vi.fn(async () => ({})),
    async evaluate(expression: string) {
      return runInNewContext(expression.replaceAll('await import(', 'await __testImport('), {
        Error,
        window: { __claudeTeamsUiDidInit: true },
        async __testImport(path: string) {
          imports.push(path);
          expect(path).toBe('/api/index.ts');
          return { api: { teams } };
        },
      });
    },
  };
  return {
    evidence,
    imports,
    run: () =>
      runDesktopHostRoutingProof(
        cdp,
        { handleId: 'TEST-routing-owner', root: '/TEST-routing' },
        evidence
      ),
  };
}

describe('request-shaped Host Team authority', () => {
  it('runs all six original Desktop routing probes without Host or legacy dispatch', async () => {
    const f = fixture();
    vi.mocked(f.backend.getConnections).mockResolvedValue({
      state: 'ready',
      bindings: [{ handle: { handleId: 'TEST-routing-owner' }, label: 'TEST owner', members: [] }],
    });
    vi.mocked(f.backend.invoke).mockImplementation(async (request) => {
      expect(request.operation).toBe('team.roster.read');
      return {
        ok: true,
        value: {
          revision: 'a'.repeat(64),
          members: [
            {
              memberId: 'TEST-alice',
              name: 'alice',
              role: 'member',
              settings: {},
              settingsFingerprint: 'b'.repeat(64),
            },
          ],
          removedMembers: [],
        },
      };
    });
    const proof = desktopProof(f.teams);
    await proof.run();
    expect(proof.imports).toEqual(['/api/index.ts']);
    expect(proof.evidence.hostRequestRouting).toMatchObject({
      status: 'PASS',
      probes: [
        {
          method: 'launchTeam',
          outcome: 'Host team operation launch-source-required (not-dispatched)',
        },
        { method: 'createTeam', outcome: 'This operation is not supported for Host teams' },
        { method: 'createConfig', outcome: 'This operation is not supported for Host teams' },
        {
          method: 'updateMemberSettings',
          outcome: 'Host team operation invalid-definition-edit (not-dispatched)',
        },
        { method: 'showMessageNotification', outcome: 'Invalid captured Host notification' },
        { method: 'showMessageNotification', outcome: 'Invalid captured Host notification' },
      ],
    });
    expect(f.backend.getConnections).not.toHaveBeenCalled();
    expect(f.backend.invoke).not.toHaveBeenCalled();
    for (const method of f.methods) expect(f.legacy[method]).not.toHaveBeenCalled();
  });

  it.each([
    ['resolved conflict', async () => ({ outcome: 'target_conflict' })],
    ['resolved completed edit', async () => ({ outcome: 'completed', effect: 'persisted_only' })],
    [
      'old unsupported refusal',
      async () => {
        throw new Error('This operation is not supported for Host teams');
      },
    ],
    [
      'unknown dispatch outcome',
      async () => {
        throw new Error('Host team operation invalid-definition-edit (unknown)');
      },
    ],
  ] as const)(
    'refuses %s as proof of malformed member-settings routing',
    async (_label, update) => {
      const f = fixture();
      const teams = new Proxy(f.teams, {
        get(target, property) {
          return property === 'updateMemberSettings' ? update : Reflect.get(target, property);
        },
      });
      const proof = desktopProof(teams);
      await expect(proof.run()).rejects.toThrow('exact renderer routing refusal');
      expect(proof.evidence.hostRequestRouting).toMatchObject({ status: 'INCOMPLETE' });
      expect(f.backend.getConnections).not.toHaveBeenCalled();
      expect(f.backend.invoke).not.toHaveBeenCalled();
      for (const method of f.methods) expect(f.legacy[method]).not.toHaveBeenCalled();
    }
  );

  it('keeps rejected request-shaped Host operations away from legacy filesystem routing', async () => {
    const f = fixture();
    for (const method of ['createTeam', 'createConfig', 'updateMemberSettings'] as const) {
      for (const teamName of [hostTeamSelectionKey('TEST-missing-owner'), 'host-team:%']) {
        const operation = Reflect.apply(f.teams[method], f.teams, [{ teamName }]);
        if (method === 'updateMemberSettings')
          await expect(operation).rejects.toMatchObject({
            code: 'invalid-definition-edit',
            outcome: 'not-dispatched',
          });
        else await expect(operation).rejects.toThrow('not supported for Host teams');
      }
      expect(f.legacy[method]).not.toHaveBeenCalled();
    }
    expect(f.backend.getConnections).not.toHaveBeenCalled();
    expect(f.backend.invoke).not.toHaveBeenCalled();
  });

  it('guards request-shaped captured destinations before either raw Create result bridge', async () => {
    const f = fixture();
    const createTeamResult = vi.fn(),
      createConfigResult = vi.fn();
    const legacy = Object.freeze({ ...f.legacy, createTeamResult, createConfigResult });
    const teams = createHostTeamsApi(legacy, f.backend);
    for (const method of ['createTeam', 'createConfig'] as const)
      for (const teamName of [hostTeamSelectionKey('TEST-original'), 'host-team:%'])
        await expect(Reflect.apply(teams[method], teams, [{ teamName }])).rejects.toThrow(
          'not supported for Host teams'
        );
    expect(createTeamResult).not.toHaveBeenCalled();
    expect(createConfigResult).not.toHaveBeenCalled();
    expect(f.legacy.createTeam).not.toHaveBeenCalled();
    expect(f.legacy.createConfig).not.toHaveBeenCalled();
    expect(f.backend.getConnections).not.toHaveBeenCalled();
    expect(f.backend.invoke).not.toHaveBeenCalled();
  });

  it('requires an original saved-roster launch intent before any Host or legacy dispatch', async () => {
    const f = fixture();
    await expect(
      Reflect.apply(f.teams.launchTeam, f.teams, [
        {
          teamName: hostTeamSelectionKey('TEST-missing-owner'),
        },
      ])
    ).rejects.toMatchObject({ code: 'launch-source-required', outcome: 'not-dispatched' });
    await expect(
      Reflect.apply(f.teams.launchTeam, f.teams, [{ teamName: 'host-team:%' }])
    ).rejects.toThrow(URIError);
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
      ...request,
      teamName: target.teamName,
      target: { ...target },
    });
    const captured = vi.mocked(f.legacy.showMessageNotification).mock.calls[0][0];
    expect(captured).not.toBe(request);
    expect(captured.target).not.toBe(target);
    expect(vi.mocked(f.legacy.showMessageNotification).mock.contexts[0]).toBe(f.legacy);
    expect(f.backend.getConnections).not.toHaveBeenCalled();
    expect(f.backend.invoke).not.toHaveBeenCalled();
    for (const method of [
      'launchTeam',
      'createTeam',
      'createConfig',
      'updateMemberSettings',
    ] as const)
      expect(f.legacy[method]).not.toHaveBeenCalled();
  });

  it('refuses conflicting or malformed Host notification destinations before Desktop transport', async () => {
    const f = fixture();
    for (const teamName of ['same-display-legacy', hostTeamSelectionKey('TEST-another-owner')]) {
      await expect(
        f.teams.showMessageNotification({
          teamName,
          teamDisplayName: 'Team',
          from: 'alice',
          body: 'Message',
          target: { kind: 'team', teamName: hostTeamSelectionKey('TEST-original') },
        })
      ).rejects.toThrow('Invalid captured Host notification');
    }
    await expect(
      f.teams.showMessageNotification({
        teamName: 'host-team:%',
        teamDisplayName: 'Team',
        from: 'alice',
        body: 'Message',
      })
    ).rejects.toThrow(URIError);
    await expect(
      Reflect.apply(f.teams.showMessageNotification, f.teams, [
        {
          teamName: hostTeamSelectionKey('TEST-original'),
        },
      ])
    ).rejects.toThrow('Invalid captured Host notification');
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
