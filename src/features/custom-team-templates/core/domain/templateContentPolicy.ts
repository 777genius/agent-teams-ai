import { CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION } from '@features/custom-team-templates/contracts';
import { isCanonicalSettingsLeadMember } from '@shared/utils/leadDetection';
import {
  createCliAutoSuffixNameGuard,
  createCliProvisionerNameGuard,
  validateTeamMemberNameFormat,
} from '@shared/utils/teamMemberName';

import {
  TEMPLATE_MAX_MEMBERS,
  TEMPLATE_MEMBER_ROLE_MAX_LENGTH,
  TEMPLATE_MEMBER_WORKFLOW_MAX_LENGTH,
  TEMPLATE_TEAM_PROMPT_MAX_LENGTH,
} from './templateLimits';
import { normalizeTemplateNameKey } from './templateNamePolicy';

import type {
  CustomTemplateSourceTeamSnapshot,
  RosterMetadataMember,
} from './templateSourceSnapshot';
import type {
  CustomTeamTemplateContentV1,
  CustomTeamTemplateMemberV1,
  CustomTeamTemplateValidationIssue,
  CustomTeamTemplateWarning,
} from '@features/custom-team-templates/contracts';

const RESERVED_TEAMMATE_NAMES = new Set(['user', 'system', 'team-lead']);

function isReservedName(name: string): boolean {
  return RESERVED_TEAMMATE_NAMES.has(name.trim().toLowerCase());
}

function projectMember(member: RosterMetadataMember): CustomTeamTemplateMemberV1 {
  const name = member.name.trim();
  const role = member.role?.trim() ?? '';
  const workflow = member.workflow?.trim() ?? '';
  // Construct field by field so unknown source fields cannot enter the template.
  return {
    name,
    ...(role ? { role } : {}),
    ...(workflow ? { workflow } : {}),
  };
}

export type ProjectTemplateContentResult =
  | {
      status: 'ready';
      content: CustomTeamTemplateContentV1;
      warnings: readonly CustomTeamTemplateWarning[];
    }
  | { status: 'rosterUnreadable'; sourceTeamName: string };

/**
 * Projects a saved-configuration snapshot onto the allowlisted template content.
 *
 * Only team prompt plus active member name/role/workflow survive. Canonical lead
 * identities are excluded from both the member projection and the removed-member
 * count, and runtime-managed `{name}-provisioner` agents are excluded with the
 * same guard the team roster itself uses, so a provisioning artifact is never
 * projected as a teammate. Removed non-lead entries are dropped and reported
 * through a count-based warning derived from the authoritative roster read
 * (never from the filtered active array). Unreadable roster metadata blocks the
 * projection entirely and stays distinct from an absent or valid empty roster.
 */
export function projectTemplateContent(
  snapshot: CustomTemplateSourceTeamSnapshot
): ProjectTemplateContentResult {
  if (snapshot.roster.status === 'unreadable') {
    return { status: 'rosterUnreadable', sourceTeamName: snapshot.sourceTeamName };
  }

  const warnings: CustomTeamTemplateWarning[] = [];
  const teamPrompt = typeof snapshot.teamPrompt === 'string' ? snapshot.teamPrompt.trim() : '';
  if (!teamPrompt) {
    warnings.push({ code: 'missingTeamPrompt' });
  }

  const rosterMembers = snapshot.roster.status === 'readable' ? snapshot.roster.members : [];
  const teammates = rosterMembers.filter((member) => !isCanonicalSettingsLeadMember(member));
  const activeMembers = teammates.filter((member) => !member.removed);
  const removedCount = teammates.length - activeMembers.length;
  const rosterNames = activeMembers.map((member) => member.name);
  const keepAutoSuffixedName = createCliAutoSuffixNameGuard(rosterNames);
  // Provisioning spawns temporary "{name}-provisioner" agents that are internal
  // artifacts, never real teammates, so the established roster guard removes
  // them from the projection before any member is persisted.
  const isRuntimeProvisionerName = createCliProvisionerNameGuard(rosterNames);
  const members = activeMembers
    .filter((member) => keepAutoSuffixedName(member.name) && isRuntimeProvisionerName(member.name))
    .map(projectMember);
  for (const member of members) {
    if (!member.role) {
      warnings.push({ code: 'missingMemberRole', memberName: member.name });
    }
    if (!member.workflow) {
      warnings.push({ code: 'missingMemberWorkflow', memberName: member.name });
    }
  }

  if (snapshot.roster.status === 'absent') {
    warnings.push({ code: 'noRecordedRoster' });
  } else if (members.length === 0) {
    warnings.push({ code: 'emptyRoster' });
  }
  if (removedCount > 0) {
    warnings.push({ code: 'removedMembersExcluded', count: removedCount });
  }

  return {
    status: 'ready',
    content: {
      schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
      teamPrompt,
      members,
    },
    warnings,
  };
}

/**
 * Validates allowlisted template content against explicit bounds.
 *
 * A runtime-managed `{name}-provisioner` member is rejected exactly like the
 * projection excludes it, so direct validation can never accept a provisioning
 * artifact as a normal template member. Deterministic and side-effect free;
 * does not truncate and does not invent member role/workflow values.
 */
export function validateTemplateContent(
  content: CustomTeamTemplateContentV1
): readonly CustomTeamTemplateValidationIssue[] {
  const issues: CustomTeamTemplateValidationIssue[] = [];
  if (content.teamPrompt.length > TEMPLATE_TEAM_PROMPT_MAX_LENGTH) {
    issues.push({ code: 'teamPromptTooLong', field: 'teamPrompt' });
  }
  if (content.members.length > TEMPLATE_MAX_MEMBERS) {
    issues.push({ code: 'tooManyMembers', field: 'members' });
  }

  const rosterNames = content.members.map((member) => member.name);
  const keepAutoSuffixedName = createCliAutoSuffixNameGuard(rosterNames);
  const isRuntimeProvisionerName = createCliProvisionerNameGuard(rosterNames);
  const seenNames = new Set<string>();
  content.members.forEach((member, index) => {
    const baseField = `members[${index}]`;
    const name = member.name.trim();
    if (!name) {
      issues.push({ code: 'memberNameRequired', field: `${baseField}.name` });
    } else {
      if (
        validateTeamMemberNameFormat(name) ||
        isReservedName(name) ||
        !keepAutoSuffixedName(name) ||
        !isRuntimeProvisionerName(name)
      ) {
        issues.push({ code: 'memberNameInvalid', field: `${baseField}.name` });
      }
      const identity = normalizeTemplateNameKey(name);
      if (seenNames.has(identity)) {
        issues.push({ code: 'duplicateMemberName', field: `${baseField}.name` });
      }
      seenNames.add(identity);
    }
    if (member.role && member.role.length > TEMPLATE_MEMBER_ROLE_MAX_LENGTH) {
      issues.push({ code: 'memberRoleTooLong', field: `${baseField}.role` });
    }
    if (member.workflow && member.workflow.length > TEMPLATE_MEMBER_WORKFLOW_MAX_LENGTH) {
      issues.push({ code: 'memberWorkflowTooLong', field: `${baseField}.workflow` });
    }
  });

  return issues;
}
