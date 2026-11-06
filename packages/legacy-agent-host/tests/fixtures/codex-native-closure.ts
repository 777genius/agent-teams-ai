import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { processFacts, type ProcessFact } from './native-input-capture.ts';
import { fileHash } from './native-host.ts';

export async function captureCodexNativeExecutable(path: string) {
  const before = await lstat(path);
  assert.ok(isAbsolute(path) && before.isFile() && !before.isSymbolicLink() &&
    before.size > 0 && before.size <= 512 * 1024 * 1024 && (before.mode & 0o111));
  assert.equal(await realpath(path), path);
  await access(path, constants.X_OK);
  const sha256 = await fileHash(path), after = await lstat(path);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const)
    assert.equal(after[key], before[key], 'selected native input changed during capture');
  return { path, sha256 };
}

/** Actual pinned native closure, before any metadata or business child; never inferred from PATH. */
export async function captureCodexNativeInputs(executable: string) {
  const selected = [
    { path: executable, sha256: '8238273076041e55beded03ba1d51e034f997b7d100b0642d36daf036620fe57' },
    { path: join(dirname(executable), 'codex-code-mode-host'), sha256: '0b74f513cd960f32e60836f39c574761e6fd1500e608135f3f34347acc3e0e6a' },
  ];
  const actual = await Promise.all(selected.map(value => captureCodexNativeExecutable(value.path)));
  assert.deepEqual(actual, selected, 'exact reviewed Codex native pair');
  return actual;
}

interface CodeModeWitness {
  status: 'captured';
  codex: ProcessFact;
  helper: ProcessFact;
  nativeInputs: readonly { path: string; sha256: string }[];
  afterStop?: { state: 'same-live' | 'absent' | 'identity-mismatch'; current?: ProcessFact };
  firstIdentityMismatch?: ProcessFact;
}

/** Read-only original child witness; no process control, ownership or numeric signal authority. */
export async function captureCodexCodeModeProcess(
  hostPid: number,
  nativeInputs: readonly { path: string; sha256: string }[],
  read: () => ProcessFact[] = processFacts
): Promise<CodeModeWitness> {
  assert.ok(Number.isSafeInteger(hostPid) && hostPid > 0);
  assert.equal(nativeInputs.length, 2);
  const [codex, helper] = nativeInputs;
  assert.equal(helper!.path, join(dirname(codex!.path), 'codex-code-mode-host'));
  for (const selected of nativeInputs) {
    assert.equal(await realpath(selected.path), selected.path);
    assert.equal(await fileHash(selected.path), selected.sha256);
  }
  const rows = read();
  const roots = rows.filter(row => row.parentPid === hostPid && row.command === codex!.path);
  assert.equal(roots.length, 1, 'one selected original live Codex root');
  const helpers = rows.filter(row => row.parentPid === roots[0]!.pid && row.command === helper!.path);
  assert.equal(helpers.length, 1, 'actual original code-mode helper must be observed before Stop');
  assert.equal(helpers[0]!.groupId, helpers[0]!.pid, 'pinned native helper has its own process group');
  assert.ok(roots[0]!.birth && helpers[0]!.birth);
  return { status: 'captured', codex: { ...roots[0]! }, helper: { ...helpers[0]! }, nativeInputs };
}

export function observeCodexCodeModeProcess(
  witness: CodeModeWitness, read: () => ProcessFact[] = processFacts
) {
  const current = read().find(row => row.pid === witness.helper.pid);
  const state = !current ? 'absent' :
    (['pid', 'parentPid', 'groupId', 'birth', 'command'] as const).every(key => current[key] === witness.helper[key])
      ? 'same-live' : 'identity-mismatch';
  const observation = { state, ...(current ? { current } : {}) } as NonNullable<CodeModeWitness['afterStop']>;
  if (state === 'identity-mismatch' && !witness.firstIdentityMismatch)
    witness.firstIdentityMismatch = { ...current! };
  witness.afterStop = observation;
  return observation;
}
