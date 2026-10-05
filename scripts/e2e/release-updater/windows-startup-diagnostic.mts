import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ExecFileException } from 'node:child_process';

// Compare Windows PowerShell startup only. Never launch the app, an installer,
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

// This baseline exactly reproduces windows-native.mts's current child env.
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
for (const [name, source] of Object.entries(scripts)) {
  await writeFile(path.join(root, `${name}.ps1`), source);
  await writeFile(path.join(evidence, `${name}.ps1`), source);
}

interface Result {
  variant: string;
  probe: string;
  pid: number | null;
  elapsedMs: number;
  code: number | string | null;
  signal: string | null;
  killed: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
  phases: string[];
  startupHealthy: boolean;
}
const results: Result[] = [];
const prefix = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
for (const [variant, env] of [
  ['current-minimal', minimal],
  ['test-profile', profile],
] as const) {
  for (const probe of ['command-entry', 'dotnet-file', 'cmdlet-discovery'] as const) {
    const marker = path.join(root, `${variant}-${probe}.progress.txt`);
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
            path.join(root, `${probe}.ps1`),
            '-Marker',
            marker,
            '-InputFile',
            input,
          ];
    const startedAt = Date.now();
    let pid: number | null = null;
    const result = await new Promise<Result>((resolve) => {
      const child = execFile(
        executable,
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
          })
      );
      pid = child.pid ?? null;
      // Exactly the existing EOF fix, not a different stdin transport.
      child.stdin?.end();
    });
    result.phases = (await readFile(marker, 'utf8')).split(/\r?\n/u).filter(Boolean);
    const expected =
      probe === 'command-entry' ? 'STARTUP_COMMAND_ENTRY' : '{"scope":"startup-only","value":17}';
    result.startupHealthy =
      result.code === 0 &&
      result.signal === null &&
      !result.killed &&
      result.stdout.trim() === expected &&
      result.stderr.trim() === '' &&
      (probe === 'command-entry' || result.phases.at(-1) === 'complete');
    results.push(result);
    await writeFile(
      path.join(evidence, `${variant}-${probe}.json`),
      JSON.stringify(result, null, 2)
    );
    await writeFile(
      path.join(evidence, `${variant}-${probe}.progress.txt`),
      await readFile(marker, 'utf8')
    );
    console.log(JSON.stringify(result));
  }
}
await writeFile(
  path.join(evidence, 'summary.json'),
  JSON.stringify(
    {
      scope: 'Read-only PowerShell startup comparison; no app/installer execution',
      diagnosticCompleted: true,
      appE2EProved: false,
      executable,
      root,
      architecture: process.arch,
      timeoutMsPerChild: 20_000,
      environmentKeys: { minimal: Object.keys(minimal), testProfile: Object.keys(profile) },
      results,
    },
    null,
    2
  )
);
// Child failures are evidence, not permission to select a fallback or skip the
// unchanged native updater gate that runs in the next workflow step.
