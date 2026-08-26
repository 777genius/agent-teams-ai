import { lstat, mkdir, open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { REQUIRED_SANDBOX } from './contracts';
import { atomicPrivateFile, canonicalJson, ensurePrivateDirectory } from './secure-files';

const OUTER_MARKER = '.agent-teams-actual-owner-e2e-marker.json';

export type ActualOwnerRunSandbox = Readonly<{
  root: string;
  evidenceRoot: string;
  markerPath: string;
  runLedgerPath: string;
}>;

/** Verifies that the only admitted outer sandbox has its task-owned marker. */
export async function assertOuterSandbox(): Promise<void> {
  const markerPath = join(REQUIRED_SANDBOX, OUTER_MARKER);
  const stat = await lstat(markerPath);
  const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    marker.schemaVersion !== 1 ||
    marker.marker !== 'agent-teams-refresh-actual-owner-e2e-r1' ||
    marker.purpose !== 'disposable actual-owner E2E inputs and evidence only'
  ) {
    throw new Error('actual_owner_outer_marker_invalid');
  }
}

/** Creates one empty nonce-bound run root beneath the admitted disposable sandbox. */
export async function createRunSandbox(nonce: string): Promise<ActualOwnerRunSandbox> {
  await assertOuterSandbox();
  const runsRoot = join(REQUIRED_SANDBOX, 'runs');
  await ensurePrivateDirectory(runsRoot, REQUIRED_SANDBOX);
  const root = join(runsRoot, nonce);
  await mkdir(root, { mode: 0o700 });
  await ensurePrivateDirectory(root, REQUIRED_SANDBOX);
  if ((await readdir(root)).length !== 0) throw new Error('actual_owner_run_not_empty');
  const markerPath = join(root, '.actual-owner-run.json');
  await atomicPrivateFile(
    markerPath,
    canonicalJson({
      schemaVersion: 1,
      purpose: 'agent-teams.hosted-actual-owner-e2e.run/v1',
      nonce,
    }),
    REQUIRED_SANDBOX
  );
  const evidenceRoot = join(root, 'evidence');
  await ensurePrivateDirectory(evidenceRoot, REQUIRED_SANDBOX);
  return Object.freeze({
    root,
    evidenceRoot,
    markerPath,
    runLedgerPath: join(root, 'run-count.json'),
  });
}

/** Claims the sandbox's single permitted final run with create-exclusive semantics. */
export async function claimExactlyOneRun(sandbox: ActualOwnerRunSandbox): Promise<void> {
  try {
    const handle = await open(sandbox.runLedgerPath, 'wx', 0o600);
    try {
      await handle.writeFile(canonicalJson({ schemaVersion: 1, count: 1 }));
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new Error('actual_owner_exactly_one_run_violated', { cause: error });
  }
}
