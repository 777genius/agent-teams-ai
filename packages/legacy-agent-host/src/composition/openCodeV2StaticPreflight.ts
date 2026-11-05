import { timingSafeEqual } from 'node:crypto';
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
      'delivery' | 'native-version' | 'binary-digest' | 'binding' }
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
  return posix.isAbsolute(directory) && posix.normalize(directory) === directory && directory !== '/';
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
