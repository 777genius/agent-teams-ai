import { join } from 'node:path';

import {
  captureCliProcessStop,
  readVerifiedCliProcessRelease,
  type VerifiedCliProcessRelease,
} from '@main/utils/cliProcessCustody';

import {
  type LegacyNativeCensus,
  type LegacyNativeTarget,
  nativeRecord,
  nativeReleaseDigest,
  readLegacyNativeCensus,
  readNativeRecord,
} from './LegacyNativeStopCensus';

import type { ChildProcess } from 'node:child_process';

export interface LegacyNativeStopRun {
  teamName: string;
  runId: string;
  child: ChildProcess | null;
  detectedSessionId: string | null;
  expectedMembers: readonly string[];
  allEffectiveMembers: readonly unknown[];
  mixedSecondaryLanes: readonly unknown[];
  request: { providerId?: string; members: readonly unknown[] };
}
export interface LegacyNativeStopRelease {
  version: 1;
  kind: 'desktop-owned-unix-cli';
  target: LegacyNativeTarget;
  census: LegacyNativeCensus;
  process: VerifiedCliProcessRelease;
}
export interface CapturedLegacyNativeStop {
  /** Returns no proof until the exact original process owner confirmed exit. */
  complete(): LegacyNativeStopRelease | null;
}
const capturedProofs = new WeakMap<LegacyNativeStopRelease, string>();

function sameDirectory(left: LegacyNativeCensus, right: LegacyNativeCensus): boolean {
  return JSON.stringify(left.directory) === JSON.stringify(right.directory);
}
function identityText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

/** Synchronous capture precedes the first Stop await and any metadata cleanup. */
export function captureLegacyNativeStop(
  teamsBasePath: string,
  run: LegacyNativeStopRun,
  current: () => boolean
): CapturedLegacyNativeStop | null {
  try {
    if (
      process.platform === 'win32' ||
      !current() ||
      !run.child ||
      !identityText(run.runId) ||
      !identityText(run.detectedSessionId) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(run.teamName) ||
      run.expectedMembers.length ||
      run.allEffectiveMembers.length ||
      run.request.members.length ||
      run.mixedSecondaryLanes.length ||
      (run.request.providerId !== undefined && run.request.providerId !== 'anthropic')
    )
      return null;
    const processCapture = captureCliProcessStop(run.child);
    if (!processCapture) return null;
    const teamDir = join(teamsBasePath, run.teamName);
    const config = readNativeRecord(join(teamDir, 'config.json'), 10 * 1024 * 1024);
    if (!Array.isArray(config.members) || config.members.length !== 1) return null;
    const leadName = nativeRecord(config.members[0]).name;
    if (!identityText(leadName)) return null;
    const target: LegacyNativeTarget = {
      teamName: run.teamName,
      runId: run.runId,
      leadName,
      sessionId: run.detectedSessionId,
      rootPid: processCapture.rootPid,
    };
    const launch = readNativeRecord(join(teamDir, 'launch-state.json'));
    const freshness = readNativeRecord(join(teamDir, 'launch-freshness.json'));
    if (
      launch.version !== 2 ||
      launch.teamName !== target.teamName ||
      launch.publicationRunId !== target.runId ||
      launch.leadSessionId !== target.sessionId ||
      !Array.isArray(launch.expectedMembers) ||
      launch.expectedMembers.length ||
      Object.keys(nativeRecord(launch.members)).length ||
      freshness.version !== 1 ||
      freshness.teamName !== target.teamName ||
      freshness.kind !== 'launch' ||
      freshness.runId !== target.runId
    )
      return null;
    const original = readLegacyNativeCensus(teamDir, target);
    return Object.freeze({
      complete() {
        try {
          if (!current()) return null;
          const verified = readVerifiedCliProcessRelease(processCapture);
          if (!verified) return null;
          const census = readLegacyNativeCensus(teamDir, target);
          if (!sameDirectory(original, census)) return null;
          const proof: LegacyNativeStopRelease = {
            version: 1,
            kind: 'desktop-owned-unix-cli',
            target: structuredClone(target),
            census,
            process: verified,
          };
          capturedProofs.set(proof, nativeReleaseDigest(proof));
          return proof;
        } catch {
          return null;
        }
      },
    });
  } catch {
    return null;
  }
}

