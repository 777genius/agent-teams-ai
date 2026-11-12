import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeProfileSchema } from '../dist/composition/runtimeProfile.js';
import { openCodeManagementProfileSchema } from '../dist/management/profile.js';
import { teamModelProbeProfile, teamModelProbeSelectionSchema } from '../dist/composition/teamLaunchModelProbe.js';

const nativePath = (name: string) => process.platform === 'win32' ? `C:\\TEST\\${name}` : `/TEST/${name}`;
const member = () => ({
  provider: 'opencode' as const, nativeGeneration: 'v2' as const, protocolRevision: '2.1.4' as const,
  teamId: 'TEST-team', memberId: 'TEST-member', principalId: 'TEST-principal', sessionId: 'TEST-session',
  generation: 1, configRevision: 'TEST-config', model: 'TEST-model', accountBinding: 'TEST-account',
  cwd: nativePath('workspace'), executable: { path: nativePath('bun.exe'), sha256: 'a'.repeat(64) },
  environment: { HOME: nativePath('home'), XDG_CONFIG_HOME: nativePath('config'),
    XDG_DATA_HOME: nativePath('data'), XDG_CACHE_HOME: nativePath('cache') },
  endpoint: 'http://127.0.0.1:12345',
  limits: { queuedInputs: 1, inputBytes: 1024, outputBytes: 1024, outputEvents: 64,
    pendingInteractions: 1, timeoutMs: 1000 },
  embedded: { version: '2.1.4' as const, directory: nativePath('graph'),
    manifestSha256: 'b'.repeat(64), platform: process.platform, arch: process.arch,
    externalDirectory: 'deny' as const },
  nativeOptions: { providerId: 'TEST-provider', agent: 'build' },
});

test('captured V2 runtime and its derived management probe accept only the current native path form', () => {
  const profile = runtimeProfileSchema.parse({ members: [member()] });
  const management = teamModelProbeProfile(profile.members[0]!);
  assert.equal(openCodeManagementProfileSchema.safeParse(management).success, true);
  for (const bad of ['C:relative', '\\\\server\\share\\workspace', '//server/share/workspace',
    '\\rooted-without-drive', process.platform === 'win32' ? '/foreign/workspace' : 'C:\\foreign\\workspace']) {
    assert.equal(runtimeProfileSchema.safeParse({ members: [{ ...member(), cwd: bad }] }).success, false);
    assert.equal(openCodeManagementProfileSchema.safeParse({ ...management, cwd: bad }).success, false);
  }
});

test('the ordinary probe preserves V1 POSIX paths and admits a Windows drive path only for native OpenCode', () => {
  const base = { launchId: 'TEST-launch', rosterRevision: 'TEST-roster', memberId: 'TEST-member', model: 'TEST-model',
    draft: { providerId: 'opencode', target: { kind: 'lead' }, workspace: nativePath('workspace') } };
  assert.equal(teamModelProbeSelectionSchema.safeParse(base).success, true);
  for (const bad of ['C:relative', '\\\\server\\share\\workspace',
    'C:\\TEST\\..\\outside', ...(process.platform === 'win32' ? [] : ['C:\\foreign\\workspace'])]) {
    assert.equal(teamModelProbeSelectionSchema.safeParse({ ...base, draft: { ...base.draft, workspace: bad } }).success, false);
  }
  for (const workspace of ['/repo/', '//server/share/workspace']) {
    assert.equal(teamModelProbeSelectionSchema.safeParse({ ...base, draft: { ...base.draft, workspace } }).success, true,
      'an unselected draft retains the original V1 POSIX path rule');
    assert.equal(runtimeProfileSchema.safeParse({ members: [{ ...member(), cwd: workspace }] }).success, false,
      'a selected V2 runtime still refuses a noncanonical or foreign path before allocation');
  }
  for (const providerId of ['anthropic', 'codex']) {
    assert.equal(teamModelProbeSelectionSchema.safeParse({ ...base,
      draft: { ...base.draft, providerId, workspace: 'C:\\TEST\\workspace' } }).success, false,
    'other providers do not gain Windows qualification from the OpenCode path');
  }
});
