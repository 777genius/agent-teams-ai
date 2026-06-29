import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildWorkspaceTrustPathCandidates } from '@features/workspace-trust/core/domain';
import { FileClaudeTrustPersister } from '@features/workspace-trust/main';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tmpDir: string;

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
}

describe('FileClaudeTrustPersister', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-trust-persister-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('persists exact workspace and git-root trust keys while preserving existing project fields', async () => {
    const configPath = path.join(tmpDir, '.claude.json');
    const repoDir = path.join(tmpDir, 'repo');
    const appDir = path.join(repoDir, 'packages', 'app');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          theme: 'dark',
          projects: {
            [appDir]: {
              allowedTools: ['Read'],
            },
          },
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const workspace = buildWorkspaceTrustPathCandidates({
      cwd: appDir,
      realCwd: appDir,
      gitRoot: repoDir,
      platform: 'posix',
    })[0];
    const result = await new FileClaudeTrustPersister({
      globalConfigFilePath: configPath,
      platform: 'posix',
    }).persistTrustState(workspace);

    expect(result.ok).toBe(true);
    const parsed = await readJson(configPath);
    expect(parsed.theme).toBe('dark');
    expect(parsed.projects).toMatchObject({
      [appDir]: {
        allowedTools: ['Read'],
        hasTrustDialogAccepted: true,
      },
      [repoDir]: {
        hasTrustDialogAccepted: true,
      },
    });
    expect((parsed.projects as Record<string, unknown>)[path.dirname(appDir)]).toBeUndefined();
  });

  it('creates a missing Claude state file with a trusted projects map', async () => {
    const configPath = path.join(tmpDir, 'missing', '.claude.json');
    const projectDir = path.join(tmpDir, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    const workspace = buildWorkspaceTrustPathCandidates({
      cwd: projectDir,
      platform: 'posix',
    })[0];

    const result = await new FileClaudeTrustPersister({
      globalConfigFilePath: configPath,
      platform: 'posix',
    }).persistTrustState(workspace);

    expect(result.ok).toBe(true);
    await expect(readJson(configPath)).resolves.toMatchObject({
      projects: {
        [projectDir]: {
          hasTrustDialogAccepted: true,
        },
      },
    });
  });

  it('does not overwrite malformed Claude state', async () => {
    const configPath = path.join(tmpDir, '.claude.json');
    await fs.writeFile(configPath, '{ invalid json', 'utf8');
    const workspace = buildWorkspaceTrustPathCandidates({
      cwd: path.join(tmpDir, 'project'),
      platform: 'posix',
    })[0];

    const result = await new FileClaudeTrustPersister({
      globalConfigFilePath: configPath,
      platform: 'posix',
    }).persistTrustState(workspace);

    expect(result).toMatchObject({
      ok: false,
      code: 'claude_state_read_failed',
    });
    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe('{ invalid json');
  });

  it('does not persist non-persistable git-root keys while trusting the exact workspace', async () => {
    const configPath = path.join(tmpDir, '.claude.json');
    const projectDir = path.join(tmpDir, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    const workspace = buildWorkspaceTrustPathCandidates({
      cwd: projectDir,
      realCwd: projectDir,
      gitRoot: tmpDir,
      homeDir: tmpDir,
      platform: 'posix',
    })[0];

    const result = await new FileClaudeTrustPersister({
      globalConfigFilePath: configPath,
      homeDir: tmpDir,
      platform: 'posix',
    }).persistTrustState(workspace);

    expect(result.ok).toBe(true);
    const parsed = await readJson(configPath);
    expect(parsed.projects).toMatchObject({
      [projectDir]: {
        hasTrustDialogAccepted: true,
      },
    });
    expect((parsed.projects as Record<string, unknown>)[tmpDir]).toBeUndefined();
  });

  it('refuses to persist trust for non-persistable home directories', async () => {
    const workspace = buildWorkspaceTrustPathCandidates({
      cwd: tmpDir,
      homeDir: tmpDir,
      platform: 'posix',
    })[0];

    const result = await new FileClaudeTrustPersister({
      globalConfigFilePath: path.join(tmpDir, '.claude.json'),
      platform: 'posix',
    }).persistTrustState(workspace);

    expect(result).toMatchObject({
      ok: false,
      code: 'workspace_trust_not_persistable_home_directory',
    });
    await expect(fs.stat(path.join(tmpDir, '.claude.json'))).rejects.toThrow();
  });
});
