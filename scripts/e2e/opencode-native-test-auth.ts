import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/** Fresh Windows TEST directories need an explicit private DACL before auth is
 * written. POSIX mode bits alone do not enforce this boundary on Windows. */
export async function protectWindowsTestDirectory(directory: string): Promise<void> {
  assert.equal(process.platform, 'win32');
  assert(path.isAbsolute(directory) && /(?:^|[\\/])TEST-[^\\/]+(?:[\\/]|$)/.test(directory));
  const stat = await lstat(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(await realpath(directory), directory);
  const env: NodeJS.ProcessEnv = { OPENCODE_TEST_AUTH_DIRECTORY: directory };
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'COMSPEC', 'TMP', 'TEMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const script = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
foreach ($principal in @($sid, $system)) {
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', $inherit, 'None', 'Allow'))
}
Set-Acl -LiteralPath $env:OPENCODE_TEST_AUTH_DIRECTORY -AclObject $acl
$observed = Get-Acl -LiteralPath $env:OPENCODE_TEST_AUTH_DIRECTORY
if (!$observed.AreAccessRulesProtected -or $observed.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Private TEST ACL missing' }
$rules = @($observed.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 2) { throw 'Unexpected TEST access rule' }
foreach ($rule in $rules) {
  if ($rule.IdentityReference.Value -notin @($sid.Value, $system.Value) -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') { throw 'Unexpected TEST access rule' }
}
`;
  try {
    await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        env,
        timeout: 15_000,
        maxBuffer: 4096,
      }
    );
  } catch {
    throw new Error('Private Windows TEST ACL qualification failed');
  }
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
  void seedOpenRouter().catch(() => {
    console.error('Private Windows TEST auth seeding failed');
    process.exitCode = 1;
  });
}
