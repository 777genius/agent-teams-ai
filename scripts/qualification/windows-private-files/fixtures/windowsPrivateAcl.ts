import { execFileSync } from 'node:child_process';
import path from 'node:path';

export interface WindowsAclSnapshot {
  userSid: string;
  ownerSid: string;
  rules: Array<{ sid: string; type: string }>;
}

/** SID syntax only; GetCurrent().User remains the authority for the user's identity. */
function isWindowsSid(sid: string): boolean {
  if (!/^S-1-(?:0|[1-9]\d{0,14}|0x[\da-fA-F]{12})(?:-(?:0|[1-9]\d{0,9})){1,15}$/.test(sid))
    return false;
  const [, , authority, ...subAuthorities] = sid.split('-');
  return Number(authority) <= 0xffffffffffff &&
    subAuthorities.every((part) => Number(part) <= 0xffffffff);
}

/** Allow only the current user and Windows administrators/SYSTEM, never other users/groups. */
export function validateWindowsAcl(snapshot: WindowsAclSnapshot): void {
  if (
    !isWindowsSid(snapshot.userSid) ||
    snapshot.ownerSid !== snapshot.userSid ||
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
const runAcl: WindowsAclRunner = (script) => {
  const executable = path.win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  return execFileSync(
    executable,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
};

/** Read effective filesystem ACLs; failure/malformed output fails closed. No credential is passed to a process. */
export function assertPrivateWindowsAcl(file: string, runner: WindowsAclRunner = runAcl): void {
  const literal = file.replace(/'/g, "''");
  const script = `$ErrorActionPreference='Stop'; $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $a=Get-Acl -LiteralPath '${literal}'; @{userSid=$u;ownerSid=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString()} })} | ConvertTo-Json -Compress -Depth 4`;
  try {
    validateWindowsAcl(JSON.parse(runner(script)) as WindowsAclSnapshot);
  } catch {
    throw new Error('API credential ACL is not private to the current Windows user');
  }
}
