import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('standalone Phase 2 read wiring', () => {
  it('admits hosted bootstrap and immutable identity before constructing ambient services', async () => {
    const [source, composition] = await Promise.all([
      readFile('src/main/standalone.ts', 'utf8'),
      readFile('src/main/composition/hosted/phase2ReadComposition.ts', 'utf8'),
    ]);

    expect(source).toContain(
      'const appDataRoot = admitHostedReadRoot(bootstrap.runtimeInstance.appDataRoot.reference)'
    );
    expect(source).toContain('admitHostedReadRoot(bootstrap.runtimeInstance.claudeRoot.reference)');
    expect(source).toContain('createPhase2ReadOnlyIdentitySource({ appDataRoot })');
    expect(source).toContain('await readPorts.teamIdentities.listTeamIdentities()');
    expect(source).toContain('new Phase2ReadBootstrapSource({');
    expect(source).toContain('readSerializedBootstrap: () => serializedHostedBootstrap');
    expect(source).toContain('authority: bootstrap.authority');
    expect(source).toContain('createMountBindingScopedPhase2ReadPorts({');
    expect(source).toContain('mountBinding: bootstrap.mountBinding');
    expect(source).toContain('runtimeInstance: bootstrap.runtimeInstance');
    expect(source).toContain('teamIdentities: teamIdentityGateway');
    expect(source).toContain('...readPorts');
    expect(source).toContain('phase2ReadHost = createPhase2ReadHost(composition');
    expect(source).toContain('requestSignal: AbortSignal');
    expect(source).toContain('signal: requestSignal');
    expect(source).toContain(
      'phase2ReadHost = createPhase2ReadHost(composition, createPhase2ReadQueryContext)'
    );
    expect(source).not.toContain('signal: new AbortController().signal');
    expect(source).toMatch(/const services: HttpServices = \{[\s\S]*phase2ReadHost,[\s\S]*\};/);
    expect(source.indexOf('new Phase2ReadBootstrapSource')).toBeLessThan(
      source.indexOf("import('./services/infrastructure/ServiceContext')")
    );
    expect(source.indexOf('await readPorts.teamIdentities.listTeamIdentities()')).toBeLessThan(
      source.indexOf("import('./services/infrastructure/ServiceContext')")
    );
    expect(source).toContain('if (hostedMode) localContext.startCacheOnly()');
    expect(source).not.toContain('JSON.parse');
    expect(source).not.toContain('createInternalStorageFeature');
    expect(source).not.toContain('InternalStorageFeature');
    expect(source).not.toContain('teamIdentityReadBackend');
    expect(source).not.toContain('TeamDataService');
    expect(source).not.toContain('TeamProvisioningService');
    expect(source).not.toContain("import('./services/team')");
    expect(source).not.toContain('getAppDataPath');
    expect(source).not.toContain('scheduleStaleAnthropicTeamApiKeyHelperCleanup');
    expect(composition).not.toContain('TeamDataService');
    expect(composition).not.toContain('TeamProvisioningService');
    expect(composition).not.toMatch(
      /\b(readdir|writeFile|mkdir|rm|unlink|rename|spawn|fork|execFile)\s*\(/
    );
    expect(composition).toContain('fs.constants.O_RDONLY | NO_FOLLOW');
    expect(composition).not.toMatch(/fs\.promises\.readFile\s*\(/);
  });

  it('keeps invalid bootstrap fatal and missing identity storage fail-closed without disposal', async () => {
    const [standalone, desktop] = await Promise.all([
      readFile('src/main/standalone.ts', 'utf8'),
      readFile('src/main/index.ts', 'utf8'),
    ]);

    expect(standalone).toContain(
      'let phase2ReadHost: Phase2ReadHost = createUnavailablePhase2ReadHost()'
    );
    expect(standalone).toMatch(
      /if \(hostedMode\) \{[\s\S]*new Phase2ReadBootstrapSource\([\s\S]*\)\.load\(\)/
    );
    expect(standalone).toContain(
      'Hosted Phase 2 identity storage unavailable; canonical reads remain disabled.'
    );
    expect(standalone).not.toContain('internalStorageFeature');
    expect(standalone).not.toContain('internalStorageFeature.dispose');
    expect(desktop).toContain('phase2ReadHost = createUnavailablePhase2ReadHost()');
    expect(desktop).not.toContain('new Phase2ReadBootstrapSource');
  });
});
