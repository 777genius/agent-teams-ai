import { AgentChangeLedgerReader } from '@agent-teams/task-change-ledger';
import { realpath } from 'node:fs/promises';
import { evidenceProjectDir } from '../evidence/evidenceProjectDir.js';
import { readEvidenceFileImage, SNAPSHOT_LIMITS } from '../evidence/WorkspaceSnapshot.js';
import { deliveryFingerprint, normalizeBinding, runtimeDigest } from '../runtime/identity.js';
import { digest } from '../team/identity.js';
import { resolveCapturedReviewWorkspaces } from './CapturedReviewWorkspaces.js';
import type { MemberEntry } from './MemberEntry.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { GoalInputSource } from '../team/goalContracts.js';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Read-only metadata, including a proven retained generation; never a runnable registry entry. */
export type GoalEvidenceMember = Pick<MemberEntry, 'team' | 'binding' | 'config' | 'selection'> & {
  profile: Pick<RuntimeMemberProfile, 'cwd' | 'principalId'>;
};

/**
 * Existing bounded ledger reads prove captured file progress, not complete native coverage.
 * The caller assigns these references only to this original input's receipt-owned obligation.
 */
export async function readGoalProgressEvidence(options: {
  entry: GoalEvidenceMember;
  source: GoalInputSource;
  /** Completion compares all original actor inputs in one bounded ledger read. */
  additionalSources?: readonly GoalInputSource[];
  /** Proposal-time read only. Never used to admit a continuation. */
  allowActive?: boolean;
  ownerStorageRoot: string;
  initialRuntimeMembers?: readonly RuntimeMemberProfile[];
  readRuntime: RuntimeOwner['readCapturedSession'];
  assertCurrent(): void;
}): Promise<readonly string[]> {
  const { entry, source } = options;
  const sources = [source, ...(options.additionalSources ?? [])];
  const assertSource = () => {
    options.assertCurrent();
    if (sources.some(selected => digest(normalizeBinding(selected.binding)) !== digest(normalizeBinding(entry.binding))))
      throw new Error('Goal progress belongs to another original member');
    const { record, attached } = options.readRuntime(entry.binding);
    const config = entry.selection?.restore
      ? { ...entry.config, checkpointRef: entry.selection.restore.reference } : entry.config;
    if (!record || !record.sessionRef || record.custody === 'unknown' ||
        (!options.allowActive && (!attached || record.phase !== 'allocated' || record.sealed || record.custody !== 'owned')) ||
        runtimeDigest(record.config) !== runtimeDigest(config) ||
        record.openFingerprint !== runtimeDigest({ profileId: record.profileId, config: record.config }))
      throw new Error('Goal progress original Runtime is unavailable');
    const associations = sources.map(selected => {
      const inputs = record.inputs.filter(input => input.intent.inputId === selected.inputId &&
        input.operationRef === selected.operationRef);
      const input = inputs[0];
      if (inputs.length !== 1 || !input ||
          !(input.phase === 'terminal' && (input.terminal === 'succeeded' ||
              options.allowActive && ['failed', 'cancelled'].includes(input.terminal ?? '')) ||
            options.allowActive && (input.phase === 'claimed' || input.phase === 'consumed')) ||
          input.fingerprint !== selected.inputFingerprint ||
          deliveryFingerprint(input.intent) !== selected.inputFingerprint)
        throw new Error('Goal evidence requires the original captured active or eligible settled input');
      if (!options.allowActive) return entry.team.owner.goals.assertSource(entry.profile.principalId, selected);
      if (input.phase !== 'terminal' && (!attached || record.phase !== 'allocated' || record.sealed || record.custody !== 'owned'))
        throw new Error('Goal completion active input lost its original Runtime');
      // Completion includes known failed/cancelled originals and their captured effects.
      // It never adopts their grants or substitutes a current generation's profile.
      const association = entry.team.owner.goals.association(input.intent);
      const goal = entry.team.owner.goals.snapshot();
      if (!association || association.goalId !== goal?.goalId || association.revision !== goal.revision)
        throw new Error('Goal completion original association changed');
      return association;
    });
    return { associations, sessionRef: record.sessionRef, hostIncarnation: record.hostIncarnation,
      configRevision: record.config!.configRevision };
  };
  const original = assertSource();
  const roster = entry.team.connection.readRoster();
  const members = (options.allowActive ? [...roster.members, ...roster.removedMembers] : roster.members)
    .filter(member => member.memberId === source.binding.memberId);
  if (members.length !== 1) throw new Error('Goal progress original actor is unavailable');
  const memberName = members[0]!.name;
  const result = await new AgentChangeLedgerReader().readAgentChangesWithEvidence({
    teamName: entry.team.definition.binding.teamName,
    memberName,
    actorId: source.binding.memberId,
    projectDir: evidenceProjectDir(options.ownerStorageRoot, entry.team.definition.binding.teamName),
    projectPath: entry.profile.cwd,
  });
  if (digest(assertSource()) !== digest(original)) throw new Error('Goal progress authority changed');
  // The reader always labels native coverage partial. Actual damaged/capped inventory,
  // however, may have dropped this input's rows and cannot prove a completion fingerprint.
  if (options.allowActive && result.changes.reviewDiagnostics?.some(diagnostic =>
      diagnostic.reviewBlocking && ['ledger_integrity_recovered', 'journal_unavailable',
        'unsafe_or_untrusted_evidence'].includes(diagnostic.code)))
    throw new Error('Goal completion captured evidence inventory is unavailable');

  // A historical actor row, fresh event id or model report never creates progress for this input.
  const evidence = result.evidence.filter(event => {
    const cause = event.causalBinding;
    if (!object(cause) || event.actorId !== source.binding.memberId) return false;
    const selected = sources.find(input => cause.inputId === input.inputId && cause.operationRef === input.operationRef);
    if (!selected) return false;
    if (!object(cause.binding) ||
        digest(normalizeBinding(cause.binding as unknown as GoalInputSource['binding'])) !==
          digest(normalizeBinding(selected.binding)) ||
        cause.sessionRef !== original.sessionRef || cause.hostIncarnation !== original.hostIncarnation ||
        cause.configRevision !== original.configRevision)
      throw new Error('Goal progress captured input identity changed');
    return true;
  });
  const byId = new Map(evidence.map(event => [event.eventId, event]));
  if (options.allowActive) {
    for (const file of result.changes.files) for (const snippet of file.snippets) {
      const ledger = snippet.ledger;
      if (!ledger || !byId.has(ledger.eventId)) continue;
      const unchanged = !!ledger.afterHash && ledger.afterHash === ledger.beforeHash;
      if (!unchanged && (ledger.nativeCapture !== 'qualified' || snippet.isError || !ledger.afterHash))
        throw new Error('Goal completion contains an unqualified captured file effect');
    }
  }
  const files = result.changes.files.flatMap(file => {
    const snippets = file.snippets.filter(snippet => {
      const ledger = snippet.ledger, event = ledger && byId.get(ledger.eventId);
      return !!event && event.filePath === snippet.filePath &&
        ledger!.actorId === source.binding.memberId && ledger!.nativeCapture === 'qualified' &&
        !snippet.isError && !!ledger!.afterHash && /^[a-f0-9]{64}$/u.test(ledger!.afterHash) &&
        (options.allowActive || ledger!.afterHash !== ledger!.beforeHash);
    });
    return snippets.length ? [{ ...file, snippets }] : [];
  });
  if (!files.length) return [];
  // Historical completion reads use the current authorized operator. A removed actor's
  // immutable capture proves provenance, never renewed permission to execute as that actor.
  const readerPrincipalId = options.allowActive ? entry.team.operatorPrincipalId : entry.profile.principalId;
  if (!readerPrincipalId) throw new Error('Goal completion original evidence has no authorized reader');
  const used = new Set(files.flatMap(file => file.snippets.map(snippet => snippet.ledger!.eventId)));
  const captured = resolveCapturedReviewWorkspaces({
    team: entry.team,
    ownerStorageRoot: options.ownerStorageRoot,
    origin: { memberName },
    actorId: source.binding.memberId,
    evidence: evidence.filter(event => used.has(event.eventId)),
    files,
    principalId: readerPrincipalId,
    ...(options.initialRuntimeMembers ? { initialRuntimeMembers: options.initialRuntimeMembers } : {}),
  });
  captured.assertCurrent();
  if (digest(assertSource()) !== digest(original)) throw new Error('Goal progress authority changed');
  const references = files.flatMap(file => file.snippets.map(snippet =>
    `native-artifact:${digest({ path: snippet.filePath, afterHash: snippet.ledger!.afterHash })}`));
  if (options.allowActive) {
    const paths = [...new Set(files.flatMap(file => file.snippets.map(snippet => snippet.filePath)))].sort();
    if (paths.length > SNAPSHOT_LIMITS.files) throw new Error('Goal completion artifact count exceeds capture limits');
    let bytes = 0;
    for (const path of paths) {
      const roots = captured.roots.filter(root => evidence.some(event =>
        used.has(event.eventId) && event.filePath === path && event.workspaceRoot === root.path));
      if (roots.length !== 1) throw new Error('Goal completion artifact workspace is ambiguous');
      captured.assertCurrent();
      const current = await readEvidenceFileImage(roots[0]!.path, path);
      if (current.reason || current.exists === undefined ||
          current.exists && (!current.sha256 || await realpath(path) !== path))
        throw new Error('Goal completion current artifact is unavailable');
      bytes += current.content?.length ?? 0;
      if (bytes > SNAPSHOT_LIMITS.totalBytes) throw new Error('Goal completion artifact bytes exceed capture limits');
      captured.assertCurrent();
      if (digest(assertSource()) !== digest(original)) throw new Error('Goal completion authority changed');
      references.push(`current-artifact:${digest({ path, exists: current.exists, sha256: current.sha256 ?? null })}`);
    }
  }
  return [...new Set(references)].sort();
}
