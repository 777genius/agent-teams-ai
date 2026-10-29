import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  captureRuntimeSource,
  compileRuntimeCapture,
} from '../dist/composition/runtimeCaptureSource.js';
import { captureCreateTeamDraft } from '../dist/composition/captureCreateTeamDraft.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { resolveRuntimeRecipe } from '../dist/composition/runtimeRecipe.js';
import { claudeMcpServers } from '../dist/adapters/providers/claudeMcpServers.js';
import { capturedMcpServersSchema } from '../dist/mcp-catalog/capturedServer.js';
import { TeamLaunchError } from '../dist/team-launch/contracts.js';
import type { ClaudeMemberProfile } from '../dist/composition/runtimeProfile.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { TeamRosterConfiguration } from '../dist/team/rosterContracts.js';
import type { TeamMcpEndpoint } from '../dist/mcp/contracts.js';

function fixture(t: { after(callback: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-runtime-mcp-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'),
    other = join(root, 'other'),
    home = join(root, 'home');
  for (const path of [project, other, home]) mkdirSync(path);
  const configPath = join(home, 'TEST-claude.json');
  const config = {
    unrelatedAuth: 'TEST-not-mcp-private-auth',
    mcpServers: {
      Docs: { command: 'TEST-user-docs', env: { TEST_TOKEN: 'TEST-private-mcp-token' } },
      http: {
        type: 'http',
        url: 'https://example.invalid/mcp',
        headers: { Authorization: 'TEST-private-header' },
      },
      disabled: { command: 'TEST-disabled', enabled: false },
      TEAM: { url: 'https://example.invalid/forged-team' },
    },
    projects: {
      [project]: { mcpServers: { Docs: { command: 'TEST-local-docs' } } },
      [other]: { mcpServers: { Other: { command: 'TEST-other-local' } } },
    },
  };
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(
    join(project, '.mcp.json'),
    JSON.stringify({ mcpServers: { project: { command: 'TEST-project' } } })
  );
  writeFileSync(
    join(other, '.mcp.json'),
    JSON.stringify({ mcpServers: { OtherProject: { command: 'TEST-other-project' } } })
  );
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team', teamName: 'test-mcp' };
  const recipe: ClaudeMemberProfile = {
    provider: 'claude',
    teamId: binding.teamId,
    memberId: 'lead',
    principalId: 'TEST-principal',
    sessionId: 'TEST-session',
    generation: 0,
    configRevision: 'TEST-config',
    cwd: project,
    environment: { HOME: home, CLAUDE_CONFIG_DIR: home, PATH: '/TEST/bin' },
    executable: { path: process.execPath, sha256: 'a'.repeat(64) },
    accountBinding: 'TEST-account',
    model: 'TEST-model',
    nativeTools: ['Read'],
    autoAllowedTools: [],
    nativeOptions: { settingSources: ['project'] },
    mcpCatalogSource: { claudeConfigPath: configPath },
    limits: {
      queuedInputs: 8,
      inputBytes: 4096,
      outputBytes: 8192,
      outputEvents: 128,
      pendingInteractions: 8,
      timeoutMs: 1000,
    },
  };
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    principalId: 'TEST-human',
    creation: { contextIds: ['TEST-context'] },
    owner: {
      ownerId: 'TEST-owner',
      profileId: 'TEST-profile',
      revision: 'TEST-revision',
      storageRoot: root,
      protocolVersion: 1,
      buildId: 'TEST-build',
      nodeSha256: 'a'.repeat(64),
      hostEntrySha256: 'b'.repeat(64),
    },
    runtime: { members: [recipe], providerTemplates: [structuredClone(recipe)] },
    teams: [
      {
        binding,
        scope: {
          projectId: 'TEST-context',
          workspaceId: 'TEST-context',
          teamId: binding.teamId,
          runId: 'TEST-run',
          memberId: 'user',
          generation: '1',
        },
        members: [],
        grants: [],
      },
    ],
  };
  const roster: TeamRosterConfiguration = {
    revision: 'c'.repeat(64),
    savedSettings: { cwd: project, providerId: 'anthropic' },
    removedMembers: [],
    members: [
      { memberId: 'lead', name: 'team-lead', role: 'lead', settings: {} },
      { memberId: 'inherit', name: 'inherit', role: 'member', settings: { cwd: other } },
      {
        memberId: 'scoped',
        name: 'scoped',
        role: 'member',
        settings: {
          cwd: other,
          mcpPolicy: {
            mode: 'inheritScopes',
            scopes: { user: false, project: false, local: true },
          },
        },
      },
      {
        memberId: 'strict',
        name: 'strict',
        role: 'member',
        settings: {
          mcpPolicy: { mode: 'strictAllowlist', serverNames: ['docs'], scopes: { local: false } },
        },
      },
      {
        memberId: 'app',
        name: 'app',
        role: 'member',
        settings: { mcpPolicy: { mode: 'appOnly' } },
      },
    ],
  };
  const team = { definition: profile.teams[0]! };
  return {
    root,
    project,
    other,
    configPath,
    config,
    recipe,
    profile,
    roster,
    team,
    source: () => captureRuntimeSource(profile, team, 'TEST-command', 'TEST-roster', roster),
  };
}

test('actual private catalog+dynamic cwd compile all existing member MCP modes before digest', (t) => {
  const f = fixture(t),
    original = structuredClone(f.profile),
    source = f.source();
  const result = compileRuntimeCapture(f.profile, f.team, source);
  const [lead, inherit, scoped, strict, app] = result.profiles;
  assert.equal(source.mcpCaptureVersion, 1);
  assert.deepEqual(Object.keys(lead!.capturedMcpServers!).sort(), ['Docs', 'http', 'project']);
  assert.deepEqual(
    inherit!.capturedMcpServers,
    lead!.capturedMcpServers,
    'inheritLead is original lead selection even in another cwd'
  );
  assert.deepEqual(scoped!.capturedMcpServers, {
    Other: { type: 'stdio', command: 'TEST-other-local' },
  });
  assert.deepEqual(strict!.capturedMcpServers, {
    Docs: {
      type: 'stdio',
      command: 'TEST-user-docs',
      env: { TEST_TOKEN: 'TEST-private-mcp-token' },
    },
  });
  assert.deepEqual(app!.capturedMcpServers, {});
  for (const selected of result.profiles) {
    assert.equal(selected.provider, 'claude');
    if (selected.provider !== 'claude') throw new Error('TEST expected Claude');
    assert.deepEqual(
      selected.nativeOptions?.settingSources,
      ['project'],
      'MCP scope never disables instructions/skills/hooks sources'
    );
  }
  assert.deepEqual(f.profile, original);
  const wire = JSON.stringify(source);
  for (const privateValue of [
    'TEST-private-mcp-token',
    'TEST-private-header',
    'TEST-not-mcp-private-auth',
    f.configPath,
    'capturedMcpServers',
    'mcpCatalogSource',
  ])
    assert.equal(
      wire.includes(privateValue),
      false,
      `private value absent from capture: ${privateValue}`
    );
  assert.deepEqual(
    compileRuntimeCapture(structuredClone(f.profile), f.team, structuredClone(source)),
    result
  );
});

test('changed actual private source holds original command rather than compiling replacement config', (t) => {
  const f = fixture(t),
    source = f.source();
  f.config.mcpServers.http.headers.Authorization = 'TEST-changed-private-header';
  writeFileSync(f.configPath, JSON.stringify(f.config));
  assert.throws(
    () => compileRuntimeCapture(f.profile, f.team, source),
    (error: unknown) =>
      error instanceof TeamLaunchError &&
      error.code === 'hold' &&
      error.reason === 'capture-recipe-changed'
  );
  assert.equal(source.commandId, 'TEST-command');
});

test('old unversioned captures preserve exact existing recipe semantics without new catalog reads', (t) => {
  const f = fixture(t);
  delete f.recipe.mcpCatalogSource;
  delete f.profile.runtime!.providerTemplates![0]!.mcpCatalogSource;
  f.roster.members = f.roster.members.filter((member) => ['lead', 'app'].includes(member.memberId));
  const source = f.source();
  delete source.mcpCaptureVersion;
  for (const member of source.members)
    member.recipeDigest = runtimeDigest(
      resolveRuntimeRecipe(f.profile.runtime, 'TEST-team', member.memberId, 'anthropic')
    );
  const result = compileRuntimeCapture(f.profile, f.team, source);
  assert.ok(result.profiles.every((profile) => profile.capturedMcpServers === undefined));
});

test('Create uses same policy compiler and never exposes private MCP credentials in selections', (t) => {
  const f = fixture(t);
  const captured = captureCreateTeamDraft(f.profile, {
    preparationId: 'TEST-preparation',
    draft: {
      contextId: 'TEST-context',
      teamName: 'test-fresh-mcp',
      savedSettings: { cwd: f.project, providerId: 'anthropic' },
      members: [
        {
          name: 'worker',
          memberSettings: { mcpPolicy: { mode: 'strictAllowlist', serverNames: ['http'] } },
        },
      ],
    },
  });
  assert.equal(captured.selections.length, 2);
  assert.equal(JSON.stringify(captured.selections).includes('TEST-private-header'), false);
});

test('Claude config contains selected transports and immutable Team while caller mutation cannot retarget it', (t) => {
  const f = fixture(t),
    compiled = compileRuntimeCapture(f.profile, f.team, f.source()).profiles[0]!;
  assert.equal(compiled.provider, 'claude');
  if (compiled.provider !== 'claude') throw new Error('TEST expected Claude');
  const endpoint: Pick<TeamMcpEndpoint, 'url' | 'bearerToken'> = {
    url: 'http://127.0.0.1:12345/team',
    bearerToken: 'TEST-team-token',
  };
  const result = claudeMcpServers(compiled, endpoint);
  assert.equal(result.Docs!.type, 'stdio');
  assert.deepEqual(result.team, {
    type: 'http',
    url: endpoint.url,
    headers: { Authorization: 'Bearer TEST-team-token' },
  });
  compiled.capturedMcpServers!.http = { type: 'http', url: 'https://example.invalid/changed' };
  assert.deepEqual(result.http, {
    type: 'http',
    url: 'https://example.invalid/mcp',
    headers: { Authorization: 'TEST-private-header' },
  });
  assert.equal(
    capturedMcpServersSchema.safeParse({
      TEAM: { type: 'http', url: 'https://example.invalid/spoof' },
    }).success,
    false
  );
});
