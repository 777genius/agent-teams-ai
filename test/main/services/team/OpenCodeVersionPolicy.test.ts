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
  buildOpenCodeBinaryFingerprint,
  evaluateOpenCodeSupport,
  parseOpenCodeSemver,
  selectPermissionReplyRouteFromCache,
  shouldReuseCompatibilitySnapshot,
  type OpenCodeCompatibilitySnapshot,
  type OpenCodeRouteCompatibilityCache,
} from '../../../../src/main/services/team/opencode/version/OpenCodeVersionPolicy';

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
      })
    ).toMatchObject({
      supported: false,
      supportLevel: 'unsupported_prerelease',
      diagnostics: ['OpenCode prerelease 1.14.19-beta.1 is not enabled for production team launch'],
    });
  });

  it('requires capabilities before support', () => {
    expect(
      evaluateOpenCodeSupport({
        version: '1.14.19',
        capabilities: missingCapabilities(['POST permission reply route']),
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
      })
    ).toMatchObject({
      supported: true,
      supportLevel: 'production_supported',
      diagnostics: [],
    });
  });

  it('accepts supported version when capabilities pass', () => {
    expect(
      evaluateOpenCodeSupport({
        version: '1.14.19',
        capabilities: readyCapabilities(),
      })
    ).toMatchObject({
      supported: true,
      supportLevel: 'production_supported',
      diagnostics: [],
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
