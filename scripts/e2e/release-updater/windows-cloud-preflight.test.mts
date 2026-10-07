import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertCloudPreflight,
  cloudExperiencePackage,
  cloudPreflightEnabled,
  testCloudExperiencePreflight,
} from './windows-cloud-preflight.mts';
import type {
  CloudPreflightReceipt,
  ClosedCloudPreflightReceipt,
  NoActionCloudPreflightReceipt,
} from './windows-cloud-preflight.mts';

// These fail if a receipt mistakes transport completion for closure, adopts a
// reused identity, endorses an unverified signer, or runs outside the TEST VM.
const image = 'C:\\Windows\\System32\\WWAHost.exe';
const held = {
  Pid: 8964,
  Executable: image,
  Sid: 'S-1-5-21-TEST',
  Session: 2,
  BirthFileTime: '134358687958186587',
};
const afterHeld = {
  ...held,
  Pid: 9012,
  Executable: 'C:\\Windows\\explorer.exe',
  BirthFileTime: '134358687958186600',
};
const after = {
  Hwnd: '30208',
  AfterHwnd: '30208',
  Pid: 9012,
  AfterPid: 9012,
  Thread: 9014,
  AfterThread: 9014,
  Before: afterHeld,
  After: afterHeld,
  PackageBefore: null,
  PackageAfter: null,
  PackageBeforeStatus: 15700,
  PackageAfterStatus: 15700,
  Error: null,
};
const receipt: ClosedCloudPreflightReceipt = {
  expectedImage: image,
  expectedSid: held.Sid,
  expectedSession: 2,
  signature: {
    status: 'Valid',
    subject: 'CN=Microsoft Windows, O=Microsoft Corporation, C=US',
    thumbprint: 'a'.repeat(40),
    sha256: 'b'.repeat(64),
  },
  close: {
    Outcome: 'closed',
    Before: {
      ...after,
      Hwnd: '10208',
      Pid: 8964,
      Thread: 9164,
      Before: held,
      After: null,
      PackageBefore: cloudExperiencePackage,
      PackageBeforeStatus: 0,
    },
    Immediate: { ...held },
    AfterHeld: { ...held },
    AfterForeground: after,
    Requested: 1,
    InputSent: 0,
    Message: 0x10,
    Qualifying: false,
    SendError: 0,
    SendReturned: true,
    WindowGone: true,
    ProcessExited: false,
    ElapsedMs: 900,
    Error: null,
  },
};
void test('window closure requires independent proof even when WM_CLOSE transport returns zero', () => {
  assertCloudPreflight(receipt, image);
  const copy = structuredClone(receipt);
  copy.close.SendReturned = false;
  copy.close.SendError = 0;
  assertCloudPreflight(copy, image);
  copy.close.ProcessExited = true;
  copy.close.AfterHeld = null;
  assertCloudPreflight(copy, image);
});
const rejected: Record<string, (copy: ClosedCloudPreflightReceipt) => void> = {
  'transport completed but window remains': (c) => {
    c.close.WindowGone = false;
  },
  'request retried': (c) => {
    c.close.Requested = 2;
  },
  'no actual request': (c) => {
    c.close.Requested = 0;
  },
  'foreign input': (c) => {
    c.close.InputSent = 1;
  },
  'wrong window message': (c) => {
    c.close.Message = 0x12;
  },
  'qualification claim': (c) => {
    c.close.Qualifying = true;
  },
  'PID mismatch': (c) => {
    c.close.Before.Pid++;
  },
  'missing thread': (c) => {
    c.close.Before.Thread = 0;
  },
  'zero HWND': (c) => {
    c.close.Before.Hwnd = '0';
  },
  'held birth changed before request': (c) => {
    c.close.Immediate.BirthFileTime = '134358687958186600';
  },
  'held birth changed after request': (c) => {
    assert(c.close.AfterHeld);
    c.close.AfterHeld.BirthFileTime = '134358687958186600';
  },
  'different system image': (c) => {
    c.expectedImage = 'C:\\Windows\\System32\\other.exe';
  },
  'wrong SID': (c) => {
    c.expectedSid = 'S-1-5-21-OTHER';
  },
  'wrong session': (c) => {
    c.expectedSession = 3;
  },
  'wrong package': (c) => {
    c.close.Before.PackageBefore = 'Microsoft.Other';
  },
  'unknown package status': (c) => {
    c.close.Before.PackageBeforeStatus = 5;
  },
  'signature invalid': (c) => {
    c.signature.status = 'HashMismatch';
  },
  'non-Microsoft signer': (c) => {
    c.signature.subject = 'CN=Other, O=Other';
  },
  'malformed signature identity': (c) => {
    c.signature.thumbprint = '';
  },
  'malformed image hash': (c) => {
    c.signature.sha256 = '';
  },
  'unknown foreground identity': (c) => {
    c.close.AfterForeground.Error = 'Access denied';
  },
  'replacement CloudExperienceHost': (c) => {
    c.close.AfterForeground.PackageBefore = cloudExperiencePackage;
    c.close.AfterForeground.PackageAfter = cloudExperiencePackage;
    c.close.AfterForeground.PackageBeforeStatus = 0;
    c.close.AfterForeground.PackageAfterStatus = 0;
  },
  'recycled original HWND': (c) => {
    c.close.AfterForeground.Hwnd = '10208';
    c.close.AfterForeground.AfterHwnd = '10208';
  },
  'process exited with contradictory held snapshot': (c) => {
    c.close.ProcessExited = true;
  },
  'close refused': (c) => {
    c.close.Error = 'Window did not close';
  },
};
for (const [name, change] of Object.entries(rejected))
  void test(`preflight rejects ${name}`, () => {
    const copy = structuredClone(receipt);
    change(copy);
    assert.throws(() => assertCloudPreflight(copy, image));
  });
