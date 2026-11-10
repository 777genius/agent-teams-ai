import type { CapturedMcpSource } from '../mcp-catalog/capturedSource.js';
import {
  CapturedClaudeMcpCatalogReader,
  McpCatalogUnavailable,
} from '../mcp-catalog/captureClaudeCatalog.js';
import { selectMcpCatalog } from '../mcp-catalog/catalog.js';
import { normalizeTeamMemberMcpPolicy } from '../mcp-catalog/memberPolicy.js';
import { captureSelectedMcpServers } from '../mcp-catalog/capturedServer.js';
import { captureOpenCodeMcpPolicyPlugin } from '../adapters/providers/openCodeMcpPolicy.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import type { ConfiguredMcpServer } from '../mcp-catalog/catalog.js';
import type { CapturedMcpServers } from '../mcp-catalog/capturedServer.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type { TeamMemberSettings } from '../team/rosterContracts.js';

/** Called before recipeDigest: source files can never change an original captured recipe silently. */
export function captureRuntimeMcp(options: {
  recipes: readonly RuntimeMemberProfile[];
  savedCwd: string;
  members: readonly { role: 'lead' | 'member'; settings: TeamMemberSettings }[];
}): RuntimeMemberProfile[] {
  const cache = new Map<string, ConfiguredMcpServer[]>();
  const reader = new CapturedClaudeMcpCatalogReader();
  const read = (recipe: RuntimeMemberProfile, cwd: string): ConfiguredMcpServer[] => {
    const path = recipe.mcpCatalogSource?.claudeConfigPath;
    if (!path) throw new TeamLaunchError('invalid', 'member-mcp-catalog-unconfigured');
    const key = JSON.stringify([path, cwd]);
    const prior = cache.get(key);
    if (prior) return prior;
    const rows = reader.readCatalog({ userConfigPath: path, projectPath: cwd });
    cache.set(key, rows);
    return rows;
  };
  const leadIndex = options.members.findIndex((member) => member.role === 'lead');
  const lead = options.recipes[leadIndex];
  if (!lead) throw new TeamLaunchError('invalid', 'capture-lead');
  try {
    const leadServers: CapturedMcpServers = lead.mcpCatalogSource
      ? captureSelectedMcpServers(
          selectMcpCatalog(read(lead, options.savedCwd), undefined, ['team', 'agent-teams'])
        )
      : structuredClone(lead.capturedMcpServers ?? {});
    const leadSource: CapturedMcpSource | undefined = lead.mcpCatalogSource
      ? { userConfigPath: lead.mcpCatalogSource.claudeConfigPath, projectPath: options.savedCwd }
      : undefined;
    return options.recipes.map((recipe, index) => {
      const member = options.members[index];
      if (!member) throw new TeamLaunchError('invalid', 'capture-member');
      const policy = member.settings.mcpPolicy;
      const servers =
        member.role === 'lead' || !policy || policy.mode === 'inheritLead'
          ? structuredClone(leadServers)
          : policy.mode === 'appOnly'
            ? {}
            : captureSelectedMcpServers(
                selectMcpCatalog(
                  read(recipe, member.settings.cwd ?? options.savedCwd),
                  normalizeTeamMemberMcpPolicy(policy),
                  ['team', 'agent-teams']
                )
              );
      const source =
        member.role === 'lead' || !policy || policy.mode === 'inheritLead'
          ? leadSource
          : policy.mode === 'appOnly'
            ? undefined
            : {
                userConfigPath: recipe.mcpCatalogSource!.claudeConfigPath,
                projectPath: member.settings.cwd ?? options.savedCwd,
                ...(normalizeTeamMemberMcpPolicy(policy)
                  ? { policy: normalizeTeamMemberMcpPolicy(policy)! }
                  : {}),
              };
      const selected =
        recipe.provider === 'opencode' ? captureOpenCodeMcpPolicyPlugin(recipe) : recipe;
      const { capturedMcpSource: _oldSource, ...base } = structuredClone(selected);
      return {
        ...base,
        capturedMcpServers: servers,
        ...(source ? { capturedMcpSource: structuredClone(source) } : {}),
      };
    });
  } catch (error) {
    if (error instanceof TeamLaunchError) throw error;
    if (error instanceof McpCatalogUnavailable)
      throw new TeamLaunchError('hold', 'capture-mcp-source-unavailable');
    throw new TeamLaunchError('invalid', 'member-mcp-configuration');
  }
}
