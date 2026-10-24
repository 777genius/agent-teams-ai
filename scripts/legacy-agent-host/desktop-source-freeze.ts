import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';

/** Preserve a failed source freeze in the raw receipt without hiding cleanup evidence. */
export async function verifyDesktopSourceFreeze(
  repo: string,
  sources: readonly string[],
  before: readonly { path: string; sha256: string }[],
  evidence: Record<string, unknown>
): Promise<void> {
  try {
    const after = await Promise.all(
      sources.map(async (path) => ({ path, sha256: await fileDigest(join(repo, path)) }))
    );
    evidence.selectedSourceHashesAfterFlow = after;
    assert.deepEqual(after, before, 'selected production source remained frozen during app proof');
  } catch (error) {
    evidence.sourceFreezeFailure =
      error instanceof Error ? error.message.slice(0, 1000) : 'source freeze unavailable';
    evidence.status = 'INCOMPLETE';
  }
}
