import { AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV } from '@shared/constants/anthropicConnectionMode';

import { toGatewayArtifactId } from './GatewayArtifactId';

import type { GatewayConnectionSpec } from '../../../core/domain/index';
import type { ResolvedMemberGatewayConnection } from '../../application/GatewayProviderService';

/**
 * Pure spec -> runtime-artifact mappings. Core never learns `ANTHROPIC_*`,
 * Codex CLI or OpenCode JSON formats; provisioning seams only call these.
 */

export type MemberGatewayEnvPatch = Record<string, string>;

export interface GatewayMemberEnvPatchInput {
  spec: Pick<GatewayConnectionSpec, 'baseUrl'>;
  apiKey: string;
}

/** Claude Code member binding: base URL + token, blanking the competing key. */
export function buildClaudeGatewayMemberEnvPatch(
  input: GatewayMemberEnvPatchInput
): MemberGatewayEnvPatch {
  return {
    ANTHROPIC_BASE_URL: input.spec.baseUrl,
    ANTHROPIC_AUTH_TOKEN: input.apiKey,
    ANTHROPIC_API_KEY: '',
  };
}

export const CODEX_GATEWAY_API_KEY_ENV_VAR = 'CODEX_API_KEY';

/** Codex member binding: per-process key for the custom provider `env_key`. */
export function buildCodexGatewayMemberEnvPatch(
  input: Pick<GatewayMemberEnvPatchInput, 'apiKey'>
): MemberGatewayEnvPatch {
  return { [CODEX_GATEWAY_API_KEY_ENV_VAR]: input.apiKey };
}

export interface CodexGatewayCustomProviderConfig {
  enabled: boolean;
  baseUrl: string;
  model?: string;
}

/**
 * Neutral Codex custom-provider config data; CLI formatting reuses the
 * existing builders in `src/main/services/runtime/ProviderConnectionService.ts`.
 */
export function buildCodexGatewayCustomProviderConfig(input: {
  spec: Pick<GatewayConnectionSpec, 'baseUrl' | 'model'>;
}): CodexGatewayCustomProviderConfig {
  return {
    enabled: true,
    baseUrl: `${input.spec.baseUrl}/v1`,
    ...(input.spec.model ? { model: input.spec.model } : {}),
  };
}

/**
 * Single application point for member gateway env patches. Callers must apply
 * it strictly after provider runtime env resolution and outside any shared
 * team runtime settings bundle.
 */
export function applyGatewayMemberEnvPatch<T extends NodeJS.ProcessEnv>(
  env: T,
  patch: MemberGatewayEnvPatch
): T {
  Object.assign(env, patch);
  if (patch.ANTHROPIC_BASE_URL)
    Object.assign(env, { [AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]: 'compatible' });
  return env;
}

/**
 * Structural mirror of the connector input consumed by
 * `OpenCodeLocalProviderConnector.configureLocalProvider`; kept structural so
 * this feature never imports another feature's contracts.
 */
export interface OpenCodeGatewayArtifactConfigureInput {
  runtimeId: 'opencode';
  scope: 'global';
  presetId: 'custom';
  baseUrl: string;
  providerId: string;
  apiKey: string;
  defaultModelId: string;
  modelIds: string[];
  setAsDefault: false;
  setAsSmallModel: false;
  allowPrivateNetwork?: boolean;
}

export interface OpenCodeGatewayArtifactTarget {
  teamName: string;
  memberName: string;
  gatewayUsageRef: string;
}

/** `gateway-<sanitized-team>-<sanitized-member>-<hash12>` global provider id. */
export function toOpenCodeGatewayProviderId(target: OpenCodeGatewayArtifactTarget): string {
  return toGatewayArtifactId(target);
}

export interface OpenCodeGatewayArtifactConfigureResult {
  providerId: string;
  modelRoute: string;
}

/**
 * OpenCode member binding: per-member global provider entry via the existing
 * connector writer. Globals `model`/`small_model` are never touched and the
 * model route travels back to the member. Missing model => no artifact.
 */
export function buildOpenCodeGatewayArtifactConfigureInput(
  connection: ResolvedMemberGatewayConnection
): { input: OpenCodeGatewayArtifactConfigureInput; target: OpenCodeGatewayArtifactTarget } | null {
  const model = connection.spec.model?.trim();
  if (!model) return null;
  const target: OpenCodeGatewayArtifactTarget = {
    teamName: connection.teamName,
    memberName: connection.memberName,
    gatewayUsageRef: connection.gatewayUsageRef,
  };
  return {
    target,
    input: {
      runtimeId: 'opencode',
      scope: 'global',
      presetId: 'custom',
      // Profiles store the gateway root; the OpenAI-compatible SDK appends
      // /models and /chat/completions to its API base.
      baseUrl: `${connection.spec.baseUrl}/v1`,
      providerId: toOpenCodeGatewayProviderId(target),
      apiKey: connection.apiKey,
      defaultModelId: model,
      modelIds: [model],
      setAsDefault: false,
      setAsSmallModel: false,
      allowPrivateNetwork: connection.spec.allowPrivateNetwork,
    },
  };
}

/** `<providerEntry>/<modelId>` route for the member (never the global model). */
export function buildOpenCodeGatewayModelRoute(
  artifact: Pick<OpenCodeGatewayArtifactConfigureInput, 'providerId' | 'defaultModelId'>
): string {
  return `${artifact.providerId}/${artifact.defaultModelId}`;
}
