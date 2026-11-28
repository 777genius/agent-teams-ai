import { execFile } from 'node:child_process';

import {
  resolveWorkspaceTrustCanonicalGitRoot,
  resolveWorkspaceTrustFilesystemGitRoot,
} from '@features/workspace-trust/main';
import { canUseGitWithoutMacInstallerPrompt } from '@main/utils/gitAvailability';
import { createManagedGitEnv, getManagedGitExecutable } from '@main/utils/managedGit';
import { getHomeDir } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import type { WorkspaceTrustWorkspaceCollectionPorts } from './TeamProvisioningWorkspaceTrust';

async function verifySeparateGitDirectory(root: string): Promise<boolean> {
  let executable: string;
  try {
    executable = getManagedGitExecutable();
    if (executable === 'git' && !(await canUseGitWithoutMacInstallerPrompt())) {
      return false;
    }
  } catch {
    return false;
  }

  return new Promise((resolve) => {
    execFile(
      executable,
      ['-C', root, 'rev-parse', '--show-toplevel'],
      {
        encoding: 'utf8',
        maxBuffer: 16 * 1024,
        timeout: 1_000,
        windowsHide: true,
        env: createManagedGitEnv(process.env, { gitCommand: true }),
      },
      (error, stdout) => {
        const reported = stdout?.trim();
        if (error || !reported || !path.isAbsolute(reported)) {
          resolve(false);
          return;
        }
        void Promise.all([fs.promises.realpath(root), fs.promises.realpath(reported)])
          .then(([expected, actual]) =>
            resolve(
              process.platform === 'win32'
                ? expected.toLowerCase() === actual.toLowerCase()
                : expected === actual
            )
          )
          .catch(() => resolve(false));
      }
    );
  });
}

export function createNodeWorkspaceTrustWorkspaceCollectionPorts(): WorkspaceTrustWorkspaceCollectionPorts {
  return {
    getHomeDir,
    realpath: async (value) => fs.promises.realpath(value).catch(() => null),
    resolveGitRoot: async (cwd) =>
      resolveWorkspaceTrustFilesystemGitRoot(
        await fs.promises.realpath(cwd).catch(() => cwd),
        verifySeparateGitDirectory
      ),
    resolveCanonicalGitRoot: resolveWorkspaceTrustCanonicalGitRoot,
    platform: process.platform === 'win32' ? 'win32' : 'posix',
  };
}
