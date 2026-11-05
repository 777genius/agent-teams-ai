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
  opencodeV2?: {
    qualified?: Record<string, string[]>;
  };
  opencodeV2Delivery?: Record<string, {
    engineVersions?: string[];
    sourceCommit?: string;
    archive?: { sha256?: string };
  }>;
}

export type OpenCodeV2StaticPreflight =
  | { kind: 'hold'; reason: 'generation' | 'driver-version' | 'runtime-version' |
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
const nativeSession = /^ses_[A-Za-z0-9]+$/;
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
      directory.slice(root.length).split('\\').every(segment => segment.length > 0 && !/[ .]$/.test(segment));
  }
  return posix.isAbsolute(directory) && posix.normalize(directory) === directory && directory !== '/';
}

/** Requires an independently verified exact binary digest/version; does not itself read the binary. */
export function preflightOpenCodeV2Selection(
  selection: Readonly<OpenCodeV2Selection>,
  lock: Readonly<OpenCodeV2RuntimeLock>
): OpenCodeV2StaticPreflight {
  if (selection.generation !== 'v2' || !platforms.has(selection.platform))
    return { kind: 'hold', reason: 'generation' };
  if (!pinnedDriverVersions.has(selection.version))
    return { kind: 'hold', reason: 'driver-version' };
  if (!lock.opencodeV2?.qualified?.[selection.platform]?.includes(selection.version))
    return { kind: 'hold', reason: 'runtime-version' };
  const delivery = lock.opencodeV2Delivery?.[selection.platform];
  if (!delivery?.engineVersions?.includes(selection.version) ||
      !commit.test(delivery.sourceCommit ?? '') || !sha256.test(delivery.archive?.sha256 ?? ''))
    return { kind: 'hold', reason: 'delivery' };
  if (selection.nativeReportedVersion !== selection.version)
    return { kind: 'hold', reason: 'native-version' };
  if (!sha256.test(selection.executableSha256) ||
      !sha256.test(selection.observedExecutableSha256) ||
      !timingSafeEqual(Buffer.from(selection.executableSha256, 'hex'),
        Buffer.from(selection.observedExecutableSha256, 'hex')))
    return { kind: 'hold', reason: 'binary-digest' };
  const port = endpoint.exec(selection.endpoint)?.[1];
  if (!port || Number(port) > 65535 || !isCanonicalOpenCodeV2Directory(selection.platform, selection.directory) ||
      !nativeSession.test(selection.nativeSessionId) ||
      !selection.sessionBinding || !selection.accountBinding)
    return { kind: 'hold', reason: 'binding' };
  return {
    kind: 'candidate', platform: selection.platform, version: selection.version,
    sourceCommit: delivery.sourceCommit!, archiveSha256: delivery.archive!.sha256!,
  };
}
