import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertCaptionProof, windowsCaptureRequest } from './windows-native.mts';
import {
  assertNativeNames,
  assertNativeRootFocus,
  assertOwnedUiaMetadata,
} from './windows-ota-observer.mts';

import { assertForegroundIdentity } from './windows-owned-uia-metadata.mts';

import type { CaptionProof } from './windows-native.mts';
import type { NativeNames, NativeRootFocus, OwnedUiaMetadata } from './windows-ota-observer.mts';

// These are consumer receipt boundaries, not simulated native focus/UI qualification.
const caption: CaptionProof = {
  pid: 41,
  thread: 52,
  hwnd: 'abc',
  pointRoot: 'abc',
  pointPid: 41,
  pointThread: 52,
  hitTest: 2,
  sent: 3,
  error: 0,
  originalTopmost: false,
  promoted: true,
  restored: true,
  restorationError: null,
  x: 100,
  y: 24,
  primaryWidth: 1920,
  primaryHeight: 1080,
  rect: [0, 0, 1024, 768],
  rectVerified: true,
  searchCandidates: 3,
  searchElapsedMs: 150,
};
const tree: NativeNames = {
  Names: ['Providers & plans', 'Tasks'],
  Error: null,
  HResult: 0,
  Visited: 3,
  RootChildren: 2,
  MaxDepth: 1,
  Characters: 22,
  ProcessIds: [41, 63],
  RootHwnd: 'abc',
  RootPid: 41,
  RootThread: 52,
};

void test('receipt policy permits the original fast path and scoped renderer process IDs', () => {
  assertCaptionProof(41, 'abc', null);
  assertCaptionProof(41, 'abc', caption);
  assertNativeNames(41, 'abc', tree);
});
for (const [name, change] of Object.entries({
  'foreign point root': { pointRoot: 'def' },
  'foreign point PID': { pointPid: 99 },
  'changed HWND': { hwnd: 'def' },
  'changed thread': { pointThread: 99 },
  'client area instead of caption': { hitTest: 1 },
  'partial input': { sent: 2 },
  'blocked input with unknown UIPI cause': { sent: 0, error: 5 },
  'unrestored topmost': { restored: false },
  'uncertain restoration': { restorationError: 'Owner changed' },
  'point outside primary screen': { x: 1920 },
  'point outside owned rectangle': { x: 1024 },
  'point outside bounded top strip': { y: 64 },
  'changed selected rectangle': { rectVerified: false },
  'excessive candidate count': { searchCandidates: 31 },
  'excessive total search duration': { searchElapsedMs: 2001 },
})) {
  void test(`caption receipt rejects ${name}`, () => {
    assert.throws(() => assertCaptionProof(41, 'abc', { ...caption, ...change }));
  });
}
for (const [name, change] of Object.entries({
  'partial labels after UIA error': { Error: 'Provider unavailable', HResult: -1 },
  'failed HRESULT': { HResult: -1 },
  'changed root PID': { RootPid: 99 },
  'changed root HWND': { RootHwnd: 'def' },
  'missing native thread': { RootThread: 0 },
  'excessive subtree': { Visited: 20_001 },
  'excessive depth': { MaxDepth: 65 },
  'excessive text': { Characters: 1_000_001 },
  'oversized name': { Names: ['x'.repeat(4097)] },
  'unknown process identity': { ProcessIds: [0] },
})) {
  void test(`UIA receipt rejects ${name}`, () => {
    assert.throws(() => assertNativeNames(41, 'abc', { ...tree, ...change }));
  });
}