const root = path.resolve('TEST-updater-windows-canary');
const env = {
  TEST_WINDOWS_CLOUD_EXPERIENCE_PREFLIGHT: '1',
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: '777genius/agent-teams-ai',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_JOB: 'fresh-windows',
};
void test('explicit GHA ARM fresh, predecessor and OTA TEST routes enable preflight', () => {
  assert.equal(cloudPreflightEnabled(root, env, 'win32', 'arm64'), true);
  assert.equal(
    cloudPreflightEnabled(root, { ...env, GITHUB_JOB: 'windows-predecessor' }, 'win32', 'arm64'),
    true
  );
  assert.equal(
    cloudPreflightEnabled(root, { ...env, GITHUB_JOB: 'windows-ota' }, 'win32', 'arm64'),
    true
  );
  assert.equal(cloudPreflightEnabled('/real/project', {}, 'darwin', 'arm64'), false);
  assert.equal(
    cloudPreflightEnabled(
      '/real/project',
      { TEST_WINDOWS_CLOUD_EXPERIENCE_PREFLIGHT: '0' },
      'darwin',
      'arm64'
    ),
    false
  );
});
for (const [name, change] of Object.entries({
  flag: { TEST_WINDOWS_CLOUD_EXPERIENCE_PREFLIGHT: 'true' },
  local: { GITHUB_ACTIONS: 'false' },
  repository: { GITHUB_REPOSITORY: 'other/repo' },
  event: { GITHUB_EVENT_NAME: 'pull_request' },
  job: { GITHUB_JOB: 'unreviewed-windows-job' },
}))
  void test(`preflight rejects enabled wrong ${name}`, () =>
    assert.throws(() => cloudPreflightEnabled(root, { ...env, ...change }, 'win32', 'arm64')));
void test('preflight rejects real project, non-Windows and x64 execution', () => {
  assert.throws(() =>
    cloudPreflightEnabled(path.resolve('non-test-project'), env, 'win32', 'arm64')
  );
  assert.throws(() => cloudPreflightEnabled(root, env, 'darwin', 'arm64'));
  assert.throws(() => cloudPreflightEnabled(root, env, 'win32', 'x64'));
  const ota = { ...env, GITHUB_JOB: 'windows-ota' };
  assert.throws(() => cloudPreflightEnabled(root, ota, 'win32', 'x64'));
  assert.throws(() =>
    cloudPreflightEnabled(root, { ...ota, GITHUB_ACTIONS: 'false' }, 'win32', 'arm64')
  );
  assert.throws(() =>
    cloudPreflightEnabled(path.resolve('non-test-project'), ota, 'win32', 'arm64')
  );
  assert.equal(cloudPreflightEnabled(root, ota, 'win32', 'arm64', 'cleanup'), false);
});

