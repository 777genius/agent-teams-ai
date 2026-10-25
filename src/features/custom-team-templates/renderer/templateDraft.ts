import { applyTeamTemplate } from '@features/team-templates';

import type { BuiltinTeamTemplateId, CustomTeamTemplateV1 } from '../contracts';
import type { TeamTemplateV1 } from '@features/team-templates/contracts';
import type { TeamCreateConfigRequest } from '@shared/types';

/**
 * Draft produced when a team template is applied to team creation.
 *
 * This is structurally identical to `applyTeamTemplate`'s result: only the
 * allowlisted creation fields (`description`, `prompt`, `members`) plus the
 * fixed runtime defaults. It carries no template identity, no revision, no
 * tasks, messages, sessions or history — the backend generates all new team
 * and member identities from the ordinary `TeamCreateRequest` path.
 */
export type CreateTeamTemplateDraft = Pick<
  TeamCreateConfigRequest,
  'runtimeSelectionVersion' | 'description' | 'prompt' | 'members' | 'syncModelsWithLead'
>;

export const CREATE_TEAM_TEMPLATE_NONE_VALUE = 'none';

export function builtinTemplateSelectionValue(id: BuiltinTeamTemplateId): string {
  return `builtin:${id}`;
}

export function customTemplateSelectionValue(templateId: string): string {
  return `custom:${templateId}`;
}

export type ParsedTemplateSelection =
  | { kind: 'none' }
  | { kind: 'builtin'; builtinTemplateId: string }
  | { kind: 'custom'; templateId: string }
  | { kind: 'unknown'; value: string };

export function parseTemplateSelectionValue(value: string): ParsedTemplateSelection {
  if (value === CREATE_TEAM_TEMPLATE_NONE_VALUE) return { kind: 'none' };
  if (value.startsWith('builtin:')) {
    return { kind: 'builtin', builtinTemplateId: value.slice('builtin:'.length) };
  }
  if (value.startsWith('custom:')) {
    return { kind: 'custom', templateId: value.slice('custom:'.length) };
  }
  return { kind: 'unknown', value };
}

/** Blank draft preserving the ordinary no-template creation experience. */
export function applyNoTeamTemplate(): CreateTeamTemplateDraft {
  return {
    runtimeSelectionVersion: 1,
    description: '',
    prompt: '',
    members: [],
    syncModelsWithLead: true,
  };
}

/**
 * Custom-template equivalent of `applyTeamTemplate`.
 *
 * Copies only the allowlisted content (`description`, `teamPrompt`, member
 * `name`/`role`/`workflow`) into fresh objects. The source record is never
 * mutated and no identity (`templateId`, `revision`, timestamps) survives —
 * the new team always receives backend-generated identities.
 */
export function applyCustomTeamTemplate(template: CustomTeamTemplateV1): CreateTeamTemplateDraft {
  return {
    runtimeSelectionVersion: 1,
    description: template.description ?? '',
    prompt: template.teamPrompt,
    members: template.members.map((member) => ({
      name: member.name,
      role: member.role,
      workflow: member.workflow,
    })),
    syncModelsWithLead: true,
  };
}

export type ResolveTemplateDraftResult =
  | { status: 'none'; draft: CreateTeamTemplateDraft }
  | {
      status: 'builtin';
      draft: CreateTeamTemplateDraft;
      builtinTemplateId: BuiltinTeamTemplateId;
    }
  | {
      status: 'custom';
      draft: CreateTeamTemplateDraft;
      templateId: string;
      revision: number;
    }
  | { status: 'builtinNotFound'; value: string }
  | { status: 'customNotFound'; value: string }
  | { status: 'unknownSelection'; value: string };

/**
 * Resolves a picker selection to the draft the creation dialog should apply.
 *
 * Built-in ids stay a closed catalogue: an id outside `builtins` resolves to
 * `builtinNotFound` and must never bypass backend/catalogue validation. A
 * custom id absent from the loaded library resolves to `customNotFound` so
 * the caller can surface a stale/deleted-template error instead of silently
 * applying the wrong content.
 */
export function resolveCreateTeamTemplateDraft(
  value: string,
  options: {
    builtins: readonly TeamTemplateV1[];
    customs: readonly CustomTeamTemplateV1[];
  }
): ResolveTemplateDraftResult {
  const parsed = parseTemplateSelectionValue(value);
  if (parsed.kind === 'none') {
    return { status: 'none', draft: applyNoTeamTemplate() };
  }
  if (parsed.kind === 'builtin') {
    const builtin = options.builtins.find((entry) => entry.id === parsed.builtinTemplateId);
    if (!builtin) return { status: 'builtinNotFound', value };
    return {
      status: 'builtin',
      draft: applyTeamTemplate(builtin),
      builtinTemplateId: builtin.id as BuiltinTeamTemplateId,
    };
  }
  if (parsed.kind === 'custom') {
    const record = options.customs.find((entry) => entry.templateId === parsed.templateId);
    if (!record) return { status: 'customNotFound', value };
    return {
      status: 'custom',
      draft: applyCustomTeamTemplate(record),
      templateId: record.templateId,
      revision:
        typeof record.revision === 'number' && Number.isInteger(record.revision)
          ? record.revision
          : 1,
    };
  }
  return { status: 'unknownSelection', value };
}
