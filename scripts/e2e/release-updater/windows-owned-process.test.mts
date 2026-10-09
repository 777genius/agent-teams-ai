import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { windowsReadOwnedSource } from './windows-owned-process.mts';
import { selectedWindowsPowerShell, windowsShellTestEnvironment } from './windows-powershell.mts';

// Executes the actual embedded native.ps1 function with controlled CIM races.
// Red if a nonzero SID return rejects a proven exited PID, or adopts a live PID.
void test(
  'selected PS7 owner SID failure requires independently absent PID and retains return code',
  { skip: process.platform !== 'win32' ? 'Requires selected installed PS7 on Windows VM' : false },
  async () => {
    const shell = await selectedWindowsPowerShell();
    const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-updater-windows-sid-'));
    try {
      const script = path.join(root, 'sid-contract.ps1');
      await writeFile(
        script,
        String.raw`
$ErrorActionPreference='Stop'
Import-Module CimCmdlets -ErrorAction Stop
$script:events=[Collections.Generic.List[object]]::new()
$script:queries=[Collections.Generic.List[string]]::new()
$ownedPath='C:\TEST-updater-windows-owned\install\AgentTeamsAI.exe'
$script:item=@{ ProcessId=4660; ParentProcessId=5564; ExecutablePath=$ownedPath; CommandLine='TEST owned'; CreationDate=[DateTime]::UtcNow; SessionId=2 }
function Test-OwnedPath([string]$file) { if ($file -ne $ownedPath) { throw 'Unexpected path' }; return $file }
function Write-TestProgress([string]$phase,[hashtable]$details=$null) { $script:events.Add(@{phase=$phase;details=$details}) }
function Get-CimInstance([string]$ClassName,[string]$Filter,[string]$ErrorAction) {
  if ($ClassName -ne 'Win32_Process' -or $ErrorAction -ne 'Stop') { throw 'Unexpected process query' }
  if (-not $Filter) { return $script:item }
  $script:queries.Add($Filter)
  if ($Filter -ne 'ProcessId = 4660') { throw 'Query must inspect the exact PID independently' }
  switch ($script:presence) {
    'absent' { return }
    'live' { return $script:item }
    'reused' { return @{ ProcessId=4660; ExecutablePath='C:\unowned\other.exe'; CreationDate=[DateTime]::UtcNow } }
    'ambiguous' { return @($script:item,$script:item) }
    'query-error' { throw 'TEST independent query failed' }
  }
  throw 'Unexpected presence case'
}
function Invoke-CimMethod($InputObject,[string]$MethodName,[string]$ErrorAction) {
  if ($InputObject.ProcessId -ne 4660 -or $MethodName -ne 'GetOwnerSid' -or $ErrorAction -ne 'Stop') { throw 'Unexpected SID query' }
  return @{ReturnValue=$script:returnCode;Sid=$script:sid}
}
${windowsReadOwnedSource}
$results=@(foreach ($presence in @('absent','live','reused','ambiguous','query-error')) {
  $script:presence=$presence; $script:returnCode=2; $script:sid=$null
  $script:events.Clear();$script:queries.Clear();$errorText=$null;$owners=@()
  try { $owners=@(Read-Owned $ownedPath) } catch { $errorText=$_.Exception.Message }
  @{presence=$presence;owners=$owners;error=$errorText;events=@($script:events.ToArray());queries=@($script:queries.ToArray())}
})
$script:returnCode=0;$script:sid='TEST-owner-SID';$script:presence='query-error';$script:queries.Clear()
$valid=@(Read-Owned $ownedPath)
$validQueries=@($script:queries.ToArray())
$script:sid=$null;$missingError=$null
try { Read-Owned $ownedPath | Out-Null } catch { $missingError=$_.Exception.Message }
ConvertTo-Json -InputObject @{results=$results;valid=$valid;validQueries=$validQueries;missingError=$missingError} -Depth 12 -Compress
`
      );
      const result = await promisify(execFile)(
        shell.executable,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { env: await windowsShellTestEnvironment(root, shell), timeout: 20_000, windowsHide: true }
      );
      assert.equal(result.stderr, '');
      const receipt = JSON.parse(result.stdout) as {
        results: {
          presence: string;
          owners: unknown[];
          error: string | null;
          events: {
            phase: string;
            details: { pid: number; returnValue?: number; count?: number };
          }[];
          queries: string[];
        }[];
        valid: { pid: number; sid: string }[];
        validQueries: string[];
        missingError: string;
      };
      assert.equal(receipt.results.length, 5);
      for (const observed of receipt.results) {
        assert.deepEqual(observed.queries, ['ProcessId = 4660']);
        assert.equal(observed.events[0]?.phase, 'owner-sid-failed');
        assert.equal(observed.events[0]?.details.pid, 4660);
        assert.equal(observed.events[0]?.details.returnValue, 2);
        assert.deepEqual(observed.owners, []);
        if (observed.presence === 'absent') {
          assert.equal(observed.error, null);
          assert.equal(observed.events.at(-1)?.phase, 'owner-exited-before-sid-4660');
          assert.equal(observed.events[1]?.details.count, 0);
        } else {
          assert(observed.error);
          assert(!observed.events.some((event) => event.phase === 'owner-exited-before-sid-4660'));
        }
      }
      assert.equal(receipt.valid.length, 1);
      assert.equal(receipt.valid[0]?.pid, 4660);
      assert.equal(receipt.valid[0]?.sid, 'TEST-owner-SID');
      assert.deepEqual(receipt.validQueries, []);
      assert.match(receipt.missingError, /Missing TEST process owner SID/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
