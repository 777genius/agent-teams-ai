import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';

import {
  nativeProcessProfileSchema,
  readCapturedProfile,
  RetainedWindowsCustody,
  verifyStagedBroker,
  windowsBrokerReference,
} from '@agent-teams/legacy-agent-host/owned-process';

import { capturedHostProfileDigest } from './selectedHostProfile';

import type { SelectedHostProfile } from './selectedHostProfile';
import type { NativeProcessProfile } from '@agent-teams/legacy-agent-host/owned-process';

function unavailable(): never {
  throw new Error('Captured Main custody unavailable');
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : unavailable();

/** Composition-only opt-in read from the very file/hash passed to the original Host. */
export function captureMainWindowsCustody(
  profile: SelectedHostProfile
): RetainedWindowsCustody | undefined {
  if (process.platform !== 'win32') return;
  const path = profile.env.LEGACY_AGENT_HOST_PROFILE_PATH;
  const sha256 = profile.env.LEGACY_AGENT_HOST_PROFILE_SHA256;
  if (!path || !sha256) return;
  const source = record(readCapturedProfile(path, sha256));
  const custody = source.processCustody;
  if (
    !custody ||
    typeof custody !== 'object' ||
    Array.isArray(custody) ||
    record(custody).kind !== 'main-windows-v1'
  )
    return;
  if (Object.keys(custody).length !== 1) unavailable();
  const runtime = record(source.runtime);
  const selected: NativeProcessProfile[] = [];
  for (const raw of [runtime.members, runtime.providerTemplates ?? []]) {
    if (!Array.isArray(raw) || raw.length > 256) unavailable();
    for (const candidate of raw) {
      const member = record(candidate);
      if ((member.provider !== 'claude' && member.provider !== 'codex' && member.provider !== 'opencode') ||
          (member.provider === 'opencode' && member.nativeGeneration === 'v2')) continue;
      const parsed = nativeProcessProfileSchema.parse(candidate);
      if (!parsed.windowsBroker || parsed.windowsBroker.arch !== process.arch) unavailable();
      selected.push(structuredClone(parsed));
    }
  }
  if (!selected.length) unavailable();
  const brokers = new Map(
    selected.map((value) => {
      const broker = value.windowsBroker!;
      return [windowsBrokerReference(broker), Object.freeze({ ...broker })] as const;
    })
  );
  return new RetainedWindowsCustody({
    profileId: profile.profileId,
    profileDigest: capturedHostProfileDigest(profile),
    selectBroker: (reference) => brokers.get(reference) ?? unavailable(),
    async verifyLaunch(spec, executableSha256, broker) {
      // A changed source refuses new work without discarding original cleanup capabilities.
      readCapturedProfile(path, sha256);
      if (
        !selected.some(
          (value) =>
            value.executable.path === spec.executable &&
            value.executable.sha256 === executableSha256 &&
            value.windowsBroker &&
            windowsBrokerReference(value.windowsBroker) === windowsBrokerReference(broker)
        )
      )
        unavailable();
      if ((await realpath(spec.cwd)) !== spec.cwd || !(await stat(spec.cwd)).isDirectory())
        unavailable();
      await verifyFile(broker.path, broker.sha256, true);
      verifyStagedBroker(broker.path, broker.arch, broker.capability ?? 'whole-job-v1');
      await verifyFile(spec.executable, executableSha256, false);
      readCapturedProfile(path, sha256);
    },
  });
}

/** Fresh same-file checks; this does not claim an OS execute-pinned-image guarantee. */
async function verifyFile(path: string, sha256: string, broker: boolean): Promise<void> {
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    (broker && (before.nlink !== 1n || before.size > 16n * 1024n * 1024n))
  )
    unavailable();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino) unavailable();
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await file.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (
      hash.digest('hex') !== sha256 ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.size !== current.size ||
      before.mtimeNs !== current.mtimeNs ||
      before.ctimeNs !== current.ctimeNs ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      (await realpath(path)) !== path
    )
      unavailable();
  } finally {
    await file.close();
  }
}
