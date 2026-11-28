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

/** Candidate executable matches from one existing process read; never member-role authority. */
function codexPreassertDiagnostic(hostPid: number, roots: readonly ProcessFact[],
  rows: readonly ProcessFact[], helperPath: string) {
  const project = (row: ProcessFact, executableRole: 'codex' | 'code-mode-host') => {
    const { pid, parentPid, groupId, birth } = row;
    for (const value of [pid, parentPid, groupId])
      assert.ok(Number.isSafeInteger(value) && value > 0);
    assert.ok(typeof birth === 'string' && birth.length > 0 && birth.length <= 64 &&
      Buffer.byteLength(birth, 'utf8') <= 64);
    for (const value of birth)
      assert.ok(value.charCodeAt(0) >= 0x20 && value.charCodeAt(0) !== 0x7f);
    return { pid, parentPid, groupId, birth, executableRole };
  };
  // processFacts already caps its read at 2 MiB and 20,000 rows. Reuse that table.
  const rootPids = new Set(roots.map(row => row.pid));
  const helpers: ReturnType<typeof project>[] = [];
  let helperCount = 0;
  for (const row of rows) {
    if (row.command !== helperPath || !rootPids.has(row.parentPid)) continue;
    helperCount++;
    if (helpers.length < 32) helpers.push(project(row, 'code-mode-host'));
  }
  return {
    schemaVersion: 1, diagnosticOnly: true, hostPid,
    rootCount: roots.length, helperCount,
    rootsTruncated: roots.length > 16, helpersTruncated: helperCount > 32,
    roots: roots.slice(0, 16).map(row => project(row, 'codex')), helpers,
  };
}

/** Read-only original child witness; no process control, ownership or numeric signal authority. */
export async function captureCodexCodeModeProcess(
  hostPid: number,
  nativeInputs: readonly { path: string; sha256: string }[],
  read: () => ProcessFact[] = processFacts,
  observe?: (diagnostic: unknown) => void
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
  if (observe) {
    try {
      const diagnostic = codexPreassertDiagnostic(hostPid, roots, rows, helper!.path);
      if (Buffer.byteLength(JSON.stringify(diagnostic), 'utf8') <= 16 * 1024) observe(diagnostic);
    } catch { /* Diagnostics cannot replace the original result or assertion. */ }
  }
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
