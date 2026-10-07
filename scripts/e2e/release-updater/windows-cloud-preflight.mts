import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { windowsUiaSource } from './windows-ota-observer.mts';
import { assertForegroundIdentity } from './windows-owned-uia-metadata.mts';

import type { ForegroundIdentity, HeldFocusOwner } from './windows-owned-uia-metadata.mts';
import type {
  selectedWindowsPowerShell,
  windowsShellCompilerReferences,
} from './windows-powershell.mts';

const execute = promisify(execFile);
export const cloudExperiencePackage =
  'Microsoft.Windows.CloudExperienceHost_10.0.26100.1_neutral_neutral_cw5n1h2txyewy';
export function cloudPreflightEnabled(
  root: string,
  env: NodeJS.ProcessEnv,
  platform: string,
  arch: string,
  purpose: 'probe' | 'cleanup' = 'probe'
) {
  assert(['probe', 'cleanup'].includes(purpose));
  if (purpose === 'cleanup') return false;
  if (
    env.TEST_WINDOWS_CLOUD_EXPERIENCE_PREFLIGHT === undefined ||
    env.TEST_WINDOWS_CLOUD_EXPERIENCE_PREFLIGHT === '0'
  )
    return false;
  assert.equal(env.TEST_WINDOWS_CLOUD_EXPERIENCE_PREFLIGHT, '1');
  assert.equal(platform, 'win32');
  assert.equal(arch, 'arm64');
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REPOSITORY, '777genius/agent-teams-ai');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert(['fresh-windows', 'windows-predecessor'].includes(env.GITHUB_JOB ?? ''));
  assert(path.isAbsolute(root) && path.basename(root).startsWith('TEST-updater-windows-'));
  return true;
}
export interface ClosedCloudPreflightReceipt {
  expectedImage: string;
  expectedSid: string;
  expectedSession: number;
  signature: {
    status: string;
    subject: string;
    thumbprint: string;
    sha256: string;
  };
  close: {
    Outcome: 'closed';
    Before: ForegroundIdentity;
    Immediate: HeldFocusOwner;
    AfterHeld: HeldFocusOwner | null;
    AfterForeground: ForegroundIdentity;
    Requested: number;
    InputSent: number;
    Message: number;
    Qualifying: boolean;
    SendError: number;
    SendReturned: boolean;
    WindowGone: boolean;
    ProcessExited: boolean;
    ElapsedMs: number;
    Error: string | null;
  };
}
export interface NoActionCloudPreflightReceipt {
  expectedImage: string;
  expectedSid: string;
  expectedSession: number;
  signature: null;
  close: {
    Outcome: 'no-action';
    Before: ForegroundIdentity;
    Immediate: null;
    AfterHeld: null;
    AfterForeground: null;
    Requested: 0;
    InputSent: 0;
    Message: 0;
    Qualifying: false;
    SendError: 0;
    SendReturned: false;
    WindowGone: false;
    ProcessExited: false;
    ElapsedMs: number;
    Error: null;
  };
}
export type CloudPreflightReceipt = ClosedCloudPreflightReceipt | NoActionCloudPreflightReceipt;
function assertNoAction(receipt: NoActionCloudPreflightReceipt) {
  const proof = receipt.close;
  assertForegroundIdentity(proof.Before);
  assert(
    !proof.Before.PackageBefore?.toLowerCase().startsWith('microsoft.windows.cloudexperiencehost_')
  );
  assert.notEqual(
    path.win32.basename(proof.Before.Before?.Executable ?? '').toLowerCase(),
    'wwahost.exe'
  );
  assert.equal(proof.Before.Before?.Sid, receipt.expectedSid);
  assert.equal(proof.Before.Before?.Session, receipt.expectedSession);
  assert.equal(receipt.signature, null);
  for (const key of ['Requested', 'InputSent', 'Message', 'SendError'] as const)
    assert.equal(proof[key], 0);
  for (const key of ['Qualifying', 'SendReturned', 'WindowGone', 'ProcessExited'] as const)
    assert.equal(proof[key], false);
  for (const key of ['Immediate', 'AfterHeld', 'AfterForeground', 'Error'] as const)
    assert.equal(proof[key], null);
}
export function assertCloudPreflight(receipt: CloudPreflightReceipt, expectedImage: string) {
  assert.equal(receipt.expectedImage.toLowerCase(), expectedImage.toLowerCase());
  assert.equal(path.win32.basename(expectedImage).toLowerCase(), 'wwahost.exe');
  assert(
    Number.isInteger(receipt.close.ElapsedMs) &&
      receipt.close.ElapsedMs >= 0 &&
      receipt.close.ElapsedMs < 20_000
  );
  if (receipt.close.Outcome === 'no-action') {
    assertNoAction(receipt as NoActionCloudPreflightReceipt);
    return;
  }
  assert.equal(receipt.close.Outcome, 'closed');
  const closed = receipt as ClosedCloudPreflightReceipt;
  const proof = closed.close,
    owner = proof.Before.Before;
  assert.equal(proof.Error, null);
  assert.equal(proof.Before.Error, null);
  assert(owner);
  assert.equal(owner.Pid, proof.Before.Pid);
  assert(Number.isInteger(proof.Before.Thread) && proof.Before.Thread > 0);
  assert(/^[a-f\d]{1,16}$/i.test(proof.Before.Hwnd) && proof.Before.Hwnd !== '0');
  assert(/^\d+$/.test(owner.BirthFileTime));
  assert.equal(proof.Before.PackageBefore, cloudExperiencePackage);
  assert.equal(proof.Before.PackageBeforeStatus, 0);
  assert.deepEqual(proof.Immediate, owner);
  assert.equal(owner.Executable.toLowerCase(), receipt.expectedImage.toLowerCase());
  assert.equal(owner.Sid, receipt.expectedSid);
  assert.equal(owner.Session, receipt.expectedSession);
  assert.equal(closed.signature.status, 'Valid');
  assert(/(?:^|,\s*)O=Microsoft Corporation(?:,|$)/.test(closed.signature.subject));
  assert(/^[a-f\d]{40}$/i.test(closed.signature.thumbprint));
  assert(/^[a-f\d]{64}$/.test(closed.signature.sha256));
  assert.equal(proof.Requested, 1);
  assert.equal(proof.InputSent, 0);
  assert.equal(proof.Message, 0x10);
  assert.equal(proof.Qualifying, false);
  assert.equal(proof.WindowGone, true);
  assert.equal(typeof proof.ProcessExited, 'boolean');
  if (proof.ProcessExited) assert.equal(proof.AfterHeld, null);
  else assert.deepEqual(proof.AfterHeld, owner);
  assertForegroundIdentity(proof.AfterForeground);
  assert(
    !proof.AfterForeground.PackageBefore?.toLowerCase().startsWith(
      'microsoft.windows.cloudexperiencehost_'
    )
  );
  assert.notEqual(
    path.win32.basename(proof.AfterForeground.Before?.Executable ?? '').toLowerCase(),
    'wwahost.exe'
  );
  assert.notEqual(proof.AfterForeground.Hwnd, proof.Before.Hwnd);
  assert.equal(typeof proof.SendReturned, 'boolean');
  assert(Number.isInteger(proof.SendError));
}
const preflightSource = String.raw`
param([string]$InputFile,[string]$TrustedModulePath)
$ErrorActionPreference='Stop'; $env:PSModulePath=$TrustedModulePath
$data=ConvertFrom-Json ([IO.File]::ReadAllText($InputFile))
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7 -or $PSVersionTable.PSVersion.ToString() -ne $data.shell.version -or $PSHOME -ne $data.shell.psHome -or [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName -ne $data.shell.executable) { throw 'Selected installed PS7 identity changed' }
Add-Type -ReferencedAssemblies @($data.references) -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
${windowsUiaSource}
'@
$image=[IO.Path]::Combine($data.systemRoot,'System32','WWAHost.exe')
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
$script:firstHash=$null; $script:signature=$null
$check=[Action] {
  if (([IO.File]::GetAttributes($image) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'System image is a reparse point' }
  $sig=Get-AuthenticodeSignature -LiteralPath $image
  if ($sig.Status -ne 'Valid' -or $null -eq $sig.SignerCertificate -or $sig.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') { throw 'Valid Microsoft system image signature required' }
  $hash=(Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($null -ne $script:firstHash -and $hash -ne $script:firstHash) { throw 'System image changed during preflight' }
  $script:firstHash=$hash
  $script:signature=@{status=$sig.Status.ToString();subject=$sig.SignerCertificate.Subject;thumbprint=$sig.SignerCertificate.Thumbprint;sha256=$hash}
}
$progress=[Action[TestOtaObserver+CloudCloseReceipt]] { param($proof) [IO.File]::WriteAllText($data.progress,(ConvertTo-Json -InputObject $proof -Depth 10)) }
$proof=[TestOtaObserver]::CloseTestCloudExperience($image,$sid,$session,$check,$progress)
$result=@{expectedImage=$image;expectedSid=$sid;expectedSession=$session;signature=$script:signature;close=$proof}
ConvertTo-Json -InputObject $result -Depth 10 -Compress
`;
export async function testCloudExperiencePreflight(
  root: string,
  evidence: string,
  shell: Awaited<ReturnType<typeof selectedWindowsPowerShell>>,
  references: Awaited<ReturnType<typeof windowsShellCompilerReferences>>,
  env: NodeJS.ProcessEnv,
  purpose: 'probe' | 'cleanup' = 'probe'
) {
  if (!cloudPreflightEnabled(root, process.env, process.platform, process.arch, purpose)) return;
  const claim = await open(path.join(root, 'cloud-experience-preflight.claim'), 'wx');
  await claim.close();
  const script = path.join(root, 'cloud-experience-preflight.ps1'),
    input = path.join(root, 'cloud-experience-preflight.input.json');
  await writeFile(script, preflightSource);
  await writeFile(
    input,
    JSON.stringify({
      shell,
      systemRoot: shell.systemRoot,
      references: references.assemblies.map((item) => item.file),
      progress: path.join(evidence, 'cloud-experience-before-close.json'),
    })
  );
  await copyFile(script, path.join(evidence, 'cloud-experience-preflight.ps1'));
  await copyFile(input, path.join(evidence, 'cloud-experience-preflight.input.json'));
  try {
    const result = await execute(
      shell.executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-InputFile',
        input,
        '-TrustedModulePath',
        shell.modules.join(path.delimiter),
      ],
      { env, timeout: 20_000, windowsHide: true, maxBuffer: 1_048_576 }
    );
    await writeFile(
      path.join(evidence, 'cloud-experience-transport.json'),
      JSON.stringify(result, null, 2)
    );
    const receipt = JSON.parse(result.stdout.trim()) as CloudPreflightReceipt;
    await writeFile(
      path.join(evidence, 'cloud-experience-preflight.json'),
      JSON.stringify(receipt, null, 2)
    );
    assertCloudPreflight(receipt, path.win32.join(shell.systemRoot, 'System32', 'WWAHost.exe'));
  } catch (error) {
    await writeFile(
      path.join(evidence, 'cloud-experience-preflight-error.json'),
      JSON.stringify({ error: String(error), retry: false }, null, 2)
    );
    throw error;
  }
}
