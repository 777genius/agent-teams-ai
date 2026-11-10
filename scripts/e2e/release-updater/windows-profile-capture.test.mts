import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { windowsProfileCaptureEnvironment } from './windows-powershell.mts';

void test('physical profile capture excludes TEST profile overrides while retaining shell write isolation', () => {
  const root = path.resolve('TEST-windows-profile-fixture');
  const inherited = {
    UserProfile: path.join(root, 'runner'),
    AppData: path.join(root, 'runner-roaming'),
    LocalAppData: path.join(root, 'runner-local'),
    UNRELATED_SECRET: 'must-not-be-inherited',
  };
  const isolated = {
    USERPROFILE: path.join(root, 'shell-home'),
    HOME: path.join(root, 'shell-home'),
    APPDATA: path.join(root, 'shell-roaming'),
    LOCALAPPDATA: path.join(root, 'shell-local'),
    TEMP: root,
    TMP: root,
    PSModuleAnalysisCachePath: path.join(root, 'shell-local', 'ModuleAnalysisCache'),
    PSModulePath: 'trusted-installed-modules',
    PATH: 'trusted-system32',
  };
  const captured = windowsProfileCaptureEnvironment(isolated, inherited);
  assert.equal(captured.USERPROFILE, inherited.UserProfile);
  assert.equal(captured.HOME, inherited.UserProfile);
  assert.equal(captured.APPDATA, inherited.AppData);
  assert.equal(captured.LOCALAPPDATA, inherited.LocalAppData);
  for (const key of ['TEMP', 'TMP', 'PSModuleAnalysisCachePath', 'PSModulePath', 'PATH'])
    assert.equal(captured[key], isolated[key as keyof typeof isolated]);
  assert.equal(captured.UNRELATED_SECRET, undefined);
  assert.equal(isolated.APPDATA, path.join(root, 'shell-roaming'));
});

void test('physical profile capture fails closed without absolute inherited roots', () => {
  const root = path.resolve('TEST-windows-profile-fixture');
  const valid = { USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root };
  for (const name of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA'])
    for (const value of [undefined, '', 'relative-profile'])
      assert.throws(() => windowsProfileCaptureEnvironment({}, { ...valid, [name]: value }));
});
