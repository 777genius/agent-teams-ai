import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  applyGatewayMemberEnvPatch,
  buildClaudeGatewayMemberEnvPatch,
  buildCodexGatewayCustomProviderConfig,
  buildCodexGatewayMemberEnvPatch,
  buildOpenCodeGatewayArtifactConfigureInput,
  buildOpenCodeGatewayModelRoute,
  toGatewayArtifactId,
  toOpenCodeGatewayProviderId,
} from '../main';

import type { ResolvedMemberGatewayConnection } from '../main';

function expectedGatewayArtifactId(input: {
  teamName: string;
  memberName: string;
  gatewayUsageRef: string;
}): string {
  return `gateway-${input.teamName}-${input.memberName}-${createHash('sha256')
    .update(JSON.stringify([input.teamName, input.memberName, input.gatewayUsageRef]), 'utf8')
    .digest('hex')
    .slice(0, 12)}`;
}

function connection(
  overrides: Partial<ResolvedMemberGatewayConnection> = {}
): ResolvedMemberGatewayConnection {
  return {
    spec: {
      profileId: 'profile-1',
      baseUrl: 'https://gw.example.com',
      allowPrivateNetwork: false,
      credentialRef: 'credential-1',
    },
    apiKey: 'sk-member',
    gatewayUsageRef: 'usage-ref-1',
    teamName: 'Team Alpha',
    memberName: 'Builder',
    ...overrides,
  };
}

describe('toGatewayArtifactId', () => {
  it('builds gateway-<team>-<member>-<hash12> with the documented hash', () => {
    const input = {
      teamName: 'team-a',
      memberName: 'builder',
      gatewayUsageRef: 'usage-ref-1',
    };
    expect(toGatewayArtifactId(input)).toBe(expectedGatewayArtifactId(input));
    expect(toGatewayArtifactId(input)).toMatch(/^gateway-team-a-builder-[0-9a-f]{12}$/);
    expect(toGatewayArtifactId(input)).toHaveLength('gateway-team-a-builder-'.length + 12);
  });

  it('is stable for identical inputs and separates changed bindings', () => {
    const base = { teamName: 'team-a', memberName: 'builder', gatewayUsageRef: 'usage-ref-1' };
    const same = { ...base };
    const rebound = { ...base, gatewayUsageRef: 'usage-ref-2' };
    expect(toGatewayArtifactId(base)).toBe(toGatewayArtifactId(same));
    // A changed binding (new usage source) must not rewrite the live old id.
    expect(toGatewayArtifactId(rebound)).not.toBe(toGatewayArtifactId(base));
  });

  it('sanitizes segments to [a-z0-9_-], caps them to the OpenCode 64-char id limit, and falls back when empty', () => {
    const id = toGatewayArtifactId({
      teamName: 'Team Alpha!',
      memberName: 'Builder.One',
      gatewayUsageRef: 'usage-ref-1',
    });
    expect(id).toMatch(/^gateway-team-alpha-builder-one-[0-9a-f]{12}$/);

    const empty = toGatewayArtifactId({
      teamName: '!!!',
      memberName: '???',
      gatewayUsageRef: 'usage-ref-1',
    });
    expect(empty).toMatch(/^gateway-team-member-[0-9a-f]{12}$/);

    const capped = toGatewayArtifactId({
      teamName: 'a'.repeat(40),
      memberName: 'b'.repeat(40),
      gatewayUsageRef: 'usage-ref-1',
    });
    expect(capped).toHaveLength(64);
    expect(capped).toMatch(
      new RegExp(`^gateway-${'a'.repeat(21)}-${'b'.repeat(21)}-[0-9a-f]{12}$`)
    );
  });

  it('distinguishes dot/hyphen collisions and split-boundary collisions via the hash', () => {
    const dotted = toGatewayArtifactId({
      teamName: 'a.b',
      memberName: 'c',
      gatewayUsageRef: 'usage-ref-1',
    });
    const hyphenated = toGatewayArtifactId({
      teamName: 'a-b',
      memberName: 'c',
      gatewayUsageRef: 'usage-ref-1',
    });
    expect(dotted).not.toBe(hyphenated);

    const leftSplit = toGatewayArtifactId({
      teamName: 'a-b',
      memberName: 'c',
      gatewayUsageRef: 'usage-ref-1',
    });
    const rightSplit = toGatewayArtifactId({
      teamName: 'a',
      memberName: 'b-c',
      gatewayUsageRef: 'usage-ref-1',
    });
    expect(leftSplit).not.toBe(rightSplit);
    expect(dotted.startsWith('gateway-a-b-c-')).toBe(true);
    expect(leftSplit.startsWith('gateway-a-b-c-')).toBe(true);
  });

  it('exposes the same id through the OpenCode provider-id mapping', () => {
    const target = { teamName: 'team-a', memberName: 'builder', gatewayUsageRef: 'usage-ref-1' };
    expect(toOpenCodeGatewayProviderId(target)).toBe(toGatewayArtifactId(target));
  });
});

