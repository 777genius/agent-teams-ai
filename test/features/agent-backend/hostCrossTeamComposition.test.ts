// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { createFilesystemTeamOwner } from '../../../packages/legacy-agent-host/src/adapters/team/createFilesystemTeamOwner';
import { createHostCrossTeamComposition } from '../../../packages/legacy-agent-host/src/composition/createHostCrossTeamComposition';
import { capturedTeam } from '../../../packages/legacy-agent-host/src/composition/runtimeCaptureSource';
import { startTeamMcpEndpoint } from '../../../packages/legacy-agent-host/src/mcp/endpoint';

import type { HostedTeam } from '../../../packages/legacy-agent-host/src/composition/MemberEntry';
import type { TeamHostProfile } from '../../../packages/legacy-agent-host/src/composition/TeamHost';
import type { TeamMcpEndpoint } from '../../../packages/legacy-agent-host/src/mcp/contracts';
import type {
  ImmutableDelivery,
  RuntimeMemberBinding,
} from '../../../packages/legacy-agent-host/src/team/contracts';

const roots: string[] = [],
  endpoints: TeamMcpEndpoint[] = [];
afterEach(async () => {
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-cross-team-headless-')));
  roots.push(root);
  const profile: Pick<TeamHostProfile, 'owner' | 'principalId'> = {
    principalId: 'human',
    owner: {
      ownerId: 'TEST-host',
      revision: '1',
      storageRoot: root,
      profileId: 'TEST-profile',
      protocolVersion: 1,
      buildId: 'TEST-build',
      nodeSha256: 'a'.repeat(64),
      hostEntrySha256: 'b'.repeat(64),
    },
  };
  const teams = new Map<string, HostedTeam>(),
    active = new Map<string, readonly ImmutableDelivery[]>();
  let current = true;
  const composition = createHostCrossTeamComposition({
    profile,
    teams,
    assertCurrent() {
      if (!current) throw new Error('TEST owner retired');
    },
    activeInputs: (binding) => active.get(binding.teamId) ?? [],
  });
  for (const name of ['alpha', 'beta', 'gamma']) {
    const binding = { backendId: 'TEST-host', teamId: name, teamName: name };
    const delivery = { ...binding, memberId: 'lead', runId: `${name}-run`, generation: '1' };
    const definition: HostedTeam['definition'] = {
      binding,
      scope: {
        projectId: 'TEST-project',
        workspaceId: 'TEST-workspace',
        teamId: name,
        runId: delivery.runId,
        memberId: 'lead',
        generation: '1',
      },
      members: [{ name: 'lead', memberId: 'lead', role: 'lead', delivery }],
      grants: [
        {
          principalId: 'human',
          memberName: 'user',
          permissions: ['read', 'message.write', 'admin'],
        },
        { principalId: 'native', memberName: 'lead', permissions: ['read', 'message.write'] },
      ],
    };
    const owner = createFilesystemTeamOwner({
      root,
      ...definition,
      crossTeamSourceAuthority: composition.sourceAuthorized,
    });
    teams.set(name, { definition, owner, connection: owner.connect('human') });
  }
  const team = (name: string) => {
    const result = teams.get(name);
    if (!result) throw new Error('TEST missing team');
    return result;
  };
  const binding = (name: string): RuntimeMemberBinding => ({
    backendId: 'TEST-host',
    teamId: name,
    memberId: 'lead',
    runId: `${name}-run`,
    generation: '1',
  });
  const captured = (name: string) => {
    const original = team(name),
      configurationRevision = 'c'.repeat(64);
    return capturedTeam(
      original,
      {
        commandId: 'TEST-capture-' + name,
        rosterCommandId: 'TEST-roster-' + name,
        configurationRevision,
        savedSettings: { cwd: root },
        members: original.definition.members.map((member) => ({
          memberId: member.memberId,
          name: member.name,
          role: member.role,
          settings: {},
          recipeDigest: 'd'.repeat(64),
        })),
      },
      {
        commandId: 'TEST-capture-' + name,
        configurationRevision,
        launchId: name + '-run',
        members: original.definition.members.map((member) => ({
          memberId: member.memberId,
          principalId: 'native',
          delivery: member.delivery!,
        })),
      }
    );
  };
  async function endpoint(name: string, useCapture = false) {
    const original = team(name),
      member = binding(name);
    const port = composition.memberPort(
      useCapture ? captured(name) : original,
      'native',
      member,
      () => current
    );
    const endpoint = await startTeamMcpEndpoint({
      binding: { ...member, teamName: name },
      expiresAtMs: Date.now() + 60_000,
      isCurrentBinding: () => current,
      connection: { ...original.owner.connect('native'), crossTeam: port },
    });
    endpoints.push(endpoint);
    return {
      port,
      async call(tool: string, args: Record<string, unknown>) {
        const response = await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${endpoint.bearerToken}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'TEST-request',
            method: 'tools/call',
            params: { name: tool, arguments: args },
          }),
        });
        return { ...(await response.json()), status: response.status } as {
          status: number;
          result: { isError?: boolean; structuredContent: { result?: unknown; error?: unknown } };
        };
      },
    };
  }
  return {
    root,
    team,
    teams,
    binding,
    captured,
    composition,
    active,
    endpoint,
    revoke() {
      current = false;
    },
  };
}

