import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createEmptyEndpointMap,
  type OpenCodeApiCapabilities,
  type OpenCodeApiEndpointKey,
} from '../../../../src/main/services/team/opencode/capabilities/OpenCodeApiCapabilities';
import {
  assertOpenCodeProductionE2EGate,
  buildOpenCodeBinaryFingerprint,
  evaluateOpenCodeSupport,
  parseOpenCodeSemver,
  selectPermissionReplyRouteFromCache,
  shouldReuseCompatibilitySnapshot,
  type OpenCodeCompatibilitySnapshot,
  type OpenCodeRouteCompatibilityCache,
} from '../../../../src/main/services/team/opencode/version/OpenCodeVersionPolicy';
import {
  OPENCODE_PRODUCTION_E2E_READY_CHECKPOINTS,
  OPENCODE_PRODUCTION_E2E_REQUIRED_SIGNALS,
  type OpenCodeProductionE2EEvidence,
} from '../../../../src/main/services/team/opencode/e2e/OpenCodeProductionE2EEvidence';
import { REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS } from '../../../../src/main/services/team/opencode/mcp/OpenCodeMcpToolAvailability';

describe('OpenCodeVersionPolicy', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-version-policy-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('parses stable, v-prefixed and prerelease semver strings', () => {
    expect(parseOpenCodeSemver('1.14.19')).toEqual({
      major: 1,
      minor: 14,
      patch: 19,
      prerelease: [],
    });
    expect(parseOpenCodeSemver('v1.14.19-beta.1')).toEqual({
      major: 1,
      minor: 14,
      patch: 19,
      prerelease: ['beta', '1'],
    });
    expect(parseOpenCodeSemver('not-a-version')).toBeNull();
  });

  it('rejects versions below minimum and prereleases by default', () => {
    expect(
      evaluateOpenCodeSupport({
        version: '1.4.0',
        capabilities: readyCapabilities(),
        evidence: passingEvidence(),
      })
    ).toMatchObject({
      supported: false,
      supportLevel: 'unsupported_too_old',
      diagnostics: ['OpenCode 1.4.0 is below supported minimum 1.14.19'],
    });

    expect(
      evaluateOpenCodeSupport({
        version: '1.14.19-beta.1',
        capabilities: readyCapabilities(),
        evidence: passingEvidence(),
      })
    ).toMatchObject({
      supported: false,
      supportLevel: 'unsupported_prerelease',
      diagnostics: ['OpenCode prerelease 1.14.19-beta.1 is not enabled for production team launch'],
    });
  });

  it('requires capabilities and production E2E evidence before production support', () => {
    expect(
      evaluateOpenCodeSupport({
        version: '1.14.19',
        capabilities: missingCapabilities(['POST permission reply route']),
        evidence: passingEvidence(),
      })
    ).toMatchObject({
      supported: false,
      supportLevel: 'supported_capabilities_pending',
      diagnostics: ['POST permission reply route'],
    });

    expect(
      evaluateOpenCodeSupport({
        version: '1.14.19',
        capabilities: readyCapabilities(),
        evidence: null,
      })
    ).toMatchObject({
      supported: false,
      supportLevel: 'supported_e2e_pending',
      diagnostics: [
        'OpenCode version is capability-compatible but production E2E evidence is missing',
      ],
    });
  });

  it('accepts supported version only when capabilities and E2E evidence pass', () => {
    expect(
      evaluateOpenCodeSupport({
        version: '1.14.19',
        capabilities: readyCapabilities(),
        evidence: passingEvidence(),
      })
    ).toMatchObject({
      supported: true,
      supportLevel: 'production_supported',
      diagnostics: [],
    });
  });

  it('rejects stale or incomplete production E2E evidence', () => {
    expect(
      assertOpenCodeProductionE2EGate({
        evidence: passingEvidence({ version: '1.14.18' }),
        testedVersion: '1.14.19',
      })
    ).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        'OpenCode production E2E evidence version 1.14.18 does not match tested version 1.14.19',
      ]),
    });

    expect(
      assertOpenCodeProductionE2EGate({
        evidence: passingEvidence({
          requiredSignals: requiredSignals({ canonical_log_projection_observed: false }),
        }),
        testedVersion: '1.14.19',
      })
    ).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        'OpenCode production E2E evidence is missing signals: canonical_log_projection_observed',
      ]),
    });
  });

  it('invalidates compatibility snapshot when binary identity or version changes', () => {
    const cached = compatibilitySnapshot({
      binaryPath: '/opt/homebrew/bin/opencode',
      binaryFingerprint: 'fingerprint-a',
      version: '1.14.19',
    });

    expect(
      shouldReuseCompatibilitySnapshot({
        cached,
        binaryPath: '/opt/homebrew/bin/opencode',
        binaryFingerprint: 'fingerprint-a',
        version: '1.14.19',
      })
    ).toBe(true);
    expect(
      shouldReuseCompatibilitySnapshot({
        cached,
        binaryPath: '/usr/local/bin/opencode',
        binaryFingerprint: 'fingerprint-a',
        version: '1.14.19',
      })
    ).toBe(false);
    expect(
      shouldReuseCompatibilitySnapshot({
        cached,
        binaryPath: '/opt/homebrew/bin/opencode',
        binaryFingerprint: 'fingerprint-b',
        version: '1.14.19',
      })
    ).toBe(false);
    expect(
      shouldReuseCompatibilitySnapshot({
        cached,
        binaryPath: '/opt/homebrew/bin/opencode',
        binaryFingerprint: 'fingerprint-a',
        version: '1.15.0',
      })
    ).toBe(false);
  });

  it('builds binary fingerprints from path, realpath, size and mtime', async () => {
    const binaryPath = path.join(tempDir, 'opencode');
    await fs.writeFile(binaryPath, 'version-a', 'utf8');
    const first = await buildOpenCodeBinaryFingerprint(binaryPath);

    await fs.writeFile(binaryPath, 'version-b-longer', 'utf8');
    const second = await buildOpenCodeBinaryFingerprint(binaryPath);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  it('selects permission reply route from current capability cache', () => {
    expect(selectPermissionReplyRouteFromCache(routeCache({ permissionReply: true }))).toEqual({
      kind: 'primary_permission_reply',
      method: 'POST',
      pathTemplate: '/permission/:requestID/reply',
      bodyShape: { reply: 'once' },
    });

    expect(
      selectPermissionReplyRouteFromCache(
        routeCache({
          permissionReply: false,
          permissionLegacySessionRespond: true,
        })
      )
    ).toEqual({
      kind: 'deprecated_session_permission',
      method: 'POST',
      pathTemplate: '/session/:sessionID/permissions/:permissionID',
      bodyShape: { response: 'once' },
    });

    expect(selectPermissionReplyRouteFromCache(routeCache({ permissionReply: false }))).toBeNull();
  });
});

