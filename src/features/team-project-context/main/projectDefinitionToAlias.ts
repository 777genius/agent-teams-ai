import { isDeepStrictEqual } from 'node:util';

import type { ReplaceMembersRequest, TeamCreateRequest } from '@shared/types';

type AuthoringMember = TeamCreateRequest['members'][number];

/** Runtime cwd/agentId are per-run; only the authored roster belongs to the logical team. */
export function authoredRoster(members: readonly AuthoringMember[]): unknown[] {
  return members.map((member) => ({
    name: member.name,
    role: member.role,
    workflow: member.workflow,
    isolation: member.isolation,
    providerId: member.providerId,
    providerBackendId: member.providerBackendId,
    model: member.model,
    effort: member.effort,
    fastMode: member.fastMode,
    mcpPolicy: member.mcpPolicy,
  }));
}

function displayText(value: string | undefined): string {
  return value?.trim() ?? '';
}

export interface DefinitionProjectionPorts {
  /** Only for a physical alias that is already known to be stopped by the caller's policy. */
  assertStoppedForSync(aliasTeamName: string): Promise<void>;
  replaceMembers(aliasTeamName: string, request: ReplaceMembersRequest): Promise<void>;
  updateDisplayMetadata(
    aliasTeamName: string,
    update: { description: string; color: string }
  ): Promise<void>;
}

export interface DefinitionProjectionResult {
  roster: boolean;
  metadata: boolean;
}

/**
 * The logical team is the only authority for the authored roster and the
 * display metadata (description, color). A physical project alias is a
 * projection of it: this copies only those fields, never tasks, inboxes or
 * sessions, and keeps the alias's run identities (the roster mutation is the
 * existing stopped-only one).
 */
export async function projectDefinitionToAlias(
  ports: DefinitionProjectionPorts,
  logical: Pick<TeamCreateRequest, 'members' | 'description' | 'color'>,
  alias: Pick<TeamCreateRequest, 'members' | 'description' | 'color'> & { teamName: string }
): Promise<DefinitionProjectionResult> {
  const roster = !isDeepStrictEqual(authoredRoster(logical.members), authoredRoster(alias.members));
  const metadata =
    displayText(logical.description) !== displayText(alias.description) ||
    displayText(logical.color) !== displayText(alias.color);
  if (!roster && !metadata) return { roster, metadata };
  await ports.assertStoppedForSync(alias.teamName);
  if (roster) {
    await ports.replaceMembers(alias.teamName, { members: logical.members });
  }
  if (metadata) {
    await ports.updateDisplayMetadata(alias.teamName, {
      description: displayText(logical.description),
      color: displayText(logical.color),
    });
  }
  return { roster, metadata };
}