it.each([false, true])(
  'routes headless same-Host tools through real owners and original receipts (captured snapshot: %s)',
  async (useCapture) => {
    const f = fixture(),
      alpha = await f.endpoint('alpha', useCapture),
      beta = await f.endpoint('beta', useCapture);
    expect(
      alpha.port
        .listTargets()
        .map((row) => row.teamName)
        .sort()
    ).toEqual(['beta', 'gamma']);
    const target = alpha.port.listTargets().find((row) => row.teamName === 'beta');
    if (!target) throw new Error('TEST target missing');
    const input = {
      commandId: 'TEST-original',
      toTeam: target.resourceRef,
      text: 'TEST from alpha',
    };
    const sent = await alpha.call('cross_team_send', input);
    expect(sent.result.isError).not.toBe(true);
    expect(sent.result.structuredContent.result).toMatchObject({
      phase: 'completed',
      messageId: 'TEST-original',
    });
    const original = f.team('alpha').owner.crossTeamCommands('native').lookup('TEST-original');
    if (!original) throw new Error('TEST original absent');
    expect(original.intent.pair.source.handleId).toBeUndefined();
    expect(original.intent.pair.target.handleId).toBeUndefined();
    expect(alpha.port.lookup('TEST-original')).toMatchObject({
      commandId: 'TEST-original',
      phase: 'completed',
    });
    expect(
      (await alpha.call('cross_team_send', input)).result.structuredContent.result
    ).toMatchObject({ deduplicated: true });
    expect(f.team('beta').connection.pendingDeliveries()).toHaveLength(1);
    const pending = f.team('beta').connection.pendingDeliveries()[0];
    if (!pending) throw new Error('TEST delivery absent');
    f.active.set('beta', [pending]);
    const back = beta.port.listTargets().find((row) => row.teamName === 'alpha');
    if (!back) throw new Error('TEST reply target absent');
    const reply = await beta.call('cross_team_send', {
      commandId: 'TEST-reply',
      toTeam: back.resourceRef,
      text: 'TEST reply',
    });
    expect(reply.result.structuredContent.result).toMatchObject({
      phase: 'completed',
      conversationId: original.intent.request.conversationId,
    });
    expect(
      f.team('beta').owner.crossTeamCommands('native').lookup('TEST-reply')?.intent.request
        .replyToConversationId
    ).toBe(original.intent.request.conversationId);
    expect((await alpha.port.getOutbox()).rows).toHaveLength(1);
    expect((await beta.port.getOutbox()).rows).toHaveLength(1);
    expect(
      (await alpha.call('cross_team_send', { ...input, text: 'TEST changed' })).result.isError
    ).toBe(true);
    const gamma = alpha.port.listTargets().find((row) => row.teamName === 'gamma');
    if (!gamma) throw new Error('TEST third target absent');
    expect(
      (await alpha.call('cross_team_send', { ...input, toTeam: gamma.resourceRef })).result.isError
    ).toBe(true);
    expect(f.team('gamma').connection.pendingDeliveries()).toEqual([]);
    expect(
      (
        await alpha.call('cross_team_send', {
          commandId: 'TEST-name-spoof',
          toTeam: 'beta',
          text: 'TEST spoof',
        })
      ).result.isError
    ).toBe(true);
    expect(
      f.team('alpha').owner.crossTeamCommands('native').lookup('TEST-name-spoof')
    ).toBeUndefined();
    f.revoke();
    expect(
      (
        await alpha.call('cross_team_send', {
          commandId: 'TEST-stale',
          toTeam: target.resourceRef,
          text: 'TEST stale',
        })
      ).status
    ).toBe(401);
    expect(f.team('beta').connection.pendingDeliveries()).toHaveLength(1);
  }
);

