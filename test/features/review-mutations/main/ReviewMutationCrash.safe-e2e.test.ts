import { spawn } from 'child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

type CrashPoint =
  | 'prepared'
  | 'after_disk_effect'
  | 'disk_applied'
  | 'after_decision_effect'
  | 'decisions_committed'
  | 'complete';

interface WorkerResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface RecoverySnapshot {
  fileContent: string;
  decisions: {
    hunkDecisions: Record<string, string>;
    reviewActionHistory: { id: string }[];
    reviewRedoHistory: unknown[];
    revision: number;
  };
  pendingRecords: number;
  audit: {
    diskAttempts: number;
    diskWrites: number;
    decisionAttempts: number;
  };
}

const temporaryRoots: string[] = [];
const workerPath = path.resolve('test/fixtures/reviewMutationCrashWorker.ts');
const tsxPath = path.resolve('node_modules/tsx/dist/cli.mjs');

async function runWorker(
  mode: 'run' | 'recover',
  claudeBasePath: string,
  filePath: string,
  auditPath: string,
  crashPoint: CrashPoint | 'none',
  operationShape: 'disk' | 'disk-redo' | 'decision-only-redo' = 'disk'
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tsxPath, workerPath, mode, claudeBasePath, filePath, auditPath, crashPoint, operationShape],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
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

describe('review mutation crash recovery process E2E', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it.each([
    'prepared',
    'after_disk_effect',
    'disk_applied',
    'after_decision_effect',
    'decisions_committed',
    'complete',
  ] as const)(
    'recovers exact disk, history revision, and WAL state after SIGKILL at %s',
    async (crashPoint) => {
      const root = await mkdtemp(path.join(tmpdir(), `review-crash-${crashPoint}-`));
      temporaryRoots.push(root);
      const claudeBasePath = path.join(root, 'claude-config');
      const projectPath = path.join(root, 'sandbox-project');
      const filePath = path.join(projectPath, 'fixture.ts');
      const auditPath = path.join(root, 'audit.json');
      await mkdir(projectPath, { recursive: true });
      await writeFile(filePath, 'before\n', 'utf8');

      const crashed = await runWorker('run', claudeBasePath, filePath, auditPath, crashPoint);
      expect(crashed.signal === 'SIGKILL' || crashed.code === 137, crashed.stderr).toBe(true);

      const recovered = await runWorker('recover', claudeBasePath, filePath, auditPath, 'none');
      expect(recovered.code, recovered.stderr).toBe(0);
      const snapshot = JSON.parse(recovered.stdout) as RecoverySnapshot;

      expect(snapshot).toMatchObject({
        fileContent: 'after\n',
        decisions: {
          hunkDecisions: { 'fixture-change:0': 'rejected' },
          revision: 1,
        },
        pendingRecords: 0,
        audit: {
          diskWrites: 1,
          diskAttempts: crashPoint === 'after_disk_effect' ? 2 : 1,
          decisionAttempts: crashPoint === 'after_decision_effect' ? 2 : 1,
        },
      });
    },
    30_000
  );

  it.each([
    'prepared',
    'after_disk_effect',
    'disk_applied',
    'after_decision_effect',
    'decisions_committed',
    'complete',
  ] as const)(
    'recovers disk Redo and both history branches after SIGKILL at %s',
    async (crashPoint) => {
      const root = await mkdtemp(path.join(tmpdir(), `review-disk-redo-crash-${crashPoint}-`));
      temporaryRoots.push(root);
      const claudeBasePath = path.join(root, 'claude-config');
      const projectPath = path.join(root, 'sandbox-project');
      const filePath = path.join(projectPath, 'fixture.ts');
      const auditPath = path.join(root, 'audit.json');
      await mkdir(projectPath, { recursive: true });
      await writeFile(filePath, 'before\n', 'utf8');

      const crashed = await runWorker(
        'run',
        claudeBasePath,
        filePath,
        auditPath,
        crashPoint,
        'disk-redo'
      );
      expect(crashed.signal === 'SIGKILL' || crashed.code === 137, crashed.stderr).toBe(true);

      const recovered = await runWorker(
        'recover',
        claudeBasePath,
        filePath,
        auditPath,
        'none',
        'disk-redo'
      );
      expect(recovered.code, recovered.stderr).toBe(0);
      const snapshot = JSON.parse(recovered.stdout) as RecoverySnapshot;
      expect(snapshot).toMatchObject({
        fileContent: 'after\n',
        decisions: {
          hunkDecisions: { 'fixture-change:0': 'rejected' },
          reviewActionHistory: [{ id: 'fixture-disk-action' }],
          reviewRedoHistory: [],
          revision: 2,
        },
        pendingRecords: 0,
        audit: {
          diskWrites: 1,
          diskAttempts: crashPoint === 'after_disk_effect' ? 2 : 1,
          decisionAttempts: crashPoint === 'after_decision_effect' ? 2 : 1,
        },
      });
    },
    30_000
  );

  it.each([
    'prepared',
    'disk_applied',
    'after_decision_effect',
    'decisions_committed',
    'complete',
  ] as const)(
    'recovers decision-only Redo after SIGKILL at %s',
    async (crashPoint) => {
      const root = await mkdtemp(path.join(tmpdir(), `review-redo-crash-${crashPoint}-`));
      temporaryRoots.push(root);
      const claudeBasePath = path.join(root, 'claude-config');
      const projectPath = path.join(root, 'sandbox-project');
      const filePath = path.join(projectPath, 'fixture.ts');
      const auditPath = path.join(root, 'audit.json');
      await mkdir(projectPath, { recursive: true });
      await writeFile(filePath, 'before\n', 'utf8');

      const crashed = await runWorker(
        'run',
        claudeBasePath,
        filePath,
        auditPath,
        crashPoint,
        'decision-only-redo'
      );
      expect(crashed.signal === 'SIGKILL' || crashed.code === 137, crashed.stderr).toBe(true);

      const recovered = await runWorker(
        'recover',
        claudeBasePath,
        filePath,
        auditPath,
        'none',
        'decision-only-redo'
      );
      expect(recovered.code, recovered.stderr).toBe(0);
      const snapshot = JSON.parse(recovered.stdout) as RecoverySnapshot;
      expect(snapshot).toMatchObject({
        fileContent: 'before\n',
        decisions: {
          hunkDecisions: { 'fixture-change:0': 'accepted' },
          revision: 1,
        },
        pendingRecords: 0,
        audit: {
          diskWrites: 0,
          diskAttempts: 0,
          decisionAttempts: crashPoint === 'after_decision_effect' ? 2 : 1,
        },
      });
    },
    30_000
  );
});
