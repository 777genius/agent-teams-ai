import { validateMemberSelectionChain } from './memberActions.js';
import type { ActionLaunchRecord } from './memberActions.js';
import {
  normalizeBinding,
  runtimeDigest,
} from '../runtime/identity.js';
import { TeamLaunchError } from './contracts.js';
import type {
  ExpectedLaunchMember,
  TeamLaunchRecord,
} from './contracts.js';

/** The same durable selection authorizes current delivery and historical reads. */
export function validateRestoreJournal(record: TeamLaunchRecord): void {
  try {
    const actions = (record as ActionLaunchRecord).memberActions;
    if (actions !== undefined) {
      validateMemberSelectionChain(record as ActionLaunchRecord);
      const rows = record.restorations ?? [];
      if (!Array.isArray(rows) || rows.length > 64) throw new Error();
      const commands = new Set((actions ?? []).map((a) => a.input.commandId));
      for (const row of rows) {
        if (commands.has(row.commandId)) throw new Error();
        commands.add(row.commandId);
        // The legacy atom validator still owns every checkpoint-specific invariant.
        // The combined validator owns ordering/current selection across fresh and restore edges.
        const { memberActions: _actions, ...legacy } = record as ActionLaunchRecord;
        validateRestoreJournal({
          ...legacy,
          definition: { ...legacy.definition, members: [row.member] },
          restorations: [row],
        });
      }
      return;
    }
    const rows = record.restorations ?? [];
    if (!Array.isArray(rows) || rows.length > 64) throw new Error();
    const commands = new Set<string>();
    const latest = new Map<string, ExpectedLaunchMember>();
    for (const row of rows) {
      const next = row.member,
        restore = next.restore;
      if (
        typeof row.commandId !== 'string' ||
        !row.commandId ||
        row.commandId.length > 256 ||
        commands.has(row.commandId) ||
        !restore ||
        restore.commandId !== row.commandId ||
        !/^cp1-[a-f0-9]{64}$/.test(restore.reference) ||
        !next.binding ||
        !Number.isSafeInteger(next.runtimeGeneration) ||
        next.runtimeGeneration! < 1 ||
        !/^[a-f0-9]{64}$/.test(next.configurationDigest ?? '') ||
        !/^[a-f0-9]{64}$/.test(next.baseConfigurationDigest ?? '') ||
        row.fingerprint !== runtimeDigest({ memberId: next.memberId, reference: restore.reference })
      )
        throw new Error();
      const source = normalizeBinding(restore.sourceBinding),
        target = normalizeBinding(next.binding);
      if (
        source.generation === target.generation ||
        target.memberId !== next.memberId ||
        ['backendId', 'teamId', 'runId', 'memberId'].some(
          (key) => source[key as 'memberId'] !== target[key as 'memberId']
        )
      )
        throw new Error();
      const prior = latest.get(next.memberId);
      if (
        prior &&
        (runtimeDigest(prior.binding) !== runtimeDigest(restore.sourceBinding) ||
          next.runtimeGeneration! <= prior.runtimeGeneration! ||
          next.baseConfigurationDigest !== prior.baseConfigurationDigest ||
          next.contextDigest !== prior.contextDigest ||
          next.configRevision !== prior.configRevision ||
          next.timeoutMs !== prior.timeoutMs)
      )
        throw new Error();
      commands.add(row.commandId);
      latest.set(next.memberId, next);
    }
    for (const [memberId, selected] of latest) {
      const current = record.definition.members.find((member) => member.memberId === memberId);
      if (!current || runtimeDigest(current) !== runtimeDigest(selected)) throw new Error();
    }
    for (const current of record.definition.members)
      if (current.restore && !latest.has(current.memberId)) throw new Error();
  } catch {
    throw new TeamLaunchError('hold', 'restore-journal-corrupt');
  }
}
