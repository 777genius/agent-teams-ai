// @vitest-environment node
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  captureRetainedLegacyRuntimeIdentity,
  captureRetainedLegacySourceConfiguration,
  retainedLegacySourceOperationKey,
} from '../../../src/features/agent-backend/main/infrastructure/RetainedLegacyRuntimeScope';
import { retainedLegacyAccountPaths } from '../../../src/main/composition/captureDesktopRetainedLegacyRuntime';
import { readGeminiGlobalConfig } from '../../../src/main/services/runtime/geminiRuntimeAuth';

import type { CapturedLegacyStoppedSource } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/createLegacyStoppedTeamSource';

const roots: string[] = [];
const paths = vi.hoisted(() => ({ root: '/TEST-retained-identity-not-initialized' }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => paths.root,
}));
vi.mock('../../../src/main/utils/pathDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/utils/pathDecoder')>()),
  getClaudeBasePath: () => join(paths.root, '.claude'),
  getAppDataPath: () => join(paths.root, 'app'),
}));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-retained-identity-')));
  paths.root = root;
  roots.push(root);
  const team = join(root, 'teams', 'test-original');
  mkdirSync(team, { recursive: true });
  for (const name of ['config.json', 'team.meta.json', 'members.meta.json'])
    writeFileSync(join(team, name), '{}');
  const executable = join(root, 'TEST-finite-executable');
  const credentials = join(root, 'TEST-credentials.json');
  writeFileSync(executable, 'TEST never executed');
  writeFileSync(credentials, 'TEST original account');
  let current = true,
    selected = 'TEST-original-profile';
  const source: CapturedLegacyStoppedSource = {
    sourceId: 'TEST-context-one-source',
    sourceOwnerId: 'TEST-context-one-owner',
    contextId: 'TEST-context-one',
    teamName: 'test-original',
    roots: [{ category: 'team', path: team }],
    isCurrent: () => current,
  };
  return {
    root,
    team,
    executable,
    credentials,
    source,
    retire: () => {
      current = false;
    },
    changeAccount: () => {
      selected = 'TEST-other-profile';
    },
    capture: () =>
      captureRetainedLegacyRuntimeIdentity({
        executable,
        accountFiles: [credentials],
        readSelection: () => selected,
      }),
  };
}

