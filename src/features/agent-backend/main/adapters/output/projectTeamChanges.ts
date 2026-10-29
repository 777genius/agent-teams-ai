import type { BackendTeamChanges, BackendTeamPosition } from '../../../contracts/teamChanges';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid product feed');
  return value as Record<string, unknown>;
}
function sequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error('Invalid product sequence');
  return Number(value);
}
export function projectTeamPosition(value: unknown): BackendTeamPosition {
  const source = row(value);
  if (
    typeof source.streamId !== 'string' ||
    !uuid.test(source.streamId) ||
    typeof source.cursor !== 'string' ||
    !uuid.test(source.cursor)
  )
    throw new Error('Invalid product position');
  return { streamId: source.streamId, cursor: source.cursor, sequence: sequence(source.sequence) };
}
export function projectTeamChanges(value: unknown): BackendTeamChanges {
  const source = row(value);
  if (
    Buffer.byteLength(JSON.stringify(source)) > 64 * 1024 ||
    !Array.isArray(source.events) ||
    source.events.length > 128
  )
    throw new Error('Oversized product feed');
  const position = projectTeamPosition(source);
  let previous: number | undefined;
  const events = source.events.map((value) => {
    const event = row(value),
      index = sequence(event.sequence);
    if (
      event.kind !== 'invalidate' ||
      index < 1 ||
      (previous !== undefined && index !== previous + 1) ||
      index > position.sequence ||
      event.eventId !== `${position.streamId}:${index}`
    )
      throw new Error('Invalid product event');
    previous = index;
    return { sequence: index, eventId: event.eventId, kind: 'invalidate' as const };
  });
  if (events.length && previous !== position.sequence) throw new Error('Incomplete product feed');
  if (source.gap !== undefined) {
    const reason = row(source.gap).reason;
    if (events.length || (reason !== 'initial' && reason !== 'cursor' && reason !== 'retention'))
      throw new Error('Invalid product gap');
    return { ...position, events, gap: { reason } };
  }
  return { ...position, events };
}
