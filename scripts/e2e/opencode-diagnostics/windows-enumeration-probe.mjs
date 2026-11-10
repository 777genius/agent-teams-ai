// Read-only CI diagnostic: never print process command lines or inherited environment.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isolatedEnvironment } from './platform.mjs';

assert.equal(process.platform, 'win32');
const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-diagnostics-e2e-probe-'));
const data = Object.fromEntries(
  ['home', 'temp', 'bin', 'userData'].map((key) => [key, path.join(root, key)])
);
await Promise.all(Object.values(data).map((dir) => mkdir(dir, { recursive: true })));
const env = isolatedEnvironment({ ...data, node: process.execPath });
const script =
  '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
const prefix = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const absolute = path.join(
  process.env.SystemRoot,
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);
const plumbing = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(ProgramFiles(?:\(x86\))?|ProgramW6432|CommonProgramFiles(?:\(x86\))?|CommonProgramW6432|PSModulePath)$/i.test(
      key
    )
  )
);
const results = [];
for (const [name, binary, args, environment] of [
  ['isolated-path-command', 'powershell.exe', ['-Command', script], env],
  ['isolated-absolute-command', absolute, ['-Command', script], env],
  ['isolated-os-plumbing-command', absolute, ['-Command', script], { ...env, ...plumbing }],
  [
    'isolated-absolute-encoded',
    absolute,
    ['-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    env,
  ],
]) {
  const start = performance.now();
  const result = await new Promise((resolve) =>
    execFile(
      binary,
      [...prefix, ...args],
      {
        env: environment,
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        let rows = null;
        try {
          const parsed = JSON.parse(stdout);
          rows = Array.isArray(parsed) ? parsed.length : 1;
        } catch {}
        resolve({
          name,
          durationMs: Math.round(performance.now() - start),
          code: error?.code ?? null,
          signal: error?.signal ?? null,
          killed: error?.killed ?? false,
          stderrPresent: Boolean(stderr.trim()),
          rows,
        });
      }
    )
  );
  results.push(result);
  console.log(JSON.stringify(result));
  await writeFile(
    path.join(root, 'windows-enumeration-probe.json'),
    JSON.stringify(results, null, 2)
  );
}
