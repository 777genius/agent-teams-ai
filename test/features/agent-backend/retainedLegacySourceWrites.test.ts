// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureRetainedLegacySourceConfiguration } from '../../../src/features/agent-backend/main/infrastructure/RetainedLegacySourceConfiguration';
import { withOriginalRuntimeScope } from '../../../src/main/services/runtime/OriginalRuntimeScope';
import { atomicWriteAsync } from '../../../src/main/utils/atomicWrite';

import type { OriginalRuntimeScope } from '../../../src/main/services/runtime/OriginalRuntimeScope';
import type { CapturedLegacyStoppedSource } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/createLegacyStoppedTeamSource';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-source-write-')));
  roots.push(root);
  const team = join(root, 'test-team');
  mkdirSync(team);
  for (const name of ['config.json', 'team.meta.json', 'members.meta.json'])
    writeFileSync(join(team, name), '{}');
  const source: CapturedLegacyStoppedSource = {
    sourceId: 'TEST-source',
    sourceOwnerId: 'TEST-owner',
    contextId: 'local',
    teamName: 'test-team',
    roots: [{ category: 'team', path: team }],
    isCurrent: () => true,
  };
  const captured = captureRetainedLegacySourceConfiguration(source);
  const scope: OriginalRuntimeScope = {
    teamName: source.teamName,
    sourceKey: 'TEST-source',
    operation: 'roster',
    cacheNamespace: 'TEST-private',
    binaryPath: '/TEST/never-executed',
    codexBinaryPath: null,
    nativeClaudeBinaryPath: null,
    openCodeBinaryPath: null,
    processEnv: {},
    shellEnv: {},
    providerConnections: {} as never,
    resolveOpenCodeInputDeclaration: vi.fn(),
    assertCurrent: captured.assertCurrent,
    admitLaunch: vi.fn(),
    registerChild: vi.fn(),
    beginSourceWrite: captured.beginWrite,
  };
  return { root, team, captured, scope };
}
describe('original atomic metadata write witnesses', () => {
  it('rebases only the exact bytes committed by the original Main writer', async () => {
    const f = fixture(),
      file = join(f.team, 'members.meta.json'),
      intended = '{"members":[{"name":"TEST-authorized"}]}';
    await withOriginalRuntimeScope(f.scope, () =>
      f.captured.mutate(() => atomicWriteAsync(file, intended))
    );
    expect(readFileSync(file, 'utf8')).toBe(intended);
    expect(f.captured.assertCurrent).not.toThrow();
  });
  it('rejects a foreign provider change during asynchronous precommit without publishing roster', async () => {
    const f = fixture(),
      file = join(f.team, 'members.meta.json');
    await expect(
      withOriginalRuntimeScope(f.scope, () =>
        atomicWriteAsync(file, '{"members":[]}', {
          async beforeCommit() {
            await Promise.resolve();
            writeFileSync(join(f.team, 'team.meta.json'), '{"providerId":"TEST-foreign"}');
          },
        })
      )
    ).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{}');
    expect(f.captured.assertCurrent).toThrow();
  });
  it('does not give a read-only scoped call permission to publish source configuration', async () => {
    const f = fixture();
    f.scope.operation = 'status';
    await expect(
      withOriginalRuntimeScope(f.scope, () =>
        atomicWriteAsync(join(f.team, 'team.meta.json'), '{"cwd":"TEST"}')
      )
    ).rejects.toThrow();
    expect(readFileSync(join(f.team, 'team.meta.json'), 'utf8')).toBe('{}');
  });
  it('keeps ordinary unscoped atomic writes unchanged', async () => {
    const f = fixture(),
      file = join(f.root, 'TEST-unrelated.json');
    await atomicWriteAsync(file, '{"TEST":true}');
    expect(readFileSync(file, 'utf8')).toBe('{"TEST":true}');
  });
});
