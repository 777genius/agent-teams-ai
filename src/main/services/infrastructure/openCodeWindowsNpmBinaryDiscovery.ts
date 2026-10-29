import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  OPENCODE_V2_NPM_WRAPPER_PACKAGE,
  resolveOpenCodeV2NpmWrapperBinary,
} from '@main/services/runtime/openCodeRuntimeBinaryEnv';
import { isAbsoluteExistingFile } from '@main/utils/runtimePathBinaryResolver';

/** Legacy `npm i -g opencode-ai` wrapper package. */
const LEGACY_NPM_ROOT_PACKAGE_NAME = 'opencode-ai';
const WINDOWS_EXECUTABLE_NAME = 'opencode.exe';

/**
 * Static text markers of the target npm package in npm-generated shims. The shim
 * is read as text only: it is never executed and its script content is never
 * interpreted, so the binding check cannot run user code.
 */
const NPM_SHIM_MAX_BYTES = 64 * 1024;
const LEGACY_NPM_SHIM_TARGET_MARKER = 'node_modules/opencode-ai/bin/';
const V2_NPM_SHIM_TARGET_MARKER = `node_modules/${OPENCODE_V2_NPM_WRAPPER_PACKAGE}/bin/`;

type WindowsNpmOpenCodeBinding = 'legacy' | 'v2' | 'unknown';

/** Platform packages npm adds under the legacy wrapper package on Windows. */
function getLegacyWindowsPlatformPackageNames(): string[] {
  return process.arch === 'x64'
    ? ['opencode-windows-x64', 'opencode-windows-x64-baseline']
    : [`opencode-windows-${process.arch}`];
}

function collectLegacyWindowsNativeCandidates(shimDirectory: string): string[] {
  const packageRoot = path.join(shimDirectory, 'node_modules', LEGACY_NPM_ROOT_PACKAGE_NAME);
  return [
    path.join(packageRoot, 'bin', WINDOWS_EXECUTABLE_NAME),
    ...getLegacyWindowsPlatformPackageNames().map((packageName) =>
      path.join(packageRoot, 'node_modules', packageName, 'bin', WINDOWS_EXECUTABLE_NAME)
    ),
  ];
}

function collectV2WindowsNativeCandidates(shimDirectory: string): string[] {
  const wrapperBinaryPath = path.join(
    shimDirectory,
    'node_modules',
    OPENCODE_V2_NPM_WRAPPER_PACKAGE,
    'bin',
    WINDOWS_EXECUTABLE_NAME
  );
  // Reuse the npm wrapper mapping introduced for explicit overrides: the runtime
  // admits only the platform package delivery, never the wrapper copy under bin/.
  const platformBinaryPath = resolveOpenCodeV2NpmWrapperBinary(wrapperBinaryPath);
  return platformBinaryPath ? [platformBinaryPath] : [];
}

/**
 * Which npm package the shim was generated for, decided from its static text only.
 * The npm shim template invokes `<prefix>/node_modules/<package>/bin/...`, so a
 * single known package marker identifies the active installation. No marker (a
 * custom wrapper) or both markers (ambiguous) fall back to the deterministic
 * legacy-first order used before this binding check existed.
 */
function readWindowsNpmShimBinding(shimPath: string): WindowsNpmOpenCodeBinding {
  let contents: string;
  try {
    const info = statSync(shimPath);
    if (!info.isFile() || info.size <= 0 || info.size > NPM_SHIM_MAX_BYTES) {
      return 'unknown';
    }
    contents = readFileSync(shimPath, 'utf8');
  } catch {
    return 'unknown';
  }
  if (contents.includes('\0')) {
    return 'unknown';
  }
  const normalizedContents = contents.replaceAll('\\', '/').toLowerCase();
  const mentionsLegacy = normalizedContents.includes(LEGACY_NPM_SHIM_TARGET_MARKER);
  const mentionsV2 = normalizedContents.includes(V2_NPM_SHIM_TARGET_MARKER);
  if (mentionsLegacy === mentionsV2) {
    return 'unknown';
  }
  return mentionsLegacy ? 'legacy' : 'v2';
}

/**
 * Native OpenCode executables a Windows PATH candidate can launch without a shell.
 *
 * npm installs OpenCode as `.cmd`/`.bat` shell shims plus a POSIX `opencode` shell
 * script. None of those can be spawned without a shell, so resolve the npm package
 * layout next to the shim instead of probing the shim itself.
 *
 * The shim names the package the user's `opencode` command actually runs, so that
 * install's native delivery is preferred even when both the legacy `opencode-ai`
 * and current `@opencode/cli` packages coexist. The other installed layout stays
 * as an ordered fallback for a missing or version-rejected shim target; with no
 * usable native candidate the caller falls through to the managed runtime instead
 * of reporting a shim as a healthy binary.
 */
export function collectWindowsNativeOpenCodeBinaryCandidates(binaryPath: string): string[] {
  if (process.platform !== 'win32') {
    return [binaryPath];
  }
  if (/\.exe$/i.test(binaryPath)) {
    return [binaryPath];
  }
  const shimDirectory = path.dirname(binaryPath);
  const legacyCandidates = collectLegacyWindowsNativeCandidates(shimDirectory);
  const v2Candidates = collectV2WindowsNativeCandidates(shimDirectory);
  const orderedCandidates =
    readWindowsNpmShimBinding(binaryPath) === 'v2'
      ? [...v2Candidates, ...legacyCandidates]
      : [...legacyCandidates, ...v2Candidates];
  return orderedCandidates.filter(isAbsoluteExistingFile);
}