const focusOwner = {
  pid: 41,
  parent: 3,
  executable: 'C:\\TEST-updater-windows-proof\\AgentTeamsAI.exe',
  start: '2026-10-07T12:23:14.7943200Z',
  sid: 'S-1-5-21-TEST',
  session: 2,
};
const cimTicks = '639269725947943200';
const heldOwner = {
  Pid: 41,
  Executable: focusOwner.executable,
  Sid: focusOwner.sid,
  Session: 2,
  BirthFileTime: '134358493947943207',
};
const focus: NativeRootFocus = {
  ...tree,
  Names: [],
  ProcessIds: [],
  Visited: 0,
  RootChildren: 0,
  MaxDepth: 0,
  Characters: 0,
  Focus: {
    Before: heldOwner,
    After: heldOwner,
    Focusable: true,
    Requested: true,
    Synchronized: true,
    SetFocusHResult: 0,
    CimTicks: cimTicks,
    ForegroundHwnd: 'abc',
    ComparisonResolution100nsTicks: 10,
  },
};
const unclicked = { ...caption, sent: 0 };
void test('root capability false still requires actual focus, foreground and synchronization receipts', () => {
  const observed = { ...focus, Focus: { ...focus.Focus, Focusable: false } };
  assertNativeRootFocus(focusOwner, 'abc', unclicked, observed);
  for (const change of [
    { Requested: false },
    { SetFocusHResult: null },
    { SetFocusHResult: -1 },
    { SetFocusHResult: 1 },
    { ForegroundHwnd: 'def' },
    { Synchronized: false },
    { After: { ...heldOwner, BirthFileTime: '134358493947943208' } },
  ])
    assert.throws(() =>
      assertNativeRootFocus(focusOwner, 'abc', unclicked, {
        ...observed,
        Focus: { ...observed.Focus, ...change },
      })
    );
});
void test('root-focus receipt requires exact held birth after documented CIM microsecond bootstrap', () => {
  assertNativeRootFocus(focusOwner, 'abc', unclicked, focus);
  for (const change of [
    { BirthFileTime: '134358493947943210' },
    { Pid: 99 },
    { Sid: 'S-1-5-21-FOREIGN' },
    { Session: 1 },
    { Executable: 'C:\\Other.exe' },
  ])
    assert.throws(() =>
      assertNativeRootFocus(focusOwner, 'abc', unclicked, {
        ...focus,
        Focus: {
          ...focus.Focus,
          Before: { ...heldOwner, ...change },
          After: { ...heldOwner, ...change },
        },
      })
    );
  assert.throws(() =>
    assertNativeRootFocus(focusOwner, 'abc', unclicked, {
      ...focus,
      Focus: { ...focus.Focus, After: { ...heldOwner, BirthFileTime: '134358493947943208' } },
    })
  );
});
for (const [name, change] of Object.entries({
  'S_OK but foreign foreground': { ForegroundHwnd: 'def' },
  'non-boolean capability observation': { Focusable: null as unknown as boolean },
  'no actual request': { Requested: false },
  'failed HRESULT': { SetFocusHResult: -1 },
  'no returned HRESULT': { SetFocusHResult: null },
  'no owned WM_NULL synchronization': { Synchronized: false },
  'broad birth tolerance': { ComparisonResolution100nsTicks: 10000 },
  'different original CIM birth': { CimTicks: '639269725947943210' },
}))
  void test(`root-focus receipt rejects ${name}`, () =>
    assert.throws(() =>
      assertNativeRootFocus(focusOwner, 'abc', unclicked, {
        ...focus,
        Focus: { ...focus.Focus, ...change },
      })
    ));
void test('root-focus cannot accept partial input, unrestored state, foreign root, thread or traversal', () => {
  for (const change of [
    { sent: 1 },
    { restored: false },
    { restorationError: 'Owner changed' },
    { error: 5 },
    { thread: 99 },
  ])
    assert.throws(() =>
      assertNativeRootFocus(focusOwner, 'abc', { ...unclicked, ...change }, focus)
    );
  for (const change of [
    { RootPid: 99 },
    { RootHwnd: 'def' },
    { RootThread: 0 },
    { Visited: 1 },
    { Names: ['foreign'] },
    { Error: 'UIA failed', HResult: -1 },
  ])
    assert.throws(() =>
      assertNativeRootFocus(focusOwner, 'abc', unclicked, { ...focus, ...change })
    );
});

