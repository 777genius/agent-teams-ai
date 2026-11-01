import { getLatestQualifiedOpenCodeV2Version } from '@features/opencode-compatibility';
import {
  chooseOpenCodeInstallGeneration,
  parseOpenCodeInstallOptions,
} from '@features/opencode-runtime-installer';
import { selectOpenCodeInstallPackage } from '@features/opencode-runtime-installer/main';
import { describe, expect, it, vi } from 'vitest';

// A moving npm tag, an unqualified platform or a malformed IPC input must not
// authorize an arbitrary V2 package; an update must retain its generation.
describe('OpenCode installation policy', () => {
  it('chooses fresh qualified V2 and retains the installed generation', () => {
    expect(chooseOpenCodeInstallGeneration(undefined, undefined, '2.1.4')).toBe('v2');
    expect(chooseOpenCodeInstallGeneration(undefined, undefined, null)).toBe('v1');
    expect(chooseOpenCodeInstallGeneration(undefined, '1.18.3', '2.1.4')).toBe('v1');
    expect(chooseOpenCodeInstallGeneration(undefined, '2.9.0', '2.1.4')).toBe('v2');
    expect(chooseOpenCodeInstallGeneration('v1', '2.1.4', '2.1.4')).toBe('v1');
    const unshipped = getLatestQualifiedOpenCodeV2Version('linux', 'arm64');
    expect(unshipped).toBeNull();
    expect(chooseOpenCodeInstallGeneration(undefined, undefined, unshipped)).toBe('v1');
    expect(getLatestQualifiedOpenCodeV2Version('unsupported', 'x64')).toBeNull();
  });

  it('uses the actual pinned ARM64 qualification for a fresh default V2 installation', () => {
    const qualified = getLatestQualifiedOpenCodeV2Version('win32', 'arm64');
    expect(qualified).toBe('2.1.4');
    expect(chooseOpenCodeInstallGeneration(undefined, undefined, qualified)).toBe('v2');
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

  it('refuses V2 on an unqualified platform before contacting npm', async () => {
    const fetchMetadata = vi.fn();
    await expect(selectOpenCodeInstallPackage('v2', null, [], fetchMetadata)).rejects.toThrow(
      'No compatible OpenCode V2'
    );
    expect(fetchMetadata).not.toHaveBeenCalled();
  });

  it('fetches the exact tested V2 and refuses redirected native metadata', async () => {
    const fetchMetadata = vi
      .fn()
      .mockResolvedValueOnce({
        name: '@opencode/cli',
        version: '2.0.32',
        optionalDependencies: { '@opencode/cli-linux-x64': '2.0.32' },
      })
      .mockResolvedValueOnce({ name: '@opencode/cli-linux-arm64', version: '2.0.32' });
    await expect(
      selectOpenCodeInstallPackage(
        'v2',
        '2.0.32',
        [{ packageName: 'opencode-linux-x64' }],
        fetchMetadata
      )
    ).rejects.toThrow('identity mismatch');
    expect(fetchMetadata.mock.calls).toEqual([
      ['@opencode/cli', '2.0.32'],
      ['@opencode/cli-linux-x64', '2.0.32'],
    ]);
  });

  it('does not upgrade a V1 installation to a different generation via npm latest', async () => {
    await expect(
      selectOpenCodeInstallPackage('v1', '2.0.32', [], () =>
        Promise.resolve({
          name: 'opencode-ai',
          version: '2.0.32',
        })
      )
    ).rejects.toThrow('selected generation');
  });
});
