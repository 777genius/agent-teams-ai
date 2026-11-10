import fs from 'node:fs';
import path from 'node:path';

export const OPENCODE_RUNTIME_BINARY_PATH_ENV = 'CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH';
export const OPENCODE_LEGACY_BINARY_PATH_ENV = 'OPENCODE_BIN_PATH';
/** Env the console wrapper reads to find the real OpenCode binary. */
export const OPENCODE_CONSOLE_WRAPPER_TARGET_ENV = 'OPENCODE_CONSOLE_WRAPPER_TARGET';
/** Set to "0" to launch the real OpenCode binary directly (no console wrapper). */
export const OPENCODE_CONSOLE_WRAPPER_DISABLE_ENV = 'AGENT_TEAMS_OPENCODE_CONSOLE_WRAPPER';
const OPENCODE_CONSOLE_WRAPPER_RELATIVE_PATH = ['runtime', 'opencode-console', 'opencode.exe'];
const OPENCODE_CONSOLE_WRAPPER_SIDECAR = 'opencode.real.path';

export interface OpenCodeBinaryOverride {
  binaryPath: string;
  envName: string;
}

/**
 * The deliberate OpenCode binary override: the first non-empty override variable,
 * checking each environment in order. Launch and status share this selection.
 */
export function readOpenCodeBinaryOverride(
  ...envs: (NodeJS.ProcessEnv | null | undefined)[]
): OpenCodeBinaryOverride | null {
  for (const env of envs) {
    for (const envName of [OPENCODE_RUNTIME_BINARY_PATH_ENV, OPENCODE_LEGACY_BINARY_PATH_ENV]) {
      const binaryPath = env?.[envName]?.trim();
      if (binaryPath) return { binaryPath, envName };
    }
  }
  return null;
}

export function isOpenCodeConsoleWrapperBinaryPath(binaryPath: string): boolean {
  const matches = (candidate: string): boolean =>
    normalizePathEntryForCompare(candidate).endsWith(
      path.sep + OPENCODE_CONSOLE_WRAPPER_RELATIVE_PATH.join(path.sep)
    );
  if (matches(binaryPath)) return true;
  try {
    return matches(fs.realpathSync(binaryPath));
  } catch {
    return false;
  }
}

export interface OpenCodeConsoleWrapperOptions {
  /** Electron resources path (defaults to process.resourcesPath). */
  resourcesPath?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Main-only hint bound to the exact candidate measured by the cached version probe. */
  verifiedNativeV2BinaryPath?: string;
}

/**
 * On Windows the orchestrator starts `opencode serve` hosts detached (no
 * console), so every console child they spawn (cmd.exe for the bash tool,
 * cursor-agent.cmd -> powershell, ...) allocates a new visible console window
 * that flashes and steals focus. resources/runtime/opencode-console/opencode.exe
 * (tools/opencode-console-wrapper) is a GUI-subsystem launcher that starts the
 * real binary with CREATE_NO_WINDOW, giving the host a hidden console that all
 * descendants inherit. When it is present, the orchestrator is pointed at the
 * wrapper and the real path is published through env + a sidecar file.
 */
