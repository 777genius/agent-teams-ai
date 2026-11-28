const path = require('node:path');

// tools/opencode-console-wrapper, staged by scripts/stage-opencode-console-wrapper.mjs.
// It is a managed AnyCPU assembly: csc stamps AnyCPU images with the legacy i386
// machine id even though the CLR loads them natively on x64 and arm64, and the
// .NET Framework compiler cannot emit an arm64 image at all, so one build serves
// every Windows architecture and reads back as ia32 here. verifyBundle.cjs
// inherits this allowance through validateNativeBinaries.
const OPENCODE_CONSOLE_WRAPPER_PATH = 'resources/runtime/opencode-console/opencode.exe';
const TEAMMATE_CONSOLE_WRAPPER_PATH = 'resources/runtime/teammate-console/teammate.exe';

function isKnownAllowedNativeMismatch(relativePath, format, archs, targetPlatform, clrManaged = false, targetArch = null) {
  const normalizedPath = relativePath.split(path.sep).join('/');
  // Git Credential Manager ships portable CLR assemblies that have an ia32 PE
  // header even in the macOS/Linux Git distributions. This is not native x86.
  const managedGitLibrary =
    /^(?:(?:[^/]+\.app\/)?Contents\/Resources\/git|resources\/git)\/(?:libexec\/git-core|(?:ucrt64|clangarm64)\/(?:libexec\/git-core|bin))\/(?:[^/]+\/)*[^/]+\.dll$/i.test(normalizedPath);
  if (managedGitLibrary && clrManaged && format === 'pe') {
    return true;
  }
  // Dugite's pinned Windows ARM64 distribution intentionally ships x64 MSYS2
  // command-line helpers in usr/. Do not relax the architecture guard elsewhere.
  if (
    targetPlatform === 'win32' &&
    targetArch === 'arm64' &&
    /^resources\/git\/usr\/(?:bin|lib|libexec)\/(?:[^/]+\/)*[^/]+\.(?:exe|dll)$/i.test(normalizedPath) &&
    format === 'pe' && archs.size === 1 && archs.has('x64')
  ) return true;

  // The exact wrapper path is an exception only for managed AnyCPU CLR images.
  const isManagedWrapperPath = normalizedPath === OPENCODE_CONSOLE_WRAPPER_PATH ||
    normalizedPath === TEAMMATE_CONSOLE_WRAPPER_PATH;
  if (targetPlatform === 'win32' && isManagedWrapperPath && clrManaged &&
      format === 'pe' && archs.size === 1 && archs.has('ia32')) return true;

  const ssh2PageantPath = 'node_modules/ssh2/util/pagent.exe';
  const isAllowedIa32Path =
    normalizedPath === ssh2PageantPath ||
    normalizedPath.endsWith(`/${ssh2PageantPath}`) ||
    // Git for Windows contains this one 32-bit MSYS helper even in 64-bit archives.
    normalizedPath === 'resources/git/usr/libexec/getprocaddr32.exe';

  return (
    targetPlatform === 'win32' &&
    isAllowedIa32Path &&
    format === 'pe' &&
    archs.size === 1 &&
    archs.has('ia32')
  );
}

module.exports = { isKnownAllowedNativeMismatch, OPENCODE_CONSOLE_WRAPPER_PATH,
  TEAMMATE_CONSOLE_WRAPPER_PATH };
