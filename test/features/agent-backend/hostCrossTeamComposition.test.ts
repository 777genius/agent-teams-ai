// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { createFilesystemTeamOwner } from '../../../packages/legacy-agent-host/src/adapters/team/createFilesystemTeamOwner';
import { createHostCrossTeamComposition } from '../../../packages/legacy-agent-host/src/composition/createHostCrossTeamComposition';
import { capturedTeam } from '../../../packages/legacy-agent-host/src/composition/runtimeCaptureSource';
import { startTeamMcpEndpoint } from '../../../packages/legacy-agent-host/src/mcp/endpoint';
import { CrossTeamOutbox } from '../../../packages/legacy-agent-host/src/cross-team/CrossTeamOutbox';
import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { createHostCrossTeamApi } from '../../../src/features/agent-backend/renderer/createHostCrossTeamApi';
import { hostTeamSelectionKey } from '../../../src/features/agent-backend/renderer/hostTeamRouting';

import type { HostedTeam } from '../../../packages/legacy-agent-host/src/composition/MemberEntry';
import type { TeamHostProfile } from '../../../packages/legacy-agent-host/src/composition/TeamHost';
import type { TeamMcpEndpoint } from '../../../packages/legacy-agent-host/src/mcp/contracts';
import type { JsonValue } from '../../../packages/legacy-agent-host/src/contracts';
import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendOwnerRouter } from '../../../src/features/agent-backend/main/application/BackendOwnerRouter';
import type {
  ImmutableDelivery,
  RuntimeMemberBinding,
} from '../../../packages/legacy-agent-host/src/team/contracts';

