import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { WorkingDirectoryMissingError } from '@main/utils/cliWorkingDirectory';
import { resolveRuntimeStatusExecutionContext } from '@main/services/runtime/runtimeStatusExecutionContext';
import { describe, expect, it } from 'vitest';

describe('OpenCode status in a macOS File Provider project', () => {
  it('uses a safe process cwd without changing the selected project, including spaces', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-home-'));
    const project = path.join(home, 'Library', 'CloudStorage', 'GoogleDrive', 'My Portfolio');
    try {
      await mkdir(project, { recursive: true });
      expect(await resolveRuntimeStatusExecutionContext('opencode', project, {
        platform: 'darwin', homePath: home,
      })).toEqual({ cwd: home, projectArgs: ['--project-path', project] });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it('leaves other providers and other platforms alone', async () => {
    const cwd = '/TEST/Library/CloudStorage/My Portfolio';
    for (const [provider, platform] of [
      ['codex', 'darwin'], ['anthropic', 'darwin'], ['gemini', 'darwin'],
      ['opencode', 'linux'], ['opencode', 'win32'],
    ] as const) {
      expect(await resolveRuntimeStatusExecutionContext(provider, cwd, {
        platform, homePath: '/Users/TEST',
      })).toEqual({ cwd, projectArgs: [] });
    }
    expect(await resolveRuntimeStatusExecutionContext('opencode', undefined, {
      platform: 'darwin', homePath: '/Users/TEST',
    })).toEqual({ cwd: undefined, projectArgs: [] });
  });
  it('does not disguise a missing project as an available home-scoped provider', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-missing-'));
    try {
      await expect(resolveRuntimeStatusExecutionContext('opencode',
        path.join(home, 'Library', 'CloudStorage', 'missing'),
        { platform: 'darwin', homePath: home },
      )).rejects.toBeInstanceOf(WorkingDirectoryMissingError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it('fails closed for a root user home', async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-project-'));
    try {
      await expect(resolveRuntimeStatusExecutionContext('opencode', project, {
        platform: 'darwin', homePath: '/',
      })).rejects.toThrow('non-root user home');
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