describe('retained legacy physical source and private account identity', () => {
  it.each(['default-home', 'selected-config'] as const)(
    'rejects a Gemini backend/account edit in the original %s global config',
    async (kind) => {
      const f = fixture();
      const env = {
        HOME: f.root,
        ...(kind === 'selected-config'
          ? { CLAUDE_CONFIG_DIR: join(f.root, 'TEST-selected-claude') }
          : {}),
      };
      const configDir = env.CLAUDE_CONFIG_DIR ?? join(f.root, '.claude');
      mkdirSync(configDir, { recursive: true });
      const file = join(configDir, '.config.json');
      writeFileSync(file, '{"geminiLastAuthMethod":"TEST-original-account"}');
      const selected = retainedLegacyAccountPaths(env, f.root);
      expect(selected.files).toContain(file);
      const current = captureRetainedLegacyRuntimeIdentity({
        executable: f.executable,
        accountFiles: selected.files,
        accountDirectories: selected.directories,
        readSelection: () => env,
      });
      expect(current).not.toThrow();
      writeFileSync(file, '{"geminiLastAuthMethod":"TEST-replaced-account"}');
      expect(await readGeminiGlobalConfig(env)).toEqual({
        geminiLastAuthMethod: 'TEST-replaced-account',
      });
      expect(current).toThrow('Original runtime selection is unavailable');
    }
  );
  it.each(['absolute', 'project-relative', 'project-relative-whitespace'] as const)(
    'pins bytes of an explicit %s Google credential override to the captured project',
    (kind) => {
      const f = fixture();
      const firstProject = join(f.root, 'TEST-first-project');
      const nextProject = join(f.root, 'TEST-next-project');
      const filename =
        kind === 'project-relative-whitespace'
          ? ' TEST-google-credentials.json '
          : 'TEST-google-credentials.json';
      mkdirSync(firstProject);
      mkdirSync(nextProject);
      const firstFile = join(firstProject, filename);
      const nextFile = kind === 'absolute' ? firstFile : join(nextProject, filename);
      writeFileSync(firstFile, '{"account":"TEST-original"}');
      if (nextFile !== firstFile) writeFileSync(nextFile, '{"account":"TEST-next-project"}');
      const env = {
        HOME: f.root,
        GOOGLE_APPLICATION_CREDENTIALS: kind === 'absolute' ? firstFile : filename,
      };
      const capture = (project: string) => {
        const selected = retainedLegacyAccountPaths(env, project);
        return {
          files: selected.files,
          current: captureRetainedLegacyRuntimeIdentity({
            executable: f.executable,
            accountFiles: selected.files,
            accountDirectories: selected.directories,
            readSelection: () => env,
          }),
        };
      };
      const first = capture(firstProject);
      const rebound = capture(nextProject);
      expect(first.files).toContain(firstFile);
      expect(rebound.files).toContain(nextFile);
      writeFileSync(nextFile, '{"account":"TEST-account-changed"}');
      expect(rebound.current).toThrow('Original runtime selection is unavailable');
      if (nextFile !== firstFile) expect(first.current).not.toThrow();
      writeFileSync(firstFile, '{"account":"TEST-first-account-changed"}');
      expect(first.current).toThrow('Original runtime selection is unavailable');
    }
  );
  it('uses one physical operation key across different context/profile receipt identities', () => {
    const f = fixture();
    const alias = {
      ...f.source,
      sourceId: 'TEST-context-two-source',
      sourceOwnerId: 'TEST-context-two-owner',
      contextId: 'TEST-context-two',
    };
    expect(retainedLegacySourceOperationKey(f.source)).toBe(
      retainedLegacySourceOperationKey(alias)
    );
    expect(alias.sourceId).not.toBe(f.source.sourceId);
  });
  it.skipIf(process.platform === 'win32')(
    'canonicalizes parent path aliases but refuses a symlink Team',
    () => {
      const f = fixture(),
        aliasRoot = join(f.root, 'TEST-teams-alias');
      symlinkSync(join(f.root, 'teams'), aliasRoot);
      expect(
        retainedLegacySourceOperationKey({
          ...f.source,
          roots: [{ category: 'team', path: join(aliasRoot, f.source.teamName) }],
        })
      ).toBe(retainedLegacySourceOperationKey(f.source));
      const linkedTeam = join(f.root, 'TEST-linked-team');
      symlinkSync(f.team, linkedTeam);
      expect(() =>
        retainedLegacySourceOperationKey({
          ...f.source,
          roots: [{ category: 'team', path: linkedTeam }],
        })
      ).toThrow();
    }
  );
  it('rejects a replaced physical source even if its original Team name still exists', () => {
    const f = fixture();
    f.retire();
    expect(() => retainedLegacySourceOperationKey(f.source)).toThrow();
  });
  it('refuses a different selected account without exposing private selectors', () => {
    const f = fixture(),
      current = f.capture();
    f.changeAccount();
    expect(current).toThrow('Original runtime selection is unavailable');
    try {
      current();
    } catch (error) {
      expect(String(error)).not.toContain('TEST-other-profile');
    }
  });
  it('detects credential-byte replacement even with the same path and length', () => {
    const f = fixture(),
      current = f.capture();
    writeFileSync(f.credentials, 'TEST replaced account');
    expect(current).toThrow();
  });
  it('detects a newly selected native account registry entry', () => {
    const f = fixture(),
      directory = join(f.root, 'TEST-accounts');
    mkdirSync(directory);
    const current = captureRetainedLegacyRuntimeIdentity({
      executable: f.executable,
      accountFiles: [],
      accountDirectories: [directory],
      readSelection: () => 'TEST',
    });
    writeFileSync(join(directory, 'registry.json'), '{"active_account_id":"TEST-changed"}');
    expect(current).toThrow();
  });
  it.skipIf(process.platform === 'win32')('detects retargeting a selected executable link', () => {
    const f = fixture(),
      second = join(f.root, 'TEST-second-executable'),
      link = join(f.root, 'TEST-executable-link');
    writeFileSync(second, 'TEST second never executed');
    symlinkSync(f.executable, link);
    const current = captureRetainedLegacyRuntimeIdentity({
      executable: link,
      accountFiles: [],
      readSelection: () => 'TEST',
    });
    rmSync(link);
    symlinkSync(second, link);
    expect(current).toThrow();
  });
  it('checks source settings between reads and admits only known own writes', async () => {
    const f = fixture(),
      captured = captureRetainedLegacySourceConfiguration(f.source);
    await captured.mutate(async () => {
      const file = join(f.team, 'members.meta.json'),
        bytes = '{"members":[{"name":"TEST-owned"}]}';
      const witness = captured.beginWrite(file, bytes)!;
      witness.beforeCommit();
      writeFileSync(file, bytes);
      witness.finish(true);
    });
    expect(captured.assertCurrent).not.toThrow();
    writeFileSync(join(f.team, 'members.meta.json'), '{"members":[{"name":"TEST-foreign"}]}');
    expect(captured.assertCurrent).toThrow();
    expect(readFileSync(join(f.team, 'team.meta.json'), 'utf8')).toBe('{}');
  });
  it('permits only native config records after admission and still rejects metadata changes', () => {
    const f = fixture(),
      config = {
        name: f.source.teamName,
        projectPath: '/TEST/project',
        members: [{ name: 'team-lead', model: 'TEST-model', cwd: '/TEST/project' }],
      };
    writeFileSync(join(f.team, 'config.json'), JSON.stringify(config));
    const captured = captureRetainedLegacySourceConfiguration(f.source);
    captured.admitLaunch({ teamName: f.source.teamName, cwd: '/TEST/project' });
    writeFileSync(
      join(f.team, 'config.json'),
      JSON.stringify({ ...config, leadSessionId: 'TEST-new-native-session' })
    );
    expect(captured.assertCurrent).not.toThrow();
    writeFileSync(join(f.team, 'team.meta.json'), '{"TEST-foreign-setting":true}');
    expect(captured.assertCurrent).toThrow();
  });
  it('never adopts unrelated source changes made during an awaited roster mutation', async () => {
    const f = fixture(),
      captured = captureRetainedLegacySourceConfiguration(f.source);
    await expect(
      captured.mutate(async () => {
        await Promise.resolve();
        writeFileSync(join(f.team, 'team.meta.json'), '{"providerId":"TEST-foreign"}');
      })
    ).rejects.toThrow();
    expect(captured.assertCurrent).toThrow();
  });
  it('checks other source files again immediately before a witnessed member commit', () => {
    const f = fixture(),
      captured = captureRetainedLegacySourceConfiguration(f.source);
    const witness = captured.beginWrite(join(f.team, 'members.meta.json'), '{"members":[]}')!;
    writeFileSync(join(f.team, 'team.meta.json'), '{"cwd":"/TEST/foreign"}');
    expect(witness.beforeCommit).toThrow();
    expect(readFileSync(join(f.team, 'members.meta.json'), 'utf8')).toBe('{}');
    expect(() => witness.finish(false)).toThrow();
  });
  it('does not adopt bytes differing from the exact original owner write', () => {
    const f = fixture(),
      captured = captureRetainedLegacySourceConfiguration(f.source);
    const file = join(f.team, 'members.meta.json'),
      witness = captured.beginWrite(file, '{"members":[]}')!;
    writeFileSync(file, '{"members":[{"name":"TEST-foreign"}]}');
    expect(() => witness.finish(true)).toThrow();
    expect(captured.assertCurrent).toThrow();
  });
  it.each(['model', 'providerId', 'cwd'] as const)(
    'does not treat foreign native member %s as a session record',
    (key) => {
      const f = fixture(),
        config = {
          name: f.source.teamName,
          members: [
            {
              name: 'team-lead',
              model: 'TEST-model',
              providerId: 'anthropic',
              cwd: '/TEST/project',
            },
          ],
        };
      writeFileSync(join(f.team, 'config.json'), JSON.stringify(config));
      const captured = captureRetainedLegacySourceConfiguration(f.source);
      captured.admitLaunch({
        teamName: f.source.teamName,
        cwd: '/TEST/project',
        providerId: 'anthropic',
        model: 'TEST-model',
      });
      writeFileSync(
        join(f.team, 'config.json'),
        JSON.stringify({ ...config, members: [{ ...config.members[0], [key]: 'TEST-foreign' }] })
      );
      expect(captured.assertCurrent).toThrow();
    }
  );
});