/** Strict finite parsing of the private proof, never a renderer input contract. */
export function parseLegacyNativeStopRelease(value: unknown): LegacyNativeStopRelease | null {
  try {
    const proof = nativeRecord(value),
      target = nativeRecord(proof.target),
      census = nativeRecord(proof.census),
      directory = nativeRecord(census.directory),
      processProof = nativeRecord(proof.process);
    if (
      proof.version !== 1 ||
      proof.kind !== 'desktop-owned-unix-cli' ||
      !['teamName', 'runId', 'leadName', 'sessionId'].every((key) => identityText(target[key])) ||
      !Number.isSafeInteger(target.rootPid) ||
      Number(target.rootPid) <= 0 ||
      !['dev', 'ino', 'birthtimeMs'].every(
        (key) =>
          typeof directory[key] === 'number' &&
          Number.isFinite(directory[key]) &&
          Number(directory[key]) >= 0
      ) ||
      typeof census.nativeDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(census.nativeDigest) ||
      processProof.version !== 1 ||
      !identityText(processProof.ownerIncarnation) ||
      processProof.rootPid !== target.rootPid ||
      processProof.processGroupId !== target.rootPid ||
      !identityText(processProof.rootStartIdentity) ||
      !Array.isArray(processProof.processes) ||
      processProof.processes.length > 256
    )
      return null;
    const pids = new Set<number>();
    for (const value of processProof.processes) {
      const item = nativeRecord(value);
      if (
        !Number.isSafeInteger(item.pid) ||
        Number(item.pid) <= 0 ||
        !Number.isSafeInteger(item.parentPid) ||
        Number(item.parentPid) < 0 ||
        item.processGroupId !== target.rootPid ||
        !identityText(item.startIdentity) ||
        (item.pid === processProof.rootPid &&
          item.startIdentity !== processProof.rootStartIdentity) ||
        pids.has(Number(item.pid))
      )
        return null;
      pids.add(Number(item.pid));
    }
    return structuredClone(value) as LegacyNativeStopRelease;
  } catch {
    return null;
  }
}

/** The writer requires a genuine unchanged in-memory capture; cold readers use the durable hash binding. */
export function isCurrentLegacyNativeStopRelease(
  teamDir: string,
  proof: LegacyNativeStopRelease,
  requireCapture = false
): boolean {
  try {
    if (
      !parseLegacyNativeStopRelease(proof) ||
      (requireCapture && capturedProofs.get(proof) !== nativeReleaseDigest(proof))
    )
      return false;
    const census = readLegacyNativeCensus(teamDir, proof.target);
    return sameDirectory(census, proof.census) && census.nativeDigest === proof.census.nativeDigest;
  } catch {
    return false;
  }
}

/** Cold archive reader: no process probes, effects, repair, or runtime recovery. */
export function readLegacyNativeStopRelease(
  teamDir: string,
  teamName: string
): LegacyNativeStopRelease | null {
  try {
    const marker = readNativeRecord(join(teamDir, 'launch-stopped.json'));
    const freshness = readNativeRecord(join(teamDir, 'launch-freshness.json'));
    const proof = parseLegacyNativeStopRelease(marker.nativeRelease);
    if (
      !proof ||
      marker.version !== 1 ||
      marker.teamName !== teamName ||
      !identityText(marker.stopId) ||
      freshness.version !== 1 ||
      freshness.teamName !== teamName ||
      freshness.kind !== 'stop' ||
      freshness.stopId !== marker.stopId ||
      freshness.stoppedRunId !== proof.target.runId ||
      proof.target.teamName !== teamName ||
      freshness.nativeReleaseOwnerIncarnation !== proof.process.ownerIncarnation ||
      freshness.nativeReleaseDigest !== nativeReleaseDigest(proof)
    )
      return null;
    if (!isCurrentLegacyNativeStopRelease(teamDir, proof)) return null;
    return proof;
  } catch {
    return null;
  }
}

/** Existing stopped publication may retain exact old proof; a new proof requires the live capture brand. */
export function selectLegacyNativeStopReleaseProof(options: {
  teamDir: string;
  teamName: string;
  freshness: { kind: 'launch'; runId: string } | { kind: 'stop'; stoppedRunId?: string } | null;
  provided?: LegacyNativeStopRelease;
}): { proof: LegacyNativeStopRelease; assertCurrent(): void } | null {
  const { teamDir, teamName, freshness, provided } = options;
  const proof =
    provided ??
    (freshness?.kind === 'stop' ? readLegacyNativeStopRelease(teamDir, teamName) : null);
  const runId = freshness?.kind === 'launch' ? freshness.runId : freshness?.stoppedRunId;
  if (
    !proof ||
    proof.target.teamName !== teamName ||
    proof.target.runId !== runId ||
    !isCurrentLegacyNativeStopRelease(teamDir, proof, provided !== undefined)
  )
    return null;
  const originalDigest = nativeReleaseDigest(proof);
  return Object.freeze({
    proof,
    assertCurrent() {
      if (
        nativeReleaseDigest(proof) !== originalDigest ||
        !isCurrentLegacyNativeStopRelease(teamDir, proof, provided !== undefined)
      )
        throw new Error('Native stop release authority changed');
    },
  });
}
