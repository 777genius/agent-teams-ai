import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureRuntimeSource, compileRuntimeCapture } from '../dist/composition/runtimeCaptureSource.js';
import { captureCreateTeamDraft } from '../dist/composition/captureCreateTeamDraft.js';
import type { ClaudeMemberProfile } from '../dist/composition/runtimeProfile.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { TeamRosterConfiguration } from '../dist/team/rosterContracts.js';

type SettingSources = NonNullable<NonNullable<ClaudeMemberProfile['nativeOptions']>['settingSources']>;
function fixture(settingSources: SettingSources | undefined) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-claude-settings-sources-')));
  for (const name of ['project', 'home', 'config']) mkdirSync(join(root, name));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-settings' };
  const recipe: ClaudeMemberProfile = {
    provider: 'claude', teamId: binding.teamId, memberId: 'lead',
    principalId: 'TEST-principal', sessionId: 'TEST-session', generation: 0,
    configRevision: 'TEST-private-configuration', accountBinding: 'TEST-account',
    cwd: join(root, 'project'), model: 'TEST-model',
    executable: { path: process.execPath, sha256: 'a'.repeat(64) },
    environment: { HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'config'), PATH: '/TEST/bin' },
    nativeTools: ['Read'], autoAllowedTools: [],
    nativeOptions: { ...(settingSources === undefined ? {} : { settingSources }),
      projectInstructions: { append: 'TEST private project instruction' } },
    limits: { queuedInputs: 8, inputBytes: 4096, outputBytes: 8192,
      outputEvents: 128, pendingInteractions: 8, timeoutMs: 1000 },
  };
  const profile: TeamHostProfile = {
    schemaVersion: 1, principalId: 'TEST-human', creation: { contextIds: ['TEST-context'] },
    owner: { ownerId: 'TEST-owner', profileId: 'TEST-profile', revision: 'TEST-revision',
      storageRoot: root, protocolVersion: 1, buildId: 'TEST-build',
      nodeSha256: 'a'.repeat(64), hostEntrySha256: 'b'.repeat(64) },
    runtime: { members: [recipe], providerTemplates: [structuredClone(recipe)] },
    teams: [{ binding, scope: { projectId: 'TEST-context', workspaceId: 'TEST-context',
      teamId: binding.teamId, runId: 'TEST-run', memberId: 'user', generation: '1' },
      members: [{memberId:'lead',name:'team-lead',role:'lead'}],grants:[] }],
  };
  const roster: TeamRosterConfiguration = {
    revision: 'c'.repeat(64), savedSettings: { cwd: recipe.cwd }, removedMembers: [],
    members: [ {memberId:'lead',name:'team-lead',role:'lead',settings:{}},
      {memberId:'worker',name:'worker',role:'member',settings:{
        role:'TEST role',workflow:'TEST workflow',mcpPolicy:{mode:'appOnly'} }} ],
  };
  const team = { definition: profile.teams[0]! };
  const source = () => captureRuntimeSource(profile, team, 'TEST-capture', 'TEST-roster', roster);
  return { root, profile, roster, team, source };
}

for (const sources of [undefined, [], ['project'], ['user', 'local']] as const) {
  const label = sources === undefined ? 'omitted' : JSON.stringify(sources);
  test(`saved launch preserves ${label} private non-MCP settings sources for appOnly and inherited members`, t => {
    const f = fixture(sources === undefined ? undefined : [...sources]);
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const expected = sources === undefined ? ['user', 'project', 'local'] : [...sources];
    const original = structuredClone(f.profile), source = f.source();
    const compiled = compileRuntimeCapture(f.profile, f.team, source);
    for (const selected of compiled.profiles) {
      assert.equal(selected.provider, 'claude');
      if (selected.provider !== 'claude') throw new Error('TEST expected Claude');
      assert.deepEqual(selected.nativeOptions?.settingSources, expected);
      assert.deepEqual(selected.nativeTools, ['Read']);
      assert.deepEqual(selected.autoAllowedTools, []);
      assert.match(selected.nativeOptions?.projectInstructions?.append ?? '', /TEST private project instruction/);
    }
    const worker = compiled.profiles[1]!;
    assert.ok(worker.provider === 'claude');
    assert.match(worker.nativeOptions?.projectInstructions?.append ?? '', /TEST role/);
    assert.match(worker.nativeOptions?.projectInstructions?.append ?? '', /TEST workflow/);
    assert.deepEqual(f.profile, original, 'native recipes are never rewritten by a product MCP selection');
    assert.deepEqual(compileRuntimeCapture(structuredClone(f.profile), f.team, structuredClone(source)), compiled,
      'cold capture reconstruction uses exactly the same preserved private sources');
    assert.equal(JSON.stringify(source).includes('settingSources'), false, 'private sources are not copied into product payload');
  });
}

for (const sources of [undefined, []] as const) {
  test(`fresh Create probes use the same ${sources === undefined ? 'default' : 'explicit empty'} non-MCP sources as capture`, t => {
    const f = fixture(sources === undefined ? undefined : [...sources]);
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const original = structuredClone(f.profile);
    const captured = captureCreateTeamDraft(f.profile, {preparationId:'TEST-preparation',draft:{
      contextId:'TEST-context',teamName:'test-fresh-settings',savedSettings:{cwd:join(f.root,'project'),providerId:'anthropic'},
      members:[{name:'worker',memberSettings:{mcpPolicy:{mode:'appOnly'}}}],
    }});
    for (const row of captured.selections) {
      assert.equal(row.selection.profile.provider, 'claude');
      if (row.selection.profile.provider !== 'claude') throw new Error('TEST expected Claude probe');
      assert.deepEqual(row.selection.profile.settingSources,
        sources === undefined ? ['user','project','local'] : []);
    }
    assert.deepEqual(f.profile, original);
  });
}
