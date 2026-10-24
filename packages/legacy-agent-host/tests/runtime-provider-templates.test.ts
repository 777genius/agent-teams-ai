import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  captureRuntimeSource,
  compileRuntimeCapture,
} from '../dist/composition/runtimeCaptureSource.js';
import { resolveRuntimeRecipe } from '../dist/composition/runtimeRecipe.js';
import { runtimeProfileSchema } from '../dist/composition/runtimeProfile.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { TeamLaunchError } from '../dist/team-launch/contracts.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { RuntimeMemberProfile } from '../dist/composition/runtimeProfile.js';
import type { TeamRosterConfiguration } from '../dist/team/rosterContracts.js';

const limits = {
  queuedInputs: 8,
  inputBytes: 4096,
  outputBytes: 8192,
  outputEvents: 128,
  pendingInteractions: 8,
  timeoutMs: 1000,
};
function claude(memberId = 'lead'): RuntimeMemberProfile {
  return {
    provider: 'claude',
    teamId: 'TEST-team',
    memberId,
    principalId: `TEST-${memberId}-principal`,
    sessionId: `TEST-${memberId}-session`,
    generation: 0,
    configRevision: 'TEST-original',
    model: 'TEST-claude-model',
    accountBinding: `TEST-${memberId}-account`,
    cwd: '/TEST/private-cwd',
    environment: { HOME: '/TEST/private-home', CLAUDE_CONFIG_DIR: '/TEST/private-config' },
    executable: { path: '/TEST/claude', sha256: 'a'.repeat(64) },
    nativeTools: ['Read'],
    autoAllowedTools: ['Read'],
    limits,
  };
}
function codex(): RuntimeMemberProfile {
  return {
    provider: 'codex',
    protocolRevision: '0.162.0',
    teamId: 'TEST-template-team',
    memberId: 'TEST-template-member',
    principalId: 'TEST-template-principal',
    sessionId: 'TEST-template-session',
    generation: 0,
    configRevision: 'TEST-template-revision',
    model: 'TEST-codex-default',
    accountBinding: 'TEST-codex-template-account',
    cwd: '/TEST/template-cwd',
    environment: {
      HOME: '/TEST/codex-home',
      CODEX_HOME: '/TEST/codex-config',
      TEST_PRIVATE: 'private-value',
    },
    executable: { path: '/TEST/codex', sha256: 'b'.repeat(64) },
    limits,
    nativeOptions: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  };
}
function fixture() {
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-team' };
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    principalId: 'TEST-human',
    owner: {
      ownerId: 'TEST-owner',
      revision: 'TEST-revision',
      storageRoot: '/TEST/store',
      profileId: 'TEST-profile',
      protocolVersion: 1,
      buildId: 'TEST-build',
      nodeSha256: 'a'.repeat(64),
      hostEntrySha256: 'b'.repeat(64),
    },
    runtime: { members: [claude()], providerTemplates: [codex()] },
    teams: [
      {
        binding,
        scope: {
          projectId: 'TEST-project',
          workspaceId: 'TEST-workspace',
          teamId: binding.teamId,
          runId: 'TEST-run',
          memberId: 'lead',
          generation: '0',
        },
        members: [{ memberId: 'lead', name: 'captain', role: 'lead' }],
        grants: [],
      },
    ],
  };
  const roster: TeamRosterConfiguration = {
    revision: 'c'.repeat(64),
    savedSettings: { cwd: '/TEST/project' },
    removedMembers: [],
    members: [
      { memberId: 'lead', name: 'captain', role: 'lead', settings: {} },
      { memberId: 'new-member', name: 'worker', role: 'member', settings: { providerId: 'codex' } },
    ],
  };
  const team = { definition: profile.teams[0]! };
  const capture = () => captureRuntimeSource(profile, team, 'TEST-capture', 'TEST-roster', roster);
  return { profile, roster, team, capture };
}
const refusal = (code: string, reason: string) => (error: unknown) =>
  error instanceof TeamLaunchError && error.code === code && error.reason === reason;

