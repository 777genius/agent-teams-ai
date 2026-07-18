import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('standalone Phase 2 read wiring', () => {
  it('wires only an admitted bootstrap plus the durable identity gateway into the HTTP host', async () => {
    const source = await readFile('src/main/standalone.ts', 'utf8');

    expect(source).toContain('createInternalStorageFeature({ userDataPath: getAppDataPath() })');
    expect(source).toContain('internalStorageFeature.teamIdentityReadBackend?.gateway ?? null');
    expect(source).toContain('new Phase2ReadBootstrapSource({');
    expect(source).toContain(
      'readSerializedBootstrap: () => process.env[PHASE2_READ_BOOTSTRAP_ENV]'
    );
    expect(source).toContain('authority: bootstrap.authority');
    expect(source).toContain('teamIdentities: teamIdentityGateway');
    expect(source).toContain('phase2ReadHost = createPhase2ReadHost(composition');
    expect(source).toMatch(/const services: HttpServices = \{[\s\S]*phase2ReadHost,[\s\S]*\};/);
    expect(source).not.toContain('JSON.parse');
  });

  it('keeps unavailable bootstrap or storage fail-closed and disposes storage at shutdown', async () => {
    const [standalone, desktop] = await Promise.all([
      readFile('src/main/standalone.ts', 'utf8'),
      readFile('src/main/index.ts', 'utf8'),
    ]);

    expect(standalone).toContain(
      'let phase2ReadHost: Phase2ReadHost = createUnavailablePhase2ReadHost()'
    );
    expect(standalone).toMatch(/if \(teamIdentityGateway\) \{[\s\S]*try \{[\s\S]*\.load\(\)/);
    expect(standalone).toContain(
      'Hosted Phase 2 read bootstrap unavailable; canonical reads remain disabled.'
    );
    expect(standalone).toContain('await internalStorageFeature.dispose()');
    expect(desktop).toContain('phase2ReadHost = createUnavailablePhase2ReadHost()');
    expect(desktop).not.toContain('new Phase2ReadBootstrapSource');
  });
});
