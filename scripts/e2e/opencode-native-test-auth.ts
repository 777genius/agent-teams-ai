import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

class WindowsTestAclError extends Error {}

/** Fresh Windows TEST directories need an explicit private DACL before auth is
 * written. POSIX mode bits alone do not enforce this boundary on Windows. */
export async function protectWindowsTestDirectory(directory: string): Promise<void> {
  assert.equal(process.platform, 'win32');
  assert(path.isAbsolute(directory) && /(?:^|[\\/])TEST-[^\\/]+(?:[\\/]|$)/.test(directory));
  const stat = await lstat(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(await realpath(directory), directory);
  const programFiles = process.env.ProgramFiles;
  assert(programFiles && path.win32.isAbsolute(programFiles));
  const powershellRoot = path.win32.join(programFiles, 'PowerShell', '7');
  const env: NodeJS.ProcessEnv = { OPENCODE_TEST_AUTH_DIRECTORY: directory };
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'COMSPEC', 'TMP', 'TEMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PSModulePath = path.win32.join(powershellRoot, 'Modules');
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine('phase:owner')
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
foreach ($principal in @($sid, $system)) {
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', $inherit, 'None', 'Allow'))
}
[Console]::Out.WriteLine('phase:set_acl')
Set-Acl -LiteralPath $env:OPENCODE_TEST_AUTH_DIRECTORY -AclObject $acl
[Console]::Out.WriteLine('phase:read_acl')
$observed = Get-Acl -LiteralPath $env:OPENCODE_TEST_AUTH_DIRECTORY
[Console]::Out.WriteLine('phase:verify_acl')
if (!$observed.AreAccessRulesProtected -or $observed.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Private TEST ACL missing' }
$rules = @($observed.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 2) { throw 'Unexpected TEST access rule' }
foreach ($rule in $rules) {
  if ($rule.IdentityReference.Value -notin @($sid.Value, $system.Value) -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne 'None' -or $rule.IsInherited) { throw 'Unexpected TEST access rule' }
}
`;
  try {
    await promisify(execFile)(
      path.win32.join(powershellRoot, 'pwsh.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        env,
        timeout: 15_000,
        maxBuffer: 4096,
      }
    );
  } catch (error: unknown) {
    let phase = 'startup';
    let reason = 'process_failure';
    let errno = 'none';
    let exit = 'none';
    if (typeof error === 'object' && error !== null) {
      if ('stdout' in error && typeof error.stdout === 'string') {
        for (const line of error.stdout.split(/\r?\n/)) {
          if (/^phase:(owner|set_acl|read_acl|verify_acl)$/.test(line)) phase = line.slice(6);
        }
      }
      if ('code' in error) {
        if (typeof error.code === 'string' && /^E[A-Z0-9_]{1,48}$/.test(error.code)) {
          errno = error.code;
          reason =
            error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output_limit' : 'spawn_failure';
        } else if (
          typeof error.code === 'number' &&
          Number.isInteger(error.code) &&
          error.code >= -2147483648 &&
          error.code <= 2147483647
        ) {
          reason = 'process_exit';
          exit = String(error.code);
        }
      }
      if (
        reason === 'process_failure' &&
        'killed' in error &&
        error.killed === true &&
        'signal' in error &&
        error.signal === 'SIGTERM'
      )
        reason = 'timeout';
    }
    throw new WindowsTestAclError(
      `Private Windows TEST ACL qualification failed: reason=${reason}; phase=${phase}; errno=${errno}; exit=${exit}`
    );
  }
}

/** Bound real TEST requests through the selected model's native V1/V2 config.
 * V1 requires context alongside output. Preserve the qualified model capacity
 * so the output cap does not force compaction immediately after a tool call. */
export async function seedWindowsTestModelOutputLimit(
  directory: string,
  model: string
): Promise<void> {
  assert.equal(process.platform, 'win32');
  assert(path.isAbsolute(directory) && /(?:^|[\\/])TEST-[^\\/]+(?:[\\/]|$)/.test(directory));
  assert(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./:-]+$/.test(model));
  const separator = model.indexOf('/');
  const provider = model.slice(0, separator);
  const modelId = model.slice(separator + 1);
  // Public OpenRouter catalogue captured 2026-10-16; both official pins agree.
  const context = model === 'openrouter/nvidia/nemotron-3-super-120b-a12b:free'
    ? 262_144
    : 32_000;
  await mkdir(directory, { recursive: true });
  await protectWindowsTestDirectory(directory);
  await writeFile(
    path.join(directory, 'opencode.json'),
    JSON.stringify({
      provider: {
        [provider]: { models: { [modelId]: { limit: { context, output: 8192 } } } },
      },
    }),
    { mode: 0o600, flag: 'wx' }
  );
}

async function seedOpenRouter(): Promise<void> {
  assert.equal(process.platform, 'win32');
  const key = process.env.OPENROUTER_API_KEY;
  assert(
    key && key.trim().length > 0 && key.length <= 4096,
    'Configured TEST provider key required'
  );
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-auth-')));
  await protectWindowsTestDirectory(directory);
  const file = path.join(directory, 'auth.json');
  await writeFile(file, JSON.stringify({ openrouter: { type: 'api', key } }), {
    mode: 0o600,
    flag: 'wx',
  });
  // Only the path enters the next step. Never print the provider record/key.
  if (process.env.GITHUB_ENV) {
    assert(!/[\r\n]/.test(file));
    await writeFile(process.env.GITHUB_ENV, `OPENCODE_NATIVE_E2E_AUTH_FILE=${file}\n`, {
      flag: 'a',
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['--seed-openrouter']);
  void seedOpenRouter().catch((error: unknown) => {
    console.error(
      error instanceof WindowsTestAclError
        ? error.message
        : 'Private Windows TEST auth seeding failed'
    );
    process.exitCode = 1;
  });
}
