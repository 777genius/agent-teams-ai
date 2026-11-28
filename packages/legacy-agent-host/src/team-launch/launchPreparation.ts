import { runtimeDigest } from '../runtime/identity.js';
import { TeamLaunchError } from './contracts.js';
import type { LaunchPreparation, TeamLaunchRecord, TeamLaunchOptions } from './contracts.js';
import { memberActionBlocksSelection } from './memberActions.js';

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

/** Project a selected generation back to its immutable prepared origin.
 * The owning launch validator has already validated the complete selection graph.
 * Do not revalidate the final live graph against a historical preparation projection.
 */
function matchesPreparationOrigin(
  record: TeamLaunchRecord,
  selected: TeamLaunchRecord['definition']['members'][number],
  prepared: LaunchPreparation['members'][number]
): boolean {
  const actions = (record.memberActions ?? [])
    .filter(row => row.phase === 'selected' && row.input.memberId === prepared.memberId);
  const restorations = (record.restorations ?? [])
    .filter(row => row.member.memberId === prepared.memberId);
  const consumed = new Set<(typeof actions)[number]>();
  let current = selected;
  for (let step = 0; step <= actions.length; step++) {
    if (
      current.memberId !== prepared.memberId ||
      current.baseConfigurationDigest !== prepared.baseConfigurationDigest ||
      current.configRevision !== prepared.configRevision
    ) return false;
    const digest = runtimeDigest(current);
    const predecessors = actions.filter(row => runtimeDigest(row.selected) === digest);
    if (predecessors.length > 1) return false;
    if (predecessors.length === 1) {
      const edge = predecessors[0]!;
      if (consumed.has(edge)) return false;
      consumed.add(edge);
      current = edge.source;
      continue;
    }
    const restored = restorations.filter(row => runtimeDigest(row.member) === digest);
    if (restored.length > 1) return false;
    // Neither a fake root nor an apparent restore may borrow another retained
    // selection that ends at the same binding with different descriptor bytes.
    const sameBinding = (binding: typeof current.binding) =>
      binding !== null && current.binding !== null &&
      runtimeDigest(binding) === runtimeDigest(current.binding);
    if (
      actions.some(row => !consumed.has(row) && sameBinding(row.selected.binding)) ||
      restorations.some(row => sameBinding(row.member.binding) &&
        runtimeDigest(row.member) !== digest)
    ) return false;
    // An actual restore is an independently qualified historical boundary.
    if (current.restore) return restored.length === 1;
    if (restored.length) return false;
    return current.configurationDigest === prepared.configurationDigest;
  }
  return false;
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
      if (selected?.skipped) {
        if (!(record.memberActions ?? []).some(action =>
          action.phase === 'selected' && action.input.action === 'skip' &&
          action.input.memberId === member.memberId &&
          runtimeDigest(action.selected) === runtimeDigest(selected)))
          throw new Error();
      }
      if (
        !identity(member.memberId) ||
        !identity(member.configRevision) ||
        !hash(member.configurationDigest) ||
        !hash(member.baseConfigurationDigest) ||
        !member.configuration ||
        typeof member.configuration !== 'object' ||
        Array.isArray(member.configuration) ||
        !selected?.binding ||
        selected.configRevision !== member.configRevision ||
        selected.baseConfigurationDigest !== member.baseConfigurationDigest ||
        !matchesPreparationOrigin(record, selected, member)
      )
        throw new Error();
    }
    if (record.startCommandId && record.startCommandId !== input.commandId) throw new Error();
  } catch {
    throw new TeamLaunchError('hold', 'launch-preparation-corrupt');
  }
}

/** The original option-publication body, kept under the same Team/runtime fences. */
export function publishLaunchPreparation(options: {
  input: Omit<LaunchPreparation, 'fingerprint'>;
  authorized: TeamLaunchOptions['authorized'];
  runtime: TeamLaunchOptions['runtime'];
  load(): TeamLaunchRecord;
  commit(record: TeamLaunchRecord): void;
}): boolean {
  const { input } = options;
    const preparation = structuredClone({
      ...input,
      fingerprint: launchPreparationFingerprint(input),
    });
    const replay = () => {
      const record = options.load();
      if (!record.preparation) return false;
      if (
        record.preparation.commandId !== input.commandId ||
        record.preparation.fingerprint !== preparation.fingerprint
      )
        throw new TeamLaunchError('conflict', 'launch-configuration');
      return true;
    };
    if (options.authorized('control', replay)) return false;
    // Runtime has its own fence. Observe outside Team's lock; the synchronous
    // publication below also rejects every claimed launch/open attempt.
    for (const member of input.members) {
      const observed = options.runtime.read(member.memberId);
      const source = observed.record;
      if (
        observed.attached ||
        (source &&
          (source.phase !== 'unopened' ||
            source.custody !== 'released' ||
            source.config !== null ||
            source.openFingerprint !== null ||
            source.sealed))
      )
        throw new TeamLaunchError('conflict', 'launch-already-allocated');
    }
    return options.authorized('control', () => {
      if (replay()) return false;
      const record = options.load();
      if (
        input.sourceRosterRevision !== record.definition.rosterRevision ||
        record.startCommandId ||
        record.members.some((member) => member.attempts.some((attempt) => attempt.claimed))
      )
        throw new TeamLaunchError('conflict', 'launch-scope');
      if (preparation.members.some((m) => memberActionBlocksSelection(record, m.memberId)))
        throw new TeamLaunchError('hold', 'member-action-unresolved');
      for (const member of preparation.members) {
        const selected = record.definition.members.find(
          (item) => item.memberId === member.memberId
        );
        if (
          !selected?.binding ||
          selected.skipped ||
          selected.baseConfigurationDigest !== member.baseConfigurationDigest
        )
          throw new TeamLaunchError('conflict', 'launch-member');
        selected.configurationDigest = member.configurationDigest;
        selected.configRevision = member.configRevision;
      }
      record.preparation = preparation;
      validateLaunchPreparation(record);
      record.definition.rosterRevision = runtimeDigest({
        scope: record.definition.rosterScope ?? record.definition.launchId,
        members: record.definition.members,
      });
      record.fingerprint = runtimeDigest(record.definition);
      options.commit(record);
      return true;
    });
}
