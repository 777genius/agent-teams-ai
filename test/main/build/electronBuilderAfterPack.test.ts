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

function writePortableTreeSitterFixtures(
  graph: string,
  platform: 'linux' | 'darwin' | 'win32',
  arch: 'x64' | 'arm64'
): { path: string; bytes: Buffer }[] {
  const binaries = [
    ['linux', 'x64', createElfBuffer('x64')],
    ['linux', 'arm64', createElfBuffer('arm64')],
    ['darwin', 'x64', createMachOBuffer('x64')],
    ['darwin', 'arm64', createMachOBuffer('arm64')],
    ['win32', 'x64', createPortableExecutableBuffer('x64')],
    ['win32', 'arm64', createPortableExecutableBuffer('arm64')],
  ] as const;
  const retained: { path: string; bytes: Buffer }[] = [];
  for (const prefix of ['', '@opencode/server-v2-floor/node_modules/']) {
    for (const [p, a, bytes] of binaries) {
      const file = path.join(
        graph,
        prefix,
        '@opencode/core/node_modules/tree-sitter-bash/prebuilds',
        p + '-' + a,
        'tree-sitter-bash.node'
      );
      writeFile(file, bytes);
      if (p === platform && a === arch) retained.push({ path: file, bytes });
    }
  }
  return retained;
}

function writePortableBunPtyFixtures(
  graph: string,
  platform: 'linux' | 'darwin' | 'win32',
  arch: 'x64' | 'arm64' | 'universal'
): { path: string; bytes: Buffer }[] {
  const libraries = [
    ['linux', 'x64', 'librust_pty.so', createElfBuffer('x64')],
    ['linux', 'x64', 'librust_pty_musl.so', createElfBuffer('x64')],
    ['linux', 'arm64', 'librust_pty_arm64.so', createElfBuffer('arm64')],
    ['linux', 'arm64', 'librust_pty_arm64_musl.so', createElfBuffer('arm64')],
    ['darwin', 'x64', 'librust_pty.dylib', createMachOBuffer('x64')],
    ['darwin', 'arm64', 'librust_pty_arm64.dylib', createMachOBuffer('arm64')],
    ['win32', 'x64', 'rust_pty.dll', createPortableExecutableBuffer('x64')],
    ['win32', 'arm64', 'rust_pty_arm64.dll', createPortableExecutableBuffer('arm64')],
  ] as const;
  const retained: { path: string; bytes: Buffer }[] = [];
  for (const prefix of ['', '@opencode/server-v2-floor/node_modules/@opencode/core/node_modules/']) {
    for (const [p, a, name, bytes] of libraries) {
      const file = path.join(graph, prefix, 'bun-pty/rust-pty/target/release', name);
      writeFile(file, bytes);
      if (p === platform && (a === arch || arch === 'universal')) retained.push({ path: file, bytes });
    }
  }
  return retained;
}

function createTargetBinaryBuffer(
  platform: 'linux' | 'darwin' | 'win32',
  arch: 'x64' | 'arm64'
): Buffer {
  if (platform === 'linux') return createElfBuffer(arch);
  if (platform === 'darwin') return createMachOBuffer(arch);
  return createPortableExecutableBuffer(arch);
}

