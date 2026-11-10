import { join } from 'node:path';

import { captureExtensionRoots } from '../management/captureExtensionRoots.js';
import { managementDigest } from '../management/identity.js';
import { captureNativeClaudeFile } from './captureNativeClaudeFile.js';

import type { ExtensionRootSelection } from '../management/captureExtensionRoots.js';
import type { ClaudeManagementProfile } from '../management/profile.js';

/** Exact native mutable target, separate from intentionally arbitrary runtime MCP snapshot sources. */
export function captureNativeExtensionTarget(
  profileValue: ClaudeManagementProfile,
  selectionValue: ExtensionRootSelection,
  assertOwner: () => void
) {
  const profile = structuredClone(profileValue),
    selection = structuredClone(selectionValue);
  const roots = captureExtensionRoots(profile, selection, assertOwner);
  const nativeFile =
    selection.panel === 'mcp'
      ? captureNativeClaudeFile(profile, () => roots.assertCurrent())
      : undefined;
  const userPlugins =
    selection.panel === 'plugins'
      ? captureExtensionRoots(profile, { panel: 'plugins', scope: 'user' }, assertOwner)
      : undefined;
  const config =
    profile.environment.CLAUDE_CONFIG_DIR ?? join(profile.environment.HOME!, '.claude');
  const assertCurrent = () => {
    roots.assertCurrent();
    nativeFile?.assertCurrent();
    userPlugins?.assertCurrent();
    if (selection.panel === 'mcp' && roots.projectRoot)
      roots.assertDescendant(join(roots.projectRoot, '.mcp.json'));
    if (userPlugins) {
      userPlugins.assertDescendant(join(config, 'plugins', 'installed_plugins.json'));
      userPlugins.assertDescendant(join(config, 'settings.json'));
      if (roots.projectRoot)
        roots.assertDescendant(
          join(
            roots.rootPath,
            selection.scope === 'local' ? 'settings.local.json' : 'settings.json'
          )
        );
    }
  };
  assertCurrent();
  return Object.freeze({
    ...roots,
    targetId: managementDigest({
      roots: roots.targetId,
      nativeFile: nativeFile?.path,
      userPlugins: userPlugins?.targetId,
    }),
    nativeUserConfigPath: nativeFile?.path,
    assertCurrent,
  });
}
