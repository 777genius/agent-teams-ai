// ACL policy ported from runtime eee4061c85f269e9f81458ac82b259755dc26596.
// This is the authoritative source; the controller CJS adapter is generated and checked at build.
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import path from 'node:path';

/** macOS named allow-ACLs are independent of POSIX mode bits. Never pass file contents. */
export function assertSafeDarwinMcpAcl(file: string, privateObject: boolean): void {
  const listing = execFileSync('/bin/ls', ['-lde', file], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = listing.trimEnd().split('\n');
  if (!/^[d-][rwxStTs-]{9}[+@]?\s/.test(lines[0] ?? '')) {
    throw new Error('Cursor MCP credential ACL could not be verified');
  }
  for (const line of lines.slice(1)) {
    const entry = /^\s*\d+:\s+(.+?)\s+(allow|deny)\s+(.+)$/.exec(line);
    if (!entry) throw new Error('Cursor MCP credential ACL could not be verified');
    if (entry[2] === 'deny') continue;
    if ([`user:${userInfo().username}`, 'user:root'].includes(entry[1])) continue;
    const readonlyAncestorRights = new Set([
      'read',
      'readattr',
      'readextattr',
      'readsecurity',
      'execute',
      'list',
      'search',
      'file_inherit',
      'directory_inherit',
      'limit_inherit',
      'only_inherit',
      'inherited',
    ]);
    if (
      privateObject ||
      entry[3].split(',').some((right) => !readonlyAncestorRights.has(right.trim()))
    ) {
      throw new Error('Cursor MCP credential ACL is not private and owner controlled');
    }
  }
}

export interface WindowsAclSnapshot {
  userSid: string;
  ownerSid: string;
  rules: Array<{
    sid: string;
    type: string;
    rights?: number;
    inheritOnly?: boolean;
  }>;
}

const TRUSTED_INSTALLER_SID = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';

/** Ancestor readers may remain; foreign principals must not replace or mutate existing path objects. */
export function validateWindowsAncestorAcl(snapshot: WindowsAclSnapshot): void {
  const trusted = [snapshot.userSid, 'S-1-5-18', 'S-1-5-32-544', TRUSTED_INSTALLER_SID];
  if (
    !isWindowsSid(snapshot.userSid) ||
    !trusted.includes(snapshot.ownerSid) ||
    !snapshot.rules.length
  ) {
    throw new Error('Cursor MCP ancestor ACL is not owner controlled');
  }
  // AppendData on a directory is CreateDirectories. Standard drive roots allow
  // this without DELETE_CHILD: it cannot replace an existing validated child.
  // FileSystemRights: https://learn.microsoft.com/dotnet/api/system.security.accesscontrol.filesystemrights
  const readOrCreateDirectory = 1 | 4 | 8 | 32 | 128 | 131072 | 1048576 | 0x80000000 | 0x20000000;
  for (const rule of snapshot.rules) {
    if (
      !isWindowsSid(rule.sid) ||
      !['Allow', 'Deny'].includes(rule.type) ||
      typeof rule.inheritOnly !== 'boolean'
    )
      throw new Error('Cursor MCP ancestor ACL could not be verified');
    if (rule.type === 'Deny' || rule.inheritOnly || trusted.includes(rule.sid)) continue;
    if (
      !Number.isSafeInteger(rule.rights) ||
      rule.rights! < -0x80000000 ||
      rule.rights! > 0xffffffff ||
      (rule.rights! & ~readOrCreateDirectory) !== 0
    ) {
      throw new Error('Cursor MCP ancestor ACL is writable by another principal');
    }
  }
}

/** SID syntax only; GetCurrent().User remains the authority for the user's identity. */
function isWindowsSid(sid: string): boolean {
  if (!/^S-1-(?:0|[1-9]\d{0,14}|0x[\da-fA-F]{12})(?:-(?:0|[1-9]\d{0,9})){1,15}$/.test(sid))
    return false;
  const [, , authority, ...subAuthorities] = sid.split('-');
  return (
    Number(authority) <= 0xffffffffffff &&
    subAuthorities.every((part) => Number(part) <= 0xffffffff)
  );
}

/** Allow only the current user and Windows administrators/SYSTEM, never other users/groups. */
export function validateWindowsAcl(snapshot: WindowsAclSnapshot): void {
  if (
    !isWindowsSid(snapshot.userSid) ||
    // Elevated Windows tokens can create objects owned by the already trusted Administrators group.
    (snapshot.ownerSid !== snapshot.userSid && snapshot.ownerSid !== 'S-1-5-32-544') ||
    !snapshot.rules.length ||
    !snapshot.rules.some((rule) => rule.sid === snapshot.userSid && rule.type === 'Allow') ||
    snapshot.rules.some(
      (rule) =>
        rule.type !== 'Allow' || ![snapshot.userSid, 'S-1-5-18', 'S-1-5-32-544'].includes(rule.sid)
    )
  ) {
    throw new Error('API credential ACL is not private to the current Windows user');
  }
}

export type WindowsAclRunner = (script: string) => string;
/** Trusted WinPS5 toolchain only, including when the parent was PowerShell 7 through Bun. */
export const runWindowsMcpAclScript: WindowsAclRunner = (script) => {
  const windowsRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powerShellHome = path.win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  const executable = path.win32.join(powerShellHome, 'powershell.exe');
  // Implicit module discovery can select PS7 modules in an indirect WinPS5 child.
  // Load only the OS-shipped JSON cmdlet module; ACL reads use .NET Framework directly.
  const bootstrap =
    "$ErrorActionPreference='Stop'; $PSModuleAutoLoadingPreference='None'; $env:PSModulePath=[System.IO.Path]::Combine($PSHOME,'Modules'); Import-Module -Name ([System.IO.Path]::Combine($PSHOME,'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop; ";
  return execFileSync(
    executable,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(bootstrap + script, 'utf16le').toString('base64'),
    ],
    {
      encoding: 'utf8',
      env: {
        SystemRoot: windowsRoot,
        WINDIR: windowsRoot,
        PATH: path.win32.join(windowsRoot, 'System32'),
        PSModulePath: path.win32.join(powerShellHome, 'Modules'),
        // eslint-disable-next-line sonarjs/publicly-writable-directories -- WinPS compatibility only; this metadata-only child writes no files or credentials.
        ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
        // eslint-disable-next-line sonarjs/publicly-writable-directories -- WinPS compatibility only; this metadata-only child writes no files or credentials.
        ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
      },
      timeout: 10_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
};

/** Read effective filesystem ACLs; failure/malformed output fails closed. No credential is passed to a process. */
export function assertPrivateWindowsAcl(
  file: string,
  runner: WindowsAclRunner = runWindowsMcpAclScript
): void {
  const literal = file.replace(/'/g, "''");
  const script = `$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $p='${literal}'; $a=if ([System.IO.Directory]::Exists($p)) { [System.IO.Directory]::GetAccessControl($p) } else { [System.IO.File]::GetAccessControl($p) }; @{userSid=$u;ownerSid=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString()} })} | ConvertTo-Json -Compress -Depth 4`;
  try {
    validateWindowsAcl(JSON.parse(runner(script)) as WindowsAclSnapshot);
  } catch {
    throw new Error('API credential ACL is not private to the current Windows user');
  }
}

/** One metadata-only command checks the private root and every existing ancestor. */
export function assertWindowsMcpAncestry(
  paths: string[],
  runner: WindowsAclRunner = runWindowsMcpAclScript
): void {
  const literals = paths.map((file) => `'${file.replace(/'/g, "''")}'`).join(',');
  const script = `$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; @(${literals}) | ForEach-Object { $p=$_; $a=[System.IO.Directory]::GetAccessControl($p); @{path=$p;userSid=$u;ownerSid=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();rights=[long]$_.FileSystemRights;inheritOnly=[bool]($_.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly)} })} } | ConvertTo-Json -Compress -Depth 5`;
  try {
    const parsed: unknown = JSON.parse(runner(script));
    const records = Array.isArray(parsed) ? parsed : [parsed];
    if (!paths.length || records.length !== paths.length) throw new Error('Invalid ACL ancestry');
    for (const [index, record] of records.entries()) {
      if (!record || typeof record !== 'object' || record.path !== paths[index])
        throw new Error('Invalid ACL ancestry');
      validateWindowsAncestorAcl(record as WindowsAclSnapshot);
    }
    validateWindowsAcl(records[0] as WindowsAclSnapshot);
  } catch {
    throw new Error('Cursor MCP ancestor ACL is not private and owner controlled');
  }
}
