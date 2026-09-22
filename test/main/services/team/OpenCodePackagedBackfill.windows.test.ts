// @vitest-environment node
// Integration diagnostic: no child_process/execCli mocks and no transport projection.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  ExecCliOpenCodeBridgeProcessRunner,
  OpenCodeBridgeCommandClient,
  type OpenCodeBridgeProcessRunInput,
  redactBridgeDiagnosticText,
} from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandClient';
import { describe, expect, it } from 'vitest';

const ARCHIVE_SHA256 = 'f4f36d3f3697fcb3208e7bfc784829a447d8c7faf65570479fa0b4a92ed1ef5d';
// Workflow validates the all-or-none tuple before downloading. Retain the original
// standalone defaults and recheck the selected archive/metadata before any invocation.
const runtimeVersion = process.env.WINDOWS_BACKFILL_RUNTIME_VERSION ?? '0.0.87';
const runtimeArchiveSha256 = process.env.WINDOWS_BACKFILL_RUNTIME_ARCHIVE_SHA256 ?? ARCHIVE_SHA256;
const runtimeSourceSha = process.env.WINDOWS_BACKFILL_RUNTIME_SOURCE_SHA;
const binaryInput = process.env.WINDOWS_BACKFILL_EXE;
const evidenceDir = process.env.WINDOWS_BACKFILL_EVIDENCE_DIR;
const supportRoot = process.env.WINDOWS_BACKFILL_SUPPORT_ROOT;
const supportSha = process.env.WINDOWS_BACKFILL_SUPPORT_SHA;
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const gitHead = (cwd: string): string =>
  execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  }).trim();

function unavailableReason(platform: string, binary: string | undefined): string | null {
  if (platform !== 'win32') return 'Unavailable: actual Windows execution is required';
  if (!binary || !existsSync(binary)) return 'Unavailable: WINDOWS_BACKFILL_EXE is missing';
  return null;
}
const unavailable = unavailableReason(process.platform, binaryInput);

// Capture only synthetic inputs and selected process fields, never process.env.
function sanitized(value: unknown, root = ''): unknown {
  if (typeof value === 'string') {
    return redactBridgeDiagnosticText(root ? value.split(root).join('<sandbox>') : value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitized(item, root));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitized(item, root)])
    );
  }
  return value;
}
function flush(name: string, report: unknown, root = ''): void {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    path.join(evidenceDir, `${name}.json`),
    JSON.stringify(sanitized(report, root), null, 2) + '\n'
  );
}
// These fields are generated solely from this test's synthetic fixture. Preserve
// their literal paths/bytes: redaction would destroy the exact invocation proof.
function writeInvocationProof(name: string, proof: unknown): void {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, `${name}.json`), JSON.stringify(proof, null, 2) + '\n');
}

