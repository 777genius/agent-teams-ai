import * as fs from 'node:fs';
import * as path from 'node:path';

/** Legacy public reservations have no trustworthy inode receipt. Never adopt or remove one. */
export async function assertNoAmbiguousDetachedReservation(targetPath: string): Promise<void> {
  const parent = path.dirname(targetPath);
  const prefix = `.${path.basename(targetPath)}.replacement.`;
  for (const name of await fs.promises.readdir(parent)) {
    if (name.startsWith(prefix)) {
      throw new Error(
        `operator_required: detached reservation retained at ${path.join(parent, name)}`
      );
    }
    if (!name.startsWith('.detached-reservation-reconcile-')) continue;
    // A marker may belong to another target. Without an authenticated owner
    // record it cannot be safely distinguished or cleaned up automatically.
    throw new Error(
      `operator_required: ambiguous detached reservation retained at ${path.join(parent, name)}`
    );
  }
}
