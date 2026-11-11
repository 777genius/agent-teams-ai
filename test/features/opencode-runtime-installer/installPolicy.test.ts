import { getLatestQualifiedOpenCodeV2Version } from '@features/opencode-compatibility';
import {
  chooseOpenCodeInstallGeneration,
  DEFAULT_OPENCODE_V1_INSTALL_VERSION,
  parseOpenCodeInstallOptions,
} from '@features/opencode-runtime-installer';
import {
  selectOpenCodeInstallPackage,
  selectOpenCodeRootPackage,
} from '@features/opencode-runtime-installer/main';
import { describe, expect, it, vi } from 'vitest';

// Real contract + synthetic registry: a latest CLI must not become a new engine
// or change the selected generation. No network, installed binary or user state.
describe('OpenCode installation policy', () => {
  const qualifiedV2EngineForHost = getLatestQualifiedOpenCodeV2Version(process.platform, process.arch);
  it('defaults fresh installs to V1 and retains the installed generation', () => {
    expect(chooseOpenCodeInstallGeneration(undefined, undefined, '2.1.4')).toBe('v1');
    expect(chooseOpenCodeInstallGeneration(undefined, undefined, null)).toBe('v1');
    expect(chooseOpenCodeInstallGeneration(undefined, '1.18.3', '2.1.4')).toBe('v1');
    expect(chooseOpenCodeInstallGeneration(undefined, '2.9.0', '2.1.4')).toBe('v2');
    expect(chooseOpenCodeInstallGeneration('v1', '2.1.4', '2.1.4')).toBe('v1');
    expect(chooseOpenCodeInstallGeneration('v2', undefined, '2.1.4')).toBe('v2');
    const unshipped = getLatestQualifiedOpenCodeV2Version('linux', 'arm64');
    expect(unshipped).toBeNull();
    expect(chooseOpenCodeInstallGeneration(undefined, undefined, unshipped)).toBe('v1');
    expect(getLatestQualifiedOpenCodeV2Version('unsupported', 'x64')).toBeNull();
  });

  it('keeps V1 as default on qualified ARM64 while allowing an explicit V2 choice', () => {
    const qualified = getLatestQualifiedOpenCodeV2Version('win32', 'arm64');
    expect(qualified).toBe('2.1.4');
    expect(chooseOpenCodeInstallGeneration(undefined, undefined, qualified)).toBe('v1');
    expect(chooseOpenCodeInstallGeneration('v2', undefined, qualified)).toBe('v2');
  });

  it.each([
    null,
    'v2',
    [],
    { generation: 'latest' },
    { supportOnly: 'yes' },
    { generation: 'v1', supportOnly: true },
    { version: '2.99.0' },
    { generation: 'v2', url: 'https://other.test' },
  ])('rejects invalid install options %j', (input) => {
    expect(() => parseOpenCodeInstallOptions(input)).toThrow();
  });

  it('resolves a fresh V1 latest tag once, then fetches exact native bytes', async () => {
    const fetchMetadata = vi
      .fn()
      .mockResolvedValueOnce({
        name: 'opencode-ai',
        version: '1.20.1',
        optionalDependencies: { 'opencode-linux-x64': '^1.20.1' },
      })
      .mockResolvedValueOnce({ name: 'opencode-linux-x64', version: '1.20.1' });
    expect(DEFAULT_OPENCODE_V1_INSTALL_VERSION).toBe('latest');
    const selected = await selectOpenCodeInstallPackage(
      'v1', '2.1.4', [{ packageName: 'opencode-linux-x64' }],
      fetchMetadata, DEFAULT_OPENCODE_V1_INSTALL_VERSION
    );
    expect(selected.generation).toBe('v1');
    expect(selected.metadata.version).toBe('1.20.1');
    expect(fetchMetadata.mock.calls).toEqual([
      ['opencode-ai', 'latest'], ['opencode-linux-x64', '1.20.1'],
    ]);
  });

  it('keeps an explicit package pin exact rather than accepting redirected root metadata', async () => {
    const fetchMetadata = vi.fn().mockResolvedValue({ name: 'opencode-ai', version: '1.19.4' });
    await expect(selectOpenCodeInstallPackage(
      'v1', '2.1.4', [], fetchMetadata, '1.19.5'
    )).rejects.toThrow('selected generation');
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
    expect(fetchMetadata).toHaveBeenCalledWith('opencode-ai', '1.19.5');
  });

  it('refuses V2 on an unqualified platform before contacting npm', async () => {
    const fetchMetadata = vi.fn();
    await expect(selectOpenCodeInstallPackage('v2', null, [], fetchMetadata)).rejects.toThrow(
      'No compatible OpenCode V2'
    );
    expect(fetchMetadata).not.toHaveBeenCalled();
  });

  it.skipIf(qualifiedV2EngineForHost === null)('updates the V2 CLI independently of the separately qualified execution engine', async () => {
    const fetchMetadata = vi
      .fn()
      .mockResolvedValueOnce({
        name: '@opencode/cli',
        version: '2.9.0',
        optionalDependencies: { '@opencode/cli-linux-x64': '2.9.0' },
      })
      .mockResolvedValueOnce({ name: '@opencode/cli-linux-x64', version: '2.9.0' });
    const selected = await selectOpenCodeInstallPackage(
      'v2', qualifiedV2EngineForHost, [{ packageName: 'opencode-linux-x64' }], fetchMetadata
    );
    expect(selected.generation).toBe('v2');
    expect(selected.metadata.version).toBe('2.9.0');
    expect(fetchMetadata.mock.calls).toEqual([
      ['@opencode/cli', 'latest'], ['@opencode/cli-linux-x64', '2.9.0'],
    ]);
  });

  it.each(['1.15.9', '1.20.0-beta.1', 'v1.20.0', '1.20.0+foreign', '2.1.4', '3.0.0'])(
    'does not silently change V1 generation or accept non-stable root %s', async (version) => {
      const fetchMetadata = vi.fn().mockResolvedValue({ name: 'opencode-ai', version });
      await expect(selectOpenCodeInstallPackage('v1', '2.1.4', [], fetchMetadata))
        .rejects.toThrow('selected generation');
      expect(fetchMetadata.mock.calls).toEqual([['opencode-ai', 'latest'], ['opencode-ai', null]]);
    }
  );

  it.each(['1.19.5', '2.9.0-beta.1', '2.9.0+foreign', '3.0.0'])(
    'does not silently downgrade V2 or admit out-of-contract CLI %s', async (version) => {
      const fetchMetadata = vi.fn().mockResolvedValue({ name: '@opencode/cli', version });
      await expect(selectOpenCodeInstallPackage('v2', '2.1.4', [], fetchMetadata))
        .rejects.toThrow('selected generation');
      expect(fetchMetadata.mock.calls).toEqual([['@opencode/cli', 'latest'], ['@opencode/cli', null]]);
    }
  );

  it('does not accept a latest CLI as an unqualified execution engine', async () => {
    const fetchMetadata = vi.fn().mockResolvedValue({ name: '@opencode/cli', version: '2.9.0' });
    await expect(selectOpenCodeInstallPackage('v2', '2.9.0', [], fetchMetadata))
      .rejects.toThrow('selected generation');
  });

  it.each(['v1', 'v2'] as const)('rejects foreign %s root metadata', async (generation) => {
    const version = generation === 'v1' ? '1.20.1' : '2.9.0';
    const fetchMetadata = vi.fn().mockResolvedValue({ name: 'foreign-package', version });
    await expect(selectOpenCodeInstallPackage(generation, '2.1.4', [], fetchMetadata))
      .rejects.toThrow('selected generation');
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
  });

  for (const generation of ['v1', 'v2'] as const) {
    it.skipIf(generation === 'v2' && qualifiedV2EngineForHost === null)(
      `refuses redirected ${generation} native metadata`, async () => {
    const rootName = generation === 'v1' ? 'opencode-ai' : '@opencode/cli';
    const name = generation === 'v1' ? 'opencode-linux-x64' : '@opencode/cli-linux-x64';
    const version = generation === 'v1' ? '1.20.1' : '2.9.0';
    const fetchMetadata = vi
      .fn()
      .mockResolvedValueOnce({ name: rootName, version, optionalDependencies: { [name]: version } })
      .mockResolvedValueOnce({ name: name.replace('x64', 'arm64'), version });
    await expect(selectOpenCodeInstallPackage(
      generation, generation === 'v2' ? qualifiedV2EngineForHost : '2.1.4',
      [{ packageName: 'opencode-linux-x64' }], fetchMetadata
    )).rejects.toThrow('identity mismatch');
    expect(fetchMetadata.mock.calls).toEqual([[rootName, 'latest'], [name, version]]);
      }
    );
  }

  it('does not follow a moving root tag or mismatched native version', async () => {
    const fetchMetadata = vi
      .fn()
      .mockResolvedValueOnce({
        name: 'opencode-ai', version: '1.20.1',
        optionalDependencies: { 'opencode-linux-x64': '1.20.2' },
      });
    await expect(selectOpenCodeInstallPackage(
      'v1', '2.1.4', [{ packageName: 'opencode-linux-x64' }], fetchMetadata
    )).rejects.toThrow('differs from its root');
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
  });

  it.skipIf(qualifiedV2EngineForHost === null)('uses the same root resolution for update checks and installation', async () => {
    const fetchMetadata = vi.fn().mockResolvedValue({ name: '@opencode/cli', version: '2.9.0' });
    const root = await selectOpenCodeRootPackage('v2', qualifiedV2EngineForHost, fetchMetadata);
    expect(root.version).toBe('2.9.0');
    expect(fetchMetadata).toHaveBeenCalledWith('@opencode/cli', 'latest');
  });

  for (const generation of ['v1', 'v2'] as const) {
    it.skipIf(generation === 'v2' && qualifiedV2EngineForHost === null)(
      `keeps latest ${generation} install in its generation when the global tag advances`,
      async () => {
        const rootName = generation === 'v1' ? 'opencode-ai' : '@opencode/cli';
        const packageName = generation === 'v1' ? 'opencode-linux-x64' : '@opencode/cli-linux-x64';
        const major = generation === 'v1' ? 1 : 2;
        const expected = `${major}.20.10`;
        const metadata = (version: string) => ({
          name: rootName,
          version,
          optionalDependencies: { [packageName]: version },
        });
        const fetchMetadata = vi
          .fn()
          .mockResolvedValueOnce(metadata('3.0.0'))
          .mockResolvedValueOnce({
            name: rootName,
            versions: {
              [`${major}.20.2`]: metadata(`${major}.20.2`),
              [expected]: metadata(expected),
              [`${major}.21.0-beta.1`]: metadata(`${major}.21.0-beta.1`),
              [`${major}.22.0+foreign`]: metadata(`${major}.22.0+foreign`),
              [`${major}.23.0`]: { ...metadata(`${major}.23.0`), name: 'foreign' },
              [`${major}.24.0`]: metadata(`${major}.25.0`),
              '3.0.0': metadata('3.0.0'),
            },
          })
          .mockResolvedValueOnce({ name: packageName, version: expected });
        const selected = await selectOpenCodeInstallPackage(
          generation,
          qualifiedV2EngineForHost,
          [{ packageName: 'opencode-linux-x64' }],
          fetchMetadata
        );
        expect(selected.metadata.version).toBe(expected);
        expect(fetchMetadata.mock.calls).toEqual([
          [rootName, 'latest'],
          [rootName, null],
          [packageName, expected],
        ]);
      }
    );
  }

  it.each([
    { name: 'foreign-package', versions: { '1.20.0': { name: 'opencode-ai', version: '1.20.0' } } },
    { name: 'opencode-ai', versions: [] },
    { name: 'opencode-ai', versions: { '2.0.0': { name: 'opencode-ai', version: '2.0.0' } } },
    { name: 'opencode-ai', versions: { '1.20.0': null } },
  ])('refuses an invalid compatible release snapshot %#', async (registry) => {
    const fetchMetadata = vi
      .fn()
      .mockResolvedValueOnce({ name: 'opencode-ai', version: '2.0.0' })
      .mockResolvedValueOnce(registry);
    await expect(selectOpenCodeInstallPackage('v1', '2.1.4', [], fetchMetadata)).rejects.toThrow(
      'selected generation'
    );
    expect(fetchMetadata).toHaveBeenCalledTimes(2);
  });
});
