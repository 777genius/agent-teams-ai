import { createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

/**
 * V2.0 qualification boundary, not a native readiness certificate.
 * Only trusted Host composition may provide these captures. Neither the renderer nor
 * a model choice may select the engine, executable, lease or session identity.
 * A passing result permits a later *read-only native probe*, never submit/launch.
 */
export interface OpenCodeV2Selection {
  generation: string;
  platform: string;
  version: string;
  nativeReportedVersion: string;
  executableSha256: string;
  observedExecutableSha256: string;
  endpoint: string;
  directory: string;
  nativeSessionId: string;
  sessionBinding: string;
  accountBinding: string;
}

export interface OpenCodeV2RuntimeLock {
  version?: string;
  opencodeV2?: {
    qualified?: Record<string, string[]>;
  };
  opencodeV2Delivery?: Record<string, {
    schemaVersion?: number;
    bridgeProtocol?: number;
    engineVersions?: string[];
    sourceCommit?: string;
    platform?: string;
    arch?: string;
    runtimeVersion?: string;
    archive?: { sha256?: string };
  }>;
}

export type OpenCodeV2StaticPreflight =
  | { kind: 'hold'; reason: 'generation' | 'platform' | 'driver-version' | 'runtime-version' |
      'delivery' | 'native-version' | 'binary-digest' | 'binding' | 'current-product' }
  | { kind: 'candidate'; platform: string; version: string; sourceCommit: string; archiveSha256: string };

// Exact pinned private factory at agent-teams-ai/old-provider-implementations PR #1,
// 7573a508. These are *not* the Desktop launcher engine qualification versions.
const pinnedDriverVersions = new Set(['2.0.0', '2.0.21']);
const platforms = new Set([
  'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64',
]);
const sha256 = /^[0-9a-f]{64}$/;
const commit = /^[0-9a-f]{40}$/;
// The pinned private V2 DriverConfig accepts only alphanumeric ses_ suffixes.
// Keep Host admission no wider than that executable driver contract.
const nativeSession = /^ses_[A-Za-z0-9]{1,256}$/;
const endpoint = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;

/**
 * Lexical captured-path guard only; native realpath/process ownership still require
 * a separate TEST-owned proof. Do not accept drive-relative, UNC, root or traversal.
 */
export function isCanonicalOpenCodeV2Directory(platform: string, directory: string): boolean {
  if (typeof directory !== 'string' || directory.length === 0 ||
      directory.length > 8192 || directory.includes('\0')) return false;
  if (platform.startsWith('win32-')) {
    const root = win32.parse(directory).root;
    return /^[A-Za-z]:\\/.test(directory) && win32.isAbsolute(directory) &&
      win32.normalize(directory) === directory && directory.length > root.length &&
      directory.slice(root.length).split('\\').every(segment =>
        segment.length > 0 && !/[ .]$/.test(segment) &&
        // Win32 device aliases and NTFS alternate data streams are not normal
        // workspace directories even when path.normalize() leaves them unchanged.
        !/[<>:"|?*\x00-\x1f]/.test(segment) &&
        !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(segment));
  }
  return posix.isAbsolute(directory) && !directory.endsWith('/') &&
    posix.normalize(directory) === directory && directory !== '/';
}

/** Requires an independently verified exact binary digest/version; does not itself read the binary. */
export function preflightOpenCodeV2Selection(
  selection: Readonly<OpenCodeV2Selection>,
  lock: Readonly<OpenCodeV2RuntimeLock>
): OpenCodeV2StaticPreflight {
  // A malformed captured profile/manifest must HOLD rather than crash the Host.
  // These values originate from serialized data; TypeScript types alone are not runtime proof.
  if (selection === null || typeof selection !== 'object' || Array.isArray(selection))
    return { kind: 'hold', reason: 'binding' };
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock))
    return { kind: 'hold', reason: 'runtime-version' };
  if (selection.generation !== 'v2')
    return { kind: 'hold', reason: 'generation' };
  if (!platforms.has(selection.platform))
    return { kind: 'hold', reason: 'platform' };
  if (!pinnedDriverVersions.has(selection.version))
    return { kind: 'hold', reason: 'driver-version' };
  // Runtime manifests are JSON, not trustworthy TypeScript objects. String.includes
  // would otherwise accept a forged "2.0.21" substring as a qualified version.
  const qualified = lock.opencodeV2?.qualified?.[selection.platform];
  if (!Array.isArray(qualified) || !qualified.every((value) => typeof value === 'string') ||
      !qualified.includes(selection.version))
    return { kind: 'hold', reason: 'runtime-version' };
  const delivery = lock.opencodeV2Delivery?.[selection.platform];
  const delivered = delivery?.engineVersions;
  const [expectedPlatform, expectedArch] = selection.platform.split('-');
  // A digest for another OS or release is not an authenticated native engine
  // for this tuple. Selectors and delivery metadata must agree before probing.
  if (typeof lock.version !== 'string' || !lock.version ||
      // A future delivery schema/bridge must not be mistaken for an already
      // qualified native protocol, even when its engine and digest match.
      delivery?.schemaVersion !== 1 || delivery?.bridgeProtocol !== 1 ||
      delivery?.runtimeVersion !== lock.version ||
      delivery?.platform !== expectedPlatform || delivery?.arch !== expectedArch ||
      !Array.isArray(delivered) || !delivered.every((value) => typeof value === 'string') ||
      !delivered.includes(selection.version) ||
      typeof delivery?.sourceCommit !== 'string' || !commit.test(delivery.sourceCommit) ||
      typeof delivery?.archive?.sha256 !== 'string' || !sha256.test(delivery.archive.sha256))
    return { kind: 'hold', reason: 'delivery' };
  if (selection.nativeReportedVersion !== selection.version)
    return { kind: 'hold', reason: 'native-version' };
  if (typeof selection.executableSha256 !== 'string' ||
      typeof selection.observedExecutableSha256 !== 'string' ||
      !sha256.test(selection.executableSha256) ||
      !sha256.test(selection.observedExecutableSha256) ||
      !timingSafeEqual(Buffer.from(selection.executableSha256, 'hex'),
        Buffer.from(selection.observedExecutableSha256, 'hex')))
    return { kind: 'hold', reason: 'binary-digest' };
  const port = typeof selection.endpoint === 'string' ? endpoint.exec(selection.endpoint)?.[1] : undefined;
  if (!port || Number(port) > 65535 || !isCanonicalOpenCodeV2Directory(selection.platform, selection.directory) ||
      typeof selection.nativeSessionId !== 'string' || !nativeSession.test(selection.nativeSessionId) ||
      typeof selection.sessionBinding !== 'string' || !selection.sessionBinding.trim() ||
      typeof selection.accountBinding !== 'string' || !selection.accountBinding.trim())
    return { kind: 'hold', reason: 'binding' };
  return {
    kind: 'candidate', platform: selection.platform, version: selection.version,
    sourceCommit: delivery.sourceCommit!, archiveSha256: delivery.archive!.sha256!,
  };
}


