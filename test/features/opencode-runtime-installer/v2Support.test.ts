// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyExternalOpenCodeV2Base } from '../../../scripts/lib/opencode-v2-base-inventory.mts';
import { zipFixture } from '../../../scripts/lib/runtime-zip.test-fixture.mts';
import {
  readOpenCodeV2DeliveryMap,
  V2_MANIFEST_FILE,
} from '../../../src/features/opencode-runtime-installer/core/domain/v2Delivery';
import { OpenCodeV2SupportInstaller } from '../../../src/features/opencode-runtime-installer/main/application/OpenCodeV2SupportInstaller';

import type { OpenCodeV2DeliveryDescriptor } from '../../../src/features/opencode-runtime-installer/core/domain/v2Delivery';
import type { OpenCodeRuntimeStatus } from '@shared/types';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function fixture(
  change?: (
    entries: { name: string; data: Buffer; symlink?: boolean }[],
    descriptor: OpenCodeV2DeliveryDescriptor
  ) => void,
  graphMetadata?: string
) {
  const identity = {
    schemaVersion: 1 as const,
    runtimeVersion: '0.0.999',
    sourceCommit: 'a'.repeat(40),
    bridgeProtocol: 1 as const,
    platform: process.platform,
    arch: process.arch,
    requiredBunVersion: '1.3.11',
    engineVersions: ['2.1.4'],
  };
  const files = [
    ['local-cli/opencodeV2Server.js', 'server fixture'],
    ['local-cli/opencodeV2ExecutionServer.js', 'execution fixture'],
    ['local-cli/opencodeV2RunOwner.js', 'owner fixture'],
    [
      'local-cli/opencode-v2-graphs.json',
      graphMetadata ??
        JSON.stringify({
          schema: 2,
          graphs: [{ version: '2.1.4', server: '@opencode/server-v2.1.4' }],
          pty: '0.4.11',
        }),
    ],
    ['local-cli/node_modules/native/runtime.node', 'native fixture'],
  ]
    .map(([name, data]) => ({ name, data: Buffer.from(data) }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  const manifest = Buffer.from(
    JSON.stringify(
      {
        ...identity,
        files: files.map((file) => ({
          path: file.name,
          bytes: file.data.length,
          sha256: sha(file.data),
          executable: false,
        })),
      },
      null,
      2
    ) + '\n'
  );
  const entries = [{ name: V2_MANIFEST_FILE, data: manifest }, ...files];
  const descriptor: OpenCodeV2DeliveryDescriptor = {
    ...identity,
    archive: {
      file: `agent-teams-opencode-v2-support-${process.platform}-${process.arch}-v0.0.999.zip`,
      kind: 'zip',
      sha256: '',
      bytes: 1,
      entries: entries.length,
      expandedBytes: entries.reduce((sum, file) => sum + file.data.length, 0),
    },
    manifest: {
      file: V2_MANIFEST_FILE,
      sha256: sha(manifest),
      bytes: manifest.length,
      files: files.length,
    },
  };
  change?.(entries, descriptor);
  const archive = zipFixture(entries);
  descriptor.archive.bytes = archive.length;
  descriptor.archive.sha256 = sha(archive);
  const platformKey = `${process.platform}-${process.arch}`;
  const lock = {
    version: '0.0.999',
    releaseRepository: '777genius/agent_teams_orchestrator_binaries',
    releaseTag: 'runtime-v0.0.999',
    assets: { [platformKey]: {} },
    opencodeV2: { qualified: { [platformKey]: ['2.1.4'] } },
    opencodeV2Delivery: { [platformKey]: descriptor },
  };
  return { descriptor, archive, lock };
}

describe('external OpenCode V2 support installation', () => {
  let root: string;
  const native: OpenCodeRuntimeStatus = {
    installed: true,
    source: 'override',
    binaryPath: '/TEST/native-opencode',
    version: '2.9.0',
    state: 'ready',
  };
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'TEST-v2-support-'));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });
  function installer(lock: unknown) {
    return new OpenCodeV2SupportInstaller({ lock, cacheRoot: () => root });
  }
  function download(archive: Buffer) {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array(archive), {
          headers: { 'content-length': String(archive.length) },
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  function directory(descriptor: OpenCodeV2DeliveryDescriptor) {
    return path.join(
      root,
      descriptor.runtimeVersion,
      `${descriptor.platform}-${descriptor.arch}`,
      descriptor.archive.sha256
    );
  }

  it('accepts producer-shaped graph package metadata above 64 KiB', async () => {
    const graphMetadata =
      JSON.stringify(
        {
          schema: 2,
          graphs: [{ version: '2.1.4', server: '@opencode/server-v2.1.4' }],
          pty: '0.4.11',
          packages: Array.from({ length: 1800 }, (_, index) => ({
            name: `@TEST/package-${index}`,
            version: '2.1.4',
            path: `node_modules/@TEST/package-${index}`,
          })),
        },
        null,
        2
      ) + '\n';
    expect(Buffer.byteLength(graphMetadata)).toBeGreaterThan(64 * 1024);
    const { lock, archive } = fixture(undefined, graphMetadata);
    download(archive);
    const service = installer(lock);
    await service.install(native.version!, () => {});
    expect((await service.withStatus(native)).v2Support).toBe('ready');
  });

  it.each([
    ['opencodeV2Server.js', 'opencodev2server.js'],
    ['opencodeV2ExecutionServer.js', 'opencodev2executionserver.js'],
    ['opencodeV2RunOwner.js', 'opencodev2runowner.js'],
    ['opencode-v2-graphs.json', 'Opencode-v2-graphs.json'],
  ])('refuses a fully hashed manifest with the wrong case for %s', async (required, wrongCase) => {
    const { lock, descriptor, archive } = fixture((entries, pinned) => {
      const manifestEntry = entries.find((entry) => entry.name === V2_MANIFEST_FILE);
      const helperEntry = entries.find((entry) => entry.name === `local-cli/${required}`);
      if (!manifestEntry || !helperEntry) throw new Error('Missing required TEST fixture entry');
      const manifest = JSON.parse(manifestEntry.data.toString('utf8')) as {
        files: { path: string }[];
      };
      const row = manifest.files.find((file) => file.path === helperEntry.name);
      if (!row) throw new Error('Missing required TEST manifest row');
      helperEntry.name = `local-cli/${wrongCase}`;
      row.path = helperEntry.name;
      manifest.files.sort((left, right) =>
        Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))
      );
      manifestEntry.data = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
      pinned.manifest.bytes = manifestEntry.data.length;
      pinned.manifest.sha256 = sha(manifestEntry.data);
      pinned.archive.expandedBytes = entries.reduce((sum, entry) => sum + entry.data.length, 0);
    });
    download(archive);
    await expect(installer(lock).install(native.version!, () => {})).rejects.toThrow(
      'Invalid pinned OpenCode V2 support delivery'
    );
    await expect(readFile(path.join(directory(descriptor), 'installed.json'))).rejects.toThrow();
  });

  it('refuses graph metadata above the 32 MiB inventory JSON budget without publishing', async () => {
    const graphMetadata =
      JSON.stringify({
        schema: 2,
        graphs: [{ version: '2.1.4', server: '@opencode/server-v2.1.4' }],
        pty: '0.4.11',
      }) + ' '.repeat(32 * 1024 ** 2);
    const { lock, descriptor, archive } = fixture(undefined, graphMetadata);
    download(archive);
    await expect(installer(lock).install(native.version!, () => {})).rejects.toThrow(
      'graph metadata is too large'
    );
    await expect(readFile(path.join(directory(descriptor), 'installed.json'))).rejects.toThrow();
  }, 15_000);

  it('binds support Bun requirements and every base target to the staged build identity', async () => {
    const { lock, descriptor } = fixture();
    const platformKey = `${process.platform}-${process.arch}`;
    await mkdir(path.join(root, 'local-cli'));
    await mkdir(path.join(root, 'bun'));
    await writeFile(path.join(root, 'local-cli/cli.js'), 'TEST base entry');
    await writeFile(path.join(root, 'bun/bun'), 'TEST base Bun');
    await writeFile(path.join(root, 'bun/bun.exe'), 'TEST base Windows Bun');
    await writeFile(path.join(root, 'COMMIT_SHA'), descriptor.sourceCommit);
    await writeFile(
      path.join(root, 'opencode-delivery.json'),
      JSON.stringify({ bunVersion: descriptor.requiredBunVersion })
    );
    expect(verifyExternalOpenCodeV2Base(root, lock, platformKey)).toBe(true);
    descriptor.requiredBunVersion = '1.4.0'; // Valid semver must still match the actual base pin.
    expect(() => verifyExternalOpenCodeV2Base(root, lock, platformKey)).toThrow(
      'different base Bun version'
    );
    descriptor.requiredBunVersion = '1.3.11';
    const baseOnlyKey = platformKey === 'win32-arm64' ? 'darwin-x64' : 'win32-arm64';
    const baseOnly = {
      ...lock,
      assets: { ...lock.assets, [baseOnlyKey]: {} },
      opencodeV2: { qualified: { ...lock.opencodeV2.qualified, [baseOnlyKey]: [] } },
    };
    expect(verifyExternalOpenCodeV2Base(root, baseOnly, baseOnlyKey)).toBe(true);
    await writeFile(path.join(root, 'COMMIT_SHA'), 'b'.repeat(40));
    expect(() => verifyExternalOpenCodeV2Base(root, baseOnly, baseOnlyKey)).toThrow(
      'source identities differ'
    );
  });

  it('preserves native identity, installs verified support once and repairs corruption without in-place edits', async () => {
    const { lock, descriptor, archive } = fixture();
    const service = installer(lock);
    const fetchMock = download(archive);
    expect(await service.withStatus(native)).toMatchObject({
      ...native,
      state: 'idle',
      v2Support: 'required',
    });
    await service.install(native.version!, () => {});
    expect(await service.withStatus(native)).toMatchObject({ ...native, v2Support: 'ready' });
    const receiptPath = path.join(directory(descriptor), 'installed.json');
    const original = JSON.parse(await readFile(receiptPath, 'utf8')) as { instance: string };
    await service.install(native.version!, () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const originalFile = path.join(
      directory(descriptor),
      original.instance,
      'local-cli/node_modules/native/runtime.node'
    );
    await writeFile(originalFile, 'tamper fixture'); // Same byte length: cheap status is availability only.
    expect((await service.withStatus(native)).v2Support).toBe('ready');
    await service.install(native.version!, () => {});
    const repaired = JSON.parse(await readFile(receiptPath, 'utf8')) as { instance: string };
    expect(repaired.instance).not.toBe(original.instance);
    expect(await readFile(originalFile, 'utf8')).toBe('tamper fixture');
    expect(
      await readFile(
        path.join(
          directory(descriptor),
          repaired.instance,
          'local-cli/node_modules/native/runtime.node'
        ),
        'utf8'
      )
    ).toBe('native fixture');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['archive', 'manifest', 'file', 'symlink'] as const)(
    'refuses a wrong %s before publishing a receipt',
    async (failure) => {
      const { lock, descriptor, archive } = fixture((entries, descriptor) => {
        if (failure === 'manifest') descriptor.manifest.sha256 = 'b'.repeat(64);
        if (failure === 'file') entries[1].data = Buffer.alloc(entries[1].data.length, 65);
        if (failure === 'symlink') Object.assign(entries[1], { symlink: true });
      });
      const bytes = Buffer.from(archive);
      if (failure === 'archive') bytes[0] ^= 1;
      download(bytes);
      await expect(installer(lock).install(native.version!, () => {})).rejects.toThrow();
      await expect(readFile(path.join(directory(descriptor), 'installed.json'))).rejects.toThrow();
      expect(
        (await readdir(directory(descriptor))).filter(
          (name) => name.startsWith('.staging-') || name.startsWith('.download-')
        )
      ).toEqual([]);
    }
  );

  it('rejects malformed and partial new metadata while absent legacy metadata keeps V1/V2 unchanged', async () => {
    expect(readOpenCodeV2DeliveryMap({ version: '0.0.145' })).toBeNull();
    const legacy = installer({ version: '0.0.145' });
    expect(await legacy.withStatus(native)).toEqual(native);
    const { lock } = fixture();
    expect(() => readOpenCodeV2DeliveryMap({ ...lock, opencodeV2Delivery: {} })).toThrow();
    for (const field of ['platform', 'runtimeVersion', 'requiredBunVersion'] as const) {
      const bad = structuredClone(lock);
      bad.opencodeV2Delivery[`${process.platform}-${process.arch}`][field] = 'wrong';
      expect(() => readOpenCodeV2DeliveryMap(bad)).toThrow();
    }
    const v1 = { ...native, version: '1.18.3' };
    expect(await installer({ opencodeV2Delivery: null }).withStatus(v1)).toEqual(v1);
    expect(() =>
      verifyExternalOpenCodeV2Base(
        root,
        { ...lock, opencodeV2Delivery: null },
        `${process.platform}-${process.arch}`
      )
    ).toThrow();
  });

  it('keeps concurrent publishers immutable and exposes only a complete receipt', async () => {
    const { lock, descriptor, archive } = fixture();
    download(archive);
    await Promise.all([
      installer(lock).install(native.version!, () => {}),
      installer(lock).install(native.version!, () => {}),
    ]);
    expect((await installer(lock).withStatus(native)).v2Support).toBe('ready');
    const names = await readdir(directory(descriptor));
    expect(names.filter((name) => name.startsWith('.'))).toEqual([]);
    expect(names.filter((name) => name !== 'installed.json').length).toBeGreaterThanOrEqual(1);
  });

  it('preserves the previous receipt on an interrupted repair and removes only its own staging', async () => {
    const { lock, descriptor, archive } = fixture();
    const service = installer(lock);
    download(archive);
    await service.install(native.version!, () => {});
    const receiptFile = path.join(directory(descriptor), 'installed.json');
    const before = await readFile(receiptFile, 'utf8');
    const receipt = JSON.parse(before) as { instance: string };
    await writeFile(
      path.join(
        directory(descriptor),
        receipt.instance,
        'local-cli/node_modules/native/runtime.node'
      ),
      'tamper fixture'
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(archive.subarray(0, 32));
                controller.error(new Error('TEST interrupted download'));
              },
            })
          )
      )
    );
    await expect(service.install(native.version!, () => {})).rejects.toThrow(
      'TEST interrupted download'
    );
    expect(await readFile(receiptFile, 'utf8')).toBe(before);
    expect((await readdir(directory(descriptor))).filter((name) => name.startsWith('.'))).toEqual(
      []
    );
  });
});
