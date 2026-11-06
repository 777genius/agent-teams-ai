import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { canUseGitWithoutMacInstallerPrompt } from '../TeamWorktreeGitService';

describe('macOS Git availability without installer prompts', () => {
  it('does not probe Git when macOS PATH contains no executable', async () => {
    const emptyDirectory = await mkdtemp(path.join(tmpdir(), 'agent-teams-empty-path-'));
    try {
      await expect(canUseGitWithoutMacInstallerPrompt('darwin', emptyDirectory)).resolves.toBe(
        false
      );
    } finally {
      await rm(emptyDirectory, { recursive: true, force: true });
    }
  });

  it('accepts a separate executable Git without requiring Apple developer tools', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'agent-teams-git-path-'));
    try {
      const executable = path.join(directory, 'git');
      await writeFile(executable, '#!/bin/sh\nexit 0\n');
      await chmod(executable, 0o755);
      await expect(canUseGitWithoutMacInstallerPrompt('darwin', directory)).resolves.toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves existing Git behavior on other platforms', async () => {
    await expect(canUseGitWithoutMacInstallerPrompt('linux', '')).resolves.toBe(true);
    await expect(canUseGitWithoutMacInstallerPrompt('win32', '')).resolves.toBe(true);
  });
});
