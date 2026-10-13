// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const afterPackModule = require('../../../scripts/electron-builder/afterPack.cjs');

const {
  OPENCODE_CONSOLE_WRAPPER_PATH,
  detectBinaryMetadata,
  isKnownAllowedNativeMismatch,
  parseElf,
  parseMachO,
  parsePortableExecutable,
  pruneNodePtyArtifacts,
  validateNativeBinaries,
} = afterPackModule._internal;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-test-'));
}

function writeFile(filePath: string, content: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createMachOBuffer(arch: 'arm64' | 'x64'): Buffer {
  const cpuType = arch === 'arm64' ? 0x0100000c : 0x01000007;
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(cpuType, 4);
  return buffer;
}

function createElfBuffer(arch: 'arm64' | 'x64'): Buffer {
  const machine = arch === 'arm64' ? 0x00b7 : 0x003e;
  const buffer = Buffer.alloc(64);
  buffer[0] = 0x7f;
  buffer[1] = 0x45;
  buffer[2] = 0x4c;
  buffer[3] = 0x46;
  buffer[5] = 1;
  buffer.writeUInt16LE(machine, 18);
  return buffer;
}

function createPortableExecutableBuffer(arch: 'arm64' | 'ia32' | 'x64'): Buffer {
  const machine = arch === 'arm64' ? 0xaa64 : arch === 'ia32' ? 0x014c : 0x8664;
  const buffer = Buffer.alloc(256);
  buffer[0] = 0x4d;
  buffer[1] = 0x5a;
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer[0x80] = 0x50;
  buffer[0x81] = 0x45;
  buffer[0x82] = 0x00;
  buffer[0x83] = 0x00;
  buffer.writeUInt16LE(machine, 0x84);
  return buffer;
}

describe('electron-builder afterPack', () => {
  const tempDirs: string[] = [];
  const managedRuntimeTargets = [
    ['win32', 'x64'],
    ['linux', 'x64'],
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
  ] as const;

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('parses native binary headers for all supported bundle formats', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);

    const machoPath = path.join(tempDir, 'arm64.node');
    const elfPath = path.join(tempDir, 'linux.node');
    const pePath = path.join(tempDir, 'win.node');
    writeFile(machoPath, createMachOBuffer('arm64'));
    writeFile(elfPath, createElfBuffer('x64'));
    writeFile(pePath, createPortableExecutableBuffer('arm64'));

    await expect(detectBinaryMetadata(machoPath)).resolves.toEqual({
      format: 'mach-o',
      archs: new Set(['arm64']),
    });
    await expect(detectBinaryMetadata(elfPath)).resolves.toEqual({
      format: 'elf',
      archs: new Set(['x64']),
    });
    await expect(detectBinaryMetadata(pePath)).resolves.toEqual({
      format: 'pe',
      archs: new Set(['arm64']),
    });
    expect(parseMachO(createMachOBuffer('x64'))).toEqual({
      format: 'mach-o',
      archs: new Set(['x64']),
    });
    expect(parseElf(createElfBuffer('arm64'))).toEqual({
      format: 'elf',
      archs: new Set(['arm64']),
    });
    expect(parsePortableExecutable(createPortableExecutableBuffer('x64'))).toEqual({
      format: 'pe',
      archs: new Set(['x64']),
    });
  });

  it('prunes node-pty prebuilds that do not match the target platform and arch', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const prebuildsDir = path.join(tempDir, 'node_modules', 'node-pty', 'prebuilds');
    const binDir = path.join(tempDir, 'node_modules', 'node-pty', 'bin');

    writeFile(path.join(prebuildsDir, 'darwin-arm64', 'pty.node'), createMachOBuffer('arm64'));
    writeFile(path.join(prebuildsDir, 'darwin-x64', 'pty.node'), createMachOBuffer('x64'));
    writeFile(path.join(prebuildsDir, 'win32-x64', 'pty.node'), createPortableExecutableBuffer('x64'));
    writeFile(path.join(binDir, 'darwin-arm64-143', 'node-pty.node'), createMachOBuffer('arm64'));
    writeFile(path.join(binDir, 'darwin-x64-143', 'node-pty.node'), createMachOBuffer('x64'));

    const removed = await pruneNodePtyArtifacts(tempDir, 'darwin', 'arm64');

    expect(removed).toEqual(
      expect.arrayContaining([
        path.join(prebuildsDir, 'darwin-x64'),
        path.join(prebuildsDir, 'win32-x64'),
        path.join(binDir, 'darwin-x64-143'),
      ])
    );
    expect(fs.existsSync(path.join(prebuildsDir, 'darwin-arm64'))).toBe(true);
    expect(fs.existsSync(path.join(binDir, 'darwin-arm64-143'))).toBe(true);
    expect(fs.existsSync(path.join(prebuildsDir, 'darwin-x64'))).toBe(false);
  });

  it('prunes host node-pty build outputs when a matching target prebuild exists', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const nodePtyDir = path.join(
      tempDir,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'node-pty'
    );
    const releaseDir = path.join(nodePtyDir, 'build', 'Release');
    const prebuildDir = path.join(nodePtyDir, 'prebuilds', 'win32-x64');

    writeFile(path.join(tempDir, 'AgentTeamsAI.exe'), createPortableExecutableBuffer('x64'));
    writeFile(path.join(releaseDir, 'pty.node'), createMachOBuffer('arm64'));
    writeFile(path.join(releaseDir, 'spawn-helper'), createMachOBuffer('arm64'));
    writeFile(path.join(prebuildDir, 'pty.node'), createPortableExecutableBuffer('x64'));
    writeFile(path.join(prebuildDir, 'conpty.node'), createPortableExecutableBuffer('x64'));

    await afterPackModule({
      appOutDir: tempDir,
      electronPlatformName: 'win32',
      arch: 1,
    });

    expect(fs.existsSync(releaseDir)).toBe(false);
    expect(fs.existsSync(path.join(prebuildDir, 'pty.node'))).toBe(true);
  });

  it('keeps incompatible node-pty build outputs when no target prebuild exists', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const releaseDir = path.join(
      tempDir,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'node-pty',
      'build',
      'Release'
    );

    writeFile(path.join(tempDir, 'agent-teams-ai'), createElfBuffer('x64'));
    writeFile(path.join(releaseDir, 'pty.node'), createMachOBuffer('arm64'));

    await expect(
      afterPackModule({
        appOutDir: tempDir,
        electronPlatformName: 'linux',
        arch: 1,
      })
    ).rejects.toThrow('Found incompatible native binaries in linux-x64 bundle after pruning');

    expect(fs.existsSync(releaseDir)).toBe(true);
  });

  it.each(managedRuntimeTargets)('prunes known %s-%s runtime variants while retaining compatible target siblings', async (platform, targetArch) => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const resources = platform === 'darwin'
      ? path.join(tempDir, 'Agent Teams AI.app', 'Contents', 'Resources')
      : path.join(tempDir, 'resources');
    const modules = path.join(resources, 'runtime', 'local-cli', 'node_modules');
    const targetFiles: string[] = [];
    const foreignFiles: string[] = [];
    for (const coreRoot of [
      path.join(modules, '@opencode', 'core'),
      path.join(modules, '@opencode', 'server-v2-floor', 'node_modules', '@opencode', 'core'),
    ]) {
      const prebuilds = path.join(coreRoot, 'node_modules', 'tree-sitter-bash', 'prebuilds');
      const target = path.join(prebuilds, `${platform}-${targetArch}`, 'tree-sitter-bash.node');
      writeFile(target, platform === 'darwin' ? createMachOBuffer(targetArch)
      : platform === 'win32' ? createPortableExecutableBuffer('x64') : createElfBuffer('x64'));
      targetFiles.push(target);
      for (const [variant, bytes] of [
        ['darwin-arm64', createMachOBuffer('arm64')],
        ['darwin-x64', createMachOBuffer('x64')],
        ['linux-arm64', createElfBuffer('arm64')],
        ['linux-x64', createElfBuffer('x64')],
        ['win32-arm64', createPortableExecutableBuffer('arm64')],
        ['win32-x64', createPortableExecutableBuffer('x64')],
      ] as const) {
        if (variant === `${platform}-${targetArch}`) continue;
        const foreign = path.join(prebuilds, variant, 'tree-sitter-bash.node');
        writeFile(foreign, bytes);
        foreignFiles.push(foreign);
      }
    }
    if (platform === 'win32') {
      const ffiTarget = path.join(
        modules, '@yuuang', 'ffi-rs-win32-x64-msvc', 'ffi-rs.win32-x64-msvc.node'
      );
      const ffiForeign = path.join(
        modules, '@yuuang', 'ffi-rs-win32-ia32-msvc', 'ffi-rs.win32-ia32-msvc.node'
      );
      writeFile(ffiTarget, createPortableExecutableBuffer('x64'));
      writeFile(ffiForeign, createPortableExecutableBuffer('ia32'));
      targetFiles.push(ffiTarget);
      foreignFiles.push(ffiForeign);
    }
    const release = path.join(modules, 'bun-pty', 'rust-pty', 'target', 'release');
    const targetLibrary = platform === 'darwin' ? (targetArch === 'arm64' ? 'librust_pty_arm64.dylib' : 'librust_pty.dylib')
      : platform === 'win32' ? 'rust_pty.dll' : 'librust_pty.so';
    const target = path.join(release, targetLibrary);
    writeFile(target, platform === 'darwin' ? createMachOBuffer(targetArch)
      : platform === 'win32' ? createPortableExecutableBuffer('x64') : createElfBuffer('x64'));
    targetFiles.push(target);
    for (const [filename, bytes] of [
      ['librust_pty.dylib', createMachOBuffer('x64')],
      ['librust_pty_arm64.dylib', createMachOBuffer('arm64')],
      ['librust_pty.so', createElfBuffer('x64')],
      ['librust_pty_arm64.so', createElfBuffer('arm64')],
      ['rust_pty.dll', createPortableExecutableBuffer('x64')],
    ] as const) {
      if (filename === targetLibrary) continue;
      const foreign = path.join(release, filename);
      writeFile(foreign, bytes);
      foreignFiles.push(foreign);
    }

    await afterPackModule({ appOutDir: tempDir, electronPlatformName: platform, arch: targetArch === 'arm64' ? 3 : 1 });
    expect(foreignFiles.length).toBe(platform === 'win32' ? 15 : 14);
    expect(foreignFiles.every(file => !fs.existsSync(file))).toBe(true);
    expect(targetFiles.every(file => fs.existsSync(file))).toBe(true);
    await expect(validateNativeBinaries(tempDir, platform, targetArch)).resolves.toEqual([]);
  });

  it.each(managedRuntimeTargets)('retains %s-%s runtime variants without compatible siblings and rejects unknown native files', async (platform, targetArch) => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const resources = platform === 'darwin'
      ? path.join(tempDir, 'Agent Teams AI.app', 'Contents', 'Resources')
      : path.join(tempDir, 'resources');
    const modules = path.join(resources, 'runtime', 'local-cli', 'node_modules');
    const missingSibling = path.join(
      modules, '@opencode', 'core', 'node_modules', 'tree-sitter-bash',
      'prebuilds', platform === 'darwin' ? 'win32-arm64' : 'darwin-arm64', 'tree-sitter-bash.node'
    );
    const invalidSibling = path.join(
      modules, 'bun-pty', 'rust-pty', 'target', 'release',
      platform === 'darwin' ? (targetArch === 'arm64' ? 'librust_pty_arm64.dylib' : 'librust_pty.dylib')
        : platform === 'win32' ? 'rust_pty.dll' : 'librust_pty.so'
    );
    const foreign = path.join(path.dirname(invalidSibling), platform === 'win32' ? 'librust_pty.so' : 'rust_pty.dll');
    const unknown = path.join(modules, 'unknown-package', 'unknown.node');
    writeFile(missingSibling, platform === 'darwin' ? createPortableExecutableBuffer('arm64') : createMachOBuffer('arm64'));
    writeFile(invalidSibling, platform === 'darwin' ? createMachOBuffer(targetArch === 'arm64' ? 'x64' : 'arm64')
      : platform === 'win32' ? createPortableExecutableBuffer('arm64') : createElfBuffer('arm64'));
    writeFile(foreign, platform === 'win32' ? createElfBuffer('x64') : createPortableExecutableBuffer('x64'));
    writeFile(unknown, platform === 'darwin' ? createElfBuffer('x64') : createMachOBuffer('x64'));

    await expect(afterPackModule({ appOutDir: tempDir, electronPlatformName: platform, arch: targetArch === 'arm64' ? 3 : 1 }))
      .rejects.toThrow(`Found incompatible native binaries in ${platform}-${targetArch} bundle after pruning`);
    expect([missingSibling, invalidSibling, foreign, unknown].every(file => fs.existsSync(file)))
      .toBe(true);
  });

  it('fails validation when a foreign-arch native binary remains in the bundle', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);

    writeFile(
      path.join(tempDir, 'Contents', 'Resources', 'app.asar.unpacked', 'bad.node'),
      createMachOBuffer('x64')
    );

    await expect(validateNativeBinaries(tempDir, 'darwin', 'arm64')).resolves.toEqual([
      {
        path: path.join('Contents', 'Resources', 'app.asar.unpacked', 'bad.node'),
        format: 'mach-o',
        archs: ['x64'],
      },
    ]);
  });

  it('accepts a clean arm64 mac bundle after pruning', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);

    writeFile(
      path.join(tempDir, 'Contents', 'MacOS', 'Agent Teams AI'),
      createMachOBuffer('arm64')
    );
    writeFile(
      path.join(
        tempDir,
        'Contents',
        'Resources',
        'app.asar.unpacked',
        'node_modules',
        'node-pty',
        'build',
        'Release',
        'pty.node'
      ),
      createMachOBuffer('arm64')
    );
    writeFile(
      path.join(
        tempDir,
        'Contents',
        'Resources',
        'app.asar.unpacked',
        'node_modules',
        'node-pty',
        'prebuilds',
        'darwin-arm64',
        'pty.node'
      ),
      createMachOBuffer('arm64')
    );
    writeFile(
      path.join(
        tempDir,
        'Contents',
        'Resources',
        'app.asar.unpacked',
        'node_modules',
        'node-pty',
        'prebuilds',
        'darwin-x64',
        'pty.node'
      ),
      createMachOBuffer('x64')
    );

    await afterPackModule({
      appOutDir: tempDir,
      electronPlatformName: 'darwin',
      arch: 3,
    });

    expect(
      fs.existsSync(
        path.join(
          tempDir,
          'Contents',
          'Resources',
          'app.asar.unpacked',
          'node_modules',
          'node-pty',
          'prebuilds',
          'darwin-x64'
        )
      )
    ).toBe(false);
  });

  it('accepts a clean x64 Windows bundle with optional standalone helper binaries', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);

    writeFile(path.join(tempDir, 'Agent Teams AI.exe'), createPortableExecutableBuffer('x64'));
    writeFile(
      path.join(
        tempDir,
        'resources',
        'app.asar.unpacked',
        'node_modules',
        'node-pty',
        'build',
        'Release',
        'pty.node'
      ),
      createPortableExecutableBuffer('x64')
    );
    const pageantPath = path.join(
      tempDir,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'ssh2',
      'util',
      'pagent.exe'
    );
    const armConptyDir = path.join(
      tempDir,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'node-pty',
      'third_party',
      'conpty',
      '1.23.251008001',
      'win10-arm64'
    );
    writeFile(pageantPath, createPortableExecutableBuffer('ia32'));
    writeFile(path.join(armConptyDir, 'conpty.dll'), createPortableExecutableBuffer('arm64'));
    writeFile(path.join(armConptyDir, 'OpenConsole.exe'), createPortableExecutableBuffer('arm64'));

    await afterPackModule({
      appOutDir: tempDir,
      electronPlatformName: 'win32',
      arch: 1,
    });

    expect(fs.existsSync(pageantPath)).toBe(true);
    expect(fs.existsSync(armConptyDir)).toBe(false);
  });

  it('still reports unrelated ia32 Windows binaries in an x64 bundle', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);

    const badBinaryPath = path.join(tempDir, 'resources', 'app.asar.unpacked', 'bad-helper.exe');
    writeFile(badBinaryPath, createPortableExecutableBuffer('ia32'));

    await expect(validateNativeBinaries(tempDir, 'win32', 'x64')).resolves.toEqual([
      {
        path: path.join('resources', 'app.asar.unpacked', 'bad-helper.exe'),
        format: 'pe',
        archs: ['ia32'],
      },
    ]);
  });

  it('accepts native arm64 runtime payloads in an arm64 Windows bundle', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);

    writeFile(
      path.join(tempDir, 'resources', 'terminal-platform', 'terminal-daemon.exe'),
      createPortableExecutableBuffer('arm64')
    );
    writeFile(
      path.join(tempDir, 'resources', 'runtime', 'claude-multimodel.exe'),
      createPortableExecutableBuffer('arm64')
    );
    writeFile(
      path.join(
        tempDir,
        'resources',
        'terminal-platform',
        'terminal-platform-node',
        'native',
        'terminal_node_napi.win32.arm64.node'
      ),
      createPortableExecutableBuffer('arm64')
    );

    await expect(validateNativeBinaries(tempDir, 'win32', 'arm64')).resolves.toEqual([]);
  });

  it('rejects an x64 runtime executable in an arm64 Windows bundle', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const relativePath = path.join('resources', 'runtime', 'claude-multimodel.exe');

    writeFile(path.join(tempDir, relativePath), createPortableExecutableBuffer('x64'));

    await expect(validateNativeBinaries(tempDir, 'win32', 'arm64')).resolves.toEqual([
      {
        path: relativePath,
        format: 'pe',
        archs: ['x64'],
      },
    ]);
  });

  it('accepts the managed AnyCPU OpenCode console wrapper in Windows bundles', async () => {
    for (const targetArch of ['x64', 'arm64'] as const) {
      const tempDir = createTempDir();
      tempDirs.push(tempDir);

      writeFile(
        path.join(tempDir, ...OPENCODE_CONSOLE_WRAPPER_PATH.split('/')),
        createPortableExecutableBuffer('ia32')
      );
      writeFile(
        path.join(tempDir, 'resources', 'runtime', 'claude-multimodel.exe'),
        createPortableExecutableBuffer(targetArch)
      );

      await expect(validateNativeBinaries(tempDir, 'win32', targetArch)).resolves.toEqual([]);
    }
  });

  it('keeps the console wrapper exception fail-closed', () => {
    const ia32 = new Set(['ia32']);
    expect(
      isKnownAllowedNativeMismatch(
        OPENCODE_CONSOLE_WRAPPER_PATH.split('/').join(path.sep),
        'pe',
        ia32,
        'win32'
      )
    ).toBe(true);
    // The same managed binary anywhere else in the bundle is still a mismatch.
    expect(
      isKnownAllowedNativeMismatch(
        path.join('resources', 'runtime', 'opencode.exe'),
        'pe',
        ia32,
        'win32'
      )
    ).toBe(false);
    expect(
      isKnownAllowedNativeMismatch(
        path.join('resources', 'app.asar.unpacked', ...OPENCODE_CONSOLE_WRAPPER_PATH.split('/')),
        'pe',
        ia32,
        'win32'
      )
    ).toBe(false);
    expect(
      isKnownAllowedNativeMismatch(
        OPENCODE_CONSOLE_WRAPPER_PATH.split('/').join(path.sep),
        'pe',
        new Set(['armv7l']),
        'win32'
      )
    ).toBe(false);
    expect(
      isKnownAllowedNativeMismatch(
        OPENCODE_CONSOLE_WRAPPER_PATH.split('/').join(path.sep),
        'pe',
        ia32,
        'linux'
      )
    ).toBe(false);
  });

  it('rejects the x64 terminal addon in an arm64 Windows bundle', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const relativePath = path.join(
      'resources',
      'terminal-platform',
      'terminal-platform-node',
      'native',
      'terminal_node_napi.win32.x64.node'
    );

    writeFile(path.join(tempDir, relativePath), createPortableExecutableBuffer('x64'));

    await expect(validateNativeBinaries(tempDir, 'win32', 'arm64')).resolves.toEqual([
      {
        path: relativePath,
        format: 'pe',
        archs: ['x64'],
      },
    ]);
  });
});
