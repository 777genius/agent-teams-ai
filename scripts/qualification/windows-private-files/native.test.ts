import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, readdir, rm, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { privateDirectory, readPrivateJson, validatePrivatePath, writePrivateJson } from './fixtures/privateFiles';
import { assertPrivateWindowsAcl, type WindowsAclSnapshot } from './fixtures/windowsPrivateAcl';

interface NativeAcl extends WindowsAclSnapshot {
  protected: boolean;
  inherited: boolean[];
}
function powershell(script: string): string {
  return execFileSync(path.win32.join(process.env.SystemRoot ?? 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe'),
  ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; ${script}`, 'utf16le').toString('base64')],
  { encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
const literal = (file: string): string => `'${file.replace(/'/g, "''")}'`;
function snapshot(file: string): NativeAcl {
  return JSON.parse(powershell(`$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $a=Get-Acl -LiteralPath ${literal(file)}; $r=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); @{userSid=$u;ownerSid=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;protected=$a.AreAccessRulesProtected;inherited=@($r | ForEach-Object {$_.IsInherited});rules=@($r | ForEach-Object {@{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString()}})} | ConvertTo-Json -Depth 4 -Compress`)) as NativeAcl;
}
async function setPrivate(root: string, file: string): Promise<void> {
  const relative = path.relative(root, file);
  assert(!relative.startsWith('..') && !path.isAbsolute(relative), 'permission adjustment must stay in owned fixtures');
  const stat = await lstat(file);
  assert(!stat.isSymbolicLink() && (stat.isDirectory() || (stat.isFile() && stat.nlink === 1)), 'never adjust link ACLs');
  const inherit = stat.isDirectory() ? 'ContainerInherit, ObjectInherit' : 'None';
  powershell(`$p=${literal(file)}; $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a=Get-Acl -LiteralPath $p; $a.SetAccessRuleProtection($true,$false); foreach($r in @($a.Access)){$a.RemoveAccessRuleSpecific($r)}; $a.SetOwner($u); foreach($s in @($u.Value,'S-1-5-18','S-1-5-32-544')){$id=[System.Security.Principal.SecurityIdentifier]::new($s); $r=[System.Security.AccessControl.FileSystemAccessRule]::new($id,'FullControl','${inherit}','None','Allow'); $a.AddAccessRule($r)}; Set-Acl -LiteralPath $p -AclObject $a`);
}
function grant(file: string, sid: string): void {
  powershell(`$p=${literal(file)}; $a=Get-Acl -LiteralPath $p; $id=[System.Security.Principal.SecurityIdentifier]::new('${sid}'); $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($id,'Read','Allow')); Set-Acl -LiteralPath $p -AclObject $a`);
}

test('native filesystem qualification', { skip: process.platform !== 'win32' }, async (t) => {
  // Every fixture is brand new and below homedir. There is no auth service or credential.
  const root = await mkdtemp(path.join(homedir(), '.filesystem-qualification-'));
  const links: string[] = [];
  try {
    await t.test('unmodified profile inheritance: observe native default owner and first publication', async (sub) => {
      const profile = path.join(root, 'default-profile');
      await mkdir(profile);
      const native = snapshot(profile);
      const category = (sid: string): string => sid === native.userSid ? 'current-user' : sid === 'S-1-5-18' ? 'system' : sid === 'S-1-5-32-544' ? 'administrators' : 'unexpected';
      sub.diagnostic(JSON.stringify({ defaultProfileAcl: { ownerMatchesCurrentUser: native.ownerSid === native.userSid, ownerCategory: category(native.ownerSid), protected: native.protected, inherited: native.inherited, principalCategories: native.rules.map(rule => ({ principal: category(rule.sid), type: rule.type })) } }));
      // Native elevated owner may be Administrators; the exact private DACL is still required.
      // Unsupported owners/grants fail here without silently repairing the default profile.
      const directory = await privateDirectory(profile);
      const file = path.join(directory, 'fixture.json');
      await writePrivateJson(file, { fixture: 'first' });
      assert.deepEqual(await readPrivateJson(file), { fixture: 'first' });
    });

    // Controlled fixtures exercise policy separately from the unmodified runner profile.
    await setPrivate(root, root);
    const profile = path.join(root, "quote'profile");
    await mkdir(profile);
    const directory = await privateDirectory(profile);
    const file = path.join(directory, "quote'fixture.json");
    await t.test('unsafe temporary inheritance rejects first write and replacement', { timeout: 120_000 }, async () => {
      const grantUnsafeInheritance = (directory: string): void => {
        powershell(`$p=${literal(directory)}; $a=Get-Acl -LiteralPath $p; $id=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'); $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($id,'Read','ContainerInherit, ObjectInherit','None','Allow')); Set-Acl -LiteralPath $p -AclObject $a`);
        assert.throws(() => assertPrivateWindowsAcl(directory), /private/);
      };
      const firstDirectory = path.join(root, 'temporary-first-negative');
      await mkdir(firstDirectory);
      const absent = path.join(firstDirectory, 'fixture.json');
      grantUnsafeInheritance(firstDirectory);
      await assert.rejects(writePrivateJson(absent, { fixture: 'forbidden' }), /private/);
      await assert.rejects(lstat(absent), { code: 'ENOENT' });
      assert.deepEqual(await readdir(firstDirectory), []);
      const replacementDirectory = path.join(root, 'temporary-replacement-negative');
      await mkdir(replacementDirectory);
      const existing = path.join(replacementDirectory, 'fixture.json');
      await writePrivateJson(existing, { fixture: 'retained' });
      await setPrivate(root, existing);
      grantUnsafeInheritance(replacementDirectory);
      assertPrivateWindowsAcl(existing);
      assert.deepEqual(await readPrivateJson(existing), { fixture: 'retained' });
      await assert.rejects(writePrivateJson(existing, { fixture: 'forbidden' }), /private/);
      assert.deepEqual(await readPrivateJson(existing), { fixture: 'retained' });
      assert.deepEqual(await readdir(replacementDirectory), ['fixture.json']);
    });

    await t.test('absent first write, read, replacement and owner/private inheritance', async () => {
      await assert.rejects(lstat(file), { code: 'ENOENT' });
      await writePrivateJson(file, { fixture: 'first' });
      assert.deepEqual(await readPrivateJson(file), { fixture: 'first' });
      const acl = snapshot(file);
      assert([acl.userSid, 'S-1-5-32-544'].includes(acl.ownerSid), 'native owner must be current user or builtin Administrators');
      assert.equal(acl.protected, false);
      assert(acl.inherited.length > 0 && acl.inherited.every(Boolean));
      assertPrivateWindowsAcl(file); // actual native runner, never injected
      await writePrivateJson(file, { fixture: 'replacement' });
      assert.deepEqual(await readPrivateJson(file), { fixture: 'replacement' });
      assert.deepEqual(await readdir(directory), [path.basename(file)]);
    });
    for (const sid of ['S-1-1-0', 'S-1-5-32-545']) {
      await t.test(`reject foreign grant ${sid} and retain data`, async () => {
        grant(file, sid);
        try {
          assert.throws(() => assertPrivateWindowsAcl(file), /private/);
          await assert.rejects(readPrivateJson(file), /private/);
          await assert.rejects(writePrivateJson(file, { fixture: 'forbidden' }), /private/);
          assert.deepEqual(await readdir(directory), [path.basename(file)]);
        } finally { await setPrivate(root, file); }
        assert.deepEqual(await readPrivateJson(file), { fixture: 'replacement' });
      });
    }
    await t.test('reject file symlink, directory junction and hardlink', async () => {
      const sym = path.join(directory, 'symbolic.json');
      const junction = path.join(root, 'junction');
      const hard = path.join(directory, 'hard.json');
      // Failure to create a native link is a qualification failure, not a skip.
      await symlink(file, sym, 'file'); links.push(sym);
      await assert.rejects(validatePrivatePath(sym), /private/);
      await assert.rejects(writePrivateJson(sym, { fixture: 'forbidden' }), /private/);
      await symlink(profile, junction, 'junction'); links.push(junction);
      await assert.rejects(privateDirectory(junction), /Unsafe|private|changed/);
      await link(file, hard); links.push(hard);
      await assert.rejects(readPrivateJson(hard), /private/);
      await assert.rejects(writePrivateJson(file, { fixture: 'forbidden' }), /private/);
      await unlink(hard); links.splice(links.indexOf(hard), 1);
      assert.deepEqual(await readPrivateJson(file), { fixture: 'replacement' });
    });
    await t.test('owned cleanup succeeds with a remaining negative grant', async () => {
      const negative = path.join(directory, 'cleanup.json');
      await writePrivateJson(negative, { fixture: 'cleanup' });
      grant(negative, 'S-1-1-0');
      await assert.rejects(readPrivateJson(negative), /private/);
      await unlink(negative);
      assert.equal(existsSync(negative), false);
    });
  } finally {
    // Remove owned links first; recursive cleanup never adjusts their targets.
    for (const file of links.toReversed()) {
      if ((await lstat(file)).isDirectory()) await rm(file);
      else await unlink(file);
    }
    await rm(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false, 'owned profile cleanup must complete after failures');
  }
});
