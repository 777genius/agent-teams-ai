import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import {
  type HostedOpenCodeRuntimeLockV2,
  hostedOpenCodeRuntimePlatformKey,
  parseHostedOpenCodeRuntimeLock,
} from '../../../src/features/hosted-opencode-runtime';
import { extractHostedOpenCodeBinary } from '../../../src/main/composition/hosted/infrastructure/hostedOpenCodeArchive';
import {
  installHostedOpenCodeRuntime,
  resolveHostedOpenCodeRuntimeBinary,
} from '../../../src/main/composition/hosted/infrastructure/HostedOpenCodeRuntimeInstaller';

const SOURCE = {
  repository: '777genius/opencode-anomaly',
  baseCommit: '49c69c5ed3ccf706b61b3febb43c8aaff7f8325e',
  commit: '476b667c385210b19fbd15bcb57456cacb0ae9e7',
  reviewedPatchSha256: 'dbd8b2c1eda38043e3bfc9e2b809f4ef393fa075349ed219109a7deaca0c590e',
} as const;
const VERSION = '1.18.4-agentteams.1';
const PLATFORM = 'linux-x64';
const FILE = `opencode-${PLATFORM}-${VERSION}.tar.gz`;
const URL = `https://github.com/777genius/opencode-anomaly/releases/download/v${VERSION}/${FILE}`;

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function tarEntry(name: string, value: Buffer, type = '0', link = ''): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000755\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${value.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write(link, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return Buffer.concat([header, value, Buffer.alloc((512 - (value.length % 512)) % 512)]);
}

function archive(
  entries: Array<{ name: string; value?: Buffer; type?: string; link?: string }>
): Buffer {
  return gzipSync(
    Buffer.concat([
      ...entries.map((entry) =>
        tarEntry(entry.name, entry.value ?? Buffer.alloc(0), entry.type, entry.link)
      ),
      Buffer.alloc(1024),
    ])
  );
}

function availableLock(binary: Buffer, tarball: Buffer): HostedOpenCodeRuntimeLockV2 {
  const unavailable = { status: 'unavailable', reason: 'artifact_digests_pending' } as const;
  return {
    schemaVersion: 2,
    runtime: 'opencode',
    version: VERSION,
    tag: `v${VERSION}`,
    productionEligible: false,
    source: SOURCE,
    releaseRepository: SOURCE.repository,
    platforms: {
      'darwin-arm64': unavailable,
      'darwin-x64': unavailable,
      'linux-arm64': unavailable,
      'linux-x64': {
        status: 'available',
        file: FILE,
        archiveKind: 'tar.gz',
        binaryName: 'opencode',
        archiveSha256: digest(tarball),
        binarySha256: digest(binary),
        assetUrl: URL,
      },
      'win32-arm64': unavailable,
      'win32-x64': unavailable,
    },
  };
}

function response(value: Buffer): Response {
  return new Response(new Uint8Array(value), {
    status: 200,
    headers: { 'content-length': `${value.length}` },
  });
}

describe('hosted OpenCode runtime lock v2', () => {
  it('admits the checked-in fail-closed source identity', async () => {
    const lock = parseHostedOpenCodeRuntimeLock(
      JSON.parse(await fs.readFile(path.resolve('opencode-hosted-runtime.lock.json'), 'utf8'))
    );
    expect(lock).toMatchObject({
      version: VERSION,
      tag: `v${VERSION}`,
      productionEligible: false,
      source: SOURCE,
    });
    expect(
      Object.values(lock.platforms).filter((item) => item.status === 'available')
    ).toHaveLength(5);
    expect(lock.platforms['win32-arm64']).toEqual({
      status: 'unavailable',
      reason: 'artifact_digests_pending',
    });
  });

  it.each([
    ['source', { source: { ...SOURCE, commit: '0'.repeat(39) } }],
    ['version', { version: '1.18.4', tag: 'v1.18.4' }],
    ['platform', { platforms: {} }],
    ['eligibility', { productionEligible: true }],
  ])('rejects wrong %s identity', async (_name, mutation) => {
    const original = JSON.parse(
      await fs.readFile(path.resolve('opencode-hosted-runtime.lock.json'), 'utf8')
    );
    expect(() => parseHostedOpenCodeRuntimeLock({ ...original, ...mutation })).toThrow();
  });

  it('rejects latest and non-exact asset URLs', () => {
    const binary = Buffer.from('binary');
    const tarball = archive([{ name: 'package/opencode', value: binary }]);
    const lock = availableLock(binary, tarball) as unknown as Record<string, unknown>;
    const platforms = lock.platforms as Record<string, Record<string, unknown>>;
    platforms[PLATFORM] = {
      ...platforms[PLATFORM],
      assetUrl: 'https://github.com/777genius/opencode-anomaly/releases/latest/download/x',
    };
    expect(() => parseHostedOpenCodeRuntimeLock(lock)).toThrow(
      'hosted_opencode_lock_asset_url_invalid'
    );
  });

  it('rejects unsupported platforms', () => {
    expect(() => hostedOpenCodeRuntimePlatformKey('freebsd', 'x64')).toThrow(
      'hosted_opencode_platform_unsupported'
    );
  });

  it('requires materialized attested candidate bytes for provenance verification', async () => {
    await expect(
      promisify(execFile)(process.execPath, [
        path.resolve('scripts/verify-hosted-opencode-runtime-provenance.mjs'),
      ])
    ).rejects.toThrow('hosted-opencode-provenance-invalid:candidate-manifest-required');
  });

  it.each([
    [
      'provenance',
      'scripts/verify-hosted-opencode-runtime-provenance.mjs',
      'hosted-opencode-provenance-invalid:candidate-binary-path',
    ],
    [
      'materialization',
      'scripts/verify-hosted-opencode-runtime-materialization.mjs',
      'hosted-opencode-materialization-unsafe-binary-path',
    ],
  ])('%s verification rejects unsafe archive members before reading archives', async (_name, script, error) => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'hosted-opencode-verifier-'));
    try {
      for (const binaryPath of ['--checkpoint-action=exec=payload/opencode', '../opencode']) {
        const manifestPath = path.join(root, 'manifest.json');
        await fs.writeFile(
          manifestPath,
          JSON.stringify({ assets: [{ os: 'linux', arch: 'x64', binaryPath }] })
        );
        await expect(
          promisify(execFile)(process.execPath, [path.resolve(script), manifestPath, PLATFORM])
        ).rejects.toThrow(error);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('hosted OpenCode runtime archive safety', () => {
  it.each([
    [{ name: '../opencode', value: Buffer.from('x') }, 'traversal'],
    [{ name: 'package/opencode', type: '2', link: '/tmp/evil' }, 'symlink'],
  ])('rejects $1 archive entries', (entry, _label) => {
    expect(() => extractHostedOpenCodeBinary(archive([entry]), 'tar.gz', 'opencode')).toThrow(
      'hosted_opencode_archive_unsafe_entry'
    );
  });
});

describe('hosted-only OpenCode installer and resolver', () => {
  let root: string;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'hosted-opencode-runtime-'));
    process.env.NODE_ENV = 'test';
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('fails closed for the checked-in unavailable platform without fetching or fallback', async () => {
    const lock = JSON.parse(
      await fs.readFile(path.resolve('opencode-hosted-runtime.lock.json'), 'utf8')
    );
    const fetch = vi.fn();
    process.env.OPENCODE_BIN_PATH = '/user/path/opencode';
    await expect(
      installHostedOpenCodeRuntime({
        runtimeRoot: root,
        lock,
        platform: 'win32',
        arch: 'arm64',
        fetch,
        allowIneligibleTestFixture: true,
      })
    ).rejects.toThrow('hosted_opencode_artifact_unavailable:win32-arm64');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cannot run a non-production-eligible lock outside an explicit test fixture seam', async () => {
    const binary = Buffer.from('binary');
    const tarball = archive([{ name: 'package/opencode', value: binary }]);
    await expect(
      installHostedOpenCodeRuntime({
        runtimeRoot: root,
        lock: availableLock(binary, tarball),
        platform: 'linux',
        arch: 'x64',
      })
    ).rejects.toThrow('hosted_opencode_runtime_not_production_eligible');
  });

  it('installs exact URL -> archive -> binary -> version -> current.json v2 and resolves it', async () => {
    const binary = Buffer.from('verified hosted binary');
    const tarball = archive([{ name: 'package/opencode', value: binary }]);
    const fetch = vi.fn(async () => response(tarball));
    const options = {
      runtimeRoot: root,
      lock: availableLock(binary, tarball),
      platform: 'linux' as const,
      arch: 'x64',
      fetch,
      executeVersion: async () => VERSION,
      allowIneligibleTestFixture: true,
    };
    const manifest = await installHostedOpenCodeRuntime(options);
    expect(fetch).toHaveBeenCalledWith(URL, expect.objectContaining({ redirect: 'error' }));
    expect(JSON.parse(await fs.readFile(path.join(root, 'current.json'), 'utf8'))).toEqual(
      manifest
    );
    await expect(resolveHostedOpenCodeRuntimeBinary(options)).resolves.toBe(manifest.binaryPath);
  });

  it('coalesces concurrent identical installs into one atomic publication', async () => {
    const binary = Buffer.from('concurrent hosted binary');
    const tarball = archive([{ name: 'package/opencode', value: binary }]);
    let releaseDownload: (() => void) | undefined;
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const fetch = vi.fn(async () => {
      await downloadGate;
      return response(tarball);
    });
    const options = {
      runtimeRoot: root,
      lock: availableLock(binary, tarball),
      platform: 'linux' as const,
      arch: 'x64',
      fetch,
      executeVersion: async () => VERSION,
      allowIneligibleTestFixture: true,
    };
    const first = installHostedOpenCodeRuntime(options);
    const second = installHostedOpenCodeRuntime(options);
    releaseDownload?.();
    const [firstManifest, secondManifest] = await Promise.all([first, second]);
    expect(secondManifest).toEqual(firstManifest);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(path.join(root, 'current.json'), 'utf8'))).toEqual(
      firstManifest
    );
  });

  it.each([
    [
      'archive',
      (lock: HostedOpenCodeRuntimeLockV2) => ({
        ...lock,
        platforms: {
          ...lock.platforms,
          [PLATFORM]: { ...lock.platforms[PLATFORM], archiveSha256: '0'.repeat(64) },
        },
      }),
    ],
    [
      'binary',
      (lock: HostedOpenCodeRuntimeLockV2) => ({
        ...lock,
        platforms: {
          ...lock.platforms,
          [PLATFORM]: { ...lock.platforms[PLATFORM], binarySha256: '0'.repeat(64) },
        },
      }),
    ],
  ])('rejects wrong %s digest', async (kind, mutate) => {
    const binary = Buffer.from('binary');
    const tarball = archive([{ name: 'package/opencode', value: binary }]);
    await expect(
      installHostedOpenCodeRuntime({
        runtimeRoot: root,
        lock: mutate(availableLock(binary, tarball)),
        platform: 'linux',
        arch: 'x64',
        fetch: async () => response(tarball),
        executeVersion: async () => VERSION,
        allowIneligibleTestFixture: true,
      })
    ).rejects.toThrow(`hosted_opencode_${kind}_sha256_mismatch`);
  });

  it('rejects wrong exact version and leaves no current manifest', async () => {
    const binary = Buffer.from('binary');
    const tarball = archive([{ name: 'package/opencode', value: binary }]);
    await expect(
      installHostedOpenCodeRuntime({
        runtimeRoot: root,
        lock: availableLock(binary, tarball),
        platform: 'linux',
        arch: 'x64',
        fetch: async () => response(tarball),
        executeVersion: async () => '1.18.4',
        allowIneligibleTestFixture: true,
      })
    ).rejects.toThrow('hosted_opencode_version_mismatch');
    await expect(fs.readFile(path.join(root, 'current.json'))).rejects.toThrow();
  });

  it('keeps the previous current.json on a partial install failure', async () => {
    const previous = '{"previous":true}\n';
    await fs.writeFile(path.join(root, 'current.json'), previous);
    const binary = Buffer.from('binary');
    const tarball = archive([{ name: 'package/opencode', value: binary }]);
    await expect(
      installHostedOpenCodeRuntime({
        runtimeRoot: root,
        lock: availableLock(binary, tarball),
        platform: 'linux',
        arch: 'x64',
        fetch: async () => response(tarball),
        executeVersion: async () => VERSION,
        allowIneligibleTestFixture: true,
        beforePublishManifest: async () => {
          throw new Error('injected_partial_install');
        },
      })
    ).rejects.toThrow('injected_partial_install');
    expect(await fs.readFile(path.join(root, 'current.json'), 'utf8')).toBe(previous);
  });

  it('does not publish current.json when atomic manifest publication fails', async () => {
    const binary = Buffer.from('binary');
    const tarball = archive([{ name: 'package/opencode', value: binary }]);
    await fs.mkdir(path.join(root, 'current.json'), { recursive: true });
    await expect(
      installHostedOpenCodeRuntime({
        runtimeRoot: root,
        lock: availableLock(binary, tarball),
        platform: 'linux',
        arch: 'x64',
        fetch: async () => response(tarball),
        executeVersion: async () => VERSION,
        allowIneligibleTestFixture: true,
      })
    ).rejects.toThrow();
    expect((await fs.lstat(path.join(root, 'current.json'))).isFile()).toBe(false);
  });

  it('fails closed instead of resolving env, PATH, or a tampered binary', async () => {
    const binary = Buffer.from('binary');
    const tarball = archive([{ name: 'package/opencode', value: binary }]);
    const options = {
      runtimeRoot: root,
      lock: availableLock(binary, tarball),
      platform: 'linux' as const,
      arch: 'x64',
      allowIneligibleTestFixture: true,
    };
    process.env.PATH = root;
    process.env.OPENCODE_BIN_PATH = path.join(root, 'user-opencode');
    await fs.writeFile(process.env.OPENCODE_BIN_PATH, binary);
    await expect(resolveHostedOpenCodeRuntimeBinary(options)).rejects.toThrow(
      'hosted_opencode_current_manifest_missing'
    );
    const installed = await installHostedOpenCodeRuntime({
      ...options,
      fetch: async () => response(tarball),
      executeVersion: async () => VERSION,
    });
    await fs.writeFile(installed.binaryPath, 'tampered');
    await expect(resolveHostedOpenCodeRuntimeBinary(options)).rejects.toThrow(
      'hosted_opencode_binary_sha256_mismatch'
    );
  });
});
