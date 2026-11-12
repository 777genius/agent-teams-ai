import { createTeamMcpTools } from '../../mcp/tools.js';
import type { MemberProviderContext } from './MemberProvider.js';
import type { OpenCodeV2SessionPermissionRule } from '@agent-teams/provider-implementations/opencode';

/** The existing captured Host policy, translated once to the native V2 schema. */
export function openCodeV2EmbeddedConfig(context: MemberProviderContext) {
  const profile = context.profile;
  if (profile.provider !== 'opencode' || profile.protocolRevision !== '2.1.4' ||
      profile.nativeGeneration !== 'v2' || !profile.embedded)
    throw new Error('OpenCode V2 embedded selection unavailable');
  const manual = profile.nativeOptions.toolApprovalMode !== 'auto';
  const permissions: OpenCodeV2SessionPermissionRule[] = [
    { action: '*', resource: '*', effect: 'deny' },
    ...['read', 'glob', 'grep', 'todowrite', 'edit', 'shell'].map(action => ({
      action, resource: '*', effect: manual ? 'ask' as const : 'allow' as const,
    })),
    { action: 'subagent', resource: '*', effect: 'deny' },
    { action: 'execute', resource: '*', effect: 'deny' },
    ...['agent-teams_*', 'agent_teams_*', 'mcp__agent-teams__*', 'mcp__agent_teams__*']
      .map(action => ({ action, resource: '*', effect: 'allow' as const })),
    { action: 'external_directory', resource: '*', effect: profile.embedded.externalDirectory },
  ];
  const selection = {
    agent: profile.nativeOptions.agent,
    model: { providerID: profile.nativeOptions.providerId, id: profile.model,
      variant: profile.nativeOptions.variant ?? 'default' },
    permissions,
  };
  const model = { providerID: selection.model.providerID, model: selection.model.id,
    ...(selection.model.variant ? { variant: selection.model.variant } : {}) };
  const config = {
    update: 'disable', share: 'disabled', snapshots: false, warming: false,
    // Only bundled engine tools. Never import ambient project or user plugins.
    plugins: [], model, default_agent: selection.agent, permissions,
    agents: { title: { disabled: true }, summary: { disabled: true },
      [selection.agent]: { model, permissions, mode: 'primary' } },
    mcp: { servers: { 'agent-teams': {
      type: 'remote', url: context.endpoint.url,
      headers: { Authorization: `Bearer ${context.endpoint.bearerToken}` },
      oauth: false, codemode: false,
    } } },
    ...(profile.embedded.providerConfiguration ? {
      providers: { [selection.model.providerID]: profile.embedded.providerConfiguration },
    } : {}),
  };
  return { config, selection, requiredToolNames: createTeamMcpTools(context.connection)
    .list().map(tool => tool.name).sort() };
}
