import { validateNativeLaunchAdditions } from '../../team-launch/nativeLaunchAddition.js';
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
import type { TeamLaunchRecord } from '../../team-launch/contracts.js';

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
  current(initial: RuntimeMemberBinding): TeamRuntimeSelection | undefined {
    const row = this.read(initial);
    if (!row) return undefined;
    const member = row.definition.members.find((value) => value.memberId === initial.memberId);
    if (!member?.binding || !this.sameMember(initial, member.binding))
      throw new TeamOwnerError('hold');
    // Predecessor records did not contain a numeric runtime generation. They may
    // describe their original selection, but cannot introduce a replacement.
    if (member.runtimeGeneration === undefined) {
      if (runtimeDigest(member.binding) !== runtimeDigest(initial))
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
    });
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