it('captured cross-Team ports refuse canonical replacement and stale identity without reading or writing another Team', async () => {
  const snapshot = (root: string): unknown =>
    readdirSync(root, { withFileTypes: true }).map((item) => [
      item.name,
      item.isDirectory() ? snapshot(join(root, item.name)) : readFileSync(join(root, item.name)),
    ]);
  const changes: ((f: ReturnType<typeof fixture>, source: HostedTeam) => void)[] = [
    (f) => {
      f.teams.delete('alpha');
    },
    (f) => {
      f.teams.set('alpha', { ...f.team('alpha') });
    },
    (f) => {
      f.team('alpha').owner = f.team('beta').owner;
    },
    (f) => {
      f.team('alpha').connection = f.team('alpha').owner.connect('human');
    },
    (f) => {
      f.team('alpha').definition.binding = {
        ...f.team('alpha').definition.binding,
        backendId: 'TEST-other-host',
      };
    },
    (_f, source) => {
      source.owner = _f.team('beta').owner;
    },
    (_f, source) => {
      source.connection = source.owner.connect('human');
    },
    (_f, source) => {
      source.definition.binding = { ...source.definition.binding, teamId: 'beta' };
    },
  ];
  for (const change of changes) {
    const f = fixture(),
      source = f.captured('alpha');
    const port = f.composition.memberPort(source, 'native', f.binding('alpha'), () => true);
    const before = snapshot(f.root);
    change(f, source);
    expect(() => port.listTargets()).toThrow(/forbidden/);
    expect(() => port.lookup('TEST-never-adopt')).toThrow(/forbidden/);
    await expect(async () => port.getOutbox()).rejects.toThrow(/forbidden/);
    await expect(
      port.send({ commandId: 'TEST-never-adopt', toTeam: 'beta', text: 'TEST refused' })
    ).rejects.toThrow(/forbidden/);
    expect(snapshot(f.root)).toEqual(before);
  }
  const f = fixture(),
    source = f.captured('alpha');
  let current = true;
  const port = f.composition.memberPort(source, 'native', f.binding('alpha'), () => current);
  expect(port.listTargets()).toHaveLength(2);
  const before = snapshot(f.root);
  current = false;
  expect(() => port.listTargets()).toThrow(/forbidden/);
  expect(snapshot(f.root)).toEqual(before);
  for (const [principal, binding] of [
    ['native', { ...f.binding('alpha'), generation: 'TEST-stale-generation' }],
    ['human', f.binding('alpha')],
  ] as const) {
    const foreign = f.composition.memberPort(source, principal, binding, () => true);
    expect(() => foreign.listTargets()).toThrow(/forbidden/);
    await expect(
      foreign.send({ commandId: 'TEST-foreign-actor', toTeam: 'beta', text: 'TEST refused' })
    ).rejects.toThrow(/forbidden/);
    expect(snapshot(f.root)).toEqual(before);
  }
  f.teams.delete('alpha');
  const unbound = f.composition.memberPort(source, 'native', f.binding('alpha'), () => true);
  f.teams.set('alpha', { ...source });
  expect(() => unbound.listTargets(), 'no late canonical adoption').toThrow(/forbidden/);
  expect(snapshot(f.root)).toEqual(before);
});
