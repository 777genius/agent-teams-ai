import {
  ANTHROPIC_TEAM_EFFORT_LEVELS,
  CODEX_TEAM_EFFORT_LEVELS,
  isTeamEffortLevelForProvider,
  LEGACY_TEAM_EFFORT_LEVELS,
} from '@shared/utils/effortLevels';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';

import {
  HOSTED_MVP_TOOL_APPROVAL_MODE,
  type HostedRosterConfiguration,
  hostedRosterMembers,
  isHostedInitialMemberName,
  parseHostedRosterConfiguration,
} from '../../contracts/hostedRosterConfiguration';

import type { EffortLevel, TeamProviderId } from '@shared/types';

export interface HostedRosterMemberDraft {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly model: string;
  readonly effort: EffortLevel | '';
}

export interface HostedRosterLaneDraft {
  readonly id: string;
  readonly provider: TeamProviderId;
  readonly selectedModel: string;
  readonly effort: EffortLevel | '';
  readonly members: readonly HostedRosterMemberDraft[];
}

export interface HostedInitialRosterDraft {
  readonly lanes: readonly HostedRosterLaneDraft[];
}

export type HostedInitialRosterResult =
  | Readonly<{
      ok: true;
      configuration: HostedRosterConfiguration;
      members: readonly Readonly<{ name: string }>[];
    }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

let nextEditorId = 0;

function id(prefix: 'lane' | 'member'): string {
  nextEditorId += 1;
  return `${prefix}-${nextEditorId}`;
}

function member(
  values: Partial<Omit<HostedRosterMemberDraft, 'id'>> = {}
): HostedRosterMemberDraft {
  return Object.freeze({
    id: id('member'),
    name: values.name ?? '',
    prompt: values.prompt ?? '',
    model: values.model ?? '',
    effort: values.effort ?? '',
  });
}

export function createHostedInitialRosterDraft(): HostedInitialRosterDraft {
  return Object.freeze({
    lanes: Object.freeze([
      Object.freeze({
        id: id('lane'),
        provider: 'codex' as const,
        selectedModel: '',
        effort: '' as const,
        members: Object.freeze([member({ name: 'lead', model: 'gpt-5.6-sol', effort: 'medium' })]),
      }),
    ]),
  });
}

export function hostedConfigurationToRosterDraft(
  configuration: HostedRosterConfiguration
): HostedInitialRosterDraft {
  return Object.freeze({
    lanes: Object.freeze(
      configuration.lanes.map((lane) =>
        Object.freeze({
          id: id('lane'),
          provider: lane.provider,
          selectedModel: lane.kind === 'opencode' ? lane.selectedModel : '',
          effort: lane.kind === 'opencode' ? (lane.effort ?? '') : '',
          members: Object.freeze(
            lane.members.map((value) =>
              member({
                name: value.name,
                prompt: value.prompt,
                model: value.model ?? '',
                effort: value.effort ?? '',
              })
            )
          ),
        })
      )
    ),
  });
}

export function createEmptyHostedRosterLane(provider: TeamProviderId): HostedRosterLaneDraft {
  return Object.freeze({
    id: id('lane'),
    provider,
    selectedModel: '',
    effort: '',
    members: Object.freeze([member()]),
  });
}

export function createEmptyHostedRosterMember(): HostedRosterMemberDraft {
  return member();
}

export function effortLevelsForHostedProvider(provider: TeamProviderId): readonly EffortLevel[] {
  if (provider === 'codex') return CODEX_TEAM_EFFORT_LEVELS;
  if (provider === 'anthropic') return ANTHROPIC_TEAM_EFFORT_LEVELS;
  return LEGACY_TEAM_EFFORT_LEVELS;
}

export function buildHostedRosterConfiguration(
  draft: HostedInitialRosterDraft
): HostedInitialRosterResult {
  const errors: string[] = [];
  const names = new Set<string>();
  let memberCount = 0;
  if (draft.lanes.length < 1 || draft.lanes.length > 32) {
    errors.push('Add between 1 and 32 runtime lanes.');
  }

  const lanes = draft.lanes.map((lane, laneIndex) => {
    const laneNumber = laneIndex + 1;
    if (lane.members.length < 1) errors.push(`Lane ${laneNumber} needs at least one member.`);
    memberCount += lane.members.length;
    const selectedModel = lane.selectedModel;
    if (
      lane.provider === 'opencode' &&
      (selectedModel !== selectedModel.trim() ||
        parseOpenCodeQualifiedModelRef(selectedModel) === null)
    ) {
      errors.push(`Lane ${laneNumber} needs a provider-qualified OpenCode model.`);
    }
    if (lane.effort && !isTeamEffortLevelForProvider(lane.effort, lane.provider)) {
      errors.push(`Lane ${laneNumber} has an unsupported effort level.`);
    }

    const members = lane.members.map((value, memberIndex) => {
      const memberNumber = memberIndex + 1;
      const { name, prompt, model } = value;
      if (!isHostedInitialMemberName(name)) {
        errors.push(`Lane ${laneNumber}, member ${memberNumber} needs a valid unique name.`);
      } else if (names.has(name.toLowerCase())) {
        errors.push(`Member name “${name}” is used more than once.`);
      } else {
        names.add(name.toLowerCase());
      }
      if (!prompt.trim()) {
        errors.push(`Member “${name || memberNumber}” needs instructions.`);
      } else if (prompt !== prompt.trim()) {
        errors.push(
          `Member “${name || memberNumber}” instructions cannot start or end with whitespace.`
        );
      }
      if (lane.provider !== 'opencode' && !model.trim()) {
        errors.push(`Member “${name || memberNumber}” needs a model for ${lane.provider}.`);
      }
      if (model && model !== model.trim()) {
        errors.push(`Member “${name || memberNumber}” model cannot start or end with whitespace.`);
      }
      if (lane.provider === 'opencode' && model && parseOpenCodeQualifiedModelRef(model) === null) {
        errors.push(`Member “${name || memberNumber}” model must be provider-qualified.`);
      }
      if (value.effort && !isTeamEffortLevelForProvider(value.effort, lane.provider)) {
        errors.push(`Member “${name || memberNumber}” has an unsupported effort level.`);
      }
      return {
        name,
        prompt,
        ...(model ? { model } : {}),
        ...(value.effort ? { effort: value.effort } : {}),
      };
    });

    return lane.provider === 'opencode'
      ? {
          kind: 'opencode' as const,
          provider: 'opencode' as const,
          selectedModel,
          ...(lane.effort ? { effort: lane.effort } : {}),
          members,
        }
      : {
          kind: 'native' as const,
          provider: lane.provider,
          members,
        };
  });

  if (memberCount > 32) errors.push('An initial roster can contain at most 32 members.');
  if (errors.length > 0) return Object.freeze({ ok: false, errors: Object.freeze(errors) });
  try {
    const configuration = parseHostedRosterConfiguration({
      schemaVersion: 1,
      toolApprovalMode: HOSTED_MVP_TOOL_APPROVAL_MODE,
      lanes,
    });
    return Object.freeze({
      ok: true,
      configuration,
      members: hostedRosterMembers(configuration),
    });
  } catch {
    return Object.freeze({
      ok: false,
      errors: Object.freeze(['The initial roster contains values outside the supported schema.']),
    });
  }
}

export function hostedRosterCreateFingerprint(
  name: string,
  configuration: HostedRosterConfiguration
): string {
  return JSON.stringify({ name: name.trim(), configuration });
}
