import { lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const locks = require('agent-teams-controller/src/internal/fileLock.js') as {
  acquireFileLockSync(path: string, options: { acquireTimeoutMs: number }): () => void;
};

export class ProfileWriterUnavailable extends Error {
  constructor() {
    super('Profile writer unavailable');
  }
}

export interface ProfileWriterLease {
  /** Recheck before admitting work if the trusted store's identity may have changed. */
  assertCurrent(): void;
  release(): void;
}

/**
 * One writer per canonical store root. Uses the controller's existing PID/token
 * publication/recovery protocol; age alone never permits taking a live lock.
 * This establishes store ownership, not custody of any native provider process.
 */
export function acquireProfileWriterLease(root: string): ProfileWriterLease {
  try {
    if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root)
      throw new ProfileWriterUnavailable();
    const identity = lstatSync(root);
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw new ProfileWriterUnavailable();
    const unlock = locks.acquireFileLockSync(join(root, '.legacy-agent-host-writer'), {
      acquireTimeoutMs: 0,
    });
    let released = false;
    const assertCurrent = (): void => {
      if (released) throw new ProfileWriterUnavailable();
      const current = lstatSync(root);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        realpathSync(root) !== root
      )
        throw new ProfileWriterUnavailable();
    };
    return {
      assertCurrent() {
        try {
          assertCurrent();
        } catch {
          throw new ProfileWriterUnavailable();
        }
      },
      release() {
        if (released) return;
        try {
          assertCurrent();
          unlock();
          released = true;
        } catch {
          // Changed/unknown storage identity cannot authorize touching its lock.
          throw new ProfileWriterUnavailable();
        }
      },
    };
  } catch {
    throw new ProfileWriterUnavailable();
  }
}
