import { spawn } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

interface WorkerResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const temporaryRoots: string[] = [];
const workerPath = path.resolve('test/fixtures/reviewConflictRecoveryWorker.ts');
const tsxPath = path.resolve('node_modules/tsx/dist/cli.mjs');

function runWorker(mode: string, root: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxPath, workerPath, mode, root], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

describe('review conflict recovery process safety', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('survives SIGKILL before error delivery and after an explicit branch swap', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'review-conflict-restart-'));
    temporaryRoots.push(root);

    const created = await runWorker('create-and-crash', root);
    expect(created.signal === 'SIGKILL' || created.code === 137, created.stderr).toBe(true);
    const firstInspection = await runWorker('inspect', root);
    expect(firstInspection.code, firstInspection.stderr).toBe(0);
    const first = JSON.parse(firstInspection.stdout) as {
      decisions: { revision: number; hunkDecisions: Record<string, string> };
      decisionCandidates: { state: { hunkDecisions: Record<string, string> } }[];
      draftCandidates: { entry: { editorState: { doc: string } } }[];
    };
    expect(first.decisions).toMatchObject({
      revision: 1,
      hunkDecisions: { 'synthetic:0': 'accepted' },
    });
    expect(first.decisionCandidates).toMatchObject([
      { state: { hunkDecisions: { 'synthetic:0': 'rejected' } } },
    ]);
    expect(first.draftCandidates).toMatchObject([
      { entry: { editorState: { doc: 'ACD' } } },
    ]);

    const swapped = await runWorker('swap-and-crash', root);
    expect(swapped.signal === 'SIGKILL' || swapped.code === 137, swapped.stderr).toBe(true);
    const secondInspection = await runWorker('inspect', root);
    expect(secondInspection.code, secondInspection.stderr).toBe(0);
    const second = JSON.parse(secondInspection.stdout) as typeof first;
    expect(second.decisions).toMatchObject({
      revision: 2,
      hunkDecisions: { 'synthetic:0': 'rejected' },
    });
    expect(second.decisionCandidates).toMatchObject([
      { state: { hunkDecisions: { 'synthetic:0': 'accepted' } } },
    ]);
  });
});
