import assert from 'node:assert/strict';

import { isReviewedWindowsTargetVersion, isWindowsOtaMode } from './windowsReleaseScenario.ts';

interface Bytes {
  size: number;
  sha256: string;
  sha512: string;
}

export const ARM211_SHA = 'd7bbfe282cba0467f389b24ca3f0cc0404efbbd21c0ce0d09a0e0080c9abfc43';
export const DECODER_ARCHIVE_SHA =
  'ac3f38f96ce7498096a123bb0862dd6db863a7353c9e9e1c15f73c183adf6620';
export function usesRepairedArm211(architecture: string, mode: string, targetVersion: string) {
  return (
    architecture === 'arm64' &&
    (mode === 'predecessor' || isWindowsOtaMode(mode)) &&
    isReviewedWindowsTargetVersion(targetVersion)
  );
}
export const ARM211_FILES = [
  'AgentTeamsAI.exe',
  'd3dcompiler_47.dll',
  'dxcompiler.dll',
  'dxil.dll',
  'ffmpeg.dll',
  'libEGL.dll',
  'libGLESv2.dll',
  'resources/app.asar.unpacked/node_modules/node-pty/build/Release/winpty-agent.exe',
  'resources/app.asar.unpacked/node_modules/node-pty/build/Release/winpty.dll',
  'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-arm64/conpty/conpty.dll',
  'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-arm64/conpty/OpenConsole.exe',
  'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-arm64/winpty-agent.exe',
  'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-arm64/winpty.dll',
  'resources/app.asar.unpacked/node_modules/node-pty/third_party/conpty/1.23.251008001/win10-arm64/conpty.dll',
  'resources/app.asar.unpacked/node_modules/node-pty/third_party/conpty/1.23.251008001/win10-arm64/OpenConsole.exe',
  'resources/runtime/claude-multimodel.exe',
  'resources/terminal-platform/terminal-daemon.exe',
  'vk_swiftshader.dll',
  'vulkan-1.dll',
] as const;
export interface ArmPriorFixture {
  fixtureKind: 'repaired-original-arm64-211';
  originalPriorFreshInstallProved: false;
  actualNsisExitCode: number;
  source: Bytes;
  sourceApplicationSha: string;
  archive: Bytes;
  decoder: { archive: Bytes; executable: Bytes };
  preserved: Record<string, Bytes>;
  registry: {
    installLocation: string;
    uninstallString: string;
    quietUninstallString: string;
    version: string;
  };
  files: { name: string; source: Bytes; installed: Bytes; architecture: string }[];
}

export function assertArmPriorFixture(value: ArmPriorFixture) {
  assert.equal(value.fixtureKind, 'repaired-original-arm64-211');
  assert.equal(value.originalPriorFreshInstallProved, false);
  assert.equal(value.actualNsisExitCode, 0);
  assert.equal(value.source.sha256, ARM211_SHA);
  assert.equal(value.source.size, 196906862);
  assert.equal(value.sourceApplicationSha, '395572f9ff2a261cb28224754883a39d2c3c8827');
  assert.equal(value.decoder.archive.sha256, DECODER_ARCHIVE_SHA);
  assert.equal(value.decoder.archive.size, 491981);
  assert.deepEqual(
    value.files.map((file) => file.name).sort((a, b) => a.localeCompare(b)),
    [...ARM211_FILES].sort((a, b) => a.localeCompare(b))
  );
  for (const file of value.files) {
    assert.equal(file.architecture, 'arm64');
    assert.deepEqual(file.installed, file.source);
  }
  for (const bytes of [
    value.archive,
    value.decoder.executable,
    ...Object.values(value.preserved),
    ...value.files.map((file) => file.source),
  ]) {
    assert(/^[a-f\d]{64}$/u.test(bytes.sha256) && /^[A-Za-z\d+/]{86}==$/u.test(bytes.sha512));
    assert(Number.isSafeInteger(bytes.size) && bytes.size > 0);
  }
  assert.deepEqual(
    Object.keys(value.preserved).sort((a, b) => a.localeCompare(b)),
    [
      ...['resources/app.asar', 'resources/app-update.yml'],
      'cache/installer.exe',
      'Uninstall AgentTeamsAI.exe',
    ].sort((a, b) => a.localeCompare(b))
  );
  assert.equal(value.preserved['cache/installer.exe']?.sha256, ARM211_SHA);
}
