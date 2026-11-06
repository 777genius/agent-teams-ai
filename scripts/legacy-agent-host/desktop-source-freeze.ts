import assert from 'node:assert/strict';
import { join } from 'node:path';
import { captureCodexNativeExecutable } from '../../packages/legacy-agent-host/tests/fixtures/codex-native-closure.ts';
export { captureCodexNativeInputs as captureDesktopCodexNativeInputs } from '../../packages/legacy-agent-host/tests/fixtures/codex-native-closure.ts';
import { fileDigest } from './desktop-backend-fixture.ts';

export async function captureDesktopSourceHashes(repo: string, sources: readonly string[]) {
  return Promise.all(
    sources.map(async path => ({ path, sha256: await fileDigest(join(repo, path)) }))
  );
}

/** Called after captured app cleanup, including failed flows; never hides the original error. */
export async function verifyDesktopNativeFreeze(
  before: readonly { path: string; sha256: string }[], evidence: Record<string, unknown>
) {
  if (!before.length) return;
  try {
    const after = await Promise.all(before.map(value => captureCodexNativeExecutable(value.path)));
    evidence.selectedNativeInputHashesAfterCleanup = after;
    assert.deepEqual(after, before, 'selected native inputs remained frozen through cleanup');
  } catch (error) {
    evidence.nativeInputFreezeFailure = error instanceof Error ? error.message.slice(0, 1000) : 'native input freeze unavailable';
    evidence.status = 'INCOMPLETE';
  }
}

/** Preserve a failed source freeze in the raw receipt without hiding cleanup evidence. */
export async function verifyDesktopSourceFreeze(
  repo: string,
  sources: readonly string[],
  before: readonly { path: string; sha256: string }[],
  evidence: Record<string, unknown>
): Promise<void> {
  try {
    const after = await captureDesktopSourceHashes(repo, sources);
    evidence.selectedSourceHashesAfterFlow = after;
    assert.deepEqual(after, before, 'selected production source remained frozen during app proof');
  } catch (error) {
    evidence.sourceFreezeFailure =
      error instanceof Error ? error.message.slice(0, 1000) : 'source freeze unavailable';
    evidence.status = 'INCOMPLETE';
  }
}