describe('member gateway env patches', () => {
  it('builds the Claude patch with base URL + token and blanks the competing key', () => {
    expect(buildClaudeGatewayMemberEnvPatch(connection())).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.example.com',
      ANTHROPIC_AUTH_TOKEN: 'sk-member',
      ANTHROPIC_API_KEY: '',
    });
  });

  it('builds the Codex patch with a per-process key only', () => {
    expect(buildCodexGatewayMemberEnvPatch({ apiKey: 'sk-member' })).toEqual({
      CODEX_API_KEY: 'sk-member',
    });
  });

  it('applies patches over inherited env without clobbering unrelated keys', () => {
    const env: NodeJS.ProcessEnv = {
      AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE: 'subscription',
      ANTHROPIC_API_KEY: 'lead-key',
      ANTHROPIC_AUTH_TOKEN: 'lead-token',
      KEEP: 'keep-me',
    };
    const returned = applyGatewayMemberEnvPatch(
      env,
      buildClaudeGatewayMemberEnvPatch(connection())
    );
    expect(returned).toBe(env);
    expect(env).toEqual({
      AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE: 'compatible',
      ANTHROPIC_BASE_URL: 'https://gw.example.com',
      ANTHROPIC_AUTH_TOKEN: 'sk-member',
      ANTHROPIC_API_KEY: '',
      KEEP: 'keep-me',
    });
  });
});

describe('Codex custom provider config', () => {
  it('maps the spec to the neutral custom-provider config', () => {
    expect(buildCodexGatewayCustomProviderConfig({ spec: connection().spec })).toEqual({
      enabled: true,
      baseUrl: 'https://gw.example.com/v1',
    });
    expect(
      buildCodexGatewayCustomProviderConfig({
        spec: { ...connection().spec, model: 'gpt-5' },
      })
    ).toEqual({ enabled: true, baseUrl: 'https://gw.example.com/v1', model: 'gpt-5' });
  });
});

describe('OpenCode gateway artifact mapping', () => {
  it('configures a per-member provider entry without touching global model routing', () => {
    const artifact = buildOpenCodeGatewayArtifactConfigureInput(
      connection({ spec: { ...connection().spec, model: 'gpt-5' } })
    );
    expect(artifact).not.toBeNull();
    expect(artifact!.input).toMatchObject({
      runtimeId: 'opencode',
      scope: 'global',
      presetId: 'custom',
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sk-member',
      defaultModelId: 'gpt-5',
      modelIds: ['gpt-5'],
      setAsDefault: false,
      setAsSmallModel: false,
    });
    expect(artifact!.input.providerId).toBe(toOpenCodeGatewayProviderId(artifact!.target));
    expect(buildOpenCodeGatewayModelRoute(artifact!.input)).toBe(
      `${artifact!.input.providerId}/gpt-5`
    );
  });

  it('keeps a gateway path prefix when selecting the OpenAI-compatible API base', () => {
    const artifact = buildOpenCodeGatewayArtifactConfigureInput(
      connection({
        spec: { ...connection().spec, baseUrl: 'https://gw.example.com/proxy', model: 'gpt-5' },
      })
    );
    expect(artifact!.input.baseUrl).toBe('https://gw.example.com/proxy/v1');
  });

  it('returns no artifact when the binding has no model', () => {
    expect(buildOpenCodeGatewayArtifactConfigureInput(connection())).toBeNull();
  });
});
