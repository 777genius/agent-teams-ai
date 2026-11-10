import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { selectedWindowsPowerShell, windowsShellTestEnvironment } from './windows-powershell.mts';

import { lastSelectedStartupProbes, runStartupProbeAttempts } from './windows-startup-retry.mts';
import type { StartupProbeAttempt, StartupProbeResult } from './windows-startup-retry.mts';
import type { ExecFileException } from 'node:child_process';

// Compare explicit shell startup only. Never launch the app, an installer,
// an agent/runtime, or a fallback shell; this is not updater E2E evidence.
assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Only disposable GitHub Windows VMs are allowed');
const evidenceIndex = process.argv.indexOf('--evidence');
const evidenceArgument = process.argv[evidenceIndex + 1];
assert(evidenceIndex >= 0 && evidenceArgument, 'Required --evidence');
const evidence = path.resolve(evidenceArgument, 'startup-diagnostic');
const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-updater-windows-startup-'));
await mkdir(evidence, { recursive: true });

function inherited(name: string): string | undefined {
  return Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}
const systemRoot = inherited('SystemRoot');
assert(systemRoot && path.isAbsolute(systemRoot), 'Absolute SystemRoot required');
const system32 = path.join(systemRoot, 'System32');
const psHome = path.join(system32, 'WindowsPowerShell', 'v1.0');
const executable = path.join(psHome, 'powershell.exe');
const home = path.join(root, 'home');
const roaming = path.join(root, 'roaming');
const local = path.join(root, 'local');
const cache = path.join(local, 'Microsoft', 'Windows', 'PowerShell');
for (const directory of [home, roaming, local, cache]) await mkdir(directory, { recursive: true });

// Preserve the exact Windows PowerShell 5.1 baseline from attempt 4.
const minimal: NodeJS.ProcessEnv = {
  SystemRoot: systemRoot,
  WINDIR: systemRoot,
  PATH: system32,
  TEMP: root,
  TMP: root,
};
const profile: NodeJS.ProcessEnv = {
  ...minimal,
  HOME: home,
  USERPROFILE: home,
  HOMEDRIVE: path.parse(home).root.slice(0, 2),
  HOMEPATH: home.slice(2),
  APPDATA: roaming,
  LOCALAPPDATA: local,
  SystemDrive: path.parse(systemRoot).root.slice(0, 2),
  ComSpec: path.join(system32, 'cmd.exe'),
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  // Do not inherit pwsh's PS7 module directories through the Node parent.
  PSModulePath: path.join(psHome, 'Modules'),
  PSModuleAnalysisCachePath: path.join(cache, 'ModuleAnalysisCache'),
};
for (const name of [
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
]) {
  const value = inherited(name);
  if (value && path.isAbsolute(value)) profile[name] = value;
}

const input = path.join(root, 'input.json');
await writeFile(input, '{"scope":"startup-only","value":17}');
const entry = String.raw`
param([string]$Marker, [string]$InputFile)
[IO.File]::AppendAllText($Marker, 'script-entry' + [Environment]::NewLine)
$ErrorActionPreference = 'Stop'
`;
const dotnet = `${entry}
[Console]::Out.WriteLine('{"scope":"startup-only","value":17}')
[IO.File]::AppendAllText($Marker, 'complete' + [Environment]::NewLine)
`;
const discovery = `${entry}
$text = Get-Content -LiteralPath $InputFile -Raw
[IO.File]::AppendAllText($Marker, 'after-get-content' + [Environment]::NewLine)
$data = ConvertFrom-Json -InputObject $text
[IO.File]::AppendAllText($Marker, 'after-convert-from-json' + [Environment]::NewLine)
$leaf = Split-Path -Leaf $InputFile
[IO.File]::AppendAllText($Marker, 'after-split-path' + [Environment]::NewLine)
$json = ConvertTo-Json -InputObject $data -Compress
[IO.File]::AppendAllText($Marker, 'after-convert-to-json' + [Environment]::NewLine)
[Console]::Out.WriteLine($json)
[IO.File]::AppendAllText($Marker, 'complete' + [Environment]::NewLine)
`;
const scripts = { 'dotnet-file': dotnet, 'cmdlet-discovery': discovery };
const selectedShell = await selectedWindowsPowerShell();
const selectedEnvironment = await windowsShellTestEnvironment(root, selectedShell);
const selectedIdentityCheck = `
[Environment]::SetEnvironmentVariable('PSModulePath', '${selectedShell.modules.join(path.delimiter).replaceAll("'", "''")}', 'Process')
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 required' }
if ($PSVersionTable.PSVersion.ToString() -ne '${selectedShell.version}' -or $PSHOME -ne '${selectedShell.psHome.replaceAll("'", "''")}' -or [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName -ne '${selectedShell.executable.replaceAll("'", "''")}') { throw 'Selected shell identity changed' }
`;
for (const [name, source] of Object.entries(scripts)) {
  await writeFile(path.join(root, `${name}.ps1`), source);
  await writeFile(path.join(evidence, `${name}.ps1`), source);
  const selectedSource = source.replace(entry, `${entry}${selectedIdentityCheck}`);
  await writeFile(path.join(root, `selected-${name}.ps1`), selectedSource);
  await writeFile(path.join(evidence, `selected-${name}.ps1`), selectedSource);
}

