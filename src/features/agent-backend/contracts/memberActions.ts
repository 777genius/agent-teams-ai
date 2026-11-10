export interface BackendMemberActionRequest {
  launchId: string;
  rosterRevision: string;
  memberId: string;
  expectedGeneration: string | null;
  action: 'restart' | 'skip';
}
export type BackendMemberObservation =
  | { availability: 'unavailable' | 'no-allocation' }
  | { availability: 'absent'; generation: string }
  | {
      availability: 'observed';
      generation: string;
      phase: 'unopened' | 'opening' | 'allocated' | 'closing' | 'closed' | 'held';
      custody: 'owned' | 'released' | 'unknown';
      attached: boolean;
    };
export interface BackendMemberActionView {
  commandId: string;
  launchId: string;
  rosterRevision: string;
  memberId: string;
  action: 'restart' | 'skip';
  allocation: 'none' | 'runtime';
  sourceGeneration: string | null;
  selectedGeneration: string | null;
  stage: 'prepared' | 'requested' | 'source-closed' | 'source-unallocated' | 'selected' | 'refused';
  current: boolean;
  source: BackendMemberObservation;
  selected: BackendMemberObservation | null;
}
export interface BackendMemberActionRead {
  launchId: string;
  rosterRevision: string;
  memberId: string;
  actions: BackendMemberActionView[];
  retries: { commandId: string; attemptId: string; current: boolean }[];
}
export interface BackendMemberActionPayloads {
  'team.member.action.prepare': BackendMemberActionRequest;
  'team.member.action.execute': BackendMemberActionRequest;
  'team.member.actions.read': { launchId: string; memberId: string };
  'team.member.action.lookup': { launchId: string; memberId: string; originalCommandId: string };
}
function fail(): never {
  throw new Error('Invalid member action');
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some((d) => !('value' in d))
  )
    fail();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0')) fail();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail();
  return value;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail();
  return value as T;
}
function generation(value: unknown): string | null {
  return value === null ? null : id(value);
}
export function readMemberActionRequest(value: unknown): BackendMemberActionRequest {
  const r = object(value, [
    'launchId',
    'rosterRevision',
    'memberId',
    'expectedGeneration',
    'action',
  ]);
  return {
    launchId: id(r.launchId),
    rosterRevision: id(r.rosterRevision),
    memberId: id(r.memberId),
    expectedGeneration: generation(r.expectedGeneration),
    action: oneOf(r.action, ['restart', 'skip']),
  };
}
export function readMemberActionQuery(value: unknown): { launchId: string; memberId: string } {
  const r = object(value, ['launchId', 'memberId']);
  return { launchId: id(r.launchId), memberId: id(r.memberId) };
}
export function readMemberActionLookup(value: unknown): {
  launchId: string;
  memberId: string;
  originalCommandId: string;
} {
  const r = object(value, ['launchId', 'memberId', 'originalCommandId']);
  return {
    launchId: id(r.launchId),
    memberId: id(r.memberId),
    originalCommandId: id(r.originalCommandId),
  };
}
function observation(value: unknown): BackendMemberObservation {
  if (!value || typeof value !== 'object' || !('availability' in value)) fail();
  const availability = oneOf(value.availability, [
    'unavailable',
    'no-allocation',
    'absent',
    'observed',
  ]);
  const r = object(
    value,
    availability === 'observed'
      ? ['availability', 'generation', 'phase', 'custody', 'attached']
      : availability === 'absent'
        ? ['availability', 'generation']
        : ['availability']
  );
  if (availability === 'unavailable' || availability === 'no-allocation') return { availability };
  if (availability === 'absent') return { availability, generation: id(r.generation) };
  return {
    availability,
    generation: id(r.generation),
    phase: oneOf(r.phase, ['unopened', 'opening', 'allocated', 'closing', 'closed', 'held']),
    custody: oneOf(r.custody, ['owned', 'released', 'unknown']),
    attached: boolean(r.attached),
  };
}
export function readMemberActionView(value: unknown): BackendMemberActionView {
  const r = object(value, [
    'commandId',
    'launchId',
    'rosterRevision',
    'memberId',
    'action',
    'allocation',
    'sourceGeneration',
    'selectedGeneration',
    'stage',
    'current',
    'source',
    'selected',
  ]);
  const row: BackendMemberActionView = {
    commandId: id(r.commandId),
    launchId: id(r.launchId),
    rosterRevision: id(r.rosterRevision),
    memberId: id(r.memberId),
    action: oneOf(r.action, ['restart', 'skip']),
    allocation: oneOf(r.allocation, ['none', 'runtime']),
    sourceGeneration: generation(r.sourceGeneration),
    selectedGeneration: generation(r.selectedGeneration),
    stage: oneOf(r.stage, [
      'prepared',
      'requested',
      'source-closed',
      'source-unallocated',
      'selected',
      'refused',
    ]),
    current: boolean(r.current),
    source: observation(r.source),
    selected: r.selected === null ? null : observation(r.selected),
  };
  if (
    (row.source.availability === 'no-allocation' && row.allocation !== 'none') ||
    (row.selected?.availability === 'no-allocation' && row.allocation !== 'none') ||
    (row.allocation === 'none' && row.action !== 'skip') ||
    (row.stage === 'source-unallocated' && row.allocation !== 'none') ||
    (row.stage !== 'selected' && row.selected !== null) ||
    ((row.source.availability === 'observed' || row.source.availability === 'absent') &&
      row.source.generation !== row.sourceGeneration) ||
    ((row.selected?.availability === 'observed' || row.selected?.availability === 'absent') &&
      row.selected.generation !== row.selectedGeneration)
  )
    fail();
  return row;
}
export function readMemberActions(value: unknown): BackendMemberActionRead {
  const r = object(value, ['launchId', 'rosterRevision', 'memberId', 'actions', 'retries']);
  if (
    !Array.isArray(r.actions) ||
    r.actions.length > 64 ||
    !Array.isArray(r.retries) ||
    r.retries.length > 64 ||
    JSON.stringify(value).length > 1024 * 1024
  )
    fail();
  const row = {
    launchId: id(r.launchId),
    rosterRevision: id(r.rosterRevision),
    memberId: id(r.memberId),
    actions: r.actions.map(readMemberActionView),
    retries: r.retries.map((value) => {
      const r = object(value, ['commandId', 'attemptId', 'current']);
      return {
        commandId: id(r.commandId),
        attemptId: id(r.attemptId),
        current: boolean(r.current),
      };
    }),
  };
  if (
    new Set(row.retries.map((r) => r.commandId)).size !== row.retries.length ||
    new Set(row.retries.map((r) => r.attemptId)).size !== row.retries.length ||
    row.retries.filter((r) => r.current).length > 1
  )
    fail();
  if (
    row.actions.some((a) => a.launchId !== row.launchId || a.memberId !== row.memberId) ||
    new Set(row.actions.map((a) => a.commandId)).size !== row.actions.length
  )
    fail();
  return row;
}
