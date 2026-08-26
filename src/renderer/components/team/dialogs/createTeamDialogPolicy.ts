import { validateMemberNameInline } from '@renderer/components/team/members/MembersEditorSection';

import type { useAppTranslation } from '@features/localization/renderer';
import type { TeamCreateRequest } from '@shared/types';

type CreateTeamTranslator = ReturnType<typeof useAppTranslation>['t'];

export const TEAM_COLOR_NAMES = [
  'blue',
  'green',
  'red',
  'yellow',
  'purple',
  'cyan',
  'orange',
  'pink',
] as const;

export const DEFAULT_CREATE_TEAM_MEMBERS: ReadonlyArray<{
  name: string;
  roleSelection: string;
  workflowKind?: 'reviewer';
}> = [
  { name: 'alice', roleSelection: 'reviewer', workflowKind: 'reviewer' },
  { name: 'tom', roleSelection: 'developer' },
  { name: 'bob', roleSelection: 'developer' },
  { name: 'jack', roleSelection: 'developer' },
];

export interface TeamCopyData extends Pick<
  TeamCreateRequest,
  | 'description'
  | 'color'
  | 'prompt'
  | 'providerId'
  | 'model'
  | 'effort'
  | 'fastMode'
  | 'limitContext'
  | 'skipPermissions'
  | 'members'
> {
  teamName: string;
  cwd?: string;
}

export interface ActiveTeamRef {
  teamName: string;
  displayName: string;
  projectPath: string;
}

export interface CreateTeamValidationResult {
  valid: boolean;
  errors?: {
    teamName?: string;
    members?: string;
    cwd?: string;
  };
}

/** Mirrors Claude CLI's sanitization without a backtracking-prone trim regex. */
export function sanitizeCreateTeamName(name: string): string {
  let result = name
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-{2,}/g, '-')
    .toLowerCase();
  while (result.startsWith('-')) result = result.slice(1);
  while (result.endsWith('-')) result = result.slice(0, -1);
  return result;
}

export function validateCreateTeamNameInline(name: string, t: CreateTeamTranslator): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const sanitized = sanitizeCreateTeamName(trimmed);
  if (!sanitized) return t('create.validation.nameMustContainLetterOrDigit');
  if (sanitized.length > 128) return t('create.validation.nameTooLong');
  return null;
}

export function buildDefaultCreateTeamDescription(
  teamName: string,
  t: CreateTeamTranslator
): string {
  const trimmedName = teamName.trim();
  return trimmedName.length > 0
    ? t('create.defaultDescription.named', { teamName: trimmedName })
    : t('create.defaultDescription.fallback');
}

export function validateCreateTeamRequest(
  request: TeamCreateRequest,
  t: CreateTeamTranslator,
  options?: { requireCwd?: boolean }
): CreateTeamValidationResult {
  const requireCwd = options?.requireCwd ?? true;
  const sanitized = sanitizeCreateTeamName(request.teamName);
  if (!sanitized) {
    return {
      valid: false,
      errors: { teamName: t('create.validation.nameMustContainLetterOrDigit') },
    };
  }
  if (sanitized.length > 128) {
    return { valid: false, errors: { teamName: t('create.validation.nameTooLong') } };
  }
  if (requireCwd && !request.cwd.trim()) {
    return { valid: false, errors: { cwd: t('create.validation.selectWorkingDirectory') } };
  }
  if (request.members.some((member) => !member.name.trim())) {
    return { valid: false, errors: { members: t('create.validation.memberNameRequired') } };
  }
  if (request.members.some((member) => validateMemberNameInline(member.name.trim()) !== null)) {
    return { valid: false, errors: { members: t('create.validation.memberNameInvalid') } };
  }
  const uniqueNames = new Set(request.members.map((member) => member.name.trim().toLowerCase()));
  if (uniqueNames.size !== request.members.length) {
    return { valid: false, errors: { members: t('create.validation.memberNamesUnique') } };
  }
  return { valid: true };
}

export function isCurrentCreateTeamPrepareGeneration(
  ref: { current: number },
  generation: number
): boolean {
  return ref.current === generation;
}