const metadata: OwnedUiaMetadata = {
  RootHwnd: 'abc',
  RootPid: 41,
  RootThread: 52,
  Before: { ...heldOwner },
  After: { ...heldOwner },
  CimTicks: cimTicks,
  Requested: false,
  InputSent: 0,
  Complete: true,
  StopReason: null,
  Error: null,
  ElapsedMs: 150,
  Owners: [
    {
      Index: 0,
      ParentPid: focusOwner.parent,
      CimTicks: cimTicks,
      Before: { ...heldOwner },
      After: { ...heldOwner },
    },
  ],
  Foreground: {
    Hwnd: 'def',
    AfterHwnd: 'def',
    Pid: 99,
    AfterPid: 99,
    Thread: 100,
    AfterThread: 100,
    Before: { ...heldOwner, Pid: 99, Executable: 'C:\\Windows\\ShellOverlay.exe' },
    After: { ...heldOwner, Pid: 99, Executable: 'C:\\Windows\\ShellOverlay.exe' },
    PackageBefore: null,
    PackageAfter: null,
    PackageBeforeStatus: 15700,
    PackageAfterStatus: 15700,
    Error: null,
  },
  Nodes: [
    {
      Index: 0,
      ParentIndex: -1,
      Depth: 0,
      Pid: 41,
      OwnerIndex: 0,
      Hwnd: 'abc',
      NativePid: 41,
      RootAncestor: 'abc',
      Enabled: true,
      Focusable: false,
      Boundary: false,
    },
    {
      Index: 1,
      ParentIndex: 0,
      Depth: 1,
      Pid: 41,
      OwnerIndex: 0,
      Hwnd: '0',
      NativePid: 0,
      RootAncestor: null,
      Enabled: true,
      Focusable: true,
      Boundary: false,
    },
  ],
};
void test('metadata receipt permits root-anchored zero-HWND descendants without authorizing input', () => {
  assertOwnedUiaMetadata(
    focusOwner,
    'abc',
    52,
    JSON.parse(JSON.stringify(metadata)) as OwnedUiaMetadata
  );
  assertOwnedUiaMetadata(focusOwner, 'abc', 52, {
    ...metadata,
    Complete: false,
    StopReason: 'time-limit',
    ElapsedMs: 3001,
  });
});
function metadataNode(receipt: OwnedUiaMetadata, index = 1) {
  const node = receipt.Nodes.at(index);
  assert(node);
  return node;
}
const invalidMetadata: [string, (receipt: OwnedUiaMetadata) => void][] = [
  [
    'non-Boolean boundary',
    (r) => {
      metadataNode(r).Boundary = null as unknown as boolean;
    },
  ],
  [
    'changed held birth',
    (r) => {
      r.After.BirthFileTime = '134358493947943208';
    },
  ],
  [
    'foreign root',
    (r) => {
      r.RootPid = 99;
    },
  ],
  [
    'foreign descendant',
    (r) => {
      metadataNode(r).Pid = 99;
    },
  ],
  [
    'unanchored descendant',
    (r) => {
      metadataNode(r).ParentIndex = -1;
    },
  ],
  [
    'cyclic parent',
    (r) => {
      metadataNode(r).ParentIndex = 1;
    },
  ],
  [
    'foreign HWND ancestor',
    (r) => {
      metadataNode(r).Hwnd = 'def';
      metadataNode(r).NativePid = 41;
      metadataNode(r).RootAncestor = 'def';
    },
  ],
  [
    'foreign native PID',
    (r) => {
      metadataNode(r, 0).NativePid = 99;
    },
  ],
  [
    'depth overflow',
    (r) => {
      metadataNode(r).Depth = 17;
    },
  ],
  [
    'deadline disguised as complete',
    (r) => {
      r.ElapsedMs = 3001;
    },
  ],
  [
    'truncation disguised as complete',
    (r) => {
      r.StopReason = 'time-limit';
      r.ElapsedMs = 3001;
    },
  ],
  [
    'false node-limit claim',
    (r) => {
      r.StopReason = 'node-limit';
      r.Complete = false;
    },
  ],
  [
    'partial observation',
    (r) => {
      r.Error = 'Provider failed';
    },
  ],
  [
    'actual focus request',
    (r) => {
      r.Requested = true as unknown as false;
    },
  ],
  [
    'actual input',
    (r) => {
      r.InputSent = 1 as unknown as 0;
    },
  ],
];
for (const [name, change] of invalidMetadata)
  void test(`read-only metadata receipt rejects ${name}`, () => {
    const receipt = structuredClone(metadata);
    change(receipt);
    assert.throws(() => assertOwnedUiaMetadata(focusOwner, 'abc', 52, receipt));
  });