/**
 * Read-only admission against BOTH the Stage1 capture and the currently
 * selected product distribution. A Stage1 lock can still qualify 2.0.0 while
 * the current Desktop product ships only 2.1.4. A synthetic candidate on the
 * historical lock must never be treated as a product/native launch witness.
 *
 * Even a candidate here is NOT V2 process custody, effective permissions,
 * native Session SPI, packaged E2E or authorization to submit work.
 */
export function preflightOpenCodeV2CurrentProduct(
  selection: Readonly<OpenCodeV2Selection>,
  stageLock: Readonly<OpenCodeV2RuntimeLock>,
  productLock: Readonly<OpenCodeV2RuntimeLock>
): OpenCodeV2StaticPreflight {
  const stage = preflightOpenCodeV2Selection(selection, stageLock);
  if (stage.kind === 'hold') return stage;
  const product = preflightOpenCodeV2Selection(selection, productLock);
  if (product.kind === 'hold' ||
      stageLock.version !== productLock.version ||
      stage.sourceCommit !== product.sourceCommit ||
      stage.archiveSha256 !== product.archiveSha256)
    return { kind: 'hold', reason: 'current-product' };
  return stage;
}


/**
 * READ-ONLY V01 binary measurement of a Host-selected native executable.
 *
 * Unlike the static selection's caller-supplied observed hash, this digest is
 * computed from an actual open file descriptor, with path identity checked on
 * both sides. Callers still MUST independently pin expectedSha256 to a trusted
 * distribution and bind the subsequently started native CHILD PID to that
 * executable. Measuring a CLI wrapper never qualifies its spawned engine.
 *
 * No process is started, no user configuration is read or modified.
 */
