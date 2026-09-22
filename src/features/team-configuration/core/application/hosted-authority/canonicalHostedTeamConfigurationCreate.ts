import { parseHostedRosterConfiguration } from '../../../contracts/hostedRosterConfiguration';

import type { HostedCreateDraftTeamRequest, HostedTeamConfigurationMember } from '../../../contracts/hosted';
import type { WorkspaceId } from '@shared/contracts/hosted';

/** Canonical create intent excludes transport context and the idempotency key itself. */
export function canonicalHostedTeamConfigurationCreate(input: {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly members: readonly HostedTeamConfigurationMember[];
  readonly configuration?: HostedCreateDraftTeamRequest['configuration'];
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    metadata: { name: input.name },
    members: input.members.map((member) => ({ name: member.name })),
    ...(Object.hasOwn(input, 'configuration') ? { configuration: parseHostedRosterConfiguration(input.configuration) } : {}),
  });
}
