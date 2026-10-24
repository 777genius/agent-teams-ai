import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { hashFile } from './inputs.mts';

interface ShellManifest {
  executable: string;
  psHome: string;
  version: string;
  edition: string;
  sha256: string;
  programFiles: string;
  systemRoot: string;
}

export function inheritedWindowsEnvironment(
  name: string,
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  return Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

// The workflow names its already-running installed PS7 explicitly. Never search
// PATH, install a shell, or retry using Windows PowerShell 5.1.
export async function selectedWindowsPowerShell() {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const manifestPath = inheritedWindowsEnvironment('TEST_WINDOWS_NATIVE_SHELL_MANIFEST');
  assert(manifestPath && path.isAbsolute(manifestPath), 'Explicit shell manifest required');
  assert.equal(path.basename(manifestPath), 'native-shell.json');
  const candidate: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert(candidate && typeof candidate === 'object');
  const manifest = candidate as ShellManifest;
  for (const value of Object.values(manifest)) assert.equal(typeof value, 'string');
  assert(manifest.version.length < 100 && /^[\w.+-]+$/u.test(manifest.version));
  const major = Number(manifest.version.split('.')[0]);
  assert(Number.isSafeInteger(major) && major >= 7, 'PowerShell 7 or newer required');
  assert.equal(manifest.edition, 'Core');
  assert(/^[a-f\d]{64}$/u.test(manifest.sha256));
  const programFiles =
    inheritedWindowsEnvironment('ProgramW6432') ?? inheritedWindowsEnvironment('ProgramFiles');
  const systemRoot = inheritedWindowsEnvironment('SystemRoot');
  assert(
    programFiles && systemRoot && path.isAbsolute(programFiles) && path.isAbsolute(systemRoot)
  );
  const installedRoot = await realpath(programFiles);
  assert.equal((await realpath(manifest.programFiles)).toLowerCase(), installedRoot.toLowerCase());
  assert.equal(
    (await realpath(manifest.systemRoot)).toLowerCase(),
    (await realpath(systemRoot)).toLowerCase()
  );
  const executable = await realpath(manifest.executable);
  const psHome = await realpath(manifest.psHome);
  const parts = path.relative(installedRoot, executable).split(path.sep);
  assert.equal(parts.length, 3, 'Shell must be installed under ProgramFiles/PowerShell');
  assert.equal(parts[0]?.toLowerCase(), 'powershell');
  const directory = parts[1] ?? '';
  assert(directory.length < 100 && /^[\w.-]+$/u.test(directory));
  assert.equal(
    directory.split(/[.-]/u)[0],
    String(major),
    'Installed PowerShell version directory required'
  );
  assert.equal(parts[2]?.toLowerCase(), 'pwsh.exe');
  assert.equal(path.dirname(executable).toLowerCase(), psHome.toLowerCase());
  const actual = await hashFile(executable);
  assert.equal(actual.sha256, manifest.sha256, 'Selected shell hash changed');
  const modules = [
    path.join(psHome, 'Modules'),
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
  ];
  for (const directory of modules)
    assert.equal((await realpath(directory)).toLowerCase(), directory.toLowerCase());
  return { ...manifest, executable, psHome, manifestPath, modules };
}

export async function windowsShellTestEnvironment(
  root: string,
  shell: Awaited<ReturnType<typeof selectedWindowsPowerShell>>
) {
  assert(path.isAbsolute(root) && path.basename(root).startsWith('TEST-updater-windows-'));
  const home = path.join(root, 'shell-home');
  const roaming = path.join(root, 'shell-roaming');
  const local = path.join(root, 'shell-local');
  for (const directory of [home, roaming, local]) await mkdir(directory, { recursive: true });
  const system32 = path.join(shell.systemRoot, 'System32');
  const env: NodeJS.ProcessEnv = {
    SystemRoot: shell.systemRoot,
    WINDIR: shell.systemRoot,
    SystemDrive: path.parse(shell.systemRoot).root.slice(0, 2),
    PATH: system32,
    TEMP: root,
    TMP: root,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: path.parse(home).root.slice(0, 2),
    HOMEPATH: home.slice(2),
    APPDATA: roaming,
    LOCALAPPDATA: local,
    ComSpec: path.join(system32, 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PSModulePath: shell.modules.join(path.delimiter),
    PSModuleAnalysisCachePath: path.join(local, 'ModuleAnalysisCache'),
  };
  for (const name of [
    'ProgramFiles',
    'ProgramFiles(x86)',
    'ProgramW6432',
    'CommonProgramFiles',
    'CommonProgramFiles(x86)',
    'CommonProgramW6432',
  ]) {
    const value = inheritedWindowsEnvironment(name);
    if (value && path.isAbsolute(value)) env[name] = value;
  }
  return env;
}

// The read-only physical-profile probe must see the runner's inherited profile,
// not the TEST shell profile. Keep all shell caches, modules and temporary writes
// isolated; every other native operation still uses windowsShellTestEnvironment.
export function windowsProfileCaptureEnvironment(
  isolated: NodeJS.ProcessEnv,
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const result = { ...isolated };
  for (const name of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    const value = inheritedWindowsEnvironment(name, inherited);
    assert(value && path.isAbsolute(value), `Inherited physical ${name} required`);
    result[name] = value;
  }
  const home = result.USERPROFILE;
  assert(home);
  result.HOME = home;
  result.HOMEDRIVE = path.parse(home).root.slice(0, 2);
  result.HOMEPATH = home.slice(2);
  return result;
}

// Explicit Add-Type references replace its default .NET reference set on PS7.
// Restore its complete ref set and Drawing implementation. .NET 10 Drawing exposes
// types forwarded to its private Windows assemblies, which also need references.
export async function windowsShellCompilerReferences(
  shell: Awaited<ReturnType<typeof selectedWindowsPowerShell>>
) {
  const referenceDirectory = path.join(shell.psHome, 'ref');
  assert.equal(
    (await realpath(referenceDirectory)).toLowerCase(),
    referenceDirectory.toLowerCase(),
    'Compiler reference directory must remain inside selected PSHOME'
  );
  const names = (await readdir(referenceDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.dll'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'));
  for (const required of [
    'System.Runtime.dll',
    'System.Drawing.dll',
    'System.Drawing.Primitives.dll',
  ])
    assert(
      names.some((name) => name.toLowerCase() === required.toLowerCase()),
      `Missing installed reference ${required}`
    );
  const files = names
    .filter((name) => name.toLowerCase() !== 'system.drawing.common.dll')
    .map((name) => path.join(referenceDirectory, name));
  const drawingCommon = path.join(shell.psHome, 'System.Drawing.Common.dll');
  const installedNames = new Set(
    (await readdir(shell.psHome, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name.toLowerCase())
  );
  const runtimeNames = [
    'System.Drawing.Common.dll',
    ...['System.Private.Windows.Core.dll', 'System.Private.Windows.GdiPlus.dll'].filter((name) =>
      installedNames.has(name.toLowerCase())
    ),
  ];
  const runtimeAssemblies = runtimeNames.map((name) => path.join(shell.psHome, name));
  files.push(...runtimeAssemblies);
  const assemblies = [];
  for (const file of files) {
    const canonical = await realpath(file);
    assert.equal(
      canonical.toLowerCase(),
      file.toLowerCase(),
      'Compiler assembly must not redirect outside PSHOME'
    );
    const relative = path.relative(shell.psHome, canonical).split(path.sep);
    assert(
      (relative.length === 2 && relative[0]?.toLowerCase() === 'ref') ||
        (relative.length === 1 &&
          runtimeNames.some((name) => name.toLowerCase() === relative[0]?.toLowerCase())),
      'Compiler assembly must belong to selected installed PSHOME'
    );
    const actual = await hashFile(canonical);
    assemblies.push({ file: canonical, sha256: actual.sha256, size: actual.size });
  }
  return { referenceDirectory, drawingCommon, runtimeAssemblies, assemblies };
}
