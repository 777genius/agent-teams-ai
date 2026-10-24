import type {
  BackendLeadActivity,
  BackendLeadContext,
  BackendLeadLaunch,
} from '../../../contracts/lead';
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Lead view');
  return value as Record<string, unknown>;
};
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0'))
    throw new Error('Invalid Lead launch');
  return value;
};
function launch(value: unknown): BackendLeadLaunch | null {
  if (value === null) return null;
  const row = object(value);
  return { launchId: id(row.launchId), rosterRevision: id(row.rosterRevision) };
}
/** Current SPI exposes token deltas, not cache-aware occupied prompt or model window provenance. */
export function projectLeadObservation(
  raw: unknown,
  operation: 'team.lead.activity.read' | 'team.lead.context.read'
): BackendLeadActivity | BackendLeadContext {
  const row = object(raw),
    selected = launch(row.launch);
  if (operation === 'team.lead.activity.read') {
    if (
      row.kind !== 'team-lead-activity' ||
      typeof row.state !== 'string' ||
      !['active', 'idle', 'offline'].includes(row.state) ||
      (row.state === 'offline') !== (selected === null)
    )
      throw new Error('Invalid Lead activity');
    return {
      kind: 'team-lead-activity',
      state: row.state as BackendLeadActivity['state'],
      launch: selected,
    };
  }
  if (row.kind !== 'team-lead-context') throw new Error('Invalid Lead context');
  if (row.usage === null) return { kind: 'team-lead-context', usage: null, launch: selected };
  const usage = object(row.usage),
    output = usage.outputTokens;
  if (
    !selected ||
    usage.promptInputTokens !== null ||
    usage.contextUsedTokens !== null ||
    usage.contextWindowTokens !== null ||
    usage.contextUsedPercent !== null ||
    usage.promptInputSource !== 'unavailable' ||
    (output !== null &&
      (typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0)) ||
    typeof usage.updatedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(usage.updatedAt) ||
    !Number.isFinite(Date.parse(usage.updatedAt))
  )
    throw new Error('Invalid Lead usage');
  return {
    kind: 'team-lead-context',
    launch: selected,
    usage: {
      promptInputTokens: null,
      outputTokens: output,
      contextUsedTokens: null,
      contextWindowTokens: null,
      contextUsedPercent: null,
      promptInputSource: 'unavailable',
      updatedAt: usage.updatedAt,
    },
  };
}
