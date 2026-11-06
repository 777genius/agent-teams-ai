import { projectResumePreparation } from '../resumeValues';

import type { BackendOperationRequest } from '../../../contracts/operations';
import type { BackendLaunchRestorations } from '../../../contracts/restorations';

function invalid(): never {
  throw new Error('Invalid restore selections');
}
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0'))
    return invalid();
  return value;
}

/** No truncation or private binding/native checkpoint payload escapes the exact launch read. */
export function projectLaunchRestorations(
  raw: unknown,
  request: BackendOperationRequest
): BackendLaunchRestorations {
  const source = row(raw);
  if (
    request.operation !== 'team.launch.restorations.read' ||
    source.launchId !== request.payload.launchId ||
    !Array.isArray(source.restorations) ||
    source.restorations.length > 64
  )
    return invalid();
  const commands = new Set<string>(),
    currentMembers = new Set<string>();
  const restorations = source.restorations.map(
    (value): BackendLaunchRestorations['restorations'][number] => {
      const item = row(value),
        commandId = text(item.commandId),
        memberId = text(item.memberId),
        reference = text(item.reference),
        sourceGeneration = text(item.sourceGeneration),
        selectedGeneration = text(item.selectedGeneration);
      if (
        !/^cp1-[a-f0-9]{64}$/.test(reference) ||
        commands.has(commandId) ||
        sourceGeneration === selectedGeneration ||
        typeof item.current !== 'boolean' ||
        typeof item.attached !== 'boolean' ||
        !['unopened', 'opening', 'allocated', 'closing', 'closed', 'held', 'unavailable'].includes(
          String(item.phase)
        ) ||
        !['owned', 'released', 'unknown'].includes(String(item.custody)) ||
        (item.current && currentMembers.has(memberId)) ||
        (item.phase === 'unavailable' && (item.custody !== 'unknown' || item.attached))
      )
        return invalid();
      commands.add(commandId);
      if (item.current) currentMembers.add(memberId);
      return {
        commandId,
        memberId,
        reference,
        sourceGeneration,
        selectedGeneration,
        current: item.current,
        phase: item.phase as BackendLaunchRestorations['restorations'][number]['phase'],
        custody: item.custody as BackendLaunchRestorations['restorations'][number]['custody'],
        attached: item.attached,
      };
    }
  );
  const groups = source.preparations ?? [];
  if (!Array.isArray(groups) || groups.length > 64) return invalid();
  const preparations = groups.map(projectResumePreparation);
  const resumeIds = new Set<string>(),
    preparedCommands = new Set<string>();
  for (const group of preparations) {
    if (resumeIds.has(group.resumeId)) return invalid();
    resumeIds.add(group.resumeId);
    for (const member of group.members) {
      if (preparedCommands.has(member.commandId)) return invalid();
      preparedCommands.add(member.commandId);
      const selected = restorations.find((row) => row.commandId === member.commandId);
      if (
        selected &&
        (!member.requested ||
          member.refused ||
          selected.memberId !== member.memberId ||
          selected.reference !== member.reference ||
          selected.sourceGeneration !== member.sourceGeneration)
      )
        return invalid();
    }
  }
  if (new Set([...commands, ...preparedCommands]).size > 64) return invalid();
  return {
    launchId: text(source.launchId),
    rosterRevision: text(source.rosterRevision),
    restorations,
    preparations,
  };
}
