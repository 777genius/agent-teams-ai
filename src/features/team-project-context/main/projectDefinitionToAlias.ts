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

/** What a project copy takes from the definition besides the roster. */
export interface DefinitionMetadataUpdate {
  name?: string;
  description: string;
  color: string;
  /** Saved lead instructions; present only when they differ. */
  prompt?: string;
}

export interface DefinitionProjectionPorts {
  /** Only for a physical alias that is already known to be stopped by the caller's policy. */
  assertStoppedForSync(aliasTeamName: string): Promise<void>;
  replaceMembers(aliasTeamName: string, request: ReplaceMembersRequest): Promise<void>;
  updateDisplayMetadata(aliasTeamName: string, update: DefinitionMetadataUpdate): Promise<void>;
}

export interface DefinitionProjectionResult {
  roster: boolean;
  metadata: boolean;
}

/**
 * The logical team is the only authority for the authored roster, the
 * display metadata (name, description, color) and the saved lead instructions.
 * A lead prompt typed at one launch is still used for that run (the launch
 * request wins) but the saved one is the definition's. The alias keeps its own
 * directory identity; only the shown name is refreshed (the runtime reads it
 * for recovery and notifications). A physical project alias is a
 * projection of it: this copies only those fields, never tasks, inboxes or
 * sessions, and keeps the alias's run identities (the roster mutation is the
 * existing stopped-only one).
 */
export async function projectDefinitionToAlias(
  ports: DefinitionProjectionPorts,
  logical: Pick<TeamCreateRequest, 'members' | 'displayName' | 'description' | 'color' | 'prompt'>,
  alias: Pick<TeamCreateRequest, 'members' | 'displayName' | 'description' | 'color' | 'prompt'> & {
    teamName: string;
  }
): Promise<DefinitionProjectionResult> {
  const roster = !isDeepStrictEqual(authoredRoster(logical.members), authoredRoster(alias.members));
  const nextName = displayText(logical.displayName);
  const promptChanged = displayText(logical.prompt) !== displayText(alias.prompt);
  const metadata =
    (nextName !== '' && nextName !== displayText(alias.displayName)) ||
    displayText(logical.description) !== displayText(alias.description) ||
    displayText(logical.color) !== displayText(alias.color) ||
    promptChanged;
  if (!roster && !metadata) return { roster, metadata };
  await ports.assertStoppedForSync(alias.teamName);
  if (roster) {
    await ports.replaceMembers(alias.teamName, { members: logical.members });
  }
  if (metadata) {
    await ports.updateDisplayMetadata(alias.teamName, {
      ...(nextName ? { name: nextName } : {}),
      description: displayText(logical.description),
      color: displayText(logical.color),
      ...(promptChanged ? { prompt: displayText(logical.prompt) } : {}),
    });
  }
  return { roster, metadata };
}