export function resolveOpenCodeConsoleWrapperPath(
  realBinaryPath: string,
  options: OpenCodeConsoleWrapperOptions = {}
): string | null {
  const platform = options.platform ?? process.platform;
  const sourceEnv = options.env ?? process.env;
  if (platform !== 'win32' || sourceEnv[OPENCODE_CONSOLE_WRAPPER_DISABLE_ENV]?.trim() === '0') {
    return null;
  }
  const resourcesPath = (options.resourcesPath ?? process.resourcesPath)?.trim();
  if (!resourcesPath) {
    return null;
  }
  const wrapperPath = path.join(resourcesPath, ...OPENCODE_CONSOLE_WRAPPER_RELATIVE_PATH);
  if (normalizePathEntryForCompare(realBinaryPath) === normalizePathEntryForCompare(wrapperPath)) {
    return wrapperPath;
  }
  try {
    if (!fs.statSync(wrapperPath).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  const sidecarPath = path.join(path.dirname(wrapperPath), OPENCODE_CONSOLE_WRAPPER_SIDECAR);
  try {
    let current = '';
    try {
      current = fs.readFileSync(sidecarPath, 'utf8').trim();
    } catch {
      current = '';
    }
    if (current !== realBinaryPath) {
      fs.writeFileSync(sidecarPath, realBinaryPath, 'utf8');
    }
  } catch {
    // A read-only resources directory only costs the sidecar: the wrapper also
    // reads its target from OPENCODE_CONSOLE_WRAPPER_TARGET, set below.
  }
  return wrapperPath;
}

/**
 * Official Windows V2 CLI package manifests. Any of their `bin/opencode.exe`
 * deliveries is the SDK-selected native binary, whichever architecture or
 * baseline the machine picked.
 */
const WINDOWS_V2_CLI_PACKAGE_NAMES = new Set([
  '@opencode/cli-windows-x64',
  '@opencode/cli-windows-x64-baseline',
  '@opencode/cli-windows-arm64',
]);

/** Routing hint only. The SDK still measures the selected native delivery. */
function selectedWindowsV2PackageBinary(binaryPath: string): string | null {
  if (!path.isAbsolute(binaryPath)) return null;
  try {
    const selected = fs.realpathSync(binaryPath);
    if (
      !fs.statSync(selected).isFile() ||
      path.basename(selected).toLowerCase() !== 'opencode.exe' ||
      path.basename(path.dirname(selected)).toLowerCase() !== 'bin'
    )
      return null;
    const metadata = readOpenCodePackageManifest(
      path.join(path.dirname(path.dirname(selected)), 'package.json')
    );
    if (
      !metadata ||
      !WINDOWS_V2_CLI_PACKAGE_NAMES.has(metadata.name) ||
      !OPENCODE_V2_PACKAGE_VERSION.test(metadata.version)
    )
      return null;
    return selected;
  } catch {
    return null;
  }
}

const OPENCODE_V2_PACKAGE_VERSION = /^2\.\d+\.\d+$/;
/** npm wrapper package whose `bin/opencode.exe` links to a platform package delivery. */
export const OPENCODE_V2_NPM_WRAPPER_PACKAGE = '@opencode/cli';

function readOpenCodePackageManifest(
  manifestPath: string
): { name: string; version: string } | null {
  try {
    const info = fs.lstatSync(manifestPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 64 * 1024)
      return null;
    const metadata: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      !('name' in metadata) ||
      typeof metadata.name !== 'string' ||
      !('version' in metadata) ||
      typeof metadata.version !== 'string'
    )
      return null;
    return { name: metadata.name, version: metadata.version };
  } catch {
    return null;
  }
}

function hasSameFileContent(left: string, right: string): boolean {
  const chunkSize = 1024 * 1024;
  const leftBuffer = Buffer.alloc(chunkSize);
  const rightBuffer = Buffer.alloc(chunkSize);
  const leftFd = fs.openSync(left, 'r');
  try {
    const rightFd = fs.openSync(right, 'r');
    try {
      for (;;) {
        const leftRead = fs.readSync(leftFd, leftBuffer, 0, chunkSize, null);
        const rightRead = fs.readSync(rightFd, rightBuffer, 0, chunkSize, null);
        if (leftRead !== rightRead) return false;
        if (leftRead === 0) return true;
        if (!leftBuffer.subarray(0, leftRead).equals(rightBuffer.subarray(0, rightRead)))
          return false;
      }
    } finally {
      fs.closeSync(rightFd);
    }
  } finally {
    fs.closeSync(leftFd);
  }
}

const npmWrapperCopyMatches = new Map<string, string>();

/**
 * `npm i -g @opencode/cli` links `opencode` to the wrapper package's `bin/opencode.exe`,
 * which its postinstall hard-links (or copies) from one platform package. The runtime
 * admits only the platform package delivery, so this returns that package's binary:
 * the same file, or the copy source. Any other path returns null.
 */
export function resolveOpenCodeV2NpmWrapperBinary(
  binaryPath: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (!path.isAbsolute(binaryPath)) return null;
  const sameName = (left: string, right: string): boolean =>
    platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  try {
    const selected = fs.realpathSync(binaryPath);
    const binDirectory = path.dirname(selected);
    if (!sameName(path.basename(binDirectory), 'bin')) return null;
    const wrapperRoot = path.dirname(binDirectory);
    const wrapper = readOpenCodePackageManifest(path.join(wrapperRoot, 'package.json'));
    if (
      wrapper?.name !== OPENCODE_V2_NPM_WRAPPER_PACKAGE ||
      !OPENCODE_V2_PACKAGE_VERSION.test(wrapper.version)
    )
      return null;
    // bigint: a Windows file ID does not fit a double, so number inodes can collide.
    const selectedStat = fs.statSync(selected, { bigint: true });
    if (!selectedStat.isFile()) return null;

    const packagePrefix = `cli-${platform === 'win32' ? 'windows' : platform}-`;
    const executableName = platform === 'win32' ? 'opencode.exe' : 'opencode';
    const scopeDirectories = [path.join(wrapperRoot, 'node_modules', '@opencode')];
    // npm hoists optional dependencies next to the wrapper when it can.
    if (sameName(path.basename(path.dirname(wrapperRoot)), '@opencode')) {
      scopeDirectories.push(path.dirname(wrapperRoot));
    }
    const sameSizeCandidates: string[] = [];
    for (const scopeDirectory of scopeDirectories) {
      let entries: string[];
      try {
        entries = fs.readdirSync(scopeDirectory);
      } catch {
        continue;
      }
      for (const entry of entries
        .filter((name) => name.startsWith(packagePrefix))
        .sort((left, right) => left.localeCompare(right))) {
        const packageRoot = path.join(scopeDirectory, entry);
        const manifest = readOpenCodePackageManifest(path.join(packageRoot, 'package.json'));
        if (manifest?.name !== `@opencode/${entry}` || manifest.version !== wrapper.version) {
          continue;
        }
        const candidate = path.join(packageRoot, 'bin', executableName);
        let candidateStat: fs.BigIntStats;
        try {
          candidateStat = fs.statSync(candidate, { bigint: true });
        } catch {
          continue;
        }
        if (!candidateStat.isFile() || candidateStat.size !== selectedStat.size) continue;
        if (candidateStat.dev === selectedStat.dev && candidateStat.ino === selectedStat.ino) {
          return candidate;
        }
        sameSizeCandidates.push(candidate);
      }
    }

    // A copy (no hard link): one same-size platform binary of the wrapper's version is its
    // source. Only several same-size candidates need a byte comparison, cached per file version.
    if (sameSizeCandidates.length <= 1) return sameSizeCandidates[0] ?? null;
    const cacheKey = [platform, selected, selectedStat.size, selectedStat.mtimeMs].join('\0');
    const cached = npmWrapperCopyMatches.get(cacheKey);
    if (cached && sameSizeCandidates.includes(cached)) return cached;
    const copied = sameSizeCandidates.find((candidate) => hasSameFileContent(candidate, selected));
    if (copied) npmWrapperCopyMatches.set(cacheKey, copied);
    return copied ?? null;
  } catch {
    return null;
  }
}

function normalizePathEntryForCompare(value: string): string {
  const normalized = path.resolve(value.trim());
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function prependPathEntry(env: NodeJS.ProcessEnv, directory: string): void {
  const trimmedDirectory = directory.trim();
  if (!trimmedDirectory) {
    return;
  }

  const currentPath = env.PATH ?? '';
  const currentEntries = currentPath.split(path.delimiter).filter(Boolean);
  const normalizedDirectory = normalizePathEntryForCompare(trimmedDirectory);
  const remainingEntries = currentEntries.filter(
    (entry) => normalizePathEntryForCompare(entry) !== normalizedDirectory
  );
  env.PATH = [trimmedDirectory, ...remainingEntries].join(path.delimiter);
}

export function applyOpenCodeRuntimeBinaryEnv(
  env: NodeJS.ProcessEnv,
  discoveredBinaryPath: string | null | undefined,
  wrapperOptions: OpenCodeConsoleWrapperOptions = {}
): void {
  const existingBinaryPath = env[OPENCODE_RUNTIME_BINARY_PATH_ENV]?.trim();
  const existingLegacyBinaryPath = env[OPENCODE_LEGACY_BINARY_PATH_ENV]?.trim();
  const configuredBinaryPath =
    existingBinaryPath || existingLegacyBinaryPath || discoveredBinaryPath?.trim() || '';
  if (!configuredBinaryPath) {
    return;
  }
  const npmWrapperTarget = resolveOpenCodeV2NpmWrapperBinary(
    configuredBinaryPath,
    wrapperOptions.platform ?? process.platform
  );
  if (npmWrapperTarget) {
    // The runtime rejects the npm wrapper copy, so both variables name the platform binary.
    env[OPENCODE_RUNTIME_BINARY_PATH_ENV] = npmWrapperTarget;
    env[OPENCODE_LEGACY_BINARY_PATH_ENV] = npmWrapperTarget;
  }
  const nextBinaryPath = npmWrapperTarget ?? configuredBinaryPath;

  if ((wrapperOptions.platform ?? process.platform) === 'win32') {
    // A selected console wrapper cannot establish a native identity from a stale target.
    const verifiedV2 = wrapperOptions.verifiedNativeV2BinaryPath;
    const nativeV2 =
      !isOpenCodeConsoleWrapperBinaryPath(nextBinaryPath) && path.isAbsolute(nextBinaryPath)
        ? verifiedV2 &&
          normalizePathEntryForCompare(verifiedV2) === normalizePathEntryForCompare(nextBinaryPath)
          ? nextBinaryPath
          : selectedWindowsV2PackageBinary(nextBinaryPath)
        : null;
    if (nativeV2) {
      env[OPENCODE_RUNTIME_BINARY_PATH_ENV] = nativeV2;
      env[OPENCODE_LEGACY_BINARY_PATH_ENV] = nativeV2;
      delete env[OPENCODE_CONSOLE_WRAPPER_TARGET_ENV];
      prependPathEntry(env, path.dirname(nativeV2));
      return;
    }
  }

  const wrapperPath = path.isAbsolute(nextBinaryPath)
    ? resolveOpenCodeConsoleWrapperPath(nextBinaryPath, wrapperOptions)
    : null;
  if (
    wrapperPath &&
    normalizePathEntryForCompare(wrapperPath) !== normalizePathEntryForCompare(nextBinaryPath)
  ) {
    env[OPENCODE_CONSOLE_WRAPPER_TARGET_ENV] = nextBinaryPath;
    env[OPENCODE_RUNTIME_BINARY_PATH_ENV] = wrapperPath;
    env[OPENCODE_LEGACY_BINARY_PATH_ENV] = wrapperPath;
    // PATH-based lookups keep resolving the real runtime directory.
    prependPathEntry(env, path.dirname(nextBinaryPath));
    return;
  }

  if (!existingBinaryPath) {
    env[OPENCODE_RUNTIME_BINARY_PATH_ENV] = nextBinaryPath;
  }
  if (!existingLegacyBinaryPath) {
    env[OPENCODE_LEGACY_BINARY_PATH_ENV] = nextBinaryPath;
  }

  if (!path.isAbsolute(nextBinaryPath)) {
    return;
  }
  if (wrapperPath) {
    // env already points at the wrapper: make sure PATH carries the real runtime
    // directory (the sidecar file carries the real path for the wrapper itself).
    const target = env[OPENCODE_CONSOLE_WRAPPER_TARGET_ENV]?.trim();
    if (target && path.isAbsolute(target)) {
      prependPathEntry(env, path.dirname(target));
      return;
    }
  }

  // Facts:
  // - The app-managed OpenCode status is resolved from the app runtime manifest.
  // - Released claude-multimodel builds have used both OPENCODE_BIN_PATH and
  //   CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH while the managed runtime path evolved.
  // - Older claude-multimodel readiness inventory still resolves "opencode" through PATH.
  // - Exposing the selected binary directory keeps both checks on the same runtime.
  prependPathEntry(env, path.dirname(nextBinaryPath));
}
