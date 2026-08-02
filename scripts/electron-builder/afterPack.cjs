const fs = require('node:fs');
const path = require('node:path');

const ARCH_LABELS = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
};

const TARGET_BINARY_FORMAT = {
  darwin: 'mach-o',
  linux: 'elf',
  win32: 'pe',
};

function getArchLabel(arch) {
  return ARCH_LABELS[arch] ?? String(arch);
}

async function walkFiles(rootDir) {
  const files = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    if (!currentDir) {
      continue;
    }

    let entries;
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }
      if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  return files;
}

async function findNodePtyRoots(appOutDir) {
  const roots = [];
  const queue = [appOutDir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    if (!currentDir) {
      continue;
    }

    const baseName = path.basename(currentDir);
    if (baseName === 'node-pty') {
      roots.push(currentDir);
      continue;
    }

    let entries;
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      queue.push(path.join(currentDir, entry.name));
    }
  }

  return roots;
}

function shouldKeepNodePtyPrebuild(entryName, platform, archLabel) {
  if (!entryName.startsWith(`${platform}-`)) {
    return false;
  }

  if (platform === 'darwin' && archLabel === 'universal') {
    return (
      entryName === 'darwin-universal' || entryName === 'darwin-arm64' || entryName === 'darwin-x64'
    );
  }

  return (
    entryName === `${platform}-${archLabel}` ||
    (platform === 'darwin' && entryName === 'darwin-universal')
  );
}

function shouldKeepNodePtyBin(entryName, platform, archLabel) {
  if (!entryName.startsWith(`${platform}-`)) {
    return false;
  }

  if (platform === 'darwin' && archLabel === 'universal') {
    return (
      entryName.startsWith('darwin-universal-') ||
      entryName.startsWith('darwin-arm64-') ||
      entryName.startsWith('darwin-x64-')
    );
  }

  return (
    entryName.startsWith(`${platform}-${archLabel}-`) ||
    (platform === 'darwin' && entryName.startsWith('darwin-universal-'))
  );
}

