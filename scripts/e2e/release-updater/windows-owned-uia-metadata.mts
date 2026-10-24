import assert from 'node:assert/strict';

import type { WindowsProcess } from './windows-native.mts';

export interface HeldFocusOwner {
  Pid: number;
  Executable: string;
  Sid: string;
  Session: number;
  BirthFileTime: string;
}
export interface OwnedUiaMetadata {
  RootHwnd: string;
  RootPid: number;
  RootThread: number;
  Before: HeldFocusOwner;
  After: HeldFocusOwner;
  CimTicks: string;
  Requested: false;
  InputSent: 0;
  Complete: boolean;
  StopReason: 'node-limit' | 'depth-limit' | 'time-limit' | 'foreign-boundary' | null;
  Error: string | null;
  ElapsedMs: number;
  Owners: {
    Index: number;
    ParentPid: number;
    CimTicks: string;
    Before: HeldFocusOwner;
    After: HeldFocusOwner;
  }[];
  Foreground: ForegroundIdentity;
  Nodes: {
    Index: number;
    ParentIndex: number;
    Depth: number;
    Pid: number;
    OwnerIndex: number;
    Hwnd: string | null;
    NativePid: number;
    RootAncestor: string | null;
    Enabled: boolean | null;
    Focusable: boolean | null;
    Boundary: boolean;
  }[];
}
export function assertOwnedUiaMetadata(
  owner: Omit<WindowsProcess, 'command'>,
  hwnd: string,
  thread: number,
  receipt: OwnedUiaMetadata
) {
  assert.equal(receipt.Error, null);
  assert.equal(receipt.RootPid, owner.pid);
  assert.equal(receipt.RootHwnd, hwnd);
  assert.equal(receipt.RootThread, thread);
  assert(Number.isInteger(thread) && thread > 0);
  assert.equal(receipt.Requested, false);
  assert.equal(receipt.InputSent, 0);
  assert.deepEqual(receipt.Before, receipt.After);
  assertPinnedOwners(receipt, owner);
  assert.equal(receipt.Before.Pid, owner.pid);
  assert.equal(receipt.Before.Executable.toLowerCase(), owner.executable.toLowerCase());
  assert.equal(receipt.Before.Sid, owner.sid);
  assert.equal(receipt.Before.Session, owner.session);
  const ticks = ownerCimTicks(owner.start);
  assert.equal(receipt.CimTicks, ticks.toString());
  assert.equal(receipt.Owners[0]?.CimTicks, receipt.CimTicks);
  assert(/^\d+$/.test(receipt.Before.BirthFileTime));
  assert.equal(
    BigInt(receipt.Before.BirthFileTime) / 10n,
    (ticks - 504_911_232_000_000_000n) / 10n
  );
  assert(
    ['node-limit', 'depth-limit', 'time-limit', 'foreign-boundary', null].includes(
      receipt.StopReason
    )
  );
  assert.equal(receipt.Complete, receipt.StopReason === null);
  assert(
    Number.isInteger(receipt.ElapsedMs) && receipt.ElapsedMs >= 0 && receipt.ElapsedMs < 15_000
  );
  assert(receipt.StopReason === 'time-limit' || receipt.ElapsedMs <= 3000);
  assert(receipt.Nodes.length > 0 && receipt.Nodes.length <= 128);
  if (receipt.StopReason === 'node-limit') assert.equal(receipt.Nodes.length, 128);
  if (receipt.StopReason === 'depth-limit') assert(receipt.Nodes.some((node) => node.Depth === 16));
  if (receipt.StopReason === 'time-limit') assert(receipt.ElapsedMs >= 3000);
  receipt.Nodes.forEach((node, index) => assertMetadataNode(receipt, node, index));
}
function assertPinnedOwners(receipt: OwnedUiaMetadata, owner: Omit<WindowsProcess, 'command'>) {
  assert(receipt.Owners.length >= 1 && receipt.Owners.length <= 8);
  assert.deepEqual(receipt.Owners[0]?.Before, receipt.Before);
  const knownPids = new Set<number>();
  for (const [index, pin] of receipt.Owners.entries()) {
    assert.equal(pin.Index, index);
    assert(!knownPids.has(pin.Before.Pid));
    knownPids.add(pin.Before.Pid);
    assert.deepEqual(pin.Before, pin.After);
    assert.equal(pin.ParentPid, index === 0 ? owner.parent : owner.pid);
    assert.equal(pin.Before.Executable.toLowerCase(), owner.executable.toLowerCase());
    assert.equal(pin.Before.Sid, owner.sid);
    assert.equal(pin.Before.Session, owner.session);
    assert(/^\d+$/.test(pin.CimTicks) && /^\d+$/.test(pin.Before.BirthFileTime));
    assert(BigInt(pin.Before.BirthFileTime) >= BigInt(receipt.Before.BirthFileTime));
    assert.equal(
      BigInt(pin.Before.BirthFileTime) / 10n,
      (BigInt(pin.CimTicks) - 504_911_232_000_000_000n) / 10n
    );
  }
}
function assertMetadataNode(
  receipt: OwnedUiaMetadata,
  node: OwnedUiaMetadata['Nodes'][number],
  index: number
) {
  assert.equal(node.Index, index);
  assert.equal(typeof node.Boundary, 'boolean');
  assert(Number.isInteger(node.Pid) && node.Pid > 0);
  assert(Number.isInteger(node.Depth) && node.Depth >= 0 && node.Depth <= 16);
  if (index === 0) {
    assert.equal(node.ParentIndex, -1);
    assert.equal(node.Depth, 0);
    assert.equal(node.Hwnd, receipt.RootHwnd);
  } else {
    assert(Number.isInteger(node.ParentIndex) && node.ParentIndex >= 0 && node.ParentIndex < index);
    const parent = receipt.Nodes[node.ParentIndex];
    assert(parent);
    assert.equal(parent.Boundary, false);
    assert(receipt.Owners.some((pin) => pin.Before.Pid === parent.Pid));
    assert.equal(node.Depth, parent.Depth + 1);
  }
  if (node.Boundary) {
    assert(!receipt.Owners.some((pin) => pin.Before.Pid === node.Pid));
    assert.equal(node.OwnerIndex, -1);
    assert.equal(node.Hwnd, null);
    assert.equal(node.RootAncestor, null);
    assert.equal(node.NativePid, 0);
    assert.equal(node.Enabled, null);
    assert.equal(node.Focusable, null);
    assert.equal(receipt.StopReason, 'foreign-boundary');
    assert.equal(index, receipt.Nodes.length - 1);
  } else {
    assert(Number.isInteger(node.OwnerIndex) && node.OwnerIndex >= 0);
    assert.equal(receipt.Owners[node.OwnerIndex]?.Before.Pid, node.Pid);
    assert.equal(typeof node.Enabled, 'boolean');
    assert.equal(typeof node.Focusable, 'boolean');
    assert(/^[a-f0-9]+$/.test(node.Hwnd ?? ''));
    assert(
      node.Hwnd === '0'
        ? node.NativePid === 0
        : receipt.Owners.some((pin) => pin.Before.Pid === node.NativePid)
    );
    assert.equal(node.RootAncestor, node.Hwnd === '0' ? null : receipt.RootHwnd);
  }
}
export interface ForegroundIdentity {
  Hwnd: string;
  AfterHwnd: string;
  Pid: number;
  AfterPid: number;
  Thread: number;
  AfterThread: number;
  Before: HeldFocusOwner | null;
  After: HeldFocusOwner | null;
  PackageBefore: string | null;
  PackageAfter: string | null;
  PackageBeforeStatus: number;
  PackageAfterStatus: number;
  Error: string | null;
}
export function assertForegroundIdentity(receipt: ForegroundIdentity) {
  assert.equal(receipt.Error, null);
  assert(receipt.Before && receipt.After);
  assert.deepEqual(receipt.Before, receipt.After);
  assert(Number.isInteger(receipt.Pid) && receipt.Pid > 0);
  assert(Number.isInteger(receipt.Thread) && receipt.Thread > 0);
  assert.equal(receipt.Before.Pid, receipt.Pid);
  assert.equal(receipt.Pid, receipt.AfterPid);
  assert.equal(receipt.Thread, receipt.AfterThread);
  assert(/^[a-f0-9]{1,16}$/.test(receipt.Hwnd) && receipt.Hwnd !== '0');
  assert.equal(receipt.Hwnd, receipt.AfterHwnd);
  assert(/^\d+$/.test(receipt.Before.BirthFileTime));
  assert(
    receipt.Before.Executable.length > 0 &&
      receipt.Before.Sid.length > 0 &&
      receipt.Before.Session >= 0
  );
  assert.equal(receipt.PackageBefore, receipt.PackageAfter);
  assert.equal(receipt.PackageBeforeStatus, receipt.PackageAfterStatus);
  assert([0, 15700].includes(receipt.PackageBeforeStatus));
  if (receipt.PackageBeforeStatus === 15700) assert.equal(receipt.PackageBefore, null);
  else assert(receipt.PackageBefore && receipt.PackageBefore.length <= 1024);
}
export function ownerCimTicks(start: string) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z$/.exec(start);
  assert(match, 'Owned creation must be explicit UTC');
  const seconds = Date.parse(`${match[1]}Z`);
  assert(Number.isFinite(seconds));
  return (
    BigInt(seconds) * 10_000n + BigInt((match[2] ?? '').padEnd(7, '0')) + 621_355_968_000_000_000n
  );
}

export const windowsMetadataInventorySource = String.raw`
function Get-MetadataOwners {
  $items=@(Read-Owned $data.executable)
  $owner=@($items | Where-Object { $_.pid -eq $data.pid -and (Test-SameStart $_.start $data.start) -and $_.sid -eq $data.sid -and $_.session -eq $data.session })
  if ($owner.Count -ne 1) { throw 'Metadata root identity changed' }
  $selected=@($owner[0])+@($items | Where-Object { $_.parent -eq $data.pid })
  if ($selected.Count -gt 8) { throw 'Metadata direct process bound exceeded' }
  $requests=[TestOtaObserver+FocusRequest[]]@($selected | ForEach-Object {
    $request=[TestOtaObserver+FocusRequest]::new()
    $request.Pid=$_.pid; $request.ParentPid=$_.parent; $request.Executable=$_.executable
    $request.Sid=$_.sid; $request.Session=$_.session; $request.CimTicks=Get-StartUtcTicks $_.start
    $request
  })
  return ,$requests
}
`;