function readyCapabilities(): OpenCodeApiCapabilities {
  const endpoints = createEmptyEndpointMap();
  const evidence = {} as OpenCodeApiCapabilities['evidence'];
  for (const key of Object.keys(endpoints) as OpenCodeApiEndpointKey[]) {
    endpoints[key] = true;
    evidence[key] = 'openapi';
  }

  return {
    version: '1.14.19',
    source: 'openapi_doc' as const,
    endpoints,
    requiredForTeamLaunch: {
      ready: true,
      missing: [],
    },
    evidence,
    diagnostics: [],
  };
}

function missingCapabilities(missing: string[]) {
  return {
    ...readyCapabilities(),
    requiredForTeamLaunch: {
      ready: false,
      missing,
    },
  };
}

function passingEvidence(
  overrides: Partial<OpenCodeProductionE2EEvidence> = {}
): OpenCodeProductionE2EEvidence {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const requiredToolIds = REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS.map((tool) => `agent_teams_${tool}`);
  const durableCheckpoints = OPENCODE_PRODUCTION_E2E_READY_CHECKPOINTS.map((name) => ({
    name,
    observedAt: createdAt,
  }));

  return {
    schemaVersion: 1,
    evidenceId: 'e2e-1',
    createdAt,
    expiresAt,
    version: '1.14.19',
    passed: true,
    artifactPath: '/tmp/opencode-e2e',
    binaryFingerprint: 'version:1.14.19',
    capabilitySnapshotId: 'cap-1',
    selectedModel: 'openai/gpt-5.4-mini',
    projectPathFingerprint: 'project-a',
    requiredSignals: requiredSignals(),
    mcpTools: {
      requiredTools: requiredToolIds,
      observedTools: requiredToolIds,
    },
    launch: {
      runId: 'run-1',
      teamId: 'team-a',
      teamLaunchState: 'ready',
      memberCount: 1,
      sessions: [
        {
          memberName: 'Dev',
          sessionId: 'ses-1',
          launchState: 'confirmed_alive',
        },
      ],
      durableCheckpoints,
    },
    reconcile: {
      runId: 'run-1',
      teamLaunchState: 'ready',
      memberCount: 1,
    },
    stop: {
      runId: 'run-1',
      stopped: true,
      stoppedSessionIds: ['ses-1'],
    },
    logProjection: {
      observed: true,
      projectedMessageCount: 1,
    },
    ...overrides,
  };
}

function requiredSignals(
  overrides: Partial<
    Record<(typeof OPENCODE_PRODUCTION_E2E_REQUIRED_SIGNALS)[number], boolean>
  > = {}
) {
  return Object.fromEntries(
    OPENCODE_PRODUCTION_E2E_REQUIRED_SIGNALS.map((signal) => [signal, overrides[signal] ?? true])
  ) as OpenCodeProductionE2EEvidence['requiredSignals'];
}

function compatibilitySnapshot(
  overrides: Partial<OpenCodeCompatibilitySnapshot>
): OpenCodeCompatibilitySnapshot {
  return {
    schemaVersion: 1,
    createdAt: '2026-04-21T12:00:00.000Z',
    binaryPath: '/opt/homebrew/bin/opencode',
    binaryFingerprint: 'fingerprint-a',
    installMethod: 'brew',
    version: '1.14.19',
    semver: {
      major: 1,
      minor: 14,
      patch: 19,
      prerelease: [],
    },
    supported: true,
    supportLevel: 'production_supported',
    apiCapabilities: readyCapabilities(),
    testedEvidencePath: '/tmp/opencode-e2e',
    diagnostics: [],
    ...overrides,
  };
}

function routeCache(
  overrides: Partial<Record<keyof ReturnType<typeof createEmptyEndpointMap>, boolean>>
) {
  return {
    binaryFingerprint: 'fingerprint-a',
    version: '1.14.19',
    routes: Object.fromEntries(
      Object.keys(createEmptyEndpointMap()).map((key) => [
        key,
        {
          available: overrides[key as keyof typeof overrides] ?? false,
          evidence: 'openapi',
          lastVerifiedAt: '2026-04-21T12:00:00.000Z',
        },
      ])
    ),
  } as OpenCodeRouteCompatibilityCache;
}
