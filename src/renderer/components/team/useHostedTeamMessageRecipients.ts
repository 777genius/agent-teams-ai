import { useEffect, useState } from 'react';

import { HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION } from '@features/team-configuration/contracts';

import type { HostedTeamConfigurationTransport } from '@features/team-configuration/renderer';
import type { TeamId, WorkspaceId } from '@shared/contracts/hosted';

const NO_RECIPIENTS: readonly string[] = Object.freeze([]);

/**
 * Teammate names offered as direct-message recipients, read from the saved hosted roster. This is
 * only a picker source: the external owner re-checks every recipient against the live roster, and
 * any read failure leaves the lead as the only choice.
 */
export function useHostedTeamMessageRecipients(
  transport: Pick<HostedTeamConfigurationTransport, 'getSavedRequest'>,
  workspaceId: WorkspaceId | undefined,
  teamId: TeamId | null
): readonly string[] {
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly names: readonly string[];
  } | null>(null);
  const key = workspaceId === undefined || teamId === null ? null : `${workspaceId}:${teamId}`;

  useEffect(() => {
    if (workspaceId === undefined || teamId === null || key === null) return undefined;
    const controller = new AbortController();
    void transport
      .getSavedRequest(
        { schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION, workspaceId, teamId },
        { signal: controller.signal }
      )
      .then((result) => {
        if (controller.signal.aborted) return;
        setLoaded({
          key,
          names:
            result.kind === 'found'
              ? Object.freeze(result.draft.members.map((member) => member.name))
              : NO_RECIPIENTS,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ key, names: NO_RECIPIENTS });
      });
    return () => controller.abort();
  }, [key, teamId, transport, workspaceId]);

  return loaded !== null && loaded.key === key ? loaded.names : NO_RECIPIENTS;
}
