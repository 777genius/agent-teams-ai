import { runtimeDigest } from '../runtime/identity.js';
import { capturedWorktreesSchema, launchWorktreeReceiptSchema } from './worktreeSchema.js';
import { TeamLaunchError } from './contracts.js';
import type { JsonValue } from '../contracts.js';
import type { TeamStore } from '../team/ports.js';
import type { TeamLaunchDefinition, TeamLaunchRecord } from './contracts.js';

/** Original workspace intent occupies the same launch record before its final native definition exists. */
export function prepareWorktreeLaunch(
  store: Pick<TeamStore, 'read' | 'write'>,
  input: { launchId: string; rosterRevision: string; intent: JsonValue; admission: string }
): TeamLaunchRecord {
  const path = `launches/${runtimeDigest(input.launchId)}.json`;
  const prior = store.read<TeamLaunchRecord>(path);
  if (prior) {
    if (
      !prior.worktreePreparation ||
      prior.worktreePreparation.admission !== input.admission ||
      runtimeDigest(prior.worktreePreparation.intent) !== runtimeDigest(input.intent)
    )
      throw new TeamLaunchError('hold', 'worktree-preparation-changed');
    return prior;
  }
  const definition: TeamLaunchDefinition = {
    launchId: input.launchId,
    rosterRevision: input.rosterRevision,
    capture: input.intent,
    members: [],
  };
  const record: TeamLaunchRecord = {
    schemaVersion: 1,
    definition,
    fingerprint: runtimeDigest(definition),
    members: [],
    retries: [],
    worktreePreparation: { intent: input.intent, admission: input.admission },
  };
  if (Buffer.byteLength(JSON.stringify(record)) > 1024 * 1024)
    throw new TeamLaunchError('hold', 'worktree-preparation-budget');
  store.write(path, record);
  return record;
}

/** Exactly one pre-allocation completion; normal finalized definitions remain immutable. */
export function canFinalizeWorktreeLaunch(
  record: TeamLaunchRecord,
  definition: TeamLaunchDefinition
): boolean {
  const prepared = record.worktreePreparation;
  if (!prepared || prepared.completedSourceDigest !== undefined) return false;
  const source = definition.capture,
    original = prepared.intent;
  if (
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    !original ||
    typeof original !== 'object' ||
    Array.isArray(original) ||
    source.worktreeIntentDigest !== runtimeDigest(original) ||
    runtimeDigest(source.worktrees) !== runtimeDigest(original.worktrees) ||
    record.schemaVersion !== 1 ||
    record.definition.launchId !== definition.launchId ||
    record.fingerprint !== runtimeDigest(record.definition) ||
    runtimeDigest(record.definition.capture) !== runtimeDigest(original) ||
    record.definition.members.length ||
    record.members.length ||
    record.retries.length ||
    record.startCommandId ||
    record.preparation ||
    record.restorations?.length ||
    record.resumePreparations?.length
  )
    throw new TeamLaunchError('hold', 'worktree-finalization-invalid');
  if (runtimeDigest(capturedChoices(source)) !== runtimeDigest(capturedChoices(original)))
    throw new TeamLaunchError('hold', 'worktree-capture-choices-changed');
  const rows = capturedWorktreesSchema.parse(original.worktrees);
  if (!rows.length || record.worktrees?.length !== rows.length)
    throw new TeamLaunchError('hold', 'worktree-receipts-incomplete');
  const bindings = [];
  for (const row of rows) {
    const raw = record.worktrees.find((item) => item.planDigest === runtimeDigest(row.plan));
    if (!raw) throw new TeamLaunchError('hold', 'worktree-receipts-incomplete');
    const receipt = launchWorktreeReceiptSchema.parse(raw),
      plan = row.plan,
      binding = receipt.binding;
    if (
      receipt.state !== 'completed' ||
      !binding ||
      binding.slotId !== plan.slotId ||
      binding.target.path !== plan.targetPath ||
      binding.branch !== plan.branch ||
      binding.createdCommit !== (plan.reuse?.createdCommit ?? plan.capturedCommit) ||
      runtimeDigest(binding.commonDirectory) !== runtimeDigest(plan.commonDirectory) ||
      runtimeDigest(receipt.target) !== runtimeDigest(binding.target)
    )
      throw new TeamLaunchError('hold', 'worktree-receipts-incomplete');
    bindings.push(binding);
  }
  if (runtimeDigest(source.worktreeBindings) !== runtimeDigest(bindings))
    throw new TeamLaunchError('hold', 'worktree-final-bindings-changed');
  return true;
}

export function finalizedWorktreeCapture(
  record: TeamLaunchRecord,
  definition: TeamLaunchDefinition
): TeamLaunchRecord {
  return {
    ...record,
    worktreePreparation: {
      ...record.worktreePreparation!,
      completedSourceDigest: runtimeDigest(definition.capture),
    },
  };
}

function capturedChoices(source: { [key: string]: JsonValue }) {
  if (!Array.isArray(source.members)) throw new TeamLaunchError('hold', 'worktree-capture-members');
  return {
    commandId: source.commandId,
    rosterCommandId: source.rosterCommandId,
    configurationRevision: source.configurationRevision,
    savedSettings: source.savedSettings,
    members: source.members.map((member) => {
      if (!member || typeof member !== 'object' || Array.isArray(member))
        throw new TeamLaunchError('hold', 'worktree-capture-members');
      return {
        memberId: member.memberId,
        name: member.name,
        role: member.role,
        settings: member.settings,
      };
    }),
  };
}