// A skip must contain stable, independently read non-Cloud identity and zero effects.
const skipped: NoActionCloudPreflightReceipt = {
  expectedImage: image,
  expectedSid: held.Sid,
  expectedSession: held.Session,
  signature: null,
  close: {
    Outcome: 'no-action',
    Before: after,
    Immediate: null,
    AfterHeld: null,
    AfterForeground: null,
    Requested: 0,
    InputSent: 0,
    Message: 0,
    Qualifying: false,
    SendError: 0,
    SendReturned: false,
    WindowGone: false,
    ProcessExited: false,
    ElapsedMs: 20,
    Error: null,
  },
};
void test('known stable non-Cloud foreground records no action without signature or closure claims', () => {
  assertCloudPreflight(skipped, image);
});
const invalidSkips: Record<string, (copy: CloudPreflightReceipt) => void> = {
  'unknown owner': (c) => {
    c.close.Before.Error = 'Access denied';
  },
  'foreground changed': (c) => {
    c.close.Before.AfterHwnd = 'ffff';
  },
  'owner birth changed': (c) => {
    assert(c.close.Before.After);
    c.close.Before.After = { ...c.close.Before.After, BirthFileTime: '1' };
  },
  'exact Cloud package': (c) => {
    c.close.Before.PackageBefore = cloudExperiencePackage;
    c.close.Before.PackageAfter = cloudExperiencePackage;
    c.close.Before.PackageBeforeStatus = 0;
    c.close.Before.PackageAfterStatus = 0;
  },
  'different Cloud package version': (c) => {
    c.close.Before.PackageBefore = 'Microsoft.Windows.CloudExperienceHost_other';
    c.close.Before.PackageAfter = c.close.Before.PackageBefore;
    c.close.Before.PackageBeforeStatus = 0;
    c.close.Before.PackageAfterStatus = 0;
  },
  'Cloud image with wrong package': (c) => {
    assert(c.close.Before.Before);
    c.close.Before.Before.Executable = image;
    c.close.Before.After = { ...c.close.Before.Before };
  },
  'WWAHost from another path': (c) => {
    assert(c.close.Before.Before);
    c.close.Before.Before.Executable = 'C:\\Windows\\SysWOW64\\wWaHoSt.ExE';
    c.close.Before.After = { ...c.close.Before.Before };
  },
  'unknown package read': (c) => {
    c.close.Before.PackageBeforeStatus = 5;
    c.close.Before.PackageAfterStatus = 5;
  },
  'wrong session': (c) => {
    c.expectedSession++;
  },
  'wrong SID': (c) => {
    c.expectedSid = 'S-1-5-21-OTHER';
  },
  'foreign request attempted': (c) => {
    Object.assign(c.close, { Requested: 1 });
  },
  'foreign input': (c) => {
    Object.assign(c.close, { InputSent: 1 });
  },
  'message sent': (c) => {
    Object.assign(c.close, { Message: 0x10 });
  },
  'closure claimed': (c) => {
    Object.assign(c.close, { WindowGone: true });
  },
  'process exit claimed': (c) => {
    Object.assign(c.close, { ProcessExited: true });
  },
  'transport completion claimed': (c) => {
    Object.assign(c.close, { SendReturned: true });
  },
  'qualification claimed': (c) => {
    Object.assign(c.close, { Qualifying: true });
  },
  'ambiguous transport': (c) => {
    Object.assign(c.close, { SendError: 5 });
  },
  'timeout or refusal': (c) => {
    Object.assign(c.close, { Error: 'Timeout' });
  },
  'foreign immediate owner': (c) => {
    Object.assign(c.close, { Immediate: held });
  },
  'foreign held after owner': (c) => {
    Object.assign(c.close, { AfterHeld: held });
  },
  'foreign after foreground': (c) => {
    Object.assign(c.close, { AfterForeground: after });
  },
  'invalid elapsed time': (c) => {
    c.close.ElapsedMs = 20_000;
  },
  'fabricated signature': (c) => {
    c.signature = receipt.signature;
  },
  'failed receipt disguised as skip': (c) => {
    Object.assign(c.close, { Outcome: 'failed' });
  },
};
for (const [name, change] of Object.entries(invalidSkips))
  void test(`no-action rejects ${name}`, () => {
    const copy: CloudPreflightReceipt = structuredClone(skipped);
    change(copy);
    assert.throws(() => assertCloudPreflight(copy, image));
  });

void test('cleanup purpose never qualifies or invokes the one-shot Cloud fixture', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'TEST-updater-windows-cleanup-'));
  const claim = path.join(temporary, 'cloud-experience-preflight.claim');
  const previous = process.env.TEST_WINDOWS_CLOUD_EXPERIENCE_PREFLIGHT;
  const shell: Parameters<typeof testCloudExperiencePreflight>[2] = {
    executable: path.join(temporary, 'TEST-must-not-run.exe'),
    psHome: temporary,
    version: '7.5.3',
    edition: 'Core',
    sha256: 'a'.repeat(64),
    programFiles: temporary,
    systemRoot: temporary,
    manifestPath: path.join(temporary, 'native-shell.json'),
    modules: [],
  };
  const references: Parameters<typeof testCloudExperiencePreflight>[3] = {
    referenceDirectory: temporary,
    drawingCommon: path.join(temporary, 'TEST.dll'),
    runtimeAssemblies: [],
    assemblies: [],
  };
  try {
    process.env.TEST_WINDOWS_CLOUD_EXPERIENCE_PREFLIGHT = '1';
    await writeFile(claim, 'TEST existing uncertain probe claim');
    await testCloudExperiencePreflight(temporary, temporary, shell, references, env, 'cleanup');
    assert.equal(cloudPreflightEnabled(root, env, 'win32', 'arm64', 'cleanup'), false);
    assert.equal(cloudPreflightEnabled(root, env, 'win32', 'arm64'), true);
    assert.equal(await readFile(claim, 'utf8'), 'TEST existing uncertain probe claim');
    assert.deepEqual(await readdir(temporary), ['cloud-experience-preflight.claim']);
    // Cleanup cannot mutate the probe enable flag or its one-shot claim.
    assert.equal(process.env.TEST_WINDOWS_CLOUD_EXPERIENCE_PREFLIGHT, '1');
    assert.throws(() => cloudPreflightEnabled(root, env, 'win32', 'arm64', 'unknown' as 'probe'));
  } finally {
    if (previous === undefined) delete process.env.TEST_WINDOWS_CLOUD_EXPERIENCE_PREFLIGHT;
    else process.env.TEST_WINDOWS_CLOUD_EXPERIENCE_PREFLIGHT = previous;
    await rm(temporary, { recursive: true, force: true });
  }
});