void test('foreign boundary receipt records only PID and never admits traversal beyond it', () => {
  const receipt = structuredClone(metadata);
  receipt.Complete = false;
  receipt.StopReason = 'foreign-boundary';
  Object.assign(metadataNode(receipt), {
    Pid: 99,
    Boundary: true,
    OwnerIndex: -1,
    Hwnd: null,
    RootAncestor: null,
    NativePid: 0,
    Enabled: null,
    Focusable: null,
  });
  assertOwnedUiaMetadata(focusOwner, 'abc', 52, receipt);
  metadataNode(receipt).Focusable = true;
  assert.throws(() => assertOwnedUiaMetadata(focusOwner, 'abc', 52, receipt));
});
void test('capture request serialization requires exact diagnostic opt-in and preserves owned identity', () => {
  const owner = { ...focusOwner, command: 'TEST-owned-capture' };
  for (const flag of [undefined, '0', 'true', '1']) {
    const encoded = JSON.parse(
      JSON.stringify(windowsCaptureRequest(owner, 'TEST.png', flag))
    ) as ReturnType<typeof windowsCaptureRequest>;
    const { screenshot, diagnosticOnly, ...roundtripOwner } = encoded;
    assert.deepEqual(roundtripOwner, owner);
    assert.equal(screenshot, 'TEST.png');
    assert.equal(typeof diagnosticOnly, 'boolean');
    assert.equal(diagnosticOnly, flag === '1');
  }
});