test('fresh roster member compiles only its explicit private provider template and binds target identities', () => {
  const f = fixture(),
    source = f.capture();
  const before = structuredClone(f.profile);
  const compiled = compileRuntimeCapture(f.profile, f.team, source);
  const selected = compiled.profiles[1]!;
  assert.equal(selected.provider, 'codex');
  assert.equal(selected.teamId, 'TEST-team');
  assert.equal(selected.memberId, 'new-member');
  assert.equal(selected.accountBinding, 'TEST-codex-template-account');
  assert.deepEqual(selected.environment, codex().environment);
  assert.deepEqual(selected.executable, codex().executable);
  assert.equal(selected.cwd, '/TEST/project');
  assert.equal(selected.model, 'TEST-codex-default');
  assert.notEqual(selected.principalId, codex().principalId);
  assert.notEqual(selected.sessionId, codex().sessionId);
  assert.equal(compiled.registration.members[1]!.memberId, 'new-member');
  assert.deepEqual(
    compileRuntimeCapture(structuredClone(f.profile), f.team, structuredClone(source)),
    compiled
  );
  assert.deepEqual(f.profile, before);
  const publicSource = JSON.stringify(source);
  for (const privateValue of ['private-value', '/TEST/codex-home', 'TEST-codex-template-account'])
    assert.equal(publicSource.includes(privateValue), false);
});

test('saved lead provider change and teammate inheritance use explicit templates without borrowing member accounts', () => {
  const f = fixture();
  f.roster.savedSettings!.providerId = 'codex';
  f.roster.savedSettings!.model = 'TEST-selected-model';
  f.roster.members[1]!.settings = {};
  const compiled = compileRuntimeCapture(f.profile, f.team, f.capture());
  for (const selected of compiled.profiles) {
    assert.equal(selected.provider, 'codex');
    assert.equal(selected.accountBinding, 'TEST-codex-template-account');
    assert.equal(selected.model, 'TEST-selected-model');
  }
  assert.notEqual(compiled.profiles[0]!.sessionId, compiled.profiles[1]!.sessionId);
  delete f.roster.savedSettings!.providerId;
  f.roster.members[0]!.settings.providerId = 'codex';
  assert.equal(
    compileRuntimeCapture(f.profile, f.team, f.capture()).profiles[0]!.provider,
    'codex'
  );
});

test('same-provider exact member recipe keeps its private account and defaults ahead of templates', () => {
  const f = fixture();
  f.roster.members.pop();
  const exact = f.profile.runtime!.members[0]!;
  f.profile.runtime!.providerTemplates!.push({
    ...claude('template'),
    accountBinding: 'TEST-other-account',
  });
  const source = f.capture();
  assert.equal(source.mcpCaptureVersion, 1);
  assert.equal(
    source.members[0]!.recipeDigest,
    runtimeDigest({ ...exact, capturedMcpServers: {} })
  );
  const selected = compileRuntimeCapture(f.profile, f.team, source).profiles[0]!;
  assert.equal(selected.accountBinding, exact.accountBinding);
  assert.deepEqual(selected.environment, exact.environment);
  assert.equal(selected.model, exact.model);
});

test('missing or ambiguous templates refuse; another team member is never an implicit template', () => {
  const f = fixture();
  f.profile.runtime!.members.push({ ...codex(), teamId: 'TEST-other-team' });
  delete f.profile.runtime!.providerTemplates;
  assert.throws(f.capture, refusal('invalid', 'runtime-recipe-unconfigured'));
  f.roster.savedSettings!.providerId = 'codex';
  assert.throws(f.capture, refusal('invalid', 'runtime-recipe-provider-unconfigured'));
  f.profile.runtime!.providerTemplates = [codex(), codex()];
  assert.equal(runtimeProfileSchema.safeParse(f.profile.runtime).success, false);
  assert.throws(f.capture, refusal('invalid', 'runtime-template-ambiguous'));
  assert.equal(
    runtimeProfileSchema.safeParse({ members: [], providerTemplates: [codex()] }).success,
    true
  );
  assert.equal(runtimeProfileSchema.safeParse({ members: [] }).success, false);
});