function shippedExecutableSha256(): string {
  // Bind the executable to the hash-pinned zip itself, not only an environment
  // variable supplied alongside an arbitrary executable. This never launches it.
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($env:WINDOWS_BACKFILL_ARCHIVE)
try {
  $entries = @($zip.Entries | Where-Object { $_.FullName.Replace([char]92, [char]47) -eq 'runtime/claude-multimodel.exe' })
  if ($entries.Count -ne 1) { throw 'Expected exactly one shipped runtime/claude-multimodel.exe' }
  $stream = $entries[0].Open()
  $hash = [Security.Cryptography.SHA256]::Create()
  try { [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $hash.Dispose() }
} finally { $zip.Dispose() }`,
    ],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true }
  ).trim();
}
flush('availability', {
  platform: process.platform,
  status: unavailable ?? 'eligible, not yet run',
});

type Body = Record<string, unknown>;
interface Support {
  sandboxEnvironment(root: string, fakeBinary: string): Record<string, string>;
  createBackfillFixture(
    env: NodeJS.ProcessEnv,
    workspace: string,
    project: string
  ): {
    body: Body;
    dbPath: string;
  };
  assertBackfillEnvelope(result: unknown, envelope: unknown, outcome: string, count: number): void;
  assertImportedLedger(project: string): unknown;
  teardownOwnedProcesses(root: string, report: Body, env: NodeJS.ProcessEnv): void;
}

describe('Windows packaged backfill eligibility', () => {
  it('rejects non-Windows and missing binaries without platform emulation', () => {
    expect(unavailableReason('linux', 'pretend.exe')).toContain('actual Windows');
    expect(unavailableReason('win32', undefined)).toContain('WINDOWS_BACKFILL_EXE');
  });
  it('fails closed when the dedicated diagnostic requires execution', () => {
    if (process.env.WINDOWS_BACKFILL_REQUIRED === '1') {
      expect(unavailable, 'Dedicated CI must never silently skip packaged coverage').toBeNull();
      expect(evidenceDir, 'Evidence directory is required').toBeTruthy();
    }
  });
});

const suiteName = 'actual app client / packaged Windows runtime';

describe.skipIf(Boolean(unavailable))(
  unavailable ? `${suiteName} (${unavailable})` : suiteName,
  () => {
    for (const [id, shape] of [
      ['ascii', 'ascii'],
      ['spaces', 'with spaces'],
      ['unicode', 'Юникод 世界'],
    ]) {
      it(`backfills empty, attributed history, and duplicate replay: ${id}`, async () => {
        const report: Body = {
          schemaVersion: 1,
          status: 'running',
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          referenceAppSha: 'e413d5420625a21f3c78f883e1b45f414f474f61',
          runtimeRelease: `runtime-v${runtimeVersion}`,
          qualificationMode: runtimeSourceSha ? 'manual-qualification' : 'shipped-default',
          // Populated from COMMIT_SHA inside the hash-verified release archive.
          runtimeBuildSourceSha: null,
          shape,
          invocations: [],
        };
        const invocations = report.invocations as Body[];
        let root = '';
        let support: Support | undefined;
        let env: Record<string, string> | undefined;
        const parentEnv = { ...process.env };
        const save = (): void => flush(id, report, root);
        save();
        try {
          expect(evidenceDir, 'Set WINDOWS_BACKFILL_EVIDENCE_DIR').toBeTruthy();
          report.appSourceSha = gitHead(process.cwd());
          expect(process.env.WINDOWS_BACKFILL_APP_SHA).toMatch(/^[a-f0-9]{40}$/);
          expect(report.appSourceSha).toBe(process.env.WINDOWS_BACKFILL_APP_SHA);
          // HEAD provenance must describe the actual code under test.
          expect(
            execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
              encoding: 'utf8',
              timeout: 10_000,
              windowsHide: true,
            }).trim()
          ).toBe('');
          report.appSourceFileSha256 = Object.fromEntries(
            [
              'src/main/services/team/opencode/bridge/OpenCodeBridgeCommandClient.ts',
              'src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract.ts',
              'src/main/utils/childProcess.ts',
              'src/main/utils/cliProcessDefaults.ts',
              'src/main/utils/openCodeNodeModulesJunction.ts',
              'src/main/services/runtime/openCodeAutoUpdatePolicy.ts',
              'test/main/services/team/OpenCodePackagedBackfill.windows.test.ts',
              'test/setup.ts',
              'vitest.config.ts',
            ].map((file) => [file, sha256(readFileSync(file))])
          );
          expect(
            supportRoot,
            'Set WINDOWS_BACKFILL_SUPPORT_ROOT to the pinned checkout'
          ).toBeTruthy();
          expect(supportSha).toMatch(/^[a-f0-9]{40}$/);
          report.supportSourceSha = gitHead(supportRoot!);
          expect(report.supportSourceSha).toBe(supportSha);
          const supportFile = path.join(
            supportRoot!,
            'scripts/smoke/windows-runtime-opencode-backfill.mjs'
          );
          const fixtureFile = path.join(
            supportRoot!,
            'scripts/smoke/windows-runtime-opencode-fixture.cjs'
          );
          // Reject dirty or substituted support, including untracked helper files.
          for (const file of [supportFile, fixtureFile]) {
            const relative = path.relative(supportRoot!, file).split(path.sep).join('/');
            const committed = execFileSync(
              'git',
              ['-C', supportRoot!, 'show', `${supportSha}:${relative}`],
              {
                timeout: 10_000,
                windowsHide: true,
              }
            );
            // Windows checkout may convert LF to CRLF; accept only that conversion.
            expect(readFileSync(file, 'utf8').replaceAll('\r\n', '\n')).toBe(
              committed.toString('utf8').replaceAll('\r\n', '\n')
            );
          }
          report.supportHelperSha256 = sha256(readFileSync(supportFile));
          report.supportFixtureSha256 = sha256(readFileSync(fixtureFile));
          // Use Node 24 ESM loading; Vite transforms this external Windows file incorrectly.
          support = createRequire(import.meta.url)(supportFile) as Support;
          const archive = process.env.WINDOWS_BACKFILL_ARCHIVE;
          expect(archive, 'Set WINDOWS_BACKFILL_ARCHIVE to the verified release zip').toBeTruthy();
          report.archiveSha256 = sha256(readFileSync(archive!));
          expect(runtimeArchiveSha256).toMatch(/^[a-f0-9]{64}$/);
          expect(report.archiveSha256).toBe(runtimeArchiveSha256);
          expect(path.isAbsolute(binaryInput!)).toBe(true);
          expect(path.extname(binaryInput!).toLowerCase()).toBe('.exe');
          report.executableSha256 = sha256(readFileSync(binaryInput!));
          expect(report.executableSha256).toBe(process.env.WINDOWS_BACKFILL_EXE_SHA256);
          report.executableArchiveMember = 'runtime/claude-multimodel.exe';
          report.archiveExecutableSha256 = shippedExecutableSha256();
          expect(report.executableSha256).toBe(report.archiveExecutableSha256);
          const runtimeDir = path.dirname(binaryInput!);
          report.runtimeBuildSourceSha = readFileSync(
            path.join(runtimeDir, 'COMMIT_SHA'),
            'utf8'
          ).trim();
          expect(report.runtimeBuildSourceSha).toMatch(/^[a-f0-9]{40}$/);
          if (runtimeSourceSha) {
            expect(runtimeSourceSha).toMatch(/^[a-f0-9]{40}$/);
            expect(report.runtimeBuildSourceSha).toBe(runtimeSourceSha);
          }
          expect(readFileSync(path.join(runtimeDir, 'VERSION'), 'utf8').trim()).toBe(
            runtimeVersion
          );
          root = mkdtempSync(path.join(os.tmpdir(), 'app-backfill-'));
          const caseRoot = path.join(root, shape);
          const binDir = path.join(caseRoot, 'bin');
          const workspace = path.join(caseRoot, 'workspace');
          const project = path.join(caseRoot, 'ledger-project');
          for (const dir of [binDir, workspace, project]) mkdirSync(dir, { recursive: true });
          const binary = path.join(binDir, 'runtime.exe');
          if (id === 'ascii') expect(binary).toMatch(/^[\x21-\x7e]+$/);
          copyFileSync(binaryInput!, binary);
          const assets = path.join(path.dirname(binaryInput!), 'cursor-managed');
          if (existsSync(assets))
            cpSync(assets, path.join(binDir, 'cursor-managed'), { recursive: true });
          expect(sha256(readFileSync(binary))).toBe(report.executableSha256);
          copyFileSync(fixtureFile, path.join(caseRoot, 'fake-opencode.cjs'));
          const fakeBinary = path.join(caseRoot, 'opencode.cmd');
          writeFileSync(fakeBinary, '@echo off\r\nnode "%~dp0fake-opencode.cjs" %*\r\n');
          env = support.sandboxEnvironment(caseRoot, fakeBinary);
          const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
          const powershellDir = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
          expect(env.PATH.toLowerCase().split(';')).toContain(powershellDir.toLowerCase());
          expect(existsSync(path.join(powershellDir, 'powershell.exe'))).toBe(true);
          // The default junction recovery also reads parent env. Keep it sandboxed.
          for (const key of Object.keys(process.env)) delete process.env[key];
          Object.assign(process.env, env);
          const delegate = new ExecCliOpenCodeBridgeProcessRunner();
          const client = new OpenCodeBridgeCommandClient({
            binaryPath: binary,
            tempDirectory: env.TEMP,
            env,
            processRunner: {
              async run(input: OpenCodeBridgeProcessRunInput) {
                const inputPath = input.args[input.args.indexOf('--input') + 1];
                const outputPath = input.args[input.args.indexOf('--output') + 1];
                const envelope = JSON.parse(readFileSync(inputPath, 'utf8')) as Body;
                const invocation: Body = {
                  binaryPath: input.binaryPath,
                  argv: [...input.args],
                  cwd: input.cwd,
                  timeoutMs: input.timeoutMs,
                  stdoutLimitBytes: input.stdoutLimitBytes,
                  stderrLimitBytes: input.stderrLimitBytes,
                  envelope,
                  inputSha256: sha256(readFileSync(inputPath)),
                };
                invocations.push(invocation);
                writeInvocationProof(`${id}-invocation-${invocations.length}`, {
                  appSourceSha: report.appSourceSha,
                  supportSourceSha: report.supportSourceSha,
                  archiveSha256: report.archiveSha256,
                  executableSha256: report.executableSha256,
                  ...invocation,
                  inputUtf8: readFileSync(inputPath, 'utf8'),
                });
                save();
                // Delegate the EXACT input unchanged; default runner calls real execCli.
                const result = await delegate.run(input);
                invocation.process = result;
                invocation.stdoutSha256 = sha256(result.stdout);
                invocation.stderrSha256 = sha256(result.stderr);
                if (existsSync(outputPath)) {
                  invocation.output = readFileSync(outputPath, 'utf8');
                  invocation.outputSha256 = sha256(readFileSync(outputPath));
                }
                save();
                return result;
              },
            },
          });
          const invoke = async (
            label: string,
            body: Body,
            outcome: string,
            count: number
          ): Promise<void> => {
            const firstInvocation = invocations.length;
            const result = await client.execute('opencode.backfillTaskLedger', body, {
              cwd: workspace,
              timeoutMs: 20_000,
              requestId: `app-backfill-${id}-${label}`,
            });
            report[label] = result;
            save();
            const calls = invocations.slice(firstInvocation);
            expect(calls.length).toBeGreaterThan(0);
            expect(calls.length).toBeLessThanOrEqual(2);
            for (const call of calls) {
              expect(JSON.stringify(call)).not.toMatch(
                /too many arguments|Expected 1 argument but got 2/i
              );
              expect(call.process).toMatchObject({ timedOut: false });
            }
            // The real client may recover one symlink EPERM and retry. Preserve
            // that failed attempt while requiring the final invocation to succeed.
            expect(calls.at(-1)!.process).toMatchObject({ exitCode: 0, timedOut: false });
            support!.assertBackfillEnvelope(result, calls.at(-1)!.envelope, outcome, count);
            expect(readdirSync(workspace)).toEqual([]);
          };
          await invoke(
            'empty',
            {
              teamName: 'backfill-fixture',
              teamId: 'backfill-fixture',
              taskId: 'task-1',
              memberName: 'bob',
              laneId: 'secondary:opencode:bob',
              projectDir: project,
              workspaceRoot: workspace,
              attributionMode: 'compatible',
            },
            'no-history',
            0
          );
          report.emptyLedgerEventFilePresent = existsSync(
            path.join(project, '.board-task-changes/events/task-1.jsonl')
          );
          save();
          expect(report.emptyLedgerEventFilePresent).toBe(false);
          const fixture = support.createBackfillFixture(env, workspace, project);
          report.fixtureDbSha256 = sha256(readFileSync(fixture.dbPath));
          await invoke('import', fixture.body, 'imported', 1);
          report.ledger = support.assertImportedLedger(project);
          save();
          await invoke('replay', fixture.body, 'duplicates-only', 0);
          report.replayLedger = support.assertImportedLedger(project);
          expect(report.replayLedger).toEqual(report.ledger);
          const probes = readFileSync(
            path.join(caseRoot, 'fake-opencode-invocations.jsonl'),
            'utf8'
          );
          expect(
            probes
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line) as { argv: string[] })
              .some((probe) => probe.argv.slice(2).includes('--version'))
          ).toBe(true);
          report.status = 'cleanup-pending';
        } catch (error) {
          report.status = 'failed';
          report.error = error instanceof Error ? error.stack : String(error);
          throw error;
        } finally {
          try {
            if (root) {
              const probes = path.join(root, shape, 'fake-opencode-invocations.jsonl');
              if (existsSync(probes)) report.probeInvocations = readFileSync(probes, 'utf8');
              const workspace = path.join(root, shape, 'workspace');
              if (existsSync(workspace)) report.workspaceEntriesAfterRun = readdirSync(workspace);
              const journal = path.join(
                root,
                shape,
                'ledger-project/.board-task-changes/events/task-1.jsonl'
              );
              report.finalLedgerEventFilePresent = existsSync(journal);
              if (existsSync(journal)) {
                report.finalLedgerJournal = readFileSync(journal, 'utf8');
                report.finalLedgerJournalSha256 = sha256(readFileSync(journal));
              }
              // Persist failure/ledger evidence before the blocking native cleanup.
              save();
            }
          } catch (error) {
            report.status = 'failed';
            report.evidenceError = String(error);
          }
          try {
            if (root) {
              if (support && env) support.teardownOwnedProcesses(root, report, env);
              rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
              report.sandboxRemoved = !existsSync(root);
            }
            if (report.status === 'cleanup-pending') report.status = 'passed';
          } catch (error) {
            report.status = 'failed';
            report.cleanupError = String(error);
          } finally {
            for (const key of Object.keys(process.env)) delete process.env[key];
            Object.assign(process.env, parentEnv);
            save();
          }
        }
        expect(report.status, String(report.cleanupError ?? report.evidenceError ?? '')).toBe(
          'passed'
        );
      }, 360_000); // Three commands, up to one real junction recovery each, plus owned cleanup.
    }
  }
);
