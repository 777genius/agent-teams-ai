// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { captureOpenCodeReadinessOrigin } from '../../../packages/legacy-agent-host/dist/adapters/providers/OpenCodeReadinessOrigin.js';
import { desktopBackendEnvironment } from '../../../scripts/legacy-agent-host/desktop-runtime-source-fixture';
import { captureLocalModelReadinessOrigin, captureRequestReadinessBudget } from '../../../src/features/agent-backend/main/infrastructure/CapturedLocalModelReadiness';
import { getOpenCodeGlobalConfigOverrideConflict } from '../../../src/features/runtime-provider-management/main/infrastructure/openCodeGlobalConfigOverrides';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-desktop-readiness-')));
  roots.push(root);
  const home = join(root, 'home'), workspace = join(root, 'workspace');
  await Promise.all([home, workspace].map(path => mkdir(path, { mode: 0o700 })));
  const environment = desktopBackendEnvironment(root, process.execPath, join(root, 'descriptor.json'), 'a'.repeat(64));
  const capture = (selectedEnvironment: NodeJS.ProcessEnv, current = () => {}) => captureLocalModelReadinessOrigin({
    kind: 'team', owner: { ownerId: 'TEST-owner', revision: 'TEST-owner-revision', protocolVersion: 1,
      profileId: 'TEST-profile', buildId: 'TEST-build', nodeSha256: 'b'.repeat(64), hostEntrySha256: 'c'.repeat(64), storageRoot: root },
    contextId: 'TEST-context', commandId: 'TEST-original-preflight', selection: { workspace, model: 'test-provider/TEST-model' },
    workspaces: [workspace], targets: [{ workspace, providerId: 'test-provider' }], home,
    environment: selectedEnvironment, budget: captureRequestReadinessBudget(15_000), current,
    readApprovals: async () => { throw new Error('Absent configuration must not consult unrelated approvals'); },
  });
  return { root, home, workspace, environment, capture };
}

it('uses the canonical application config while retaining the original refusal for noncanonical XDG with both files absent', async () => {
  const f = await fixture();
  const before = { ...f.environment, XDG_CONFIG_HOME: join(f.root, 'config') };
  expect(await getOpenCodeGlobalConfigOverrideConflict(before, f.home)).toMatchObject({ code: 'config-conflict' });
  const refused = await f.capture(before);
  expect(refused.workspaces[0].global).toMatchObject({ invalid: true, selectedPath: null, selectorFailure: 'config-conflict' });
  if ('notConsulted' in refused.workspaces[0].global) throw new Error('Expected original global source observation');
  expect(refused.workspaces[0].global.sources.map(source => source.present)).toEqual([false, false]);

  expect(f.environment.XDG_CONFIG_HOME).toBe(join(f.environment.HOME, '.config'));
  expect(await getOpenCodeGlobalConfigOverrideConflict(f.environment, f.home)).toBeNull();
  const original = await f.capture(f.environment);
  expect(original.workspaces[0].global).toMatchObject({ invalid: false, selectedPath: join(f.home, '.config', 'opencode', 'opencode.json') });
  if ('notConsulted' in original.workspaces[0].global) throw new Error('Expected original global source observation');
  expect(original.workspaces[0].global.sources.map(source => source.present)).toEqual([false, false]);
  expect(original.approval).toEqual({ notConsulted: 'no-private-target' });
  const accepted = captureOpenCodeReadinessOrigin(original, { cwd: f.workspace }, 'test-provider', () => true);
  expect(accepted.invalid).toBe(false);
  expect(accepted.isCurrent()).toBe(true);
});

it('still refuses the original readiness capture after context revocation', async () => {
  const f = await fixture();
  await expect(f.capture(f.environment, () => { throw new Error('TEST original context revoked'); }))
    .rejects.toThrow('TEST original context revoked');
});