const results: StartupProbeAttempt[] = [];
const prefix = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
for (const [variant, env, selectedExecutable] of [
  ['current-minimal', minimal, executable],
  ['test-profile', profile, executable],
  ['selected-ps7', selectedEnvironment, selectedShell.executable],
] as const) {
  for (const probe of ['command-entry', 'dotnet-file', 'cmdlet-discovery'] as const) {
    await runStartupProbeAttempts(
      async (attempt) => {
        const marker = path.join(root, `${variant}-${probe}-attempt-${attempt}.progress.txt`);
        await writeFile(marker, '');
        const args =
          probe === 'command-entry'
            ? [
                ...prefix,
                '-Command',
                "[Console]::Out.WriteLine('STARTUP_COMMAND_ENTRY'); [Environment]::Exit(0)",
              ]
            : [
                ...prefix,
                '-File',
                path.join(root, `${variant === 'selected-ps7' ? 'selected-' : ''}${probe}.ps1`),
                '-Marker',
                marker,
                '-InputFile',
                input,
              ];
        const startedAt = Date.now();
        let pid: number | null = null;
        let processClosed = false;
        const result = await new Promise<StartupProbeResult>((resolve) => {
          const child = execFile(
            selectedExecutable,
            args,
            { env, timeout: 20_000, maxBuffer: 2_097_152 },
            (error: ExecFileException | null, stdout, stderr) =>
              resolve({
                variant,
                probe,
                pid,
                elapsedMs: Date.now() - startedAt,
                code: error ? (error.code ?? null) : 0,
                signal: error?.signal ?? null,
                killed: error?.killed ?? false,
                stdout,
                stderr,
                error: error?.message ?? null,
                phases: [],
                startupHealthy: false,
                processClosed: false,
              })
          );
          pid = child.pid ?? null;
          child.once('close', () => {
            processClosed = true;
          });
          // Exactly the existing EOF fix, not a different stdin transport.
          child.stdin?.end();
        });
        result.processClosed = processClosed;
        result.phases = (await readFile(marker, 'utf8')).split(/\r?\n/u).filter(Boolean);
        const expected =
          probe === 'command-entry'
            ? 'STARTUP_COMMAND_ENTRY'
            : '{"scope":"startup-only","value":17}';
        result.startupHealthy =
          result.processClosed &&
          result.code === 0 &&
          result.signal === null &&
          !result.killed &&
          result.stdout.trim() === expected &&
          result.stderr.trim() === '' &&
          (probe === 'command-entry' || result.phases.at(-1) === 'complete');
        return result;
      },
      async (result) => {
        results.push(result);
        const base = `${variant}-${probe}`;
        const marker = path.join(root, `${base}-attempt-${result.attempt}.progress.txt`);
        const progress = await readFile(marker, 'utf8');
        await writeFile(
          path.join(evidence, `${base}-attempt-${result.attempt}.json`),
          JSON.stringify(result, null, 2)
        );
        await writeFile(
          path.join(evidence, `${base}-attempt-${result.attempt}.progress.txt`),
          progress
        );
        // Existing canonical paths describe the final attempt; failed attempts remain above and in summary.
        await writeFile(path.join(evidence, `${base}.json`), JSON.stringify(result, null, 2));
        await writeFile(path.join(evidence, `${base}.progress.txt`), progress);
        console.log(JSON.stringify(result));
      }
    );
  }
}
const selectedResults = lastSelectedStartupProbes(results);
await writeFile(
  path.join(evidence, 'summary.json'),
  JSON.stringify(
    {
      scope: 'Read-only PowerShell startup comparison; no app/installer execution',
      diagnosticCompleted: true,
      appE2EProved: false,
      executable,
      selectedShell,
      selectedPs7Healthy:
        selectedResults.length === 3 && selectedResults.every((result) => result.startupHealthy),
      root,
      architecture: process.arch,
      timeoutMsPerChild: 20_000,
      maxAttemptsPerProbe: 2,
      timeoutMsPerRetriedProbe: 40_000,
      environmentKeys: {
        minimal: Object.keys(minimal),
        testProfile: Object.keys(profile),
        selectedPs7: Object.keys(selectedEnvironment),
      },
      results,
    },
    null,
    2
  )
);
// Retain PS5.1 failures as evidence. The explicitly selected PS7 must succeed
// before the independent native app gate; neither a fallback nor a skipped gate.
assert.equal(selectedResults.length, 3);
assert(
  selectedResults.every((result) => result.startupHealthy),
  'Selected PowerShell 7 startup gate failed'
);
