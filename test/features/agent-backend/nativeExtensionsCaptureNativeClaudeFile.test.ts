import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { captureNativeClaudeFile } from '../../../packages/legacy-agent-host/src/extensions/captureNativeClaudeFile';
import type { ClaudeManagementProfile } from '../../../packages/legacy-agent-host/src/management/profile';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(custom = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-native-claude-file-')));
  roots.push(root);
  const home = join(root, 'home'),
    config = custom ? join(root, 'custom') : join(home, '.claude');
  mkdirSync(home, { recursive: true });
  mkdirSync(config, { recursive: true });
  const profile: ClaudeManagementProfile = {
    provider: 'claude',
    profileId: 'TEST-profile',
    accountBinding: 'TEST-account',
    configRevision: 'TEST-revision',
    sdkRevision: '0.3.305',
    configNamespace: custom ? 'custom-directory' : 'native-default',
    executable: { path: '/TEST/no-native', sha256: 'a'.repeat(64) },
    environment: {
      HOME: home,
      PATH: '/TEST/private',
      ...(custom ? { CLAUDE_CONFIG_DIR: config } : {}),
    },
    cwd: root,
    timeoutMs: 1000,
  };
  return { root, home, config, profile, capture: () => captureNativeClaudeFile(profile, () => {}) };
}
it('uses exact default/custom native namespaces rather than ambient HOME or an arbitrary catalog source', () => {
  const a = fixture(),
    b = fixture(true);
  expect(a.capture().path).toBe(join(a.home, '.claude.json'));
  expect(b.capture().path).toBe(join(b.config, '.claude.json'));
});
it('matches native legacy precedence and invalidates changed file choice', () => {
  const f = fixture(true),
    legacy = join(f.config, '.config.json'),
    current = join(f.config, '.claude.json');
  writeFileSync(legacy, '{}');
  writeFileSync(current, '{}');
  const original = f.capture();
  expect(original.path).toBe(legacy);
  writeFileSync(legacy, '');
  expect(() => original.assertCurrent()).toThrow();
  expect(f.capture().path).toBe(current);
});
it('matches empty writable legacy only while the default file is absent', () => {
  const f = fixture(),
    legacy = join(f.config, '.config.json');
  writeFileSync(legacy, '', { mode: 0o600 });
  expect(f.capture().path).toBe(legacy);
  chmodSync(legacy, 0o400);
  expect(f.capture().path).toBe(join(f.home, '.claude.json'));
});
it('retains the captured custom-OAuth filename without performing auth or reading process.env', () => {
  const f = fixture(true);
  f.profile.environment.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://TEST.invalid/oauth';
  expect(f.capture().path).toBe(join(f.config, '.claude-custom-oauth.json'));
});
it('refuses linked native config files instead of following a same-path legacy fallback', () => {
  const f = fixture();
  const foreign = join(f.root, 'foreign.json');
  writeFileSync(foreign, '{}');
  symlinkSync(foreign, join(f.home, '.claude.json'));
  expect(() => f.capture()).toThrow();
});
