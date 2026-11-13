import { validateNativeLaunchAdditions } from '../../team-launch/nativeLaunchAddition.js';
import { validateLaunchRecord } from '../../team-launch/validateLaunchRecord.js';
import { validateMemberSelectionChain } from '../../team-launch/memberActions.js';
import type { ActionLaunchRecord } from '../../team-launch/memberActions.js';
import {
  runtimeDigest,
  normalizeBinding,
} from '../../runtime/identity.js';
import { TeamOwnerError } from '../../team/contracts.js';
import { validateRestoreJournal } from '../../team-launch/validateRestoreJournal.js';
import { validateLaunchPreparation } from '../../team-launch/launchPreparation.js';
import type { RuntimeMemberBinding } from '../../team/contracts.js';
import type {
  TeamRuntimeBindings,
  TeamRuntimeSelection,
  TeamStore,
} from '../../team/ports.js';
import type { ExpectedLaunchMember, LaunchAttempt, TeamLaunchRecord } from '../../team-launch/contracts.js';

/** Read-only projection of the one authoritative launch record, never a second registry. */
export class FileTeamRuntimeBindings implements TeamRuntimeBindings {
  constructor(private readonly store: TeamStore) {}

  private read(initial: RuntimeMemberBinding): TeamLaunchRecord | undefined {
    const row = this.store.read<TeamLaunchRecord>(`launches/${runtimeDigest(initial.runId)}.json`);
    if (row === undefined) return undefined;
    if (
      row.schemaVersion !== 1 ||
      !row.definition ||
      !Array.isArray(row.definition.members) ||
      row.definition.launchId !== initial.runId ||
      runtimeDigest(row.definition) !== row.fingerprint
    )
      throw new TeamOwnerError('hold');
    try {
      validateNativeLaunchAdditions(row);
      validateRestoreJournal(row);
      validateMemberSelectionChain(row as ActionLaunchRecord);
      validateLaunchPreparation(row);
    } catch {
      throw new TeamOwnerError('hold');
    }
    return row;
  }
  private sameMember(initial: RuntimeMemberBinding, value: RuntimeMemberBinding): boolean {
    return (
      value.backendId === initial.backendId &&
      value.teamId === initial.teamId &&
      value.runId === initial.runId &&
      value.memberId === initial.memberId
    );
  }
  current(initial: RuntimeMemberBinding, checkpointRef?: string): TeamRuntimeSelection | undefined {
    const row = this.read(initial);
    if (!row) {
      if (checkpointRef !== undefined) throw new TeamOwnerError('hold');
      return undefined;
    }
    const member = row.definition.members.find((value) => value.memberId === initial.memberId);
    if (!member?.binding || !this.sameMember(initial, member.binding))
      throw new TeamOwnerError('hold');
    // Predecessor records did not contain a numeric runtime generation. They may
    // describe their original selection, but cannot introduce a replacement.
    if (member.runtimeGeneration === undefined) {
      if (checkpointRef !== undefined || runtimeDigest(member.binding) !== runtimeDigest(initial))
        throw new TeamOwnerError('hold');
      return undefined;
    }
    if (
      !Number.isSafeInteger(member.runtimeGeneration) ||
      member.runtimeGeneration < 0 ||
      !/^[a-f0-9]{64}$/.test(member.configurationDigest ?? '') ||
      !/^[a-f0-9]{64}$/.test(member.baseConfigurationDigest ?? '')
    )
      throw new TeamOwnerError('hold');
    const binding = normalizeBinding(member.binding);
    const actions = (row as ActionLaunchRecord).memberActions ?? [];
    const selectedAction = actions.some(
      (a) =>
        a.phase === 'selected' &&
        a.input.memberId === member.memberId &&
        runtimeDigest(a.selected.binding) === runtimeDigest(binding)
    );
    const originalKnown =
      runtimeDigest(binding) === runtimeDigest(normalizeBinding(initial)) ||
      actions.some(
        (a) =>
          a.input.memberId === member.memberId &&
          (runtimeDigest(a.source.binding) === runtimeDigest(normalizeBinding(initial)) ||
            runtimeDigest(a.selected.binding) === runtimeDigest(normalizeBinding(initial)))
      ) ||
      row.restorations?.some(
        (r) =>
          runtimeDigest(r.member.restore?.sourceBinding) ===
          runtimeDigest(normalizeBinding(initial))
      );
    if (
      !originalKnown ||
      (!member.restore &&
        !selectedAction &&
        runtimeDigest(binding) !== runtimeDigest(normalizeBinding(initial)))
    )
      throw new TeamOwnerError('hold');
    if (
      member.restore &&
      (!this.sameMember(initial, member.restore.sourceBinding) ||
        member.restore.sourceBinding.generation === binding.generation ||
        !/^cp1-[a-f0-9]{64}$/.test(member.restore.reference) ||
        !member.restore.commandId ||
        member.restore.commandId.length > 256)
    )
      throw new TeamOwnerError('hold');
    const prepared = row.preparation?.members.find((item) => item.memberId === member.memberId);
    return structuredClone({
      binding,
      skipped: member.skipped,
      workAllowed:
        !member.skipped &&
        !actions.some(
          (a) =>
            a.input.memberId === member.memberId &&
            (a.phase === 'requested' || a.phase === 'closed' || a.phase === 'unallocated')
        ),
      generation: member.runtimeGeneration,
      configurationDigest: member.configurationDigest!,
      baseConfigurationDigest: member.baseConfigurationDigest!,
      ...(prepared ? { configuration: prepared.configuration } : {}),
      ...(member.restore ? { restore: member.restore } : {}),
      ...(checkpointRef === undefined ? {} : {
        checkpointSource: this.checkpointSource(row, member, binding, checkpointRef),
      }),
    });
  }
  private checkpointSource(
    row: TeamLaunchRecord,
    member: ExpectedLaunchMember,
    binding: RuntimeMemberBinding,
    reference: string
  ): NonNullable<TeamRuntimeSelection['checkpointSource']> {
    try {
      validateLaunchRecord(row, row.fingerprint, row.definition.members.length);
      const restore = member.restore;
      if (!restore || restore.reference !== reference || !/^cp1-[a-f0-9]{64}$/.test(reference))
        throw new Error();
      const matches = (row.restorations ?? []).filter(item =>
        item.commandId === restore.commandId && item.member.memberId === member.memberId &&
        item.member.restore?.reference === reference &&
        runtimeDigest(item.member.binding) === runtimeDigest(binding));
      if (matches.length !== 1 ||
          runtimeDigest(matches[0]!.member.restore) !== runtimeDigest(restore))
        throw new Error();
      const selected = matches[0]!.member;
      if (selected.baseConfigurationDigest !== member.baseConfigurationDigest ||
          selected.configurationDigest !== member.configurationDigest)
        throw new Error();
      const sourceBinding = normalizeBinding(restore.sourceBinding);
      const attempts = row.members.find(item => item.memberId === member.memberId)!.attempts;
      const targetIndex = attempts.findIndex(item =>
        item.attemptId === 'restore-' + runtimeDigest(restore.commandId));
      if (targetIndex < 1) throw new Error();
      this.validateHistoricalAttempt(attempts[targetIndex]!);
      // selectRestore appends the target and its row atomically. Its immediate predecessor
      // was the source's current attempt; a shared Host nonce alone is not that proof.
      let sourceIndex = targetIndex - 1;
      let source = attempts[sourceIndex]!;
      for (let traversed = 0; traversed < attempts.length; traversed++) {
        this.validateHistoricalAttempt(source);
        const skips = (row.memberActions ?? []).filter(action =>
          action.phase === 'selected' && action.input.action === 'skip' &&
          action.input.memberId === member.memberId &&
          source.attemptId === 'action-' + runtimeDigest(action.input.commandId));
        if (!skips.length) break;
        if (skips.length !== 1 || source.claimed ||
            runtimeDigest(skips[0]!.source.binding) !== runtimeDigest(sourceBinding) ||
            runtimeDigest(skips[0]!.selected.binding) !== runtimeDigest(sourceBinding))
          throw new Error();
        const previous = attempts.findIndex(item => item.attemptId === skips[0]!.sourceAttemptId);
        if (previous < 0 || previous >= sourceIndex) throw new Error();
        sourceIndex = previous;
        source = attempts[sourceIndex]!;
      }
      if (!source.claimed || source.noAllocation || !source.hostIncarnation) throw new Error();
      // Reuse original effective digests only where the retained journal actually stored them.
      const selections = [
        ...(row.restorations ?? []).map(item => item.member),
        ...(row.memberActions ?? []).flatMap(item => [item.source, item.selected]),
        ...(row.nativeAdditions ?? []).map(item => item.member),
      ].filter(item => item.memberId === member.memberId &&
        runtimeDigest(item.binding) === runtimeDigest(sourceBinding));
      if (selections.some(item =>
        item.baseConfigurationDigest !== selected.baseConfigurationDigest ||
        item.configRevision !== selected.configRevision ||
        !/^[a-f0-9]{64}$/.test(item.configurationDigest ?? '') ||
        !Number.isSafeInteger(item.runtimeGeneration) || item.runtimeGeneration! < 0))
        throw new Error();
      const digests = new Set(selections.map(item => item.configurationDigest!));
      const generations = new Set(selections.map(item => item.runtimeGeneration!));
      if (digests.size > 1 || generations.size > 1) throw new Error();
      const prepared = row.preparation?.members.find(item => item.memberId === member.memberId);
      const configurationDigest = selections[0]?.configurationDigest ?? prepared?.configurationDigest;
      const generation = selections[0]?.runtimeGeneration;
      return {
        commandId: restore.commandId, reference, sourceBinding,
        attemptId: source.attemptId, hostIncarnation: source.hostIncarnation,
        baseConfigurationDigest: selected.baseConfigurationDigest!,
        ...(configurationDigest === undefined ? {} : { configurationDigest }),
        ...(generation === undefined ? {} : { generation }),
      };
    } catch {
      throw new TeamOwnerError('hold');
    }
  }
  private validateHistoricalAttempt(attempt: LaunchAttempt): void {
    if (!attempt || typeof attempt.attemptId !== 'string' || !attempt.attemptId ||
        attempt.attemptId.length > 256 || typeof attempt.hostIncarnation !== 'string' ||
        !attempt.hostIncarnation || attempt.hostIncarnation.length > 256 ||
        !['not-started', 'pending-bootstrap', 'pending-human', 'ready', 'failed', 'unknown', 'skipped']
          .includes(attempt.status) ||
        ['claimed', 'nativeReady', 'contextApplied', 'everReady', 'usable', 'controlAvailable', 'noAllocation']
          .some(key => typeof attempt[key as 'claimed'] !== 'boolean') ||
        !Number.isSafeInteger(attempt.startedAtMs) || attempt.startedAtMs < 0 ||
        !Number.isSafeInteger(attempt.deadlineMs) || attempt.deadlineMs < attempt.startedAtMs ||
        attempt.deadlineMs > 8_640_000_000_000_000 ||
        typeof attempt.reason !== 'string' || attempt.reason.length > 128)
      throw new Error();
  }
  retained(initial: RuntimeMemberBinding, binding: RuntimeMemberBinding): boolean {
    if (!this.sameMember(initial, binding)) return false;
    const row = this.read(initial);
    return (
      !!(row as ActionLaunchRecord | undefined)?.memberActions?.some(
        (a) => a.phase === 'selected' && runtimeDigest(a.source.binding) === runtimeDigest(binding)
      ) ||
      !!row?.restorations?.some(
        (item) =>
          item.member.memberId === initial.memberId &&
          item.member.restore &&
          runtimeDigest(item.member.restore.sourceBinding) === runtimeDigest(binding)
      )
    );
  }
}
