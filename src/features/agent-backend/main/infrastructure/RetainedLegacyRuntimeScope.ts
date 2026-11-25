import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { RetainedLegacyLaunchRefusal } from '../../core/application/RetainedLegacyLaunchCoordinator';

import type { CapturedLegacyStoppedSource } from './stopped-import/createLegacyStoppedTeamSource';

export { captureRetainedLegacySourceConfiguration } from './RetainedLegacySourceConfiguration';

/** The operation namespace is physical and independent of profile/context aliases and receipt IDs. */
export function retainedLegacySourceOperationKey(source: CapturedLegacyStoppedSource): string {
  if (!source.isCurrent()) throw new RetainedLegacyLaunchRefusal('source-changed');
  const team = source.roots.find((root) => root.category === 'team')?.path;
  if (!team || resolve(team) !== team) throw new RetainedLegacyLaunchRefusal('source-changed');
  const root = realpathSync(dirname(team));
  const stat = lstatSync(team);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new RetainedLegacyLaunchRefusal('source-changed');
  const namespace = join(root, basename(team).toLowerCase());
  if (!source.isCurrent()) throw new RetainedLegacyLaunchRefusal('source-changed');
  return createHash('sha256')
    .update(process.platform === 'win32' ? namespace.toLowerCase() : namespace)
    .digest('hex');
}

/** Private bounded fingerprints. Values, credentials and paths never enter the public scope DTO. */
export function captureRetainedLegacyRuntimeIdentity(options: {
  readSelection(): unknown;
  accountFiles: readonly string[];
  accountDirectories?: readonly string[];
  accountFileIdentity?(file: string, bytes: Buffer | undefined): string | Buffer;
  executable: string;
  additionalExecutables?: readonly string[];
}): () => void {
  const digest = () => {
    const hash = createHash('sha256');
    hash.update(JSON.stringify(options.readSelection()));
    for (const executable of [options.executable, ...(options.additionalExecutables ?? [])]) {
      const actual = realpathSync(executable),
        binary = lstatSync(actual);
      if (!binary.isFile()) throw new RetainedLegacyLaunchRefusal('account-changed');
      hash.update(JSON.stringify([actual, binary.dev, binary.ino, binary.size, binary.mtimeMs]));
    }
    const files = new Set(options.accountFiles);
    const visit = (directory: string, depth: number) => {
      if (depth > 4 || files.size > 256) throw new RetainedLegacyLaunchRefusal('account-changed');
      try {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new RetainedLegacyLaunchRefusal('account-changed');
        for (const item of readdirSync(directory, { withFileTypes: true })) {
          const entry = join(directory, item.name);
          if (item.isDirectory()) visit(entry, depth + 1);
          else files.add(entry);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    };
    for (const directory of options.accountDirectories ?? []) visit(directory, 0);
    for (const file of [...files].sort()) {
      hash.update(file);
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
          throw new RetainedLegacyLaunchRefusal('account-changed');
        const bytes = readFileSync(file);
        hash.update(options.accountFileIdentity?.(file, bytes) ?? bytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        hash.update(options.accountFileIdentity?.(file, undefined) ?? 'absent');
      }
    }
    return hash.digest('hex');
  };
  const original = digest();
  return () => {
    try {
      if (digest() !== original) throw new RetainedLegacyLaunchRefusal('account-changed');
    } catch {
      throw new RetainedLegacyLaunchRefusal('account-changed');
    }
  };
}