test('cold reconstruction refuses replaced or removed template and altered provider selection', () => {
  const f = fixture(),
    source = f.capture();
  for (const change of [
    (profile: TeamHostProfile) => {
      profile.runtime!.providerTemplates![0]!.accountBinding = 'TEST-replaced';
    },
    (profile: TeamHostProfile) => {
      profile.runtime!.providerTemplates![0]!.environment.CODEX_HOME = '/TEST/new-home';
    },
    (profile: TeamHostProfile) => {
      profile.runtime!.providerTemplates![0]!.model = 'TEST-new-default';
    },
    (profile: TeamHostProfile) => {
      profile.runtime!.providerTemplates = [];
    },
  ]) {
    const changed = structuredClone(f.profile);
    change(changed);
    assert.throws(
      () => compileRuntimeCapture(changed, f.team, source),
      refusal('hold', 'capture-recipe-changed')
    );
  }
  const altered = structuredClone(source);
  altered.members[1]!.settings.providerId = 'anthropic';
  assert.throws(
    () => compileRuntimeCapture(f.profile, f.team, altered),
    refusal('hold', 'capture-recipe-changed')
  );
});

test('resolver can bind an explicitly selected template to a newly created Team without static members', () => {
  const selected = resolveRuntimeRecipe(
    { members: [], providerTemplates: [codex()] },
    'TEST-new-team',
    'TEST-new-lead',
    'codex'
  );
  assert.equal(selected.teamId, 'TEST-new-team');
  assert.equal(selected.memberId, 'TEST-new-lead');
  assert.equal(selected.accountBinding, 'TEST-codex-template-account');
  assert.throws(
    () =>
      resolveRuntimeRecipe(
        { members: [], providerTemplates: [codex()] },
        'TEST-new-team',
        'TEST-new-lead'
      ),
    refusal('invalid', 'runtime-recipe-unconfigured')
  );
});


test('saved ordered argv enters private recipe digest and final captured configuration', () => {
  const f = fixture();
  f.roster.members = f.roster.members.slice(0, 1);
  f.roster.savedSettings!.extraCliArgs = '--max-turns 5 --json-schema "" --max-turns=7';
  const source = f.capture();
  const selected = compileRuntimeCapture(f.profile, f.team, source).profiles[0]!;
  assert.deepEqual(selected.extraArgs, ['--max-turns', '5', '--json-schema', '', '--max-turns=7']);
  const before = selected.configRevision;
  f.roster.savedSettings!.extraCliArgs = '--max-turns 6';
  const changed = f.capture();
  const after = compileRuntimeCapture(f.profile, f.team, changed).profiles[0]!;
  assert.notEqual(source.members[0]!.recipeDigest, changed.members[0]!.recipeDigest);
  assert.notEqual(before, after.configRevision);
  assert.throws(() => compileRuntimeCapture(f.profile, f.team, { ...source, savedSettings: f.roster.savedSettings! }));
  assert.equal(JSON.stringify(selected.extraArgs).includes('json-schema'), true);
});

test('empty saved argv preserves original recipe and provider-incompatible flags never disappear', () => {
  const f = fixture();
  const before = f.capture();
  f.roster.savedSettings!.extraCliArgs = '  ';
  assert.deepEqual(f.capture().members.map(row => row.recipeDigest), before.members.map(row => row.recipeDigest));
  f.roster.savedSettings!.extraCliArgs = '--max-turns 5';
  assert.throws(() => f.capture(), error => error instanceof TeamLaunchError && error.code === 'invalid');
});


test('versioned runtime selection stays configured and cannot adopt an existing native provider', () => {
  const f = fixture();
  f.roster.savedSettings!.runtimeSelectionVersion = 1;
  assert.throws(() => f.capture(), refusal('invalid', 'runtime-selection-required'));
  f.roster.savedSettings!.providerId = 'anthropic';
  const source = f.capture();
  assert.equal(source.savedSettings.runtimeSelectionVersion, 1);
  const selected = compileRuntimeCapture(f.profile, f.team, source).profiles[0]!;
  assert.equal(selected.provider, 'claude');
  assert.equal(source.savedSettings.providerId, 'anthropic');
});
