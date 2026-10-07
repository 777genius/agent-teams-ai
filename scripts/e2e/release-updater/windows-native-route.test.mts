import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertCaptionProof } from './windows-native.mts';
import { assertNativeNames } from './windows-ota-observer.mts';

import type { CaptionProof } from './windows-native.mts';
import type { NativeNames } from './windows-ota-observer.mts';

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
