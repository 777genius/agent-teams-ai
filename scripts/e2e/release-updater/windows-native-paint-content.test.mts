import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { windowsNativePaintContentReady } from './windows-native-paint-content.mts';
import { assertNativeNames, type NativeNames } from './windows-ota-observer.mts';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/windows-caption-ready-2.17.1.json', import.meta.url), 'utf8')
) as { names: string[] };
const ready = windowsNativePaintContentReady;

await test('actual W8 predecessor Settings is ready before downloading the update', () => {
  assert.equal(ready('caption-ready', fixture.names, '2.17.6'), true);
  assert.equal(ready('caption-ready', fixture.names, '2.17.7'), true);
  assert.equal(ready('available', fixture.names, '2.17.6'), false);
  assert.equal(ready('fresh', fixture.names, '2.17.6'), false);
  assert.equal(ready('automatic-successor', fixture.names, '2.17.6'), false);
});

await test('caption readiness requires each predecessor Settings marker and exact installed version', () => {
  for (const marker of [
    'Settings',
    'Manage your app preferences',
    'CLI RUNTIME',
    'Tasks',
    'Version 2.17.1',
  ]) {
    assert.equal(
      ready(
        'caption-ready',
        fixture.names.filter((name) => name !== marker),
        '2.17.6'
      ),
      false
    );
  }
  assert.equal(ready('caption-ready', [...fixture.names, 'Version 2.17.6'], '2.17.6'), false);
  assert.equal(
    ready(
      'caption-ready',
      fixture.names.map((name) => (name === 'Version 2.17.1' ? 'Version 2.17.7' : name)),
      '2.17.7'
    ),
    false
  );
  assert.equal(ready('caption-ready', [...fixture.names, 'Preparing workspace'], '2.17.6'), false);
});

await test('available still requires Download and the requested target version', () => {
  assert.equal(ready('available', [...fixture.names, 'Download'], '2.17.6'), true);
  assert.equal(ready('available', [...fixture.names, 'Download'], '2.17.7'), false);
  assert.equal(ready('available', ['Version 2.17.6'], '2.17.6'), false);
  assert.equal(ready('available', ['Download', '2.17.6', 'Preparing workspace'], '2.17.6'), false);
});

await test('fresh and automatic successor keep their new Settings content requirement', () => {
  for (const phase of ['fresh', 'automatic-successor'] as const) {
    assert.equal(ready(phase, ['Providers & plans', 'Tasks'], '2.17.6'), true);
    assert.equal(ready(phase, ['Providers & plans'], '2.17.6'), false);
    assert.equal(ready(phase, ['Tasks'], '2.17.6'), false);
    assert.equal(
      ready(phase, ['Providers & plans', 'Tasks', 'Preparing workspace'], '2.17.6'),
      false
    );
  }
  assert.equal(
    ready('caption-ready', ['Providers & plans', 'Tasks', 'Version 2.17.6'], '2.17.6'),
    false
  );
});

await test('ready content does not admit a foreign UIA root through the existing ownership guard', () => {
  const observation: NativeNames = {
    Names: fixture.names,
    Error: null,
    HResult: 0,
    RootPid: 8824,
    RootHwnd: '3005e',
    RootThread: 7004,
    Visited: 116,
    RootChildren: 2,
    MaxDepth: 19,
    Characters: 1117,
    ProcessIds: [8824, 5604],
  };
  assert.equal(ready('caption-ready', observation.Names, '2.17.6'), true);
  assert.doesNotThrow(() => assertNativeNames(8824, '3005e', observation));
  assert.throws(() => assertNativeNames(9999, '3005e', observation));
  assert.throws(() => assertNativeNames(8824, 'foreign-hwnd', observation));
});
