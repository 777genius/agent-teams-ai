import { isTeamEffortLevelForProvider } from '@shared/utils/effortLevels';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';
import { parseNumericSuffixName, validateTeamMemberNameFormat } from '@shared/utils/teamMemberName';
import { isTeamProviderId } from '@shared/utils/teamProvider';

import type { EffortLevel, TeamProviderId } from '@shared/types';

export interface HostedInitialMember {
  readonly name: string;
  readonly prompt: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
}

export type HostedInitialLane =
  | Readonly<{
      kind: 'native';
      provider: Exclude<TeamProviderId, 'opencode'>;
      members: readonly HostedInitialMember[];
    }>
  | Readonly<{
      kind: 'opencode';
      provider: 'opencode';
      selectedModel: string;
      effort?: EffortLevel;
      members: readonly HostedInitialMember[];
    }>;

/** Configuration only. Neither this schema nor model syntax asserts runtime availability. */
export interface HostedRosterConfiguration {
  readonly schemaVersion: 1;
  readonly toolApprovalMode: 'manual' | 'auto';
  readonly lanes: readonly HostedInitialLane[];
}

/**
 * Hosted MVP launch policy. Keep this separate from parsing: persisted manual-mode records remain
 * readable by shared and desktop consumers while Hosted activation stays fail-closed.
 *
 * TODO(hosted-manual-approval): set availability from the Hosted capability composition only after
 * the acceptance criteria in docs/hosted-web-mvp-deferred-todos.md are satisfied.
 */
export const HOSTED_MVP_TOOL_APPROVAL_MODE = 'auto' as const;
export function isHostedMvpManualApprovalAvailable(): boolean {
  return false;
}

export function isHostedMvpApprovalModeAvailable(
  configuration: Pick<HostedRosterConfiguration, 'toolApprovalMode'>
): boolean {
  return (
    configuration.toolApprovalMode === 'auto' ||
    (configuration.toolApprovalMode === 'manual' && isHostedMvpManualApprovalAvailable())
  );
}

export const HOSTED_ROSTER_MAX_BYTES = 192 * 1024;

function invalid(): never {
  throw new TypeError('hosted-roster-configuration-invalid');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function fields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Reflect.ownKeys(value).some(
      (key) => typeof key !== 'string' || ![...required, ...optional].includes(key)
    )
  )
    invalid();
}

function list(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 32 ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, index) => index).some(
      (index) => !Object.hasOwn(value, index)
    )
  ) {
    return invalid();
  }
  return value;
}

function bounded(value: unknown, bytes: number): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.trim() !== value ||
    value.includes('\0') ||
    value.length > bytes ||
    new TextEncoder().encode(value).length > bytes
  )
    return invalid();
  return value;
}

export function isHostedInitialMemberName(name: string): boolean {
  const lower = name.toLowerCase();
  const suffix = parseNumericSuffixName(name);
  return (
    name.length <= 64 &&
    name.trim() === name &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(name) &&
    validateTeamMemberNameFormat(name) === null &&
    lower !== 'user' &&
    lower !== 'team-lead' &&
    !lower.endsWith('-provisioner') &&
    !(suffix && suffix.suffix >= 2)
  );
}

function effort(value: unknown, provider: TeamProviderId): EffortLevel {
  if (!isTeamEffortLevelForProvider(value, provider)) return invalid();
  return value;
}

function model(value: unknown, provider: TeamProviderId): string {
  const result = bounded(value, 256);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/.test(result) ||
    /^[A-Za-z]:/.test(result) ||
    result.split('/').some((part) => part === '.' || part === '..')
  )
    return invalid();
  if (provider === 'opencode' && !parseOpenCodeQualifiedModelRef(result)) return invalid();
  return result;
}

/** Strict, detached, ordered DTO; host-owned lane IDs and paths are deliberately absent. */
export function parseHostedRosterConfiguration(value: unknown): HostedRosterConfiguration {
  const input = record(value);
  fields(input, ['schemaVersion', 'toolApprovalMode', 'lanes']);
  if (
    input.schemaVersion !== 1 ||
    (input.toolApprovalMode !== 'manual' && input.toolApprovalMode !== 'auto')
  )
    return invalid();
  const names = new Set<string>();
  const lanes = list(input.lanes).map((raw): HostedInitialLane => {
    const lane = record(raw);
    if (!isTeamProviderId(lane.provider)) return invalid();
    const provider = lane.provider;
    const openCode = provider === 'opencode';
    if (lane.kind !== (openCode ? 'opencode' : 'native')) return invalid();
    fields(
      lane,
      ['kind', 'provider', 'members', ...(openCode ? ['selectedModel'] : [])],
      openCode ? ['effort'] : []
    );
    const members = Object.freeze(
      list(lane.members).map((rawMember): HostedInitialMember => {
        const member = record(rawMember);
        fields(
          member,
          ['name', 'prompt', ...(!openCode ? ['model'] : [])],
          openCode ? ['model', 'effort'] : ['effort']
        );
        const name = bounded(member.name, 64);
        if (!isHostedInitialMemberName(name) || names.has(name.toLowerCase())) return invalid();
        names.add(name.toLowerCase());
        if (names.size > 32) return invalid();
        return Object.freeze({
          name,
          prompt: bounded(member.prompt, 64 * 1024),
          ...(Object.hasOwn(member, 'model') ? { model: model(member.model, provider) } : {}),
          ...(Object.hasOwn(member, 'effort') ? { effort: effort(member.effort, provider) } : {}),
        });
      })
    );
    if (openCode)
      return Object.freeze({
        kind: 'opencode',
        provider: 'opencode',
        selectedModel: model(lane.selectedModel, provider),
        ...(Object.hasOwn(lane, 'effort') ? { effort: effort(lane.effort, provider) } : {}),
        members,
      });
    return Object.freeze({ kind: 'native', provider, members });
  });
  const result = Object.freeze({
    schemaVersion: 1 as const,
    toolApprovalMode: input.toolApprovalMode,
    lanes: Object.freeze(lanes),
  });
  if (new TextEncoder().encode(JSON.stringify(result)).length > HOSTED_ROSTER_MAX_BYTES)
    return invalid();
  return result;
}

export function hostedRosterMembers(
  configuration: HostedRosterConfiguration
): readonly Readonly<{ name: string }>[] {
  return Object.freeze(
    configuration.lanes.flatMap((lane) => lane.members.map(({ name }) => Object.freeze({ name })))
  );
}

export function assertHostedRosterMatches(
  configuration: HostedRosterConfiguration,
  members: readonly Readonly<{ name: string }>[]
): void {
  const ordered = hostedRosterMembers(configuration);
  if (
    ordered.length !== members.length ||
    ordered.some((member, index) => member.name !== members[index]?.name)
  )
    invalid();
}