const roots: string[] = [],
  endpoints: TeamMcpEndpoint[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function fixture(projectRouting: Pick<Parameters<typeof createHostCrossTeamComposition>[0],
  'resolveTarget' | 'assertPair'> = {}) {
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
    ...projectRouting,
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
    profile,
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

it('pages retained cross-Team outbox through real HTTP without losing accepted text or changing storage', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const f = fixture();
  const alpha = await f.endpoint('alpha');
  const target = alpha.port.listTargets().find((row) => row.teamName === 'beta')!;
  const texts = Array.from({ length: 6 }, (_, index) => String(index).repeat(48_000));
  for (const [index, text] of texts.entries()) {
    now += 3_000; // Exercise ordinary accepted traffic under the unchanged pair cooldown.
    const result = await alpha.call('cross_team_send', {
      commandId: 'TEST-outbox-' + index, toTeam: target.resourceRef, text,
      summary: 'TEST summary ' + index,
    });
    expect(result.result).not.toHaveProperty('isError', true);
    expect(result.result.structuredContent.result).toMatchObject({ phase: 'completed' });
    if (index === 0) {
      const small = await alpha.port.getOutbox();
      expect(Object.keys(small).sort()).toEqual(['kind', 'rows']);
      expect(small.rows[0]?.text).toBe(text);
    }
  }
  for (const [index, text] of ['漢'.repeat(28_000), 'TEST \u0001\"\\😀'.repeat(4_000)].entries()) {
    now += 3_000;
    await alpha.port.send({ commandId: 'TEST-outbox-extra-' + index, toTeam: target.resourceRef, text });
    texts.push(text);
  }
  const outboxPath = join(f.root, 'teams/alpha/sent-cross-team.json');
  const before = readFileSync(outboxPath, 'utf8');
  const beforeReceipts = f.team('alpha').owner.crossTeamCommands('native').history();
  expect(Buffer.byteLength(before)).toBeGreaterThan(256 * 1024);
  const all: { messageId: string; text: string; summary?: string; taskRefs?: unknown[] }[] = [];
  let cursor: string | null = null;
  let revision: string | undefined;
  let firstCursor: string | undefined;
  let pages = 0;
  do {
    const response = await alpha.call('cross_team_get_outbox', cursor === null ? {} : { cursor });
    expect(response.result.structuredContent).toMatchObject({ result: { kind: 'cross-team-outbox' } });
    const page = response.result.structuredContent.result as {
      kind: string; rows: typeof all; revision: string; nextCursor: string | null;
    };
    expect(page.kind).toBe('cross-team-outbox');
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(240 * 1024);
    expect(page.revision).toMatch(/^[a-f0-9]{64}$/);
    revision ??= page.revision;
    expect(page.revision).toBe(revision);
    all.push(...page.rows);
    if (pages === 0) firstCursor = page.nextCursor ?? undefined;
    cursor = page.nextCursor;
    expect(++pages).toBeLessThan(16);
  } while (cursor !== null);
  expect(pages).toBeGreaterThan(1);
  expect(all.map((row) => row.text)).toEqual(texts);
  expect(new Set(all.map((row) => row.messageId)).size).toBe(all.length);
  expect(all[0]).toMatchObject({ summary: 'TEST summary 0' });
  const hostRead = (payload: JsonValue) => f.composition.methods['team.crossTeam.outbox.read']!.handle({
    commandId: 'TEST-desktop-read', binding: { schemaVersion: 1, handleId: 'alpha',
      owner: f.profile.owner, scope: f.team('alpha').definition.scope }, payload,
  }, { requestId: 'TEST-request', signal: new AbortController().signal });
  const router = {
    request: vi.fn<BackendOwnerRouter['request']>(async (handle, command) => {
      expect(handle.handleId).toBe('alpha');
      expect(command.method).toBe('team.crossTeam.outbox.read');
      return await hostRead(command.payload);
    }),
    lookup: vi.fn<BackendOwnerRouter['lookup']>(),
  };
  const facade = new BackendOperationsFacade(router);
  const pair = beforeReceipts[0]!.intent.pair;
  const backend: AgentBackendApi = {
    invoke: (request) => facade.invoke(request),
    getConnections: async () => ({ state: 'ready', bindings: [pair.source, pair.target].map((side) => ({
      handle: { handleId: side.teamId }, label: side.teamName, members: [],
      ownerResourceRef: 'TEST-owner', teamResourceRef: side.teamResourceRef,
    })) }),
  };
  const desktop = createHostCrossTeamApi({ send: vi.fn(), listTargets: vi.fn(), getOutbox: vi.fn() }, backend, () => () => true);
  const desktopRows = await desktop.getOutbox(hostTeamSelectionKey('alpha'));
  expect(desktopRows.map((row) => row.text)).toEqual(texts);
  expect(desktopRows[0]).toMatchObject({ fromTeam: hostTeamSelectionKey('alpha'), toTeam: hostTeamSelectionKey('beta') });
  expect(router.request.mock.calls.length).toBeGreaterThan(1);
  expect(readFileSync(outboxPath, 'utf8')).toBe(before);
  expect(f.team('alpha').owner.crossTeamCommands('native').history()).toEqual(beforeReceipts);
  expect(firstCursor).toBeDefined();
  expect(await hostRead({ cursor: firstCursor! })).toMatchObject({ ok: false, code: 'hold' });
  const beta = await f.endpoint('beta');
  expect((await beta.call('cross_team_get_outbox', { cursor: firstCursor })).result.structuredContent)
    .toEqual({ error: { code: 'hold' } });
  expect((await alpha.call('cross_team_get_outbox', { cursor: 'invalid' })).result.structuredContent)
    .toEqual({ error: { code: 'invalid' } });
  expect((await alpha.call('cross_team_get_outbox', { cursor: '1.' + '0'.repeat(64) })).result.structuredContent)
    .toEqual({ error: { code: 'hold' } });
  now += 3_000;
  await alpha.port.send({ commandId: 'TEST-outbox-later', toTeam: target.resourceRef, text: 'New retained row' });
  expect((await alpha.call('cross_team_get_outbox', { cursor: firstCursor })).result.structuredContent)
    .toEqual({ error: { code: 'hold' } });
  f.team('alpha').connection.revoke('native');
  expect((await alpha.call('cross_team_get_outbox', {})).result.structuredContent)
    .toEqual({ error: { code: 'forbidden' } });
});

it('rechecks the current Desktop read grant after the asynchronous outbox read', async () => {
  const f = fixture();
  let entered!: () => void;
  const observed = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(CrossTeamOutbox.prototype, 'read').mockImplementationOnce(async () => {
    entered();
    await gate;
    return [];
  });
  const pending = f.composition.methods['team.crossTeam.outbox.read']!.handle({
    commandId: 'TEST-retired-read', binding: { schemaVersion: 1, handleId: 'alpha',
      owner: f.profile.owner, scope: f.team('alpha').definition.scope }, payload: {},
  }, { requestId: 'TEST-request', signal: new AbortController().signal });
  await observed;
  f.team('alpha').connection.revoke('human');
  release();
  expect(await pending).toMatchObject({ ok: false, code: 'forbidden' });
});

it('keeps a foreign project alias out of the picker while admitting an exact native reply to its original resource', async () => {
  const f = fixture({ resolveTarget(source, requested, _sourceHandle, _targetHandle, visibleOnly) {
    if (source.definition.binding.teamId === 'alpha' &&
        requested.definition.binding.teamId === 'gamma' && visibleOnly)
      throw new Error('TEST physical history hidden from picker');
    return { team: requested };
  } });
  const alpha = await f.endpoint('alpha'), beta = await f.endpoint('beta');
  expect(alpha.port.listTargets().map(row => row.teamName)).toEqual(['beta']);
  const originalTarget = beta.port.listTargets().find(row => row.teamName === 'gamma')!;
  const receipt = await alpha.port.send({ commandId: 'TEST-exact-project-reply',
    toTeam: originalTarget.resourceRef, text: 'TEST retained project recipient' });
  expect(receipt.phase).toBe('completed');
  const inbox = JSON.parse(readFileSync(join(f.root, 'teams/gamma/inboxes/lead.json'), 'utf8'));
  expect(inbox).toHaveLength(1);
  expect(inbox[0].text).toContain('TEST retained project recipient');
  await alpha.port.send({ commandId: 'TEST-exact-project-reply',
    toTeam: originalTarget.resourceRef, text: 'TEST retained project recipient' });
  expect(JSON.parse(readFileSync(join(f.root, 'teams/gamma/inboxes/lead.json'), 'utf8'))).toHaveLength(1);
});

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