export async function measureOpenCodeV2Executable(
  executablePath: string,
  expectedSha256: string
): Promise<{ kind: 'hold'; reason: 'path' | 'read' | 'digest' } |
  { kind: 'measured'; executableSha256: string }> {
  const currentTuple = `${process.platform}-${process.arch}`;
  // Reuse the existing OS-specific canonical guard: a Windows UNC, device
  // alias or ADS is not an acceptable executable location even with a hash.
  if (!platforms.has(currentTuple) ||
      !isCanonicalOpenCodeV2Directory(currentTuple, executablePath))
    return { kind: 'hold', reason: 'path' };
  if (typeof expectedSha256 !== 'string' || !sha256.test(expectedSha256))
    return { kind: 'hold', reason: 'digest' };
  try {
    if (await realpath(executablePath) !== executablePath)
      return { kind: 'hold', reason: 'path' };
    // A realpath-checked path can still name a FIFO. POSIX O_NONBLOCK keeps the
    // read-only preflight from hanging on open before fstat can reject it.
    // O_NOFOLLOW also closes the final-component symlink swap window.
    // Windows uses its ordinary read-only flag; its device/path aliases are
    // rejected by isCanonicalOpenCodeV2Directory before opening anything.
    const flags = process.platform === 'win32' ? constants.O_RDONLY :
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
    const handle = await open(executablePath, flags);
    try {
      const before = await handle.stat({ bigint: true });
      // Never hash an unbounded or empty input: a TEST-owned path can name a
      // sparse huge file or grow concurrently while a read is in progress.
      // The native binary must be a bounded regular file before it can be measured.
      if (!before.isFile() || before.size === 0n || before.size > 1024n * 1024n * 1024n)
        return { kind: 'hold', reason: 'path' };
      const hash = createHash('sha256');
      let bytesRead = 0n;
      for await (const chunk of handle.createReadStream({
        autoClose: false, end: Number(before.size - 1n),
      })) {
        bytesRead += BigInt(chunk.length);
        hash.update(chunk);
      }
      const after = await handle.stat({ bigint: true });
      const byPath = await stat(executablePath, { bigint: true });
      if (bytesRead !== before.size ||
          before.dev !== after.dev || before.ino !== after.ino ||
          before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs ||
          before.dev !== byPath.dev || before.ino !== byPath.ino ||
          await realpath(executablePath) !== executablePath)
        return { kind: 'hold', reason: 'path' };
      const observed = hash.digest();
      if (!timingSafeEqual(Buffer.from(expectedSha256, 'hex'), observed))
        return { kind: 'hold', reason: 'digest' };
      return { kind: 'measured', executableSha256: observed.toString('hex') };
    } finally {
      await handle.close();
    }
  } catch {
    // A missing, symlinked, replaced or unreadable executable never authorizes
    // fallback to PATH, a V1 CLI, or a second binary.
    return { kind: 'hold', reason: 'read' };
  }
}
