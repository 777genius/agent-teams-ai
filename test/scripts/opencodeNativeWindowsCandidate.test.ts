import { describe, expect, it } from 'vitest';

import runtimeLock from '../../runtime.lock.json';
import { candidateRuntimeLock } from '../../scripts/e2e/opencode-native-windows-candidate';
import { readOpenCodeV2DeliveryMap } from '../../src/features/opencode-runtime-installer/core/domain/v2Delivery';

const sourceSha = 'a'.repeat(40);
const archiveSha256 = 'b'.repeat(64);
const descriptor = { ...runtimeLock.opencodeV2Delivery['win32-x64'], sourceCommit: sourceSha,
  arch: 'arm64', archive: { ...runtimeLock.opencodeV2Delivery['win32-x64'].archive,
    file: `agent-teams-opencode-v2-support-win32-arm64-v${runtimeLock.version}.zip` } };
const contract = { ...runtimeLock.opencodeV2, qualified: {
  ...runtimeLock.opencodeV2.qualified, 'win32-arm64': ['2.1.4'],
} };
const input = { version: runtimeLock.version, sourceSha, archiveSha256,
  platform: 'win32-arm64', descriptor, contract };
const originalSnapshot = JSON.stringify(runtimeLock);

describe('native Windows candidate split delivery', () => {
  it('replaces all stale public descriptors with the selected actual candidate descriptor', () => {
    const lock = candidateRuntimeLock(runtimeLock, input);
    expect(Object.keys(lock.assets)).toEqual(['win32-arm64']);
    expect(readOpenCodeV2DeliveryMap(lock)).toEqual({ 'win32-arm64': descriptor });
    expect(lock.sourceRef).toBe(sourceSha);
    expect(lock.releaseTag).toBe(`TEST-native-candidate-${sourceSha}`);
    expect(lock.assets['win32-arm64']).toMatchObject({
      file: 'TEST-runtime-win32-arm64.zip', sha256: archiveSha256,
    });
    expect(JSON.stringify(runtimeLock)).toBe(originalSnapshot);
  });

  it('stages an explicit x64 V1-only base without V2 input or stale public eligibility', () => {
    const lock = candidateRuntimeLock(runtimeLock, { version: '0.0.100', sourceSha, archiveSha256,
      platform: 'win32-x64', versions: 'v1',
      get contract() { throw new Error('V1 must not read the registry contract'); },
      get descriptor() { throw new Error('V1 must not read a support descriptor'); },
    });
    expect(lock.version).toBe('0.0.100');
    expect(lock.sourceRef).toBe(sourceSha);
    expect(lock.assets).toEqual({ 'win32-x64': { ...runtimeLock.assets['win32-x64'],
      file: 'TEST-runtime-win32-x64.zip', sha256: archiveSha256 } });
    expect(Object.hasOwn(lock, 'opencodeV2')).toBe(false);
    expect(Object.hasOwn(lock, 'opencodeV2Delivery')).toBe(false);
    expect(readOpenCodeV2DeliveryMap(lock)).toBe(null);
    expect(JSON.stringify(runtimeLock)).toBe(originalSnapshot);
    expect(() => candidateRuntimeLock(runtimeLock, { ...input, versions: 'v1' })).toThrow('V1 candidate requires Windows x64');
  });

  it.each([
    ['missing contract', { contract: undefined }],
    ['missing descriptor', { descriptor: undefined }],
    ['source', { descriptor: { ...descriptor, sourceCommit: 'c'.repeat(40) } }],
    ['version', { version: '0.0.999' }],
    ['platform', { descriptor: { ...descriptor, arch: 'x64' } }],
    ['engine roster', { descriptor: { ...descriptor, engineVersions: ['2.0.0'] } }],
    ['Bun', { descriptor: { ...descriptor, requiredBunVersion: '1.3.11' } }],
    ['archive identity', { descriptor: { ...descriptor, archive: { ...descriptor.archive, file: 'TEST-support.zip' } } }],
  ])('rejects a mismatched %s before packaging', (_label, patch) => {
    expect(() => candidateRuntimeLock(runtimeLock, { ...input, ...patch })).toThrow();
  });
});
