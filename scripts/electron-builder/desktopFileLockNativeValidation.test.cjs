const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { validateDesktopFileLockNative } = require('./afterPack.cjs')._internal;
const { buildFileLockNativeRebuildPlan } = require('./dist-invocations.cjs');
const bundleVerifier = import('../ci/verify-desktop-file-lock-main-bundle.mjs');

function makeElf(arch) {
  const buffer = Buffer.alloc(64);
  buffer.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  buffer.writeUInt16LE(arch === 'arm64' ? 0xb7 : 0x3e, 18);
  return buffer;
}

function makePe(arch) {
  const buffer = Buffer.alloc(128);
  buffer.set([0x4d, 0x5a]);
  buffer.writeUInt32LE(64, 0x3c);
  buffer.set([0x50, 0x45, 0, 0], 64);
  buffer.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 68);
  return buffer;
}

function makeMachO(arch) {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  return buffer;
}

function binaryFor(platform, arch) {
  if (platform === 'linux') return makeElf(arch);
  if (platform === 'win32') return makePe(arch);
  return makeMachO(arch);
}

function writeAddon(root, relativeRoot, platform, arch, name = 'desktop_file_lock_native.node') {
  const addonPath = path.join(
    root,
    relativeRoot,
    'node_modules',
    '@agent-teams',
    'desktop-file-lock-native',
    'build',
    'Release',
    name
  );
  fs.mkdirSync(path.dirname(addonPath), { recursive: true });
  fs.writeFileSync(addonPath, binaryFor(platform, arch));
  return addonPath;
}

test('accepts exactly one architecture-correct addon under asarUnpack', async (t) => {
  for (const [platform, arch] of [
    ['linux', 'x64'],
    ['darwin', 'arm64'],
    ['win32', 'arm64'],
  ]) {
    await t.test(`${platform}-${arch}`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-bundle-test-'));
      try {
        writeAddon(root, 'resources/app.asar.unpacked', platform, arch);
        const found = await validateDesktopFileLockNative(root, platform, arch);
        assert.match(found, /app\.asar\.unpacked/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('rejects missing, duplicate, packed, and wrong-architecture addons', async (t) => {
  await t.test('missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-bundle-test-'));
    await assert.rejects(validateDesktopFileLockNative(root, 'linux', 'x64'), /exactly one/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await t.test('duplicate', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-bundle-test-'));
    writeAddon(root, 'resources/app.asar.unpacked', 'linux', 'x64');
    writeAddon(root, 'resources/app.asar.unpacked', 'linux', 'x64', 'duplicate.node');
    await assert.rejects(validateDesktopFileLockNative(root, 'linux', 'x64'), /found 2/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await t.test('not unpacked', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-bundle-test-'));
    writeAddon(root, 'resources/app', 'linux', 'x64');
    await assert.rejects(
      validateDesktopFileLockNative(root, 'linux', 'x64'),
      /not under asarUnpack/
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  await t.test('wrong architecture', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-bundle-test-'));
    writeAddon(root, 'resources/app.asar.unpacked', 'linux', 'arm64');
    await assert.rejects(validateDesktopFileLockNative(root, 'linux', 'x64'), /wrong architecture/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

test('selects the Electron platform and architecture for every packaging target', () => {
  assert.deepEqual(buildFileLockNativeRebuildPlan(['--linux', '--x64'], 'linux', 'x64'), {
    platform: 'linux',
    arch: 'x64',
    modules: ['@agent-teams/desktop-file-lock-native'],
  });
  assert.deepEqual(buildFileLockNativeRebuildPlan(['--mac', '--arm64'], 'linux', 'x64'), {
    platform: 'darwin',
    arch: 'arm64',
    modules: ['@agent-teams/desktop-file-lock-native'],
  });
  assert.deepEqual(buildFileLockNativeRebuildPlan(['--win', '--arm64'], 'win32', 'x64'), {
    platform: 'win32',
    arch: 'arm64',
    modules: ['@agent-teams/desktop-file-lock-native'],
  });
});

test('main bundle guard requires the exact external package name', async (t) => {
  const { verifyDesktopFileLockMainBundle } = await bundleVerifier;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-main-bundle-test-'));
  try {
    await t.test('accepts required package', () => {
      fs.writeFileSync(
        path.join(root, 'index.cjs'),
        "require('@agent-teams/desktop-file-lock-native')"
      );
      assert.doesNotThrow(() => verifyDesktopFileLockMainBundle(root));
    });
    await t.test('rejects missing package', () => {
      fs.writeFileSync(path.join(root, 'index.cjs'), "require('node:path')");
      assert.throws(() => verifyDesktopFileLockMainBundle(root), /does not retain/);
    });
    await t.test('rejects obsolete package', () => {
      fs.writeFileSync(
        path.join(root, 'index.cjs'),
        "require('@agent-teams/desktop-file-lock-native');" +
          "require('@claude-teams/desktop-file-lock-native')"
      );
      assert.throws(() => verifyDesktopFileLockMainBundle(root), /obsolete package name/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
