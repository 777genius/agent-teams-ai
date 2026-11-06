import { runtimeDigest } from '../runtime/identity.js';
import { TeamLaunchError } from './contracts.js';
import type { LaunchPreparation, TeamLaunchRecord } from './contracts.js';

const identity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0');
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Derived native digests are not part of caller intent, which survives selected restore. */
export function launchPreparationFingerprint(
  input: Omit<LaunchPreparation, 'fingerprint'>
): string {
  return runtimeDigest({
    sourceRosterRevision: input.sourceRosterRevision,
    members: input.members.map(({ memberId, configuration }) => ({ memberId, configuration })),
  });
}

export function validateLaunchPreparation(record: TeamLaunchRecord): void {
  const input = record.preparation;
  if (input === undefined) return;
  try {
    if (
      !identity(input.commandId) ||
      !identity(input.sourceRosterRevision) ||
      !Array.isArray(input.members) ||
      input.members.length < 1 ||
      input.members.length > 256 ||
      Buffer.byteLength(JSON.stringify(input)) > 256 * 1024 ||
      new Set(input.members.map((member) => member.memberId)).size !== input.members.length ||
      input.fingerprint !== launchPreparationFingerprint(input)
    )
      throw new Error();
    for (const member of input.members) {
      const selected = record.definition.members.find((item) => item.memberId === member.memberId);
      if (
        !identity(member.memberId) ||
        !identity(member.configRevision) ||
        !hash(member.configurationDigest) ||
        !hash(member.baseConfigurationDigest) ||
        !member.configuration ||
        typeof member.configuration !== 'object' ||
        Array.isArray(member.configuration) ||
        !selected?.binding ||
        selected.skipped ||
        selected.configRevision !== member.configRevision ||
        selected.baseConfigurationDigest !== member.baseConfigurationDigest ||
        (!selected.restore && selected.configurationDigest !== member.configurationDigest)
      )
        throw new Error();
    }
    if (record.startCommandId && record.startCommandId !== input.commandId) throw new Error();
  } catch {
    throw new TeamLaunchError('hold', 'launch-preparation-corrupt');
  }
}
