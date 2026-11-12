import { createTeamMcpTools } from '../../mcp/tools.js';
import type { MemberProviderContext } from './MemberProvider.js';
import type { OpenCodeV2SessionPermissionRule } from '@agent-teams/provider-implementations/opencode';
import type { OpenCodeManagementProfile } from '../../management/profile.js';
import type { OpenCodeV2EmbeddedProfile } from '../../composition/openCodeV2EmbeddedProfile.js';

type ProviderConfiguration = OpenCodeV2EmbeddedProfile['providerConfiguration'];

/** Read-only metadata and the explicit model probe share one native no-tool policy. */
export function openCodeV2NoToolConfig(profile: OpenCodeManagementProfile,
  providerConfiguration?: ProviderConfiguration,
  configuredProviderId = profile.nativeModel?.providerId) {
  if (profile.nativeGeneration !== 'v2' || profile.protocolRevision !== '2.1.4' ||
      !profile.embedded || !profile.nativeModel)
    throw new Error('OpenCode V2 management selection unavailable');
  if (configuredProviderId === profile.nativeModel.providerId)
    providerConfiguration ??= profile.embedded.providerConfiguration;
  const permissions = [{ action: '*', resource: '*', effect: 'deny' as const }];
  const selection = {
    agent: 'agent-teams-model-probe',
    model: { providerID: profile.nativeModel.providerId, id: profile.nativeModel.modelId,
      variant: profile.variant ?? 'default' },
    permissions,
  };
  const model = { providerID: selection.model.providerID, model: selection.model.id,
    variant: selection.model.variant };
  const providers: Record<string, NonNullable<ProviderConfiguration>> | undefined =
    providerConfiguration && configuredProviderId ? { [configuredProviderId]: providerConfiguration } : undefined;
  return { selection, config: {
    update: 'disable', share: 'disabled', snapshots: false, warming: false, plugins: [],
    permissions, model, default_agent: selection.agent,
    policies: [
      { action: 'tool.use', resource: '*', effect: 'deny' },
      { action: 'integration.use', resource: '*', effect: 'deny' },
    ],
    mcp: { servers: {} },
    agents: {
      [selection.agent]: { model, permissions, mode: 'primary', steps: 1 },
      title: { disabled: true }, summary: { disabled: true },
    },
    ...(providers ? { providers } : {}),
  } };
}

/** The existing captured Host policy, translated once to the native V2 schema. */
export function openCodeV2EmbeddedConfig(context: MemberProviderContext,
  providerConfiguration?: ProviderConfiguration) {
  const profile = context.profile;
  if (profile.provider !== 'opencode' || profile.protocolRevision !== '2.1.4' ||
      profile.nativeGeneration !== 'v2' || !profile.embedded)
    throw new Error('OpenCode V2 embedded selection unavailable');
  providerConfiguration ??= profile.embedded.providerConfiguration;
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
    ...(providerConfiguration ? {
      providers: { [selection.model.providerID]: providerConfiguration },
    } : {}),
  };
  return { config, selection, requiredToolNames: createTeamMcpTools(context.connection)
    .list().map(tool => tool.name).sort() };
}
