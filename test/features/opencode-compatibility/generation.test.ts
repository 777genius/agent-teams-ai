import { classifyNativeVersion, negotiateOpenCodeProtocol } from '@features/opencode-compatibility';
import { evaluateOpenCodeSupport } from '@main/services/team/opencode/version/OpenCodeVersionPolicy';
import {
  compareVersions,
  getUnsupportedAgentTeamsOpenCodeVersionMessage,
  isAgentTeamsOpenCodeVersionSupported,
  normalizeVersion,
} from '@shared/utils/version';
import { describe, expect, it } from 'vitest';

import type { OpenCodeApiCapabilities } from '@main/services/team/opencode/capabilities/OpenCodeApiCapabilities';

// Before A0 these future-version cases return production_supported with ready V1 evidence.
describe('current public OpenCode policy consumers', () => {
  it.each([
    '2.0.0',
    '2.0.21',
    '2.1.0',
    '3.0.0',
    '999.0.0',
    '1.16.0-beta.1',
    '1.16.0 garbage',
    'OpenCode 1.16.0',
    '01.16.0',
    '1.16.0+',
    '1.16.0-01',
    '1.16.0\n2.0.0',
  ])('rejects %s even with ready V1 capabilities', (version) => {
    const capabilities = {
      requiredForTeamLaunch: { ready: true, missing: [] },
    } as unknown as OpenCodeApiCapabilities;
    expect(evaluateOpenCodeSupport({ version, capabilities }).supported).toBe(false);
    expect(isAgentTeamsOpenCodeVersionSupported(version)).toBe(false);
  });

  it.each(['2.0.0', '2.0.21', '3.0.0', 'garbage'])(
    'vetoes %s before accessing V1 evidence',
    (version) => {
      let reads = 0;
      const input = {
        version,
        get capabilities(): OpenCodeApiCapabilities {
          reads++;
          throw new Error('V1 native capability probing must not run');
        },
      };
      expect(evaluateOpenCodeSupport(input).supported).toBe(false);
      expect(reads).toBe(0);
    }
  );

  it.each(['1.16.0', 'v1.18.0\n', '1.99.12', '1.16.0+build.7'])(
    'retains V1 support for %s',
    (version) => {
      expect(isAgentTeamsOpenCodeVersionSupported(version)).toBe(true);
      expect(
        evaluateOpenCodeSupport({
          version,
          capabilities: {
            requiredForTeamLaunch: { ready: true, missing: [] },
          } as unknown as OpenCodeApiCapabilities,
        })
      ).toEqual({
        supported: true,
        supportLevel: 'production_supported',
        semver: {
          major: 1,
          minor: Number(version.replace(/^v/, '').split('.')[1]),
          patch: version.includes('1.99') ? 12 : 0,
          prerelease: [],
        },
        diagnostics: [],
      });
    }
  );

  it('retains pre-change V1 missing-capability and below-minimum diagnostics', () => {
    expect(
      evaluateOpenCodeSupport({
        version: '1.16.0',
        capabilities: {
          requiredForTeamLaunch: { ready: false, missing: ['POST permission reply route'] },
        } as unknown as OpenCodeApiCapabilities,
      })
    ).toEqual({
      supported: false,
      supportLevel: 'supported_capabilities_pending',
      semver: { major: 1, minor: 16, patch: 0, prerelease: [] },
      diagnostics: ['POST permission reply route'],
    });
    expect(
      evaluateOpenCodeSupport({ version: '1.4.0', capabilities: {} as OpenCodeApiCapabilities })
    ).toEqual({
      supported: false,
      supportLevel: 'unsupported_too_old',
      semver: { major: 1, minor: 4, patch: 0, prerelease: [] },
      diagnostics: ['OpenCode 1.4.0 is below supported minimum 1.16.0'],
    });
    expect(getUnsupportedAgentTeamsOpenCodeVersionMessage('1.4.0')).toBe(
      'OpenCode 1.4.0 is below the supported minimum 1.16.0. Update OpenCode before loading providers, models, or launching teammates.'
    );
  });

  it('cannot override the stable V1 generation boundary', () => {
    expect(
      evaluateOpenCodeSupport({
        version: '2.0.0',
        capabilities: {} as OpenCodeApiCapabilities,
        policy: { minimumVersion: '1.0.0', allowedPrerelease: true, requireCapabilities: false },
      }).supported
    ).toBe(false);
    expect(
      evaluateOpenCodeSupport({
        version: '1.16.0-beta.1',
        capabilities: {} as OpenCodeApiCapabilities,
        policy: { minimumVersion: '1.0.0', allowedPrerelease: true, requireCapabilities: false },
      }).supported
    ).toBe(false);
  });

  it.each(['2.0.0', '2.0.21'])('recognizes exact %s without enabling it', (version) => {
    expect(classifyNativeVersion(version)).toEqual({
      kind: 'recognized',
      generation: 'v2',
      apiDialect: `v2-${version}`,
      version,
      productionEligible: false,
    });
    expect(negotiateOpenCodeProtocol({ version }).kind).toBe('blocked');
  });

  it.each(['2.0.0', '2.0.21'])(
    'reports %s qualification status without advising an upgrade',
    (version) => {
      const message = getUnsupportedAgentTeamsOpenCodeVersionMessage(version);
      expect(message).toContain('not yet qualified');
      expect(message).toContain('OpenCode V1');
      expect(message).not.toContain('below');
    }
  );
  it.each(['3.0.0', '2.1.0', 'garbage', '1.16.0-beta.1'])(
    'reports the actual rejection for %s',
    (version) => {
      const message = getUnsupportedAgentTeamsOpenCodeVersionMessage(version);
      expect(message).toContain(version);
      expect(message).not.toContain('below');
      expect(message).toContain('stable OpenCode V1');
    }
  );

  // Actual independently measured native --version stdout, not normalized DTO versions.
  it.each(['2.0.0', '2.0.21'])('recognizes native CLI output for %s without launching V2', (version) => {
    const stdout = `opencode v${version}\n`;
    expect(classifyNativeVersion(stdout)).toEqual({
      kind: 'recognized',
      generation: 'v2',
      apiDialect: `v2-${version}`,
      version,
      productionEligible: false,
    });
    let reads = 0;
    const decision = evaluateOpenCodeSupport({
      version: stdout,
      get capabilities(): OpenCodeApiCapabilities {
        reads++;
        throw new Error('V1 evidence cannot qualify native V2');
      },
    });
    expect(decision.supported).toBe(false);
    expect(decision.supportLevel).toBe('supported_capabilities_pending');
    expect(decision.semver).toEqual({ major: 2, minor: 0, patch: Number(version.split('.')[2]), prerelease: [] });
    expect(reads).toBe(0);
    expect(isAgentTeamsOpenCodeVersionSupported(stdout)).toBe(false);
    expect(negotiateOpenCodeProtocol({ version: stdout }).kind).toBe('blocked');
    expect(getUnsupportedAgentTeamsOpenCodeVersionMessage(stdout)).toContain('not yet qualified');
  });

  it.each([
    'opencode v1.18.34',
    'OpenCode v2.0.0',
    'diagnostic: opencode v2.0.0',
    'opencode v2.0.0\n2.0.21',
    '\u001b[32mopencode v2.0.0\u001b[0m',
    'opencode v2.0.0+build.7',
    'opencode v2.0.0-beta.1',
    'opencode v2.0.22',
  ])('keeps unqualified CLI text %s blocked', (stdout) => {
    expect(classifyNativeVersion(stdout).kind).toBe('blocked');
    expect(isAgentTeamsOpenCodeVersionSupported(stdout)).toBe(false);
  });

  it('keeps generic version helpers permissive for other products', () => {
    expect(normalizeVersion('2.1.34 (Claude Code)\n')).toBe('2.1.34');
    expect(compareVersions('v3.0.0 (Other)', '2.1.0')).toBe(1);
    expect(compareVersions('1.2.3-beta', 'v1.2.3')).toBe(0);
  });
});
