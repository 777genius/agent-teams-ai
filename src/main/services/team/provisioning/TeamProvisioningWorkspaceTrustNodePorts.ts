import {
  resolveWorkspaceTrustCanonicalGitRoot,
  resolveWorkspaceTrustFilesystemGitRoot,
} from '@features/workspace-trust/main';
import { getHomeDir } from '@main/utils/pathDecoder';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  resolveWorkspaceTrustGitRoot,
  type WorkspaceTrustGitRootResolutionPorts,
  type WorkspaceTrustWorkspaceCollectionPorts,
} from './TeamProvisioningWorkspaceTrust';

function resolveGitTopLevel(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--show-toplevel'],
      {
        encoding: 'utf8',
        maxBuffer: 16 * 1024,
        timeout: 1000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(stdout.trim() || null);
      }
    );
  });
}

export function createNodeWorkspaceTrustGitRootResolutionPorts(): WorkspaceTrustGitRootResolutionPorts {
  return {
    resolveGitTopLevel,
    resolveFilesystemGitRoot: resolveWorkspaceTrustFilesystemGitRoot,
    isAbsolutePath: path.isAbsolute,
  };
}

export function createNodeWorkspaceTrustWorkspaceCollectionPorts(): WorkspaceTrustWorkspaceCollectionPorts {
  const gitRootPorts = createNodeWorkspaceTrustGitRootResolutionPorts();
  return {
    getHomeDir,
    realpath: async (value) => fs.promises.realpath(value).catch(() => null),
    resolveGitRoot: (cwd) => resolveWorkspaceTrustGitRoot(cwd, gitRootPorts),
    resolveCanonicalGitRoot: resolveWorkspaceTrustCanonicalGitRoot,
    platform: process.platform === 'win32' ? 'win32' : 'posix',
  };
}
