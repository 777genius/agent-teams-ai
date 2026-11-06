import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ManagementCommandError } from './commandRecords.js';

import type { ProviderManagementProfile } from './profile.js';

export type CapturedSkillRootKind = 'claude' | 'codex' | 'agents' | 'cursor';
export interface ExtensionRootSelection {
  readonly panel: 'plugins' | 'skills' | 'mcp';
  readonly scope: 'user' | 'global' | 'project' | 'local';
  readonly rootKind?: CapturedSkillRootKind;
}
export interface CapturedExtensionRoots {
  readonly targetId: string;
  readonly projectRoot: string | null;
  readonly rootPath: string;
  assertCurrent(): void;
  /** Private owner-side containment check. It never turns a caller path into authority. */
  assertDescendant(path: string): void;
}

/** Resolve only from an already captured native profile and the original existing UI selection. */
export function captureExtensionRoots(
  profile: ProviderManagementProfile,
  selection: ExtensionRootSelection,
  assertOwner: () => void
): CapturedExtensionRoots {
  assertOwner();
  const captured = structuredClone({ profile, selection });
  const { scope, panel, rootKind } = captured.selection;
  if (
    !['plugins', 'skills', 'mcp'].includes(panel) ||
    !['user', 'global', 'project', 'local'].includes(scope) ||
    (panel === 'skills') !== (rootKind !== undefined) ||
    (rootKind !== undefined && !['claude', 'codex', 'agents', 'cursor'].includes(rootKind)) ||
    (scope === 'global' && panel !== 'mcp') ||
    (panel === 'skills' && scope === 'local') ||
    (panel === 'plugins' && profile.provider !== 'claude') ||
    (rootKind === 'claude' && profile.provider !== 'claude') ||
    (rootKind === 'codex' && profile.provider !== 'codex')
  )
    throw new ManagementCommandError('invalid');
  const home = profile.environment.HOME;
  if (!home) throw new ManagementCommandError('invalid');
  const configRoot =
    profile.provider === 'claude'
      ? profile.configNamespace === 'native-default'
        ? join(home, '.claude')
        : profile.environment.CLAUDE_CONFIG_DIR
      : profile.provider === 'codex'
        ? profile.environment.CODEX_HOME
        : profile.environment.XDG_CONFIG_HOME;
  if (!configRoot) throw new ManagementCommandError('invalid');
  const projectRoot = scope === 'user' || scope === 'global' ? null : profile.cwd;
  const anchor =
    projectRoot ?? (rootKind === 'agents' || rootKind === 'cursor' ? home : configRoot);
  const rootPath =
    panel === 'skills'
      ? projectRoot
        ? join(projectRoot, `.${rootKind}`, 'skills')
        : rootKind === 'agents' || rootKind === 'cursor'
          ? join(home, `.${rootKind}`, 'skills')
          : join(configRoot, 'skills')
      : panel === 'plugins'
        ? projectRoot
          ? join(projectRoot, '.claude')
          : configRoot
        : anchor;
  const roots = new Map<string, { dev: number; ino: number }>();
  for (const root of [home, configRoot, profile.cwd]) {
    if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root)
      throw new ManagementCommandError('held');
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ManagementCommandError('held');
    roots.set(root, { dev: stat.dev, ino: stat.ino });
  }
  const check = (path: string) => {
    const rel = relative(anchor, path);
    if (
      !isAbsolute(path) ||
      resolve(path) !== path ||
      (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)))
    )
      throw new ManagementCommandError('invalid');
    let cursor = anchor;
    for (const segment of rel.split(sep).filter(Boolean)) {
      cursor = join(cursor, segment);
      try {
        if (lstatSync(cursor).isSymbolicLink()) throw new ManagementCommandError('held');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        break;
      }
    }
  };
  const assertCurrent = () => {
    assertOwner();
    for (const [path, expected] of roots) {
      const stat = lstatSync(path);
      if (
        realpathSync(path) !== path ||
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        stat.dev !== expected.dev ||
        stat.ino !== expected.ino
      )
        throw new ManagementCommandError('held');
    }
    check(rootPath);
  };
  assertCurrent();
  const targetId = createHash('sha256')
    .update(JSON.stringify({ captured, roots: [...roots], rootPath }))
    .digest('hex');
  return Object.freeze({
    targetId,
    projectRoot,
    rootPath,
    assertCurrent,
    assertDescendant(path: string) {
      assertCurrent();
      const rel = relative(rootPath, path);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new ManagementCommandError('invalid');
      check(path);
    },
  });
}