async function pruneNodePtyArtifacts(appOutDir, platform, archLabel) {
  const removedPaths = [];
  const nodePtyRoots = await findNodePtyRoots(appOutDir);

  for (const nodePtyRoot of nodePtyRoots) {
    for (const [subdirName, shouldKeep] of [
      ['prebuilds', shouldKeepNodePtyPrebuild],
      ['bin', shouldKeepNodePtyBin],
    ]) {
      const subdir = path.join(nodePtyRoot, subdirName);
      let entries;
      try {
        entries = await fs.promises.readdir(subdir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        if (shouldKeep(entry.name, platform, archLabel)) {
          continue;
        }

        const absolutePath = path.join(subdir, entry.name);
        await fs.promises.rm(absolutePath, { recursive: true, force: true });
        removedPaths.push(absolutePath);
      }
    }

    const hasTargetPrebuild = await hasNodePtyTargetPrebuild(nodePtyRoot, platform, archLabel);
    if (!hasTargetPrebuild) {
      continue;
    }

    for (const buildName of ['Release', 'Debug']) {
      const buildDir = path.join(nodePtyRoot, 'build', buildName);
      if (!(await directoryExists(buildDir))) {
        continue;
      }

      if (await containsIncompatibleNativeBinary(buildDir, platform, archLabel)) {
        await fs.promises.rm(buildDir, { recursive: true, force: true });
        removedPaths.push(buildDir);
      }
    }
  }

  return removedPaths;
}

async function directoryExists(dirPath) {
  try {
    const stat = await fs.promises.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function hasNodePtyTargetPrebuild(nodePtyRoot, platform, archLabel) {
  const prebuildsDir = path.join(nodePtyRoot, 'prebuilds');
  let entries;
  try {
    entries = await fs.promises.readdir(prebuildsDir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !shouldKeepNodePtyPrebuild(entry.name, platform, archLabel)) {
      continue;
    }

    const ptyNativePath = path.join(prebuildsDir, entry.name, 'pty.node');
    if (await fileExists(ptyNativePath)) {
      return true;
    }
  }

  return false;
}

async function fileExists(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function containsIncompatibleNativeBinary(rootDir, targetPlatform, targetArch) {
  const files = await walkFiles(rootDir);
  for (const filePath of files) {
    const metadata = await detectBinaryMetadata(filePath);
    if (!metadata) {
      continue;
    }

    if (!isBinaryCompatible(metadata.format, metadata.archs, targetPlatform, targetArch)) {
      return true;
    }
  }

  return false;
}

function findNodeModulesSequence(segments, sequence) {
  for (let index = 0; index <= segments.length - sequence.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (segments[index + offset] !== sequence[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return index;
    }
  }
  return -1;
}

function getKnownPrunableNativeArtifactRoot(appOutDir, filePath, targetPlatform, targetArch) {
  if (targetPlatform !== 'win32') {
    return null;
  }

  const relativePath = path.relative(appOutDir, filePath);
  const segments = relativePath.split(path.sep);

  const conptyIndex = findNodeModulesSequence(segments, [
    'node_modules',
    'node-pty',
    'third_party',
    'conpty',
  ]);
  const conptyArchIndex = conptyIndex + 5;
  const conptyArchDir = conptyIndex >= 0 ? segments[conptyArchIndex] : null;
  if (conptyArchDir?.startsWith('win10-') && conptyArchDir !== `win10-${targetArch}`) {
    return path.join(appOutDir, ...segments.slice(0, conptyArchIndex + 1));
  }

  return null;
}

function isKnownAllowedNativeMismatch(relativePath, format, archs, targetPlatform) {
  const normalizedPath = relativePath.split(path.sep).join('/');
  const ssh2PageantPath = 'node_modules/ssh2/util/pagent.exe';

  return (
    targetPlatform === 'win32' &&
    (normalizedPath === ssh2PageantPath || normalizedPath.endsWith(`/${ssh2PageantPath}`)) &&
    format === 'pe' &&
    archs.size === 1 &&
    archs.has('ia32')
  );
}

async function pruneKnownIncompatibleNativeArtifacts(appOutDir, targetPlatform, targetArch) {
  const files = await walkFiles(appOutDir);
  const rootsToRemove = new Set();

  for (const filePath of files) {
    const rootToRemove = getKnownPrunableNativeArtifactRoot(
      appOutDir,
      filePath,
      targetPlatform,
      targetArch
    );
    if (!rootToRemove) {
      continue;
    }

    const metadata = await detectBinaryMetadata(filePath);
    if (!metadata) {
      continue;
    }

    if (isBinaryCompatible(metadata.format, metadata.archs, targetPlatform, targetArch)) {
      continue;
    }

    rootsToRemove.add(rootToRemove);
  }

  const removedPaths = [];
  for (const absolutePath of rootsToRemove) {
    await fs.promises.rm(absolutePath, { recursive: true, force: true });
    removedPaths.push(absolutePath);
  }
  return removedPaths;
}

function mapMachOCpuType(cpuType) {
  switch (cpuType >>> 0) {
    case 0x00000007:
      return 'ia32';
    case 0x01000007:
      return 'x64';
    case 0x0000000c:
      return 'armv7l';
    case 0x0100000c:
      return 'arm64';
    default:
      return null;
  }
}

function parseMachO(buffer) {
  if (buffer.length < 8) {
    return null;
  }

  const magicHex = buffer.subarray(0, 4).toString('hex');
  const archs = new Set();

  if (magicHex === 'cafebabe' || magicHex === 'cafebabf') {
    if (buffer.length < 8) {
      return null;
    }

    const archCount = buffer.readUInt32BE(4);
    const stride = magicHex === 'cafebabf' ? 32 : 20;
    let offset = 8;

    for (let index = 0; index < archCount; index += 1) {
      if (buffer.length < offset + stride) {
        break;
      }
      const arch = mapMachOCpuType(buffer.readUInt32BE(offset));
      if (arch) {
        archs.add(arch);
      }
      offset += stride;
    }

    return archs.size > 0 ? { format: 'mach-o', archs } : null;
  }

  if (magicHex === 'bebafeca' || magicHex === 'bfbafeca') {
    if (buffer.length < 8) {
      return null;
    }

    const archCount = buffer.readUInt32LE(4);
    const stride = magicHex === 'bfbafeca' ? 32 : 20;
    let offset = 8;

    for (let index = 0; index < archCount; index += 1) {
      if (buffer.length < offset + stride) {
        break;
      }
      const arch = mapMachOCpuType(buffer.readUInt32LE(offset));
      if (arch) {
        archs.add(arch);
      }
      offset += stride;
    }

    return archs.size > 0 ? { format: 'mach-o', archs } : null;
  }

  if (magicHex === 'feedfacf' || magicHex === 'feedface') {
    const arch = mapMachOCpuType(buffer.readUInt32BE(4));
    return arch ? { format: 'mach-o', archs: new Set([arch]) } : null;
  }

  if (magicHex === 'cffaedfe' || magicHex === 'cefaedfe') {
    const arch = mapMachOCpuType(buffer.readUInt32LE(4));
    return arch ? { format: 'mach-o', archs: new Set([arch]) } : null;
  }

  return null;
}

function parseElf(buffer) {
  if (buffer.length < 20) {
    return null;
  }
  if (buffer[0] !== 0x7f || buffer[1] !== 0x45 || buffer[2] !== 0x4c || buffer[3] !== 0x46) {
    return null;
  }

  const littleEndian = buffer[5] !== 2;
  const machine = littleEndian ? buffer.readUInt16LE(18) : buffer.readUInt16BE(18);
  const arch =
    machine === 0x03
      ? 'ia32'
      : machine === 0x3e
        ? 'x64'
        : machine === 0x28
          ? 'armv7l'
          : machine === 0xb7
            ? 'arm64'
            : null;

  return arch ? { format: 'elf', archs: new Set([arch]) } : null;
}

function parsePortableExecutable(buffer) {
  if (buffer.length < 0x40) {
    return null;
  }
  if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    return null;
  }

  const peOffset = buffer.readUInt32LE(0x3c);
  if (buffer.length < peOffset + 6) {
    return null;
  }
  if (
    buffer[peOffset] !== 0x50 ||
    buffer[peOffset + 1] !== 0x45 ||
    buffer[peOffset + 2] !== 0x00 ||
    buffer[peOffset + 3] !== 0x00
  ) {
    return null;
  }

  const machine = buffer.readUInt16LE(peOffset + 4);
  const arch =
    machine === 0x014c
      ? 'ia32'
      : machine === 0x8664
        ? 'x64'
        : machine === 0xaa64
          ? 'arm64'
          : machine === 0x01c4
            ? 'armv7l'
            : null;

  return arch ? { format: 'pe', archs: new Set([arch]) } : null;
}

async function detectBinaryMetadata(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const slice = buffer.subarray(0, bytesRead);
    return parseMachO(slice) ?? parseElf(slice) ?? parsePortableExecutable(slice);
  } finally {
    await handle.close();
  }
}

function isBinaryCompatible(format, archs, targetPlatform, targetArch) {
  if (format !== TARGET_BINARY_FORMAT[targetPlatform]) {
    return false;
  }

  if (targetPlatform === 'darwin' && targetArch === 'universal') {
    return archs.has('arm64') || archs.has('x64');
  }

  return archs.has(targetArch);
}

async function validateNativeBinaries(appOutDir, targetPlatform, targetArch) {
  const mismatches = [];
  const files = await walkFiles(appOutDir);

  for (const filePath of files) {
    const relativePath = path.relative(appOutDir, filePath);
    const metadata = await detectBinaryMetadata(filePath);
    if (!metadata) {
      continue;
    }

    if (isBinaryCompatible(metadata.format, metadata.archs, targetPlatform, targetArch)) {
      continue;
    }

    if (
      isKnownAllowedNativeMismatch(relativePath, metadata.format, metadata.archs, targetPlatform)
    ) {
      continue;
    }

    mismatches.push({
      path: relativePath,
      format: metadata.format,
      archs: [...metadata.archs].sort(),
    });
  }

  return mismatches;
}

async function afterPack(context) {
  const targetPlatform = context.electronPlatformName;
  const targetArch = getArchLabel(context.arch);

  const removedPaths = [
    ...(await pruneNodePtyArtifacts(context.appOutDir, targetPlatform, targetArch)),
    ...(await pruneKnownIncompatibleNativeArtifacts(context.appOutDir, targetPlatform, targetArch)),
  ];
  const mismatches = await validateNativeBinaries(context.appOutDir, targetPlatform, targetArch);

  if (mismatches.length > 0) {
    const details = mismatches
      .slice(0, 20)
      .map((mismatch) => `- ${mismatch.path} [${mismatch.format}] -> ${mismatch.archs.join(', ')}`)
      .join('\n');
    throw new Error(
      `Found incompatible native binaries in ${targetPlatform}-${targetArch} bundle after pruning.\n${details}`
    );
  }

  if (removedPaths.length > 0) {
    console.log(
      `[afterPack] pruned ${removedPaths.length} incompatible native artifact(s) for ${targetPlatform}-${targetArch}`
    );
  }
}

module.exports = afterPack;
module.exports._internal = {
  detectBinaryMetadata,
  getArchLabel,
  isBinaryCompatible,
  isKnownAllowedNativeMismatch,
  parseElf,
  parseMachO,
  parsePortableExecutable,
  pruneKnownIncompatibleNativeArtifacts,
  pruneNodePtyArtifacts,
  validateNativeBinaries,
  walkFiles,
};
