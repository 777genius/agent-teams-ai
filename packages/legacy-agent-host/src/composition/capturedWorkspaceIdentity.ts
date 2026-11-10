import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { digest } from '../team/identity.js';

/** Original canonical directory identity; a same-path replacement never supplies a new grant. */
export function capturedWorkspaceIdentity(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Invalid captured workspace');
  const info = lstatSync(path);
  if (info.isSymbolicLink() || realpathSync(path) !== path || !info.isDirectory())
    throw new Error('Captured workspace unavailable');
  return digest({ dev: info.dev, ino: info.ino });
}
