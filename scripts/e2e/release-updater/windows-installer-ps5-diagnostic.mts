import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ExecFileException } from 'node:child_process';
import type { WindowsProcess } from './windows-native.mts';

export interface InstallerLineage {
  root: Omit<WindowsProcess, 'command'>;
  descendants: {
    identity?: Omit<WindowsProcess, 'command'> & { command: string | null };
    depth?: number;
  }[];
}
const execute = promisify(execFile);
const environmentNames =
  'SystemRoot|WINDIR|SystemDrive|PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|ComSpec|ProgramFiles|ProgramFiles(x86)|ProgramW6432|PSModulePath|PSModuleAnalysisCachePath'.split(
    '|'
  );
export function installerEnvironment(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    environmentNames.flatMap((name) => {
      const entries = Object.entries(env).filter(
        ([key]) => key.toLowerCase() === name.toLowerCase()
      );
      assert(entries.length <= 1, 'Ambiguous parent environment key');
      return entries[0]?.[1] === undefined ? [] : [[name, entries[0][1]]];
    })
  ) as NodeJS.ProcessEnv;
}
export function installerSyswow64(lineage: InstallerLineage, systemRoot: string) {
  const image = path.win32.join(
    systemRoot,
    'SysWOW64',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const matches = lineage.descendants.filter(
    ({ identity, depth }) =>
      identity &&
      depth === 1 &&
      identity.parent === lineage.root.pid &&
      identity.sid === lineage.root.sid &&
      identity.session === lineage.root.session &&
      Number.isInteger(identity.pid) &&
      identity.pid > 0 &&
      Date.parse(identity.start) >= Date.parse(lineage.root.start) &&
      identity.executable.toLowerCase() === image.toLowerCase()
  );
  return matches.length === 1 ? matches[0]?.identity : undefined;
}
export async function observeInstallerPs5Control(
  lineage: InstallerLineage,
  systemRoot: string,
  root: string,
  spawnEnv: NodeJS.ProcessEnv
) {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert(path.isAbsolute(root) && path.basename(root).startsWith('TEST-updater-windows-'));
  const environment = installerEnvironment(spawnEnv);
  const parentEnvironment = {
    provenance: 'NSIS spawn options.env; not a remote process read',
    values: environment,
    actualChildEnvironment: 'unobserved',
  };
  const selected = installerSyswow64(lineage, systemRoot);
  if (!selected)
    return {
      qualifying: false,
      parentEnvironment,
      control: null,
      reason: 'No unique direct SysWOW64 PS5 child',
    };
  assert.equal(environment.SystemRoot?.toLowerCase(), systemRoot.toLowerCase());
  const started = Date.now();
  const control = {
    executable: selected.executable,
    pid: null as number | null,
    elapsedMs: 0,
    completed: false,
    entry: false,
    code: null as string | number | null,
    killed: false,
    signal: null as NodeJS.Signals | null,
  };
  try {
    const pending = execute(
      selected.executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        "[Console]::WriteLine('CONTROL_ENTRY'); Get-Process -Id $PID -ErrorAction Stop | Out-Null; [Console]::WriteLine('CONTROL_COMPLETE')",
      ],
      { env: environment, cwd: root, timeout: 8000, windowsHide: true, maxBuffer: 4096 }
    );
    control.pid = pending.child.pid ?? null;
    pending.child.stdin?.end();
    const result = await pending;
    control.completed = result.stdout.includes('CONTROL_COMPLETE');
    control.entry = result.stdout.includes('CONTROL_ENTRY');
    control.code = 0;
  } catch (error) {
    const failure = error as ExecFileException & { stdout?: string };
    control.entry = failure.stdout?.includes('CONTROL_ENTRY') ?? false;
    control.code = failure.code ?? null;
    control.killed = failure.killed ?? false;
    control.signal = failure.signal ?? null;
  }
  control.elapsedMs = Date.now() - started;
  return { qualifying: false, parentEnvironment, control };
}
