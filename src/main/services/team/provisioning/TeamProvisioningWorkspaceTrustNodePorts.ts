import {
  resolveWorkspaceTrustCanonicalGitRoot,
  resolveWorkspaceTrustFilesystemGitRoot,
} from '@features/workspace-trust/main';
import { getHomeDir } from '@main/utils/pathDecoder';
import * as fs from 'fs';

import type { WorkspaceTrustWorkspaceCollectionPorts } from './TeamProvisioningWorkspaceTrust';

export function createNodeWorkspaceTrustWorkspaceCollectionPorts(): WorkspaceTrustWorkspaceCollectionPorts {
  return {
    getHomeDir,
    realpath: async (value) => fs.promises.realpath(value).catch(() => null),
    resolveGitRoot: async (cwd) =>
      resolveWorkspaceTrustFilesystemGitRoot(await fs.promises.realpath(cwd).catch(() => cwd)),
    resolveCanonicalGitRoot: resolveWorkspaceTrustCanonicalGitRoot,
    platform: process.platform === 'win32' ? 'win32' : 'posix',
  };
}
