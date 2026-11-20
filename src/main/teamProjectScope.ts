import {
  classifyDefinitionTarget,
  TeamProjectContextRegistry,
  TeamProjectContextRuntimeResolver,
} from '@features/team-project-context/main';

import { TeamMetaStore } from './services/team/TeamMetaStore';

/**
 * True for the logical team of the per-project history mode and for its native
 * project copies. Their definition is edited only by the desktop app, which
 * keeps one source of truth and refuses edits while a project runs; external
 * writers (HTTP/MCP) must not bypass that. Rejects when team metadata is
 * unreadable (fail closed).
 */
export async function isProjectScopedTeam(teamName: string): Promise<boolean> {
  const registry = TeamProjectContextRegistry.fromCurrentApp();
  const resolver = new TeamProjectContextRuntimeResolver(new TeamMetaStore(), registry);
  const target = await classifyDefinitionTarget(
    {
      getMode: (name) => resolver.getMode(name),
      isOwnedExecutionAlias: (name) => registry.isOwnedExecutionAlias(name),
    },
    teamName
  );
  return target !== 'native';
}
