import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { windowsObserverReadOwnedSource } from './windows-ota-observer.mts';
import { selectedWindowsPowerShell, windowsShellTestEnvironment } from './windows-powershell.mts';

void test('OTA sampler embeds the SID race contract exercised by the native regression', async () => {
  const source = await readFile(new URL('./windows-ota-observer.mts', import.meta.url), 'utf8');
  assert.equal(source.split('${windowsObserverReadOwnedSource}').length, 2);
  assert.equal(source.match(/function Read-Owned\(/gu)?.length, 1);
  assert.match(
    windowsObserverReadOwnedSource,
    /-Filter "ProcessId = \$ownedId" -ErrorAction Stop/u
  );
});

void test(
  'actual OTA sampler drops only independently absent PID after CIM NotFound or failed SID return',
  { skip: process.platform !== 'win32' ? 'Requires selected installed PS7 on Windows VM' : false },
  async () => {
    const shell = await selectedWindowsPowerShell();
    const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-updater-windows-observer-sid-'));
    try {
      const script = path.join(root, 'observer-sid-contract.ps1');
      await writeFile(
        script,
        String.raw`
$ErrorActionPreference='Stop'
Import-Module CimCmdlets -ErrorAction Stop
# Obtain the genuine exception without launching or signalling any process.
if (@(CimCmdlets\Get-CimInstance Win32_Process -Filter 'ProcessId = 4294967295' -ErrorAction Stop).Count) { throw 'Missing-PID fixture is live' }
$missing=CimCmdlets\New-CimInstance -Namespace root/cimv2 -ClassName Win32_Process -Key Handle -Property @{Handle='4294967295';ProcessId=[uint32]::MaxValue} -ClientOnly
$script:missingSidError=$null
try { CimCmdlets\Invoke-CimMethod -InputObject $missing -MethodName GetOwnerSid -ErrorAction Stop | Out-Null }
catch [Microsoft.Management.Infrastructure.CimException] { $script:missingSidError=$_.Exception }
if (-not $script:missingSidError -or $script:missingSidError.NativeErrorCode -ne [Microsoft.Management.Infrastructure.NativeErrorCode]::NotFound) { throw 'Expected genuine missing-process CIM NotFound' }
$script:otherError=[Microsoft.Management.Infrastructure.CimException]::new('TEST non-NotFound CIM failure')
if ($script:otherError.NativeErrorCode -eq [Microsoft.Management.Infrastructure.NativeErrorCode]::NotFound) { throw 'Invalid non-NotFound fixture' }
$script:queries=[Collections.Generic.List[string]]::new()
$ownedPath='C:\TEST-updater-windows-owned\install\AgentTeamsAI.exe'
$script:item=@{ProcessId=4660;ParentProcessId=5564;ExecutablePath=$ownedPath;CommandLine='TEST owned';CreationDate=[DateTime]::UtcNow;SessionId=(Get-Process -Id $PID).SessionId}
$script:ownerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Test-Canonical([string]$file) { if ($file -ne $ownedPath) { throw 'Unowned executable' }; return $file }
function Get-CimInstance([string]$ClassName,[string]$Filter,[string]$ErrorAction) {
  if ($ClassName -ne 'Win32_Process' -or $ErrorAction -ne 'Stop') { throw 'Unexpected query' }
  if (-not $Filter) { return $script:item }
  $script:queries.Add($Filter)
  if ($Filter -ne 'ProcessId = 4660') { throw 'Independent query must use the captured PID' }
  switch ($script:presence) {
    'absent' { return }
    'live' { return $script:item }
    'reused' { return @{ProcessId=4660;ExecutablePath='C:\unowned\other.exe';CreationDate=[DateTime]::UtcNow} }
    'ambiguous' { return @($script:item,$script:item) }
    'query-error' { throw 'Independent query failed' }
  }
  throw 'Unexpected presence case'
}
function Invoke-CimMethod($InputObject,[string]$MethodName,[string]$ErrorAction) {
  if ($InputObject.ProcessId -ne 4660 -or $MethodName -ne 'GetOwnerSid' -or $ErrorAction -ne 'Stop') { throw 'Unexpected SID query' }
  switch ($script:sidMode) {
    'notfound' { throw $script:missingSidError }
    'other-error' { throw $script:otherError }
    'return' { return @{ReturnValue=2;Sid=$null} }
    'valid' { return @{ReturnValue=0;Sid=$script:ownerSid} }
    'wrong-sid' { return @{ReturnValue=0;Sid='TEST unowned SID'} }
  }
  throw 'Unexpected SID case'
}
${windowsObserverReadOwnedSource}
$results=@(foreach ($mode in @('notfound','return','other-error')) {
  foreach ($presence in @('absent','live','reused','ambiguous','query-error')) {
    $script:sidMode=$mode;$script:presence=$presence;$script:queries.Clear();$errorText=$null;$owners=@()
    try { $owners=@(Read-Owned $ownedPath) } catch { $errorText=$_.Exception.Message }
    @{mode=$mode;presence=$presence;owners=$owners;error=$errorText;queries=@($script:queries.ToArray())}
  }
})
$script:sidMode='valid';$script:queries.Clear();$valid=@(Read-Owned $ownedPath);$validQueries=@($script:queries.ToArray())
$script:sidMode='wrong-sid';$sidError=$null
try { Read-Owned $ownedPath | Out-Null } catch { $sidError=$_.Exception.Message }
$script:sidMode='valid';$script:item.SessionId=-1;$sessionError=$null
try { Read-Owned $ownedPath | Out-Null } catch { $sessionError=$_.Exception.Message }
$script:item.ExecutablePath='C:\unowned\AgentTeamsAI.exe';$pathError=$null
try { Read-Owned $ownedPath | Out-Null } catch { $pathError=$_.Exception.Message }
ConvertTo-Json -InputObject @{results=$results;valid=$valid;validQueries=$validQueries;sidError=$sidError;sessionError=$sessionError;pathError=$pathError} -Depth 12 -Compress
`
      );
      const result = await promisify(execFile)(
        shell.executable,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { env: await windowsShellTestEnvironment(root, shell), timeout: 20_000, windowsHide: true }
      );
      const receipt = JSON.parse(result.stdout) as {
        results: {
          mode: string;
          presence: string;
          owners: unknown[];
          error: string | null;
          queries: string[];
        }[];
        valid: { pid: number; sid: string; session: number }[];
        validQueries: string[];
        sidError: string;
        sessionError: string;
        pathError: string;
      };
      assert.equal(receipt.results.length, 15);
      for (const observed of receipt.results) {
        assert.deepEqual(observed.owners, []);
        assert.deepEqual(
          observed.queries,
          observed.mode === 'other-error' ? [] : ['ProcessId = 4660']
        );
        if (observed.mode !== 'other-error' && observed.presence === 'absent') {
          assert.equal(observed.error, null);
        } else {
          assert(observed.error);
        }
      }
      const events = result.stderr
        .trim()
        .split(/\r?\n/u)
        .map(
          (line) =>
            JSON.parse(line) as {
              phase: string;
              pid: number;
              returnValue?: number;
              nativeErrorCode?: string;
              count?: number;
            }
        );
      assert.equal(events.length, 12);
      assert(events.every((event) => event.pid === 4660));
      assert.equal(
        events.filter(
          (event) => event.phase === 'owner-sid-failed' && event.nativeErrorCode === 'NotFound'
        ).length,
        5
      );
      assert.equal(
        events.filter((event) => event.phase === 'owner-sid-failed' && event.returnValue === 2)
          .length,
        5
      );
      assert.equal(
        events.filter((event) => event.phase === 'owner-exited-before-sid' && event.count === 0)
          .length,
        2
      );
      assert.equal(receipt.valid.length, 1);
      assert.equal(receipt.valid[0]?.pid, 4660);
      assert(receipt.valid[0]?.sid);
      assert.deepEqual(receipt.validQueries, []);
      assert.match(receipt.sidError, /TEST process owner\/session mismatch/u);
      assert.match(receipt.sessionError, /TEST process owner\/session mismatch/u);
      assert.match(receipt.pathError, /Unowned executable/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