function directChildReceipt() {
  const receipt = structuredClone(metadata);
  const child = {
    ...heldOwner,
    Pid: 63,
    BirthFileTime: (BigInt(heldOwner.BirthFileTime) + 100000n).toString(),
  };
  receipt.Owners.push({
    Index: 1,
    ParentPid: 41,
    CimTicks: (BigInt(cimTicks) + 100000n).toString(),
    Before: { ...child },
    After: { ...child },
  });
  Object.assign(metadataNode(receipt), { Pid: 63, OwnerIndex: 1 });
  return receipt;
}
void test('metadata permits only pinned direct child identity and root-anchored HWNDs', () => {
  const receipt = directChildReceipt();
  assertOwnedUiaMetadata(focusOwner, 'abc', 52, receipt);
  Object.assign(metadataNode(receipt), { Hwnd: '123', NativePid: 63, RootAncestor: 'abc' });
  assertOwnedUiaMetadata(focusOwner, 'abc', 52, receipt);
  metadataNode(receipt).NativePid = 999;
  assert.throws(() => assertOwnedUiaMetadata(focusOwner, 'abc', 52, receipt));
});
function metadataOwner(receipt: OwnedUiaMetadata, index = 1) {
  const owner = receipt.Owners.at(index);
  assert(owner);
  return owner;
}
const invalidChild: [string, (receipt: OwnedUiaMetadata) => void][] = [
  [
    'reused child birth',
    (r) => {
      metadataOwner(r).After.BirthFileTime = '134358493948043208';
    },
  ],
  [
    'non-direct parent',
    (r) => {
      metadataOwner(r).ParentPid = 63;
    },
  ],
  [
    'foreign path',
    (r) => {
      metadataOwner(r).Before.Executable = 'C:\\Other.exe';
      metadataOwner(r).After.Executable = 'C:\\Other.exe';
    },
  ],
  [
    'foreign SID',
    (r) => {
      metadataOwner(r).Before.Sid = 'S-FOREIGN';
      metadataOwner(r).After.Sid = 'S-FOREIGN';
    },
  ],
  [
    'foreign session',
    (r) => {
      metadataOwner(r).Before.Session = 3;
      metadataOwner(r).After.Session = 3;
    },
  ],
  [
    'CIM birth mismatch',
    (r) => {
      metadataOwner(r).CimTicks = (BigInt(cimTicks) + 100010n).toString();
    },
  ],
  [
    'child older than root',
    (r) => {
      metadataOwner(r).Before.BirthFileTime = '134358493947843207';
      metadataOwner(r).After.BirthFileTime = '134358493947843207';
    },
  ],
  [
    'duplicate PID adoption',
    (r) => {
      metadataOwner(r).Before.Pid = 41;
      metadataOwner(r).After.Pid = 41;
    },
  ],
  [
    'unmapped child owner index',
    (r) => {
      metadataNode(r).OwnerIndex = 7;
    },
  ],
  [
    'root parent changed',
    (r) => {
      metadataOwner(r, 0).ParentPid = 99;
    },
  ],
];
for (const [name, change] of invalidChild)
  void test(`pinned metadata rejects ${name}`, () => {
    const receipt = directChildReceipt();
    change(receipt);
    assert.throws(() => assertOwnedUiaMetadata(focusOwner, 'abc', 52, receipt));
  });
void test('foreground identity permits explicit no-package and stable packaged processes', () => {
  assertForegroundIdentity(metadata.Foreground);
  assertForegroundIdentity({
    ...metadata.Foreground,
    PackageBefore: 'Test_1.0_arm64__family',
    PackageAfter: 'Test_1.0_arm64__family',
    PackageBeforeStatus: 0,
    PackageAfterStatus: 0,
  });
});
const foregroundHeld = metadata.Foreground.After;
assert(foregroundHeld);
const invalidForeground = [
  { Error: 'Access denied', Before: null, After: null },
  { AfterHwnd: '123' },
  { AfterPid: 100 },
  { AfterThread: 101 },
  { After: { ...foregroundHeld, BirthFileTime: '134358493947943208' } },
  { After: { ...foregroundHeld, Executable: 'C:\\Other.exe' } },
  { PackageAfterStatus: 5 },
  { PackageBeforeStatus: 5, PackageAfterStatus: 5 },
  { PackageAfter: 'unexpected-package' },
];
for (const [index, change] of invalidForeground.entries())
  void test(`foreground receipt rejects unstable/unknown identity ${index}`, () => {
    assert.throws(() => assertForegroundIdentity({ ...metadata.Foreground, ...change }));
  });

void test('direct process inventory accepts eight held identities but rejects a ninth', () => {
  const receipt = directChildReceipt();
  for (let index = 2; index <= 7; index++) {
    const proof = structuredClone(metadataOwner(receipt));
    proof.Index = index;
    proof.Before.Pid = 62 + index;
    proof.After.Pid = 62 + index;
    receipt.Owners.push(proof);
  }
  assertOwnedUiaMetadata(focusOwner, 'abc', 52, receipt);
  const ninth = structuredClone(metadataOwner(receipt));
  ninth.Index = 8;
  ninth.Before.Pid = 70;
  ninth.After.Pid = 70;
  receipt.Owners.push(ninth);
  assert.throws(() => assertOwnedUiaMetadata(focusOwner, 'abc', 52, receipt));
});