describe('electron-builder afterPack', () => {
  const tempDirs: string[] = [];
  const managedRuntimeTargets = [
    ['win32', 'x64'],
    ['win32', 'arm64'],
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
      : platform === 'win32' ? createPortableExecutableBuffer(targetArch) : createElfBuffer(targetArch));
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
        modules, '@yuuang', `ffi-rs-win32-${targetArch}-msvc`, `ffi-rs.win32-${targetArch}-msvc.node`
      );
      const ffiForeign = path.join(
        modules, '@yuuang', 'ffi-rs-win32-ia32-msvc', 'ffi-rs.win32-ia32-msvc.node'
      );
      writeFile(ffiTarget, createPortableExecutableBuffer(targetArch));
      writeFile(ffiForeign, createPortableExecutableBuffer('ia32'));
      targetFiles.push(ffiTarget);
      foreignFiles.push(ffiForeign);
    }
    const release = path.join(modules, 'bun-pty', 'rust-pty', 'target', 'release');
    const targetLibrary = platform === 'darwin' ? (targetArch === 'arm64' ? 'librust_pty_arm64.dylib' : 'librust_pty.dylib')
      : platform === 'win32' ? (targetArch === 'arm64' ? 'rust_pty_arm64.dll' : 'rust_pty.dll')
      : (targetArch === 'arm64' ? 'librust_pty_arm64.so' : 'librust_pty.so');
    const keptLibraries = platform === 'linux'
      ? [targetLibrary, targetLibrary.replace(/\.so$/, '_musl.so')]
      : [targetLibrary];
    for (const filename of keptLibraries) {
      const target = path.join(release, filename);
      writeFile(target, platform === 'darwin' ? createMachOBuffer(targetArch)
        : platform === 'win32' ? createPortableExecutableBuffer(targetArch) : createElfBuffer(targetArch));
      targetFiles.push(target);
    }
    for (const [filename, bytes] of [
      ['librust_pty.dylib', createMachOBuffer('x64')],
      ['librust_pty_arm64.dylib', createMachOBuffer('arm64')],
      ['librust_pty.so', createElfBuffer('x64')],
      ['librust_pty_arm64.so', createElfBuffer('arm64')],
      ['librust_pty_musl.so', createElfBuffer('x64')],
      ['librust_pty_arm64_musl.so', createElfBuffer('arm64')],
      ['rust_pty.dll', createPortableExecutableBuffer('x64')],
      ['rust_pty_arm64.dll', createPortableExecutableBuffer('arm64')],
    ] as const) {
      if (keptLibraries.includes(filename)) continue;
      const foreign = path.join(release, filename);
      writeFile(foreign, bytes);
      foreignFiles.push(foreign);
    }

    await afterPackModule({ appOutDir: tempDir, electronPlatformName: platform, arch: targetArch === 'arm64' ? 3 : 1 });
    expect(foreignFiles.length).toBe(platform === 'win32' ? 18 : platform === 'linux' ? 16 : 17);
    expect(foreignFiles.every(file => !fs.existsSync(file))).toBe(true);
    expect(targetFiles.every(file => fs.existsSync(file))).toBe(true);
    await expect(validateNativeBinaries(tempDir, platform, targetArch)).resolves.toEqual([]);
  });

  it.each(managedRuntimeTargets)('keeps %s-%s variants without compatible siblings, prunes known bun-pty foreigns, and rejects unknown native files', async (platform, targetArch) => {
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
        : platform === 'win32' ? (targetArch === 'arm64' ? 'rust_pty_arm64.dll' : 'rust_pty.dll') : 'librust_pty.so'
    );
    const foreign = path.join(path.dirname(invalidSibling), platform === 'win32' ? 'librust_pty.so' : 'rust_pty.dll');
    const unknown = path.join(modules, 'unknown-package', 'unknown.node');
    writeFile(missingSibling, platform === 'darwin' ? createPortableExecutableBuffer('arm64') : createMachOBuffer('arm64'));
    writeFile(invalidSibling, platform === 'darwin' ? createMachOBuffer(targetArch === 'arm64' ? 'x64' : 'arm64')
      : platform === 'win32' ? createPortableExecutableBuffer(targetArch === 'arm64' ? 'x64' : 'arm64')
      : createElfBuffer('arm64'));
    writeFile(foreign, platform === 'win32' ? createElfBuffer('x64') : createPortableExecutableBuffer('x64'));
    writeFile(unknown, platform === 'darwin' ? createElfBuffer('x64') : createMachOBuffer('x64'));

    await expect(afterPackModule({ appOutDir: tempDir, electronPlatformName: platform, arch: targetArch === 'arm64' ? 3 : 1 }))
      .rejects.toThrow(`Found incompatible native binaries in ${platform}-${targetArch} bundle after pruning`);
    expect([missingSibling, invalidSibling, unknown].every(file => fs.existsSync(file)))
      .toBe(true);
    expect(fs.existsSync(foreign)).toBe(false);
  });

  it('prunes the shipped win32-arm64 bun-pty set even when rust_pty_arm64.dll is absent', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const release = path.join(
      tempDir,
      'resources',
      'runtime',
      'local-cli',
      'node_modules',
      'bun-pty',
      'rust-pty',
      'target',
      'release'
    );
    const shipped: Array<[string, Buffer]> = [
      ['librust_pty.so', createElfBuffer('x64')],
      ['rust_pty.dll', createPortableExecutableBuffer('x64')],
      ['librust_pty.dylib', createMachOBuffer('x64')],
      ['librust_pty_arm64.dylib', createMachOBuffer('arm64')],
      ['librust_pty_arm64.so', createElfBuffer('arm64')],
    ];
    for (const [filename, bytes] of shipped) {
      writeFile(path.join(release, filename), bytes);
    }

    await afterPackModule({ appOutDir: tempDir, electronPlatformName: 'win32', arch: 3 });

    expect(shipped.every(([filename]) => !fs.existsSync(path.join(release, filename)))).toBe(true);
    await expect(validateNativeBinaries(tempDir, 'win32', 'arm64')).resolves.toEqual([]);
  });

  it('prunes the msgpackr-extract ELF build leftovers shipped in the win32-arm64 runtime', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const build = path.join(
      tempDir,
      'resources',
      'runtime',
      'local-cli',
      'node_modules',
      'msgpackr-extract',
      'build',
      'Release'
    );
    const shipped = [
      path.join(build, 'extract.node'),
      path.join(build, 'obj.target', 'extract.node'),
      path.join(build, 'obj.target', 'extract', 'src', 'extract.o'),
    ];
    for (const file of shipped) {
      writeFile(file, createElfBuffer('x64'));
    }

    await afterPackModule({ appOutDir: tempDir, electronPlatformName: 'win32', arch: 3 });

    expect(shipped.every(file => !fs.existsSync(file))).toBe(true);
    await expect(validateNativeBinaries(tempDir, 'win32', 'arm64')).resolves.toEqual([]);
  });

  it('keeps a compatible msgpackr-extract binding while pruning node-gyp build leftovers', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const build = path.join(
      tempDir,
      'resources',
      'runtime',
      'local-cli',
      'node_modules',
      'msgpackr-extract',
      'build',
      'Release'
    );
    const kept = path.join(build, 'extract.node');
    const leftovers = [
      path.join(build, 'obj.target', 'extract.node'),
      path.join(build, 'obj.target', 'extract', 'src', 'extract.o'),
    ];
    writeFile(kept, createPortableExecutableBuffer('arm64'));
    for (const file of leftovers) {
      writeFile(file, createElfBuffer('x64'));
    }

    await afterPackModule({ appOutDir: tempDir, electronPlatformName: 'win32', arch: 3 });

    expect(fs.existsSync(kept)).toBe(true);
    expect(leftovers.every(file => !fs.existsSync(file))).toBe(true);
    await expect(validateNativeBinaries(tempDir, 'win32', 'arm64')).resolves.toEqual([]);
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

  it.each([
    ['linux', 'x64', 1],
    ['darwin', 'arm64', 3],
    ['darwin', 'x64', 1],
    ['win32', 'x64', 1],
    ['win32', 'arm64', 3],
  ] as const)('prunes portable runtime optional binaries for %s-%s while preserving target bytes', async (platform, arch, archCode) => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const resources = platform === 'darwin' ? 'Agent Teams AI.app/Contents/Resources' : 'resources';
    const graph = path.join(tempDir, resources, 'runtime', 'local-cli', 'node_modules');
    const retained = writePortableTreeSitterFixtures(graph, platform, arch);
    retained.push(...writePortableBunPtyFixtures(graph, platform, arch));
    const documentation = path.join(graph, 'bun-pty/rust-pty/target/release', 'README.txt');
    writeFile(documentation, Buffer.from('retain nonnative package data'));
    const targetBytes = createTargetBinaryBuffer(platform, arch);
    const mixedDirectoryFile = path.join(graph, '@opencode/core/node_modules/tree-sitter-bash/prebuilds', platform === 'linux' ? 'darwin-arm64' : 'linux-arm64', 'compatible-extra.node');
    writeFile(mixedDirectoryFile, targetBytes);
    await afterPackModule({appOutDir: tempDir, electronPlatformName: platform, arch: archCode});
    expect(retained).toHaveLength(platform === 'linux' ? 6 : 4);
    for (const file of retained) expect(fs.readFileSync(file.path)).toEqual(file.bytes);
    expect(fs.readFileSync(mixedDirectoryFile)).toEqual(targetBytes);
    expect(fs.existsSync(documentation)).toBe(true);
    await expect(validateNativeBinaries(tempDir, platform, arch)).resolves.toEqual([]);
  });

  it.each([
    ['linux', 'arm64', 3],
    ['darwin', 'universal', 4],
  ] as const)('prunes only foreign bun-pty variants for %s-%s', async (platform, arch, archCode) => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const resources = platform === 'darwin' ? 'Agent Teams AI.app/Contents/Resources' : 'resources';
    const graph = path.join(tempDir, resources, 'runtime/local-cli/node_modules');
    const retained = writePortableBunPtyFixtures(graph, platform, arch);
    await afterPackModule({ appOutDir: tempDir, electronPlatformName: platform, arch: archCode });
    expect(retained).toHaveLength(4); // Both Linux libc variants, or both Darwin architectures, in each package.
    for (const file of retained) expect(fs.readFileSync(file.path)).toEqual(file.bytes);
    await expect(validateNativeBinaries(tempDir, platform, arch)).resolves.toEqual([]);
  });

  it.each([
    ['missing sibling', '@opencode/server-v2-floor/node_modules/@opencode/core/node_modules/bun-pty/rust-pty/target/release/librust_pty_musl.so', null],
    ['malformed sibling', '@opencode/server-v2-floor/node_modules/@opencode/core/node_modules/bun-pty/rust-pty/target/release/librust_pty_musl.so', Buffer.from('invalid')],
    ['wrong sibling format', '@opencode/server-v2-floor/node_modules/@opencode/core/node_modules/bun-pty/rust-pty/target/release/librust_pty_musl.so', createElfBuffer('x64')],
    ['wrong sibling architecture', '@opencode/server-v2-floor/node_modules/@opencode/core/node_modules/bun-pty/rust-pty/target/release/librust_pty_musl.so', createPortableExecutableBuffer('arm64')],
    ['unknown filename', 'bun-pty/rust-pty/target/release/unknown.so', createPortableExecutableBuffer('x64')],
    ['unknown package path', 'other/node_modules/bun-pty/rust-pty/target/release/librust_pty.so', createPortableExecutableBuffer('x64')],
    ['unknown nested path', 'bun-pty/rust-pty/target/release/nested/librust_pty.so', createPortableExecutableBuffer('x64')],
    ['floor without its own sibling', '@opencode/server-v2-floor/node_modules/@opencode/core/node_modules/bun-pty/rust-pty/target/release/librust_pty.so', null],
  ] as const)('keeps bun-pty pruning fail-closed for %s', async (_label, relative, siblingBytes) => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const graph = path.join(tempDir, 'resources/runtime/local-cli/node_modules');
    const file = path.join(graph, relative);
    const foreignBytes = createElfBuffer('arm64');
    writeFile(file, foreignBytes);
    // A compatible root package must never authorize removal from another package.
    writeFile(path.join(graph, 'bun-pty/rust-pty/target/release/rust_pty.dll'), createPortableExecutableBuffer('x64'));
    const sibling = path.join(path.dirname(file), 'rust_pty.dll');
    if (siblingBytes) writeFile(sibling, siblingBytes);
    else if (relative.startsWith('bun-pty/')) fs.rmSync(sibling);
    await expect(afterPackModule({ appOutDir: tempDir, electronPlatformName: 'win32', arch: 1 }))
      .rejects.toThrow('Found incompatible native binaries in win32-x64 bundle after pruning');
    expect(fs.readFileSync(file)).toEqual(foreignBytes);
    if (siblingBytes) expect(fs.readFileSync(sibling)).toEqual(siblingBytes);
  });

  it('preserves Windows arm64 packaging for only the verified frozen floor PTY', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const graph = path.join(tempDir, 'resources/runtime/local-cli/node_modules');
    writeFile(path.join(graph, 'bun-pty/rust-pty/target/release/rust_pty_arm64.dll'), createPortableExecutableBuffer('arm64'));
    const floor = path.join(graph, '@opencode/server-v2-floor/node_modules/@opencode/core/node_modules/bun-pty/rust-pty/target/release');
    const oldLibraries = [
      ['librust_pty.so', createElfBuffer('x64')],
      ['librust_pty_arm64.so', createElfBuffer('arm64')],
      ['librust_pty.dylib', createMachOBuffer('x64')],
      ['librust_pty_arm64.dylib', createMachOBuffer('arm64')],
      ['rust_pty.dll', createPortableExecutableBuffer('x64')],
    ] as const;
    const manifest = path.join(floor, '../../..', 'package.json');
    const manifestBytes = Buffer.from(JSON.stringify({ name: 'bun-pty', version: '0.4.8' }));
    writeFile(manifest, manifestBytes);
    for (const [name, bytes] of oldLibraries) writeFile(path.join(floor, name), bytes);
    // The outer compatibility check must retain compatible bytes even under an old foreign filename.
    const compatible = path.join(floor, 'librust_pty_arm64.so');
    const compatibleBytes = createPortableExecutableBuffer('arm64');
    writeFile(compatible, compatibleBytes);
    await afterPackModule({ appOutDir: tempDir, electronPlatformName: 'win32', arch: 3 });
    for (const [name] of oldLibraries) {
      if (name === 'librust_pty_arm64.so') expect(fs.readFileSync(compatible)).toEqual(compatibleBytes);
      else expect(fs.existsSync(path.join(floor, name))).toBe(false);
    }
    expect(fs.readFileSync(manifest)).toEqual(manifestBytes);
    await expect(validateNativeBinaries(tempDir, 'win32', 'arm64')).resolves.toEqual([]);
  });

  it.each([
    ['wrong version', '@opencode/server-v2-floor/node_modules/@opencode/core/node_modules/bun-pty', 'librust_pty.so', { name: 'bun-pty', version: '0.4.11' }],
    ['wrong package name', '@opencode/server-v2-floor/node_modules/@opencode/core/node_modules/bun-pty', 'librust_pty.so', { name: 'other', version: '0.4.8' }],
    ['missing manifest', '@opencode/server-v2-floor/node_modules/@opencode/core/node_modules/bun-pty', 'librust_pty.so', null],
    ['other nested path', 'other/node_modules/bun-pty', 'librust_pty.so', { name: 'bun-pty', version: '0.4.8' }],
    ['unknown filename', '@opencode/server-v2-floor/node_modules/@opencode/core/node_modules/bun-pty', 'unknown.so', { name: 'bun-pty', version: '0.4.8' }],
    ['new library filename', '@opencode/server-v2-floor/node_modules/@opencode/core/node_modules/bun-pty', 'librust_pty_musl.so', { name: 'bun-pty', version: '0.4.8' }],
  ] as const)('keeps the frozen Windows arm64 PTY exception closed for %s', async (_label, relative, filename, manifest) => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const root = path.join(tempDir, 'resources/runtime/local-cli/node_modules', relative);
    const file = path.join(root, 'rust-pty/target/release', filename);
    const bytes = createElfBuffer('x64');
    writeFile(file, bytes);
    if (manifest) writeFile(path.join(root, 'package.json'), Buffer.from(JSON.stringify(manifest)));
    await expect(afterPackModule({ appOutDir: tempDir, electronPlatformName: 'win32', arch: 3 }))
      .rejects.toThrow('Found incompatible native binaries in win32-arm64 bundle after pruning');
    expect(fs.readFileSync(file)).toEqual(bytes);
  });

  it('prunes current-graph foreign bun-pty libraries regardless of a frozen-floor manifest', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const root = path.join(tempDir, 'resources/runtime/local-cli/node_modules/bun-pty');
    const file = path.join(root, 'rust-pty/target/release/librust_pty.so');
    writeFile(file, createElfBuffer('x64'));
    writeFile(path.join(root, 'package.json'), Buffer.from(JSON.stringify({ name: 'bun-pty', version: '0.4.8' })));
    await afterPackModule({ appOutDir: tempDir, electronPlatformName: 'win32', arch: 3 });
    expect(fs.existsSync(file)).toBe(false);
    await expect(validateNativeBinaries(tempDir, 'win32', 'arm64')).resolves.toEqual([]);
  });

  it('retains compatible bytes under a foreign bun-pty filename', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const release = path.join(tempDir, 'resources/runtime/local-cli/node_modules/bun-pty/rust-pty/target/release');
    const bytes = createPortableExecutableBuffer('x64');
    writeFile(path.join(release, 'rust_pty.dll'), bytes);
    writeFile(path.join(release, 'librust_pty_musl.so'), bytes);
    await afterPackModule({ appOutDir: tempDir, electronPlatformName: 'win32', arch: 1 });
    expect(fs.readFileSync(path.join(release, 'librust_pty_musl.so'))).toEqual(bytes);
  });

  it.each([
    ['x64', 1],
    ['arm64', 3],
  ] as const)(
    'prunes only the known portable ffi-rs ia32 optional binary for win32-%s',
    async (arch, archCode) => {
      const tempDir = createTempDir();
      tempDirs.push(tempDir);
      const graph = path.join(tempDir, 'resources/runtime/local-cli/node_modules');
      const ia32Package = path.join(graph, '@yuuang/ffi-rs-win32-ia32-msvc');
      const foreign = path.join(ia32Package, 'ffi-rs.win32-ia32-msvc.node');
      const target = path.join(
        graph,
        `@yuuang/ffi-rs-win32-${arch}-msvc/ffi-rs.win32-${arch}-msvc.node`
      );
      const bytes = createPortableExecutableBuffer(arch);
      const documentation = path.join(ia32Package, 'README.md');
      writeFile(foreign, createPortableExecutableBuffer('ia32'));
      writeFile(target, bytes);
      writeFile(documentation, Buffer.from('package documentation'));
      await afterPackModule({ appOutDir: tempDir, electronPlatformName: 'win32', arch: archCode });
      expect(fs.existsSync(foreign)).toBe(false);
      expect(fs.readFileSync(target)).toEqual(bytes);
      expect(fs.readFileSync(documentation)).toEqual(Buffer.from('package documentation'));
      await expect(validateNativeBinaries(tempDir, 'win32', arch)).resolves.toEqual([]);
    }
  );

  it.each([
    ['x64', 1, createElfBuffer('x64')],
    ['arm64', 3, createElfBuffer('x64')],
    ['arm64', 3, createPortableExecutableBuffer('x64')],
  ] as const)(
    'prunes only incompatible known msgpackr build files for win32-%s',
    async (arch, archCode, foreignBytes) => {
      const tempDir = createTempDir();
      tempDirs.push(tempDir);
      const graph = path.join(tempDir, 'resources/runtime/local-cli/node_modules');
      const release = 'msgpackr-extract/build/Release';
      const leaves = ['extract.node', 'obj.target/extract.node', 'obj.target/extract/src/extract.o'];
      const targetBytes = createPortableExecutableBuffer(arch);
      for (const leaf of leaves) {
        writeFile(path.join(graph, release, leaf), foreignBytes);
        writeFile(path.join(graph, 'nested/node_modules', release, leaf), targetBytes);
      }
      const packageData = path.join(graph, release, 'obj.target/extract/src/extract.cc');
      writeFile(packageData, Buffer.from('retain nonnative build data'));
      await afterPackModule({ appOutDir: tempDir, electronPlatformName: 'win32', arch: archCode });
      for (const leaf of leaves) {
        expect(fs.existsSync(path.join(graph, release, leaf))).toBe(false);
        expect(fs.readFileSync(path.join(graph, 'nested/node_modules', release, leaf))).toEqual(
          targetBytes
        );
      }
      expect(fs.readFileSync(packageData)).toEqual(Buffer.from('retain nonnative build data'));
      await expect(validateNativeBinaries(tempDir, 'win32', arch)).resolves.toEqual([]);
    }
  );

  it('preserves compatible Linux msgpackr build artifacts', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const release = path.join(
      tempDir,
      'resources/runtime/local-cli/node_modules/msgpackr-extract/build/Release'
    );
    const bytes = createElfBuffer('x64');
    for (const leaf of [
      'extract.node',
      'obj.target/extract.node',
      'obj.target/extract/src/extract.o',
    ])
      writeFile(path.join(release, leaf), bytes);
    await afterPackModule({ appOutDir: tempDir, electronPlatformName: 'linux', arch: 1 });
    for (const leaf of [
      'extract.node',
      'obj.target/extract.node',
      'obj.target/extract/src/extract.o',
    ])
      expect(fs.readFileSync(path.join(release, leaf))).toEqual(bytes);
  });

  it.each([
    'resources/runtime/local-cli/node_modules/msgpackr-extract/build/Release/other.node',
    'resources/runtime/local-cli/node_modules/msgpackr-extract/build/Debug/extract.node',
    'resources/app.asar.unpacked/node_modules/msgpackr-extract/build/Release/extract.node',
  ])('keeps msgpackr pruning fail-closed outside known runtime artifacts: %s', async (relative) => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const file = path.join(tempDir, relative);
    const bytes = createElfBuffer('x64');
    writeFile(file, bytes);
    await expect(
      afterPackModule({ appOutDir: tempDir, electronPlatformName: 'win32', arch: 3 })
    ).rejects.toThrow('Found incompatible native binaries');
    expect(fs.readFileSync(file)).toEqual(bytes);
  });

  it('preserves compatible bytes under the ia32 ffi-rs filename and on ia32 targets', async () => {
    for (const [arch, archCode] of [
      ['x64', 1],
      ['ia32', 0],
    ] as const) {
      const tempDir = createTempDir();
      tempDirs.push(tempDir);
      const file = path.join(
        tempDir,
        'resources/runtime/local-cli/node_modules/@yuuang/ffi-rs-win32-ia32-msvc/ffi-rs.win32-ia32-msvc.node'
      );
      const bytes = createPortableExecutableBuffer(arch);
      writeFile(file, bytes);
      await afterPackModule({ appOutDir: tempDir, electronPlatformName: 'win32', arch: archCode });
      expect(fs.readFileSync(file)).toEqual(bytes);
    }
  });

  it.each([
    [
      'unknown package',
      'resources/runtime/local-cli/node_modules/unknown/ffi-rs.win32-ia32-msvc.node',
      createPortableExecutableBuffer('ia32'),
    ],
    [
      'unknown filename',
      'resources/runtime/local-cli/node_modules/@yuuang/ffi-rs-win32-ia32-msvc/other.node',
      createPortableExecutableBuffer('ia32'),
    ],
    [
      'outside runtime graph',
      'resources/app.asar.unpacked/node_modules/@yuuang/ffi-rs-win32-ia32-msvc/ffi-rs.win32-ia32-msvc.node',
      createPortableExecutableBuffer('ia32'),
    ],
    [
      'wrong binary format',
      'resources/runtime/local-cli/node_modules/@yuuang/ffi-rs-win32-ia32-msvc/ffi-rs.win32-ia32-msvc.node',
      createElfBuffer('x64'),
    ],
    [
      'wrong foreign architecture',
      'resources/runtime/local-cli/node_modules/@yuuang/ffi-rs-win32-ia32-msvc/ffi-rs.win32-ia32-msvc.node',
      createPortableExecutableBuffer('arm64'),
    ],
  ] as const)('keeps ffi-rs pruning fail-closed for %s', async (_label, relative, bytes) => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const file = path.join(tempDir, relative);
    writeFile(file, bytes);
    await expect(
      afterPackModule({ appOutDir: tempDir, electronPlatformName: 'win32', arch: 1 })
    ).rejects.toThrow('Found incompatible native binaries');
    expect(fs.readFileSync(file)).toEqual(bytes);
  });

  it('keeps unknown runtime binaries and rejects malformed target prebuilds', async () => {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    const graph = path.join(tempDir, 'resources/runtime/local-cli/node_modules');
    const unknown = path.join(graph, 'unknown/bad.node');
    const unknownLibrary = path.join(graph, 'bun-pty/rust-pty/target/release/constructor');
    const target = path.join(graph, '@opencode/core/node_modules/tree-sitter-bash/prebuilds/linux-x64/tree-sitter-bash.node');
    writeFile(unknown, createMachOBuffer('arm64'));
    writeFile(unknownLibrary, createMachOBuffer('arm64'));
    writeFile(target, createMachOBuffer('arm64'));
    await expect(afterPackModule({appOutDir: tempDir, electronPlatformName: 'linux', arch: 1}))
      .rejects.toThrow('Found incompatible native binaries');
    expect(fs.existsSync(unknown)).toBe(true);
    expect(fs.existsSync(unknownLibrary)).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
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
