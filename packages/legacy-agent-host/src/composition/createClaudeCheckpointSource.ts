import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ClaudeDriverHost } from '@agent-teams/provider-implementations/claude';
import type { OpenConfig } from '@agent-teams/provider-session-contracts';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { normalizeBinding, runtimeDigest } from '../runtime/identity.js';
import { historyDigest, idle } from '../runtime/sessionState.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { TeamRuntimeSelection } from '../team/ports.js';
import type { MemberEntry } from './MemberEntry.js';

type SourceReader = NonNullable<ClaudeDriverHost['readCheckpointSource']>;
type SourceSelection = TeamRuntimeSelection & {
  checkpointSource: NonNullable<TeamRuntimeSelection['checkpointSource']>;
};
const hold = (): never => { throw new RuntimeOwnerError('hold'); };
const effective = (config: OpenConfig) => ({
  tenantId: config.tenantId, projectId: config.projectId, sessionId: config.sessionId,
  configRevision: config.configRevision, requiredCapabilities: config.requiredCapabilities,
});

/** Request/ref-local evidence for D's one omitted-path legacy hash candidate.
 * Existing Team reads retain their original authorized recovery semantics. */
export function createClaudeCheckpointSource(options: {
  entry: MemberEntry;
  request: OpenConfig;
  profileId: string;
  hostIncarnation: string;
  readRuntime: RuntimeOwner['readCapturedSession'];
  assertCurrent(): void;
  assertAllocation(): void;
}): SourceReader {
  const { entry } = options, team = entry.team, owner = team.owner;
  const binding = normalizeBinding(entry.binding);
  const request = Object.freeze({
    ...structuredClone(options.request),
    requiredCapabilities: Object.freeze([...options.request.requiredCapabilities]),
  });
  const profile = structuredClone(entry.profile), baseProfile = structuredClone(entry.baseProfile);
  const profileDigest = runtimeDigest(profile), baseDigest = runtimeDigest(baseProfile);
  const bindingDigest = runtimeDigest(binding);
  const current = () => {
    options.assertCurrent();
    options.assertAllocation();
    if (entry.team !== team || runtimeDigest(entry.binding) !== bindingDigest ||
        runtimeDigest(entry.profile) !== profileDigest || runtimeDigest(entry.baseProfile) !== baseDigest)
      hold();
  };
  return (reference, selected) => {
    if (reference !== request.checkpointRef || !/^cp1-[a-f0-9]{64}$/.test(reference) ||
        !isDeepStrictEqual(selected, request) || profile.provider !== 'claude' ||
        baseProfile.provider !== 'claude')
      return hold();
    current();
    const select = (): SourceSelection => {
      const value = owner.runtimeSelection(profile.principalId, profile.memberId, reference);
      if (!value?.checkpointSource || !value.restore || value.restore.reference !== reference ||
          value.restore.commandId !== value.checkpointSource.commandId ||
          value.checkpointSource.reference !== reference ||
          runtimeDigest(value.binding) !== bindingDigest ||
          value.baseConfigurationDigest !== baseDigest ||
          value.checkpointSource.baseConfigurationDigest !== baseDigest ||
          value.configurationDigest !== profileDigest || value.generation !== request.generation ||
          profile.generation !== request.generation ||
          runtimeDigest(value.restore.sourceBinding) !== runtimeDigest(value.checkpointSource.sourceBinding))
        return hold();
      return { ...value, checkpointSource: value.checkpointSource };
    };
    // Each projection uses its existing Team fence; Runtime reads are outside that fence.
    const selection = select(), claim = selection.checkpointSource;
    const target = options.readRuntime(binding);
    const source = options.readRuntime(claim.sourceBinding);
    const targetRecord = target.record, sourceRecord = source.record;
    if (!targetRecord || target.attached || targetRecord.phase !== 'opening' ||
        targetRecord.custody !== 'unknown' || targetRecord.sealed ||
        targetRecord.hostIncarnation !== options.hostIncarnation ||
        targetRecord.profileId !== options.profileId ||
        runtimeDigest(targetRecord.binding) !== bindingDigest ||
        !isDeepStrictEqual(targetRecord.config, request) ||
        targetRecord.restoredFrom?.reference !== reference ||
        runtimeDigest(targetRecord.restoredFrom.sourceBinding) !== runtimeDigest(claim.sourceBinding) ||
        !sourceRecord || source.attached || sourceRecord.phase !== 'closed' ||
        sourceRecord.custody !== 'released' || !sourceRecord.config || !idle(sourceRecord) ||
        sourceRecord.hostIncarnation !== claim.hostIncarnation ||
        sourceRecord.profileId !== options.profileId ||
        runtimeDigest(sourceRecord.binding) !== runtimeDigest(claim.sourceBinding) ||
        typeof sourceRecord.sessionRef !== 'string' || !sourceRecord.sessionRef ||
        profile.sessionId !== request.sessionId ||
        !isDeepStrictEqual(effective(sourceRecord.config), effective(request)) ||
        sourceRecord.config.generation >= request.generation ||
        (claim.generation !== undefined && claim.generation !== sourceRecord.config.generation))
      return hold();
    const published = sourceRecord.checkpoints?.filter(item =>
      item.status === 'published' && item.reference === reference) ?? [];
    if (published.length !== 1 || published[0]!.historyDigest !== historyDigest(sourceRecord) ||
        !/^[a-f0-9]{64}$/.test(published[0]!.payloadDigest ?? '') ||
        (claim.configurationDigest !== undefined &&
          claim.configurationDigest !== runtimeDigest({ ...profile, generation: sourceRecord.config.generation })))
      return hold();
    const originalExecutable = baseProfile.executable, selectedExecutable = profile.executable;
    if (!isAbsolute(originalExecutable.path) || originalExecutable.path.includes('\0') ||
        !/^[a-f0-9]{64}$/.test(originalExecutable.sha256) ||
        originalExecutable.path !== selectedExecutable.path ||
        originalExecutable.sha256 !== selectedExecutable.sha256)
      return hold();
    // This is the second and last explicit projection, not an unbounded freshness loop.
    if (runtimeDigest(select()) !== runtimeDigest(selection)) return hold();
    current();
    return Object.freeze({
      reference, request,
      originalExecutable: Object.freeze({ path: originalExecutable.path, sha256: originalExecutable.sha256 }),
      selectedExecutable: Object.freeze({ path: selectedExecutable.path, sha256: selectedExecutable.sha256 }),
    });
  };
}
