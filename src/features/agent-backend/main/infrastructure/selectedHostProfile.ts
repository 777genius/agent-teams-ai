import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { execFileWithLinuxChildLaunch } from '@main/utils/linuxChildLaunch';

import type { HostClientFailureCode, HostRequestOutcome } from '../../contracts';
import type { HostReviewTransportProfile } from '@agent-teams/legacy-agent-host/contracts';

export class HostClientError extends Error {
  constructor(
    readonly code: HostClientFailureCode,
    readonly outcome: HostRequestOutcome
  ) {
    super(`Host client: ${code} (${outcome})`);
    this.name = 'HostClientError';
  }
}

/** Trusted composition input. Never populate this from renderer/tool arguments. */
export interface SelectedHostProfile {
  readonly profileId: string;
  readonly reviewTransport?: HostReviewTransportProfile;
  readonly nodeExecutable: string;
  readonly nodeVersion: string;
  readonly nodeSha256: string;
  readonly hostEntry: string;
  readonly hostEntrySha256: string;
  readonly expectedBuildId: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly writeTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
}

export function captureHostProfile(profile: SelectedHostProfile): SelectedHostProfile {
  const paths = [profile.nodeExecutable, profile.hostEntry, profile.cwd, profile.env.HOME];
  const budgets = [
    profile.startupTimeoutMs,
    profile.requestTimeoutMs,
    profile.writeTimeoutMs,
    profile.shutdownTimeoutMs,
  ];
  if (
    !profile.profileId ||
    (profile.reviewTransport !== undefined && profile.reviewTransport !== 'review-v1') ||
    !profile.expectedBuildId ||
    !/^v24\.(?:2[1-9]|[3-9]\d|\d{3,})\.\d+$/.test(profile.nodeVersion) ||
    paths.some((path) => !path || !isAbsolute(path)) ||
    [profile.nodeSha256, profile.hostEntrySha256].some(
      (digest) => !/^[a-f0-9]{64}$/.test(digest)
    ) ||
    budgets.some((value) => !Number.isSafeInteger(value) || value <= 0 || value > 300_000) ||
    Object.entries(profile.env).some(
      ([key, value]) => !key || /[=\0]/.test(key) || value.includes('\0')
    )
  ) {
    throw new HostClientError('invalid-profile', 'not-dispatched');
  }
  return Object.freeze({ ...profile, env: Object.freeze({ ...profile.env }) });
}

/** Same immutable source binding used by the replaceable client and its original physical owner. */
export function capturedHostProfileDigest(profile: SelectedHostProfile): string {
  const { env, startupTimeoutMs: _startup, requestTimeoutMs: _request,
    writeTimeoutMs: _write, shutdownTimeoutMs: _shutdown, ...source } = profile;
  return createHash('sha256').update(JSON.stringify({ ...source,
    env: Object.entries(env).sort(([a], [b]) => a.localeCompare(b)) })).digest('hex');
}

export function remainingHostStartup(profile: SelectedHostProfile, remaining?: () => number): number {
  if (!remaining) return profile.startupTimeoutMs;
  try {
    const value = Math.floor(remaining());
    if (Number.isSafeInteger(value) && value > 0) return Math.min(profile.startupTimeoutMs, value);
  } catch { /* The original recovery cutoff/currentness remains authoritative. */ }
  throw new HostClientError('request-timeout', 'not-dispatched');
}

export async function validateHostProfile(
  profile: SelectedHostProfile,
  remaining?: () => number
): Promise<void> {
  try {
    remainingHostStartup(profile, remaining);
    for (const [path, expected] of [
      [profile.nodeExecutable, profile.nodeSha256],
      [profile.hostEntry, profile.hostEntrySha256],
    ]) {
      if ((await realpath(path)) !== path || !(await stat(path)).isFile()) {
        throw new HostClientError('profile-mismatch', 'not-dispatched');
      }
      remainingHostStartup(profile, remaining);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      remainingHostStartup(profile, remaining);
      const digest = hash.digest('hex');
      if (digest !== expected) throw new HostClientError('profile-mismatch', 'not-dispatched');
    }
    await access(profile.nodeExecutable, constants.X_OK);
    if (!(await stat(profile.cwd)).isDirectory() || !(await stat(profile.env.HOME)).isDirectory()) {
      throw new HostClientError('invalid-profile', 'not-dispatched');
    }
    remainingHostStartup(profile, remaining);
    const version = await new Promise<string>((resolve, reject) => {
      execFileWithLinuxChildLaunch(
        profile.nodeExecutable,
        ['--version'],
        {
          cwd: profile.cwd,
          env: { ...profile.env },
          timeout: remainingHostStartup(profile, remaining),
          maxBuffer: 1024,
          windowsHide: true,
        },
        (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim()))
      );
    });
    remainingHostStartup(profile, remaining);
    if (version !== profile.nodeVersion)
      throw new HostClientError('profile-mismatch', 'not-dispatched');
  } catch (error) {
    if (error instanceof HostClientError) throw error;
    throw new HostClientError('invalid-profile', 'not-dispatched');
  }
}
