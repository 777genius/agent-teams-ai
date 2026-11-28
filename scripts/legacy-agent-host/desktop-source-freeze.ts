import assert from 'node:assert/strict';
import { join } from 'node:path';
import { captureCodexNativeExecutable } from '../../packages/legacy-agent-host/tests/fixtures/codex-native-closure.ts';
export { captureCodexNativeInputs as captureDesktopCodexNativeInputs } from '../../packages/legacy-agent-host/tests/fixtures/codex-native-closure.ts';
import { fileDigest, desktopCodexSha256 } from './desktop-backend-fixture.ts';

/** Account-only proof executes app-server, without a model/code-mode session. */
export async function captureDesktopCodexAccountInput(executable: string) {
  const captured = await captureCodexNativeExecutable(executable);
  assert.equal(captured.sha256, desktopCodexSha256(), 'qualified account app-server input');
  return [captured];
}
import { readCapturedCandidateElectron } from './candidate-electron.ts';

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

/** Preserve the exact packed output check after UI/Stop/Quit cleanup. */
export async function verifyDesktopPackedFreeze(
  selected: { path: string; sha256: string },
  before: Awaited<ReturnType<typeof readCapturedCandidateElectron>>,
  evidence: Record<string, unknown>
): Promise<void> {
  try {
    const after = await readCapturedCandidateElectron(selected);
    assert.deepEqual(after, before, 'actual candidate resources remain exact after UI/Stop/Quit cleanup');
    evidence.packedCandidateVerifiedAfterCleanup = true;
  } catch (error) {
    evidence.packedCandidateVerificationFailure = error instanceof Error ? error.message.slice(0, 1000) : 'candidate changed';
    evidence.status = 'INCOMPLETE';
  }
}
