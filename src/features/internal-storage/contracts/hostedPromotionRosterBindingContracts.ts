import { promotionOperationId } from './hostedPromotionStorageContracts';
import { exactPublicationRecord } from './teamDraftPublicationContracts';

export interface HostedPromotionRosterMemberBinding {
  readonly memberOrdinal: number;
  readonly memberId: string;
  readonly name: string;
  readonly model: string;
  readonly promptSha256: string;
}
export interface HostedPromotionRosterLaneBinding {
  readonly laneOrdinal: number;
  readonly laneId: string;
  readonly members: readonly HostedPromotionRosterMemberBinding[];
}
/** Separate immutable commit artifact, keyed to the exact schema-2 promotion. */
export interface HostedPromotionRosterBinding {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly planSha256: string;
  readonly lanes: readonly HostedPromotionRosterLaneBinding[];
}
export type HostedPromotionRosterBindingReadResult =
  | { readonly kind: 'found'; readonly binding: HostedPromotionRosterBinding }
  | { readonly kind: 'unavailable'; readonly reason: 'legacy_frozen_without_binding' }
  | null;

const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ordinal = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < 32;
const dense = (value: unknown[]): boolean =>
  Reflect.ownKeys(value).length === value.length + 1 &&
  Array.from({ length: value.length }, (_, index) => index).every((index) =>
    Object.hasOwn(value, index)
  );

export function parseHostedPromotionRosterBinding(value: unknown): HostedPromotionRosterBinding {
  const input = exactPublicationRecord(value, [
    'schemaVersion',
    'operationId',
    'planSha256',
    'lanes',
  ]);
  if (
    input.schemaVersion !== 1 ||
    !sha(input.planSha256) ||
    !Array.isArray(input.lanes) ||
    input.lanes.length < 1 ||
    input.lanes.length > 32 ||
    !dense(input.lanes)
  ) {
    throw new TypeError('promotion-roster-binding-invalid');
  }
  const memberIds = new Set<string>();
  const names = new Set<string>();
  const laneIds = new Set<string>();
  const lanes = input.lanes.map((candidate, laneOrdinal) => {
    const lane = exactPublicationRecord(candidate, ['laneOrdinal', 'laneId', 'members']);
    if (
      !ordinal(lane.laneOrdinal) ||
      lane.laneOrdinal !== laneOrdinal ||
      typeof lane.laneId !== 'string' ||
      !/^lane_[a-f0-9]{32}$/.test(lane.laneId) ||
      laneIds.has(lane.laneId) ||
      !Array.isArray(lane.members) ||
      lane.members.length < 1 ||
      lane.members.length > 32 ||
      !dense(lane.members)
    ) {
      throw new TypeError('promotion-roster-binding-invalid');
    }
    laneIds.add(lane.laneId);
    const members = lane.members.map((candidateMember, memberOrdinal) => {
      const member = exactPublicationRecord(candidateMember, [
        'memberOrdinal',
        'memberId',
        'name',
        'model',
        'promptSha256',
      ]);
      if (
        !ordinal(member.memberOrdinal) ||
        member.memberOrdinal !== memberOrdinal ||
        typeof member.memberId !== 'string' ||
        !/^member_[a-f0-9]{32}$/.test(member.memberId) ||
        memberIds.has(member.memberId) ||
        typeof member.name !== 'string' ||
        !member.name ||
        names.has(member.name.toLowerCase()) ||
        typeof member.model !== 'string' ||
        !member.model ||
        !sha(member.promptSha256)
      ) {
        throw new TypeError('promotion-roster-binding-invalid');
      }
      memberIds.add(member.memberId);
      names.add(member.name.toLowerCase());
      return Object.freeze({
        memberOrdinal,
        memberId: member.memberId,
        name: member.name,
        model: member.model,
        promptSha256: member.promptSha256,
      });
    });
    return Object.freeze({ laneOrdinal, laneId: lane.laneId, members: Object.freeze(members) });
  });
  if (memberIds.size > 32) throw new TypeError('promotion-roster-binding-invalid');
  return Object.freeze({
    schemaVersion: 1,
    operationId: promotionOperationId(input.operationId),
    planSha256: input.planSha256,
    lanes: Object.freeze(lanes),
  });
}

export function parseHostedPromotionRosterBindingReadResult(
  value: unknown
): HostedPromotionRosterBindingReadResult {
  if (value === null) return null;
  const input = exactPublicationRecord(
    value,
    (value as { kind?: unknown })?.kind === 'found' ? ['kind', 'binding'] : ['kind', 'reason']
  );
  if (input.kind === 'found')
    return { kind: 'found', binding: parseHostedPromotionRosterBinding(input.binding) };
  if (input.kind === 'unavailable' && input.reason === 'legacy_frozen_without_binding') {
    return { kind: 'unavailable', reason: input.reason };
  }
  throw new TypeError('promotion-roster-binding-result-invalid');
}
