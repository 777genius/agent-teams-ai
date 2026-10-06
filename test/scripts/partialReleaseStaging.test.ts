// @vitest-environment node
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import {
  loadPlan,
  prepareDraft,
  requiredFeed,
  stageDraft,
  verifyDraftBytes,
} from '../../scripts/ci/release/assembly.js';
import { releaseMain } from '../../scripts/ci/release/cli.js';
import {
  canonical,
  digest,
  MAC_EVIDENCE,
  macAliases,
  MANIFEST,
  manifestFor,
  platformNames,
  renderFeed,
  textProof,
} from '../../scripts/ci/release/contract.js';
import {
  GitHubReleasePort,
  ReleaseHttpError,
  validateNativeProducer,
} from '../../scripts/ci/release/github.js';
import * as nativeReadiness from '../../scripts/ci/release/nativeReadiness.js';
import {
  publishCarriedRelease,
  verifyCarryReadiness,
} from '../../scripts/ci/release/publication.js';
import { verifyPublished } from '../../scripts/ci/release/validation.js';

import type {
  Asset,
  BuildProof,
  Mode,
  NativeEvidence,
  NativeEvidenceReference,
  NativeProbeArtifact,
  PlatformManifest,
  Release,
  ReleasePort,
} from '../../scripts/ci/release/contract.js';
import type { StagePlan } from '../../scripts/ci/release/contract.js';
import type { GitHubBuildRun, NativeProducerMetadata } from '../../scripts/ci/release/github.js';
import type {
  NativeReadinessPort,
  NativeReadinessReceipt,
} from '../../scripts/ci/release/nativeReadiness.js';
import type { PublicationPort } from '../../scripts/ci/release/publication.js';

const repository = '777genius/agent-teams-ai';
const sourceSha = '1'.repeat(40);
const targetSha = '2'.repeat(40);
const toolingSha = '3'.repeat(40);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// A byte-backed release boundary: uploads persist actual files into release storage.
// These tests fail on changed feed selection, silent replacement, incomplete recovery,
// or acceptance of unproven public carry; no real GitHub or app runtime is involved.
class TestReleaseStorage implements ReleasePort {
  readonly releases = new Map<string, Release>();
  readonly bytes = new Map<number, Buffer>();
  readonly uploads: string[] = [];
  nextId = 100;
  lostResponse = false;
  failName: string | null = null;
  nativeArtifact: NativeProbeArtifact | null = null;
  targetMinimum = '12.0';
  missingLatestFeed: string | null = null;
  beforeUpload: (() => void) | null = null;
  constructor() {
    this.releases.set('v2.17.2', {
      id: 2,
      tag_name: 'v2.17.2',
      target_commitish: targetSha,
      created_at: '2026-10-01T21:02:41Z',
      draft: true,
      prerelease: false,
      name: 'Windows/Linux release',
      body: 'Reviewed notes',
      assets: [],
    });
    this.releases.set('v2.17.1', {
      id: 1,
      tag_name: 'v2.17.1',
      target_commitish: sourceSha,
      created_at: '2026-09-28T15:27:10Z',
      draft: false,
      prerelease: false,
      name: 'Full predecessor',
      body: 'Original source notes',
      assets: [],
    });
    const t = platformNames('2.17.2');
    const m = platformNames('2.17.1').mac;
    for (const name of [...t.windows, ...t.linux, ...t.windows.map((n) => `${n}.blockmap`)])
      this.add('v2.17.2', name, Buffer.from(`real-fixture-payload:${name}`));
    for (const name of m) this.add('v2.17.1', name, Buffer.from(`signed-fixture-payload:${name}`));
    for (const [name, source] of Object.entries(macAliases('2.17.1')))
      this.add('v2.17.1', name, this.content('v2.17.1', source));
    // Preserve historical absence of a floor, its date and comments verbatim.
    const feed = `# historical raw feed\n${renderFeed(
      '2.17.1',
      m.map((n) => textProof(n, this.content('v2.17.1', n))),
      '2026-09-28T23:36:49.000Z'
    )}`;
    this.add('v2.17.1', 'latest-mac.yml', Buffer.from(feed));
  }
  add(tag: string, name: string, bytes: Buffer): void {
    const release = this.releases.get(tag)!;
    const id = this.nextId++;
    release.assets.push({ id, name, size: bytes.length, digest: `sha256:${digest(bytes)}` });
    this.bytes.set(id, Buffer.from(bytes));
  }
  content(tag: string, name: string): Buffer {
    return this.bytes.get(this.releases.get(tag)!.assets.find((a) => a.name === name)!.id)!;
  }
  release(_repo: string, tag: string): Promise<Release> {
    return Promise.resolve(structuredClone(this.releases.get(tag)!));
  }
  tagSha(_repo: string, tag: string): Promise<string> {
    return Promise.resolve(tag === 'v2.17.2' ? targetSha : sourceSha);
  }
  async latest(): Promise<Release> {
    return this.release(repository, this.releases.get('v2.17.2')!.draft ? 'v2.17.1' : 'v2.17.2');
  }
  minimum(repo: string, sha: string): Promise<string> {
    if (repo !== repository || (sha !== targetSha && sha !== sourceSha))
      throw new Error('Unknown application minimum identity');
    return Promise.resolve(sha === targetSha ? this.targetMinimum : '12.0');
  }
  async download(_repo: string, asset: Asset, destination: string): Promise<void> {
    await writeFile(destination, this.bytes.get(asset.id)!);
  }
  async upload(_repo: string, target: number | string, file: string): Promise<void> {
    this.beforeUpload?.();
    // Model both API identities: a tag resolves the current release, whereas an
    // immutable ID can never select a replacement. This catches the old adapter.
    const release =
      typeof target === 'string'
        ? this.releases.get(target)
        : [...this.releases.values()].find((r) => r.id === target);
    if (!release) throw new Error('Upload release ID no longer exists');
    const tag = release.tag_name;
    const name = path.basename(file);
    this.uploads.push(name);
    if (this.failName === name) throw new Error('Interrupted transport');
    if (this.releases.get(tag)!.assets.some((a) => a.name === name))
      throw new Error('Name collision');
    this.add(tag, name, await readFile(file));
    if (this.lostResponse) {
      this.lostResponse = false;
      throw new Error('Accepted upload but response lost');
    }
  }
  verifyBuild(_repo: string, sha: string, proof: BuildProof): Promise<void> {
    if (sha !== targetSha || proof.runId !== 10) throw new Error('Wrong build provenance');
    return Promise.resolve();
  }
  verifyNative(ref: NativeEvidenceReference): Promise<NativeProbeArtifact> {
    if (ref.toolingSha !== this.nativeArtifact?.toolingSha)
      throw new Error('No native producing artifact');
    return Promise.resolve(structuredClone(this.nativeArtifact));
  }
  publicAsset(_repo: string, tag: string, name: string): Promise<void> {
    if (
      this.releases.get(tag)!.draft ||
      !this.releases.get(tag)!.assets.some((a) => a.name === name)
    )
      throw new Error('Not public');
    return Promise.resolve();
  }
  publicRelease(_repo: string, tag: string): Promise<void> {
    if (this.releases.get(tag)!.draft) throw new Error('Not public');
    return Promise.resolve();
  }
  async publicLatest(_repo: string, tag: string): Promise<void> {
    const latest = await this.latest();
    if (tag !== latest.tag_name || latest.draft) throw new Error('Not public latest');
  }
  async publicLatestAsset(repo: string, name: string): Promise<void> {
    if (name === this.missingLatestFeed) throw new Error('Latest download unavailable');
    const latest = await this.latest();
    await this.publicAsset(repo, latest.tag_name, name);
  }
}
async function prepared(store = new TestReleaseStorage()) {
  const output = await mkdtemp(path.join(tmpdir(), 'TEST-partial-release-'));
  directories.push(output);
  const result = await prepareDraft(store, {
    repository,
    tag: 'v2.17.2',
    applicationSha: targetSha,
    toolingSha,
    mode: 'carry-mac',
    macSourceTag: 'v2.17.1',
    build: { runId: 10, attempt: 1, jobIds: [11, 12, 13] },
    output,
  });
  return { store, output, ...result };
}

describe('append-only partial release assembly', () => {
  it('preserves all Mac bytes/date/floor absence and emits real two-architecture Windows/four-format Linux feeds', async () => {
    const { store, output, plan } = await prepared();
    expect(await readFile(path.join(output, 'latest-mac.yml'))).toEqual(
      store.content('v2.17.1', 'latest-mac.yml')
    );
    expect(plan.feeds['latest-mac.yml']).not.toContain('minimumSystemVersion');
    const win = parse(requiredFeed(plan.feeds, 'latest.yml')) as {
      files: { url: string }[];
      releaseDate: string;
    };
    const linux = parse(requiredFeed(plan.feeds, 'latest-linux.yml')) as {
      files: { url: string; sha512: string; size: number }[];
    };
    expect(win.files.map((f) => f.url)).toEqual([
      'Agent.Teams.AI.Setup.2.17.2.exe',
      'Agent.Teams.AI.Setup.2.17.2-arm64.exe',
    ]);
    expect(win.releaseDate).toBe('2026-10-01T21:02:41Z');
    expect(linux.files.map((f) => f.url)).toEqual([
      'Agent.Teams.AI-2.17.2.AppImage',
      'agent-teams-ai_2.17.2_amd64.deb',
      'agent-teams-ai-2.17.2.x86_64.rpm',
      'agent-teams-ai-2.17.2.pacman',
    ]);
    for (const f of linux.files)
      expect(f).toEqual({
        url: f.url,
        sha512: createHash('sha512').update(store.content('v2.17.2', f.url)).digest('base64'),
        size: store.content('v2.17.2', f.url).length,
      });
    const oldSource = canonical(await store.release(repository, 'v2.17.1'));
    await stageDraft(store, plan);
    expect(canonical(await store.release(repository, 'v2.17.1'))).toBe(oldSource);
    for (const name of [...platformNames('2.17.1').mac, ...Object.keys(macAliases('2.17.1'))])
      expect(store.content('v2.17.2', name)).toEqual(store.content('v2.17.1', name));
    expect(store.uploads.at(-1)).toBe(MANIFEST);
    expect(store.releases.get('v2.17.2')!.draft).toBe(true);
    expect(
      store.releases.get('v2.17.2')!.assets.some((a) => /2\.17\.2.*(mac\.zip|\.dmg)$/.test(a.name))
    ).toBe(false);
    const manifest = JSON.parse(store.content('v2.17.2', MANIFEST).toString()) as Record<
      string,
      unknown
    >;
    expect(manifest.phase).toBe('assembled');
    expect(manifest).not.toHaveProperty('ready');
  });
  it('reconciles accepted uploads with lost responses and resumes the same immutable plan on a fresh runner as a verified no-op', async () => {
    const { store, output, plan, planDigest } = await prepared();
    store.lostResponse = true;
    await stageDraft(store, plan);
    expect(new Set(store.uploads).size).toBe(store.uploads.length);
    const before = store.uploads.length;
    const restored = await loadPlan(path.join(output, 'stage-plan.json'), planDigest);
    expect(await stageDraft(store, restored)).toMatchObject({ uploaded: 0, phase: 'assembled' });
    expect(store.uploads).toHaveLength(before);
    await verifyDraftBytes(store, restored);
    await expect(loadPlan(path.join(output, 'stage-plan.json'), '0'.repeat(64))).rejects.toThrow(
      'digest mismatch'
    );
  });
  it('leaves interrupted uploads unpublished, with no manifest until all outputs exist, and recovers without replacing accepted assets', async () => {
    const { store, plan } = await prepared();
    store.failName = 'latest-linux.yml';
    await expect(stageDraft(store, plan)).rejects.toThrow('Interrupted');
    expect(store.releases.get('v2.17.2')!.assets.some((a) => a.name === MANIFEST)).toBe(false);
    const acceptedIds = new Map(store.releases.get('v2.17.2')!.assets.map((a) => [a.name, a.id]));
    store.failName = null;
    await stageDraft(store, plan);
    for (const [name, id] of acceptedIds)
      expect(store.releases.get('v2.17.2')!.assets.find((a) => a.name === name)?.id).toBe(id);
  });
  it('never appends to a replacement release created after the final pre-upload identity read', async () => {
    const { store, plan } = await prepared();
    const original = await store.release(repository, 'v2.17.2');
    store.beforeUpload = () => {
      store.beforeUpload = null;
      store.releases.set('v2.17.2', { ...structuredClone(original), id: 999 });
    };
    await expect(stageDraft(store, plan)).rejects.toThrow(/identity|snapshot|changed/i);
    expect(await store.release(repository, 'v2.17.2')).toEqual({ ...original, id: 999 });
    expect(store.uploads).toEqual([]);
  });
  it.each([
    'foreign collision',
    'source replacement',
    'target public',
    'source hidden',
    'source metadata changed',
  ])('refuses %s without overwriting bytes', async (failure) => {
    const { store, plan } = await prepared();
    if (failure === 'foreign collision')
      store.add('v2.17.2', 'Agent.Teams.AI-arm64.dmg', Buffer.from('foreign bytes'));
    if (failure === 'source replacement')
      store.releases.get('v2.17.1')!.assets.find((a) => a.name.endsWith('-arm64.dmg'))!.digest =
        `sha256:${'a'.repeat(64)}`;
    if (failure === 'target public') store.releases.get('v2.17.2')!.draft = false;
    if (failure === 'source hidden') store.releases.get('v2.17.1')!.draft = true;
    if (failure === 'source metadata changed')
      store.releases.get('v2.17.1')!.created_at = '2026-10-02T00:00:00Z';
    const before = new Map([...store.bytes].map(([id, bytes]) => [id, Buffer.from(bytes)]));
    await expect(stageDraft(store, plan)).rejects.toThrow();
    expect(store.uploads).toHaveLength(0);
    for (const [id, bytes] of before) expect(store.bytes.get(id)).toEqual(bytes);
    expect(store.releases.get('v2.17.2')!.assets.some((a) => a.name === MANIFEST)).toBe(false);
  });
  it('fails full default when Mac payloads are absent, and rejects altered historical feed bytes before staging', async () => {
    const { store, output, plan } = await prepared();
    plan.feeds['latest-mac.yml'] += 'minimumSystemVersion: 22.0.0\n';
    await expect(stageDraft(store, plan)).rejects.toThrow('Byte proof mismatch');
    const fullOutput = path.join(output, 'full');
    await expect(
      prepareDraft(store, {
        repository,
        tag: 'v2.17.2',
        applicationSha: targetSha,
        toolingSha,
        mode: 'full',
        build: { runId: 10, attempt: 1, jobIds: [11, 12, 13] },
        output: fullOutput,
      })
    ).rejects.toThrow('Missing asset');
  });
  it('rejects a public manifest without native source evidence, forged asset proof, or an incomplete asset set', async () => {
    const { store, plan } = await prepared();
    await stageDraft(store, plan);
    store.releases.get('v2.17.2')!.draft = false;
    const previousLatest = vi
      .spyOn(store, 'latest')
      .mockResolvedValue(await store.release(repository, 'v2.17.1'));
    try {
      // A lagging latest must not turn missing native proof into a retryable result.
      await expect(verifyPublished(store, repository, 'v2.17.2')).rejects.toThrow(MAC_EVIDENCE);
    } finally {
      previousLatest.mockRestore();
    }
    const manifest = manifestFor(plan);
    const evidence: NativeEvidence = {
      schemaVersion: 1,
      reference: {
        repository,
        runId: 20,
        runAttempt: 1,
        jobId: 21,
        artifactId: 22,
        artifactName: 'mac-source-signature-evidence-20-1',
        artifactSha256: 'a'.repeat(64),
        toolingSha,
        inputDigest: manifest.inputDigest,
      },
      assets: platformNames('2.17.1').mac.map((name) => {
        const o = plan.input.originals.find((p) => p.name === name)!;
        return {
          assetId: o.assetId,
          sha256: o.sha256,
          version: '2.17.1',
          architecture: name.includes('-arm64') ? 'arm64' : 'x64',
          teamIdentifier: '6C84CW694S',
          productMinimum: '12.0',
          commands: [
            'codesign --verify --deep --strict TEST.app',
            'spctl --assess TEST.app',
            'xcrun stapler validate TEST.app',
            'lipo -archs TEST.app/executable',
            'plutil CFBundleShortVersionString TEST.app/Info.plist',
            'plutil LSMinimumSystemVersion TEST.app/Info.plist',
          ].map((command) => ({ command, exitCode: 0, outputSha256: 'b'.repeat(64) })),
        };
      }),
    };
    store.nativeArtifact = {
      schemaVersion: 1,
      inputDigest: manifest.inputDigest,
      toolingSha,
      sourceTag: 'v2.17.1',
      sourceApplicationSha: sourceSha,
      assets: evidence.assets,
    };
    store.add('v2.17.2', MAC_EVIDENCE, Buffer.from(canonical(evidence)));
    expect(await verifyPublished(store, repository, 'v2.17.2')).toEqual({
      mode: 'carry-mac',
      tag: 'v2.17.2',
    });
    store.releases
      .get('v2.17.2')!
      .assets.find((a) => a.name === 'Agent.Teams.AI-arm64.dmg')!.digest =
      `sha256:${'f'.repeat(64)}`;
    await expect(verifyPublished(store, repository, 'v2.17.2')).rejects.toThrow('digest changed');
    store.releases.get('v2.17.2')!.assets = store.releases
      .get('v2.17.2')!
      .assets.filter((a) => a.name !== 'agent-teams-ai-2.17.2.pacman');
    await expect(verifyPublished(store, repository, 'v2.17.2')).rejects.toThrow('Missing asset');
  });

  it('accepts a historical complete release with an AppImage-only Linux feed while auditing all four same-version assets', async () => {
    const store = new TestReleaseStorage();
    const names = platformNames('2.17.1');
    for (const name of [
      ...names.windows,
      ...names.linux,
      ...names.windows.map((n) => `${n}.blockmap`),
    ])
      store.add('v2.17.1', name, Buffer.from(`historical-full-payload:${name}`));
    for (const [feed, files] of [
      ['latest.yml', names.windows],
      ['latest-linux.yml', names.linux.slice(0, 1)],
    ] as const)
      store.add(
        'v2.17.1',
        feed,
        Buffer.from(
          renderFeed(
            '2.17.1',
            files.map((name) => textProof(name, store.content('v2.17.1', name))),
            '2026-09-28T15:27:10Z'
          )
        )
      );
    expect(await verifyPublished(store, repository, 'v2.17.1')).toEqual({
      mode: 'full',
      tag: 'v2.17.1',
    });
    const rpm = store.releases
      .get('v2.17.1')!
      .assets.find((asset) => asset.name === names.linux[2])!;
    store.bytes.set(rpm.id, Buffer.from('changed package bytes outside single-entry feed'));
    await expect(verifyPublished(store, repository, 'v2.17.1')).rejects.toThrow('digest changed');
    store.releases.get('v2.17.1')!.assets = store.releases
      .get('v2.17.1')!
      .assets.filter((asset) => asset.name !== names.linux[2]);
    await expect(verifyPublished(store, repository, 'v2.17.1')).rejects.toThrow('Missing asset');
  });

  it('requires four Linux feed formats for new manifestless full releases', async () => {
    const store = new TestReleaseStorage();
    const names = platformNames('2.17.2');
    for (const name of names.mac) store.add('v2.17.2', name, Buffer.from(`full-new-mac:${name}`));
    for (const [feed, files] of [
      ['latest.yml', names.windows],
      ['latest-linux.yml', names.linux.slice(0, 1)],
      ['latest-mac.yml', names.mac],
    ] as const)
      store.add(
        'v2.17.2',
        feed,
        Buffer.from(
          renderFeed(
            '2.17.2',
            files.map((name) => textProof(name, store.content('v2.17.2', name))),
            '2026-10-01T21:02:41Z'
          )
        )
      );
    store.releases.get('v2.17.2')!.draft = false;
    await expect(verifyPublished(store, repository, 'v2.17.2')).rejects.toThrow(
      'Invalid updater feed'
    );
  });
});

function manifestlessFull(productMinimum: string, darwinMinimum?: string): TestReleaseStorage {
  const store = new TestReleaseStorage();
  store.targetMinimum = productMinimum;
  const names = platformNames('2.17.2');
  for (const name of names.mac) store.add('v2.17.2', name, Buffer.from(`full-new-mac:${name}`));
  for (const [feed, files] of [
    ['latest.yml', names.windows],
    ['latest-linux.yml', names.linux],
    ['latest-mac.yml', names.mac],
  ] as const)
    store.add(
      'v2.17.2',
      feed,
      Buffer.from(
        renderFeed(
          '2.17.2',
          files.map((name) => textProof(name, store.content('v2.17.2', name))),
          '2026-10-01T21:02:41Z',
          feed === 'latest-mac.yml' ? darwinMinimum : undefined
        )
      )
    );
  store.releases.get('v2.17.2')!.draft = false;
  return store;
}

describe('manifestless new full release macOS minimum', () => {
  it.each<[string, string]>([
    ['12.0', '21.0.0'],
    ['13.0', '22.0.0'],
  ])(
    'accepts application product %s only with matching Darwin floor %s',
    async (productMinimum, darwinMinimum) => {
      const store = manifestlessFull(productMinimum, darwinMinimum);
      expect(await verifyPublished(store, repository, 'v2.17.2')).toEqual({
        mode: 'full',
        tag: 'v2.17.2',
      });
    }
  );

  it.each<[string, string | undefined]>([
    ['12.0', undefined],
    ['13.0', undefined],
    ['12.0', '22.0.0'],
    ['13.0', '21.0.0'],
    ['13.0', '13.0'],
    ['14.0', '23.0.0'],
  ])(
    'rejects missing/wrong/unsupported product %s and Darwin floor %s despite valid payload byte proofs',
    async (productMinimum, darwinMinimum) => {
      const store = manifestlessFull(productMinimum, darwinMinimum);
      await expect(verifyPublished(store, repository, 'v2.17.2')).rejects.toThrow(/macOS minimum/);
    }
  );
});

describe('published latest updater download contract', () => {
  it.each(['latest.yml', 'latest-linux.yml', 'latest-mac.yml'])(
    'rejects unavailable latest redirect for %s even when tag assets and latest API are valid',
    async (feed) => {
      const store = manifestlessFull('13.0', '22.0.0');
      store.missingLatestFeed = feed;
      await expect(verifyPublished(store, repository, 'v2.17.2')).rejects.toThrow(
        'Latest download unavailable'
      );
    }
  );
});

function nativeProducer(): { ref: NativeEvidenceReference; metadata: NativeProducerMetadata } {
  return {
    ref: {
      repository,
      runId: 20,
      runAttempt: 2,
      jobId: 201,
      artifactId: 22,
      artifactName: 'mac-source-signature-evidence-20-2',
      artifactSha256: 'a'.repeat(64),
      toolingSha,
      inputDigest: 'b'.repeat(64),
    },
    metadata: {
      run: {
        head_sha: toolingSha,
        run_attempt: 2,
        status: 'completed',
        path: '.github/workflows/updater-mac-source.yml',
      },
      job: {
        run_id: 20,
        name: 'mac-source-signatures',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-10-05T10:00:00Z',
        completed_at: '2026-10-05T10:05:00Z',
        steps: [
          {
            name: 'Preserve aggregate evidence and diagnostics',
            status: 'completed',
            conclusion: 'success',
            started_at: '2026-10-05T10:04:00Z',
            completed_at: '2026-10-05T10:04:30Z',
          },
        ],
      },
      attemptJobIds: [201],
      artifact: {
        name: 'mac-source-signature-evidence-20-2',
        digest: `sha256:${'a'.repeat(64)}`,
        expired: false,
        created_at: '2026-10-05T10:04:20Z',
        workflow_run: { id: 20, head_sha: toolingSha },
      },
    },
  };
}

describe('native producer authorization', () => {
  it('accepts only the reviewed current-attempt aggregate upload, including GitHub final-second precision', () => {
    const { ref, metadata } = nativeProducer();
    expect(() => validateNativeProducer(ref, metadata)).not.toThrow();
    metadata.artifact.created_at = '2026-10-05T10:04:30.999Z';
    expect(() => validateNativeProducer(ref, metadata)).not.toThrow();
    metadata.artifact.created_at = '2026-10-05T10:04:31.000Z';
    expect(() => validateNativeProducer(ref, metadata)).toThrow('producer upload step');
  });

  it.each([
    'unrelated job',
    'different attempt',
    'old archive name',
    'old archive timestamp',
    'outside upload window',
    'ambiguous upload',
    'unsuccessful upload',
  ])('rejects %s even when run/job succeed and artifact digest matches', (failure) => {
    const { ref, metadata } = nativeProducer();
    if (failure === 'unrelated job') metadata.job.name = 'unrelated successful job';
    if (failure === 'different attempt') metadata.attemptJobIds = [101];
    if (failure === 'old archive name') {
      ref.artifactName = 'mac-source-signature-evidence-20-1';
      metadata.artifact.name = ref.artifactName;
    }
    if (failure === 'old archive timestamp') metadata.artifact.created_at = '2026-10-04T10:04:20Z';
    if (failure === 'outside upload window') metadata.artifact.created_at = '2026-10-05T10:03:20Z';
    const upload = metadata.job.steps[0];
    if (!upload) throw new Error('Native producer fixture is missing its upload step');
    if (failure === 'ambiguous upload') metadata.job.steps.push({ ...upload });
    if (failure === 'unsuccessful upload') upload.conclusion = 'failure';
    expect(() => validateNativeProducer(ref, metadata)).toThrow(/producer|artifact|upload/);
  });
});

interface ReleaseTransportFixture {
  tagResponse?: Release;
  tagStatus?: number;
  listed: Release[][];
  byId: Release;
  assetPages: Asset[][];
  assetBytes?: Map<number, Buffer>;
  latestResponse?: Release;
  productMinimum?: string;
}
function requirePosixGhFixture(): void {
  if (process.platform === 'win32')
    throw new Error('POSIX gh fixtures must not resolve real gh.exe on Windows');
}
async function releaseTransport(
  fixture: ReleaseTransportFixture,
  test: (port: GitHubReleasePort, calls: () => Promise<string[]>) => Promise<void>
): Promise<void> {
  requirePosixGhFixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'TEST-release-transport-'));
  directories.push(directory);
  // Exercise actual CLI routing, exit/error classification, discovery, ID read
  // and asset pagination. The shell replaces network access, not release logic.
  await writeFile(
    path.join(directory, 'gh'),
    `#!/bin/sh
set -eu
fixture_dir=$(dirname "$0")
[ "$1" = api ]
printf '%s\\n' "$2" >> "$fixture_dir/calls.txt"
case "$2" in
  */releases/tags/*)
    if [ -f "$fixture_dir/tag.json" ]; then cat "$fixture_dir/tag.json"; else
      cat "$fixture_dir/error.txt" >&2
      exit 1
    fi ;;
  */commits/*) cat "$fixture_dir/commit.json" ;;
  */releases/latest) cat "$fixture_dir/latest.json" ;;
  */contents/package.json\\?ref=*) cat "$fixture_dir/package.json" ;;
  */actions/runs/10) cat "$fixture_dir/build-run.json" ;;
  */actions/runs/10/attempts/1/jobs\\?per_page=100) cat "$fixture_dir/build-jobs.json" ;;
  */releases/assets/*) cat "$fixture_dir/asset-\${2##*/}.bin" ;;
  */releases\\?per_page=100) cat "$fixture_dir/list.json" ;;
  */releases/*/assets\\?per_page=100) cat "$fixture_dir/assets.json" ;;
  */releases/*) cat "$fixture_dir/id.json" ;;
  *) exit 2 ;;
esac
`
  );
  await chmod(path.join(directory, 'gh'), 0o755);
  if (fixture.tagResponse)
    await writeFile(path.join(directory, 'tag.json'), JSON.stringify(fixture.tagResponse));
  await writeFile(
    path.join(directory, 'error.txt'),
    `gh: REST failure (HTTP ${fixture.tagStatus ?? 404})\n`
  );
  await writeFile(path.join(directory, 'list.json'), JSON.stringify(fixture.listed));
  await writeFile(path.join(directory, 'id.json'), JSON.stringify(fixture.byId));
  await writeFile(path.join(directory, 'assets.json'), JSON.stringify(fixture.assetPages));
  await writeFile(
    path.join(directory, 'latest.json'),
    JSON.stringify(fixture.latestResponse ?? fixture.byId)
  );
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({
      content: Buffer.from(
        JSON.stringify({
          build: { mac: { minimumSystemVersion: fixture.productMinimum ?? '13.0' } },
        })
      ).toString('base64'),
    })
  );
  await writeFile(
    path.join(directory, 'build-run.json'),
    JSON.stringify({
      head_sha: fixture.byId.target_commitish,
      run_attempt: 1,
      path: '.github/workflows/release.yml',
      event: 'push',
    })
  );
  await writeFile(
    path.join(directory, 'build-jobs.json'),
    JSON.stringify([
      {
        jobs: [
          { id: 11, run_id: 10, conclusion: 'success', name: 'release-win x64' },
          { id: 12, run_id: 10, conclusion: 'success', name: 'release-win arm64' },
          { id: 13, run_id: 10, conclusion: 'success', name: 'release-linux x64' },
          { id: 14, run_id: 10, conclusion: 'success', name: 'release-mac x64' },
          { id: 15, run_id: 10, conclusion: 'success', name: 'release-mac arm64' },
        ],
      },
    ])
  );
  await writeFile(
    path.join(directory, 'commit.json'),
    JSON.stringify({ sha: fixture.byId.target_commitish })
  );
  for (const [id, bytes] of fixture.assetBytes ?? [])
    await writeFile(path.join(directory, `asset-${id}.bin`), bytes);
  vi.stubEnv('PATH', `${directory}${path.delimiter}${process.env.PATH ?? ''}`);
  try {
    await test(new GitHubReleasePort(), async () =>
      (await readFile(path.join(directory, 'calls.txt'), 'utf8')).trim().split('\n')
    );
  } finally {
    vi.unstubAllEnvs();
  }
}

describe.skipIf(process.platform === 'win32')('authenticated draft release transport', () => {
  it('discovers an exact draft after tag 404 and reads its numeric ID with all asset pages', async () => {
    const store = new TestReleaseStorage();
    const draft = await store.release(repository, 'v2.17.2');
    const source = await store.release(repository, 'v2.17.1');
    await releaseTransport(
      {
        listed: [[source], [draft]],
        byId: { ...draft, assets: [] },
        assetPages: [draft.assets.slice(0, 2), draft.assets.slice(2)],
      },
      async (port, calls) => {
        const actual = await port.release(repository, 'v2.17.2');
        expect(actual).toEqual(draft);
        expect(await calls()).toEqual([
          `repos/${repository}/releases/tags/v2.17.2`,
          `repos/${repository}/releases?per_page=100`,
          `repos/${repository}/releases/2`,
          `repos/${repository}/releases/2/assets?per_page=100`,
        ]);
      }
    );
  });

  it('keeps published source tag transport without draft discovery', async () => {
    const source = await new TestReleaseStorage().release(repository, 'v2.17.1');
    await releaseTransport(
      { tagResponse: source, listed: [], byId: source, assetPages: [source.assets] },
      async (port, calls) => {
        expect(await port.release(repository, 'v2.17.1')).toEqual(source);
        expect(await calls()).toEqual([
          `repos/${repository}/releases/tags/v2.17.1`,
          `repos/${repository}/releases/1/assets?per_page=100`,
        ]);
      }
    );
  });

  it.each([401, 403, 429, 500])(
    'propagates HTTP %s without draft discovery and classifies its actual CLI failure',
    async (status) => {
      const draft = await new TestReleaseStorage().release(repository, 'v2.17.2');
      await releaseTransport(
        { tagStatus: status, listed: [[draft]], byId: draft, assetPages: [draft.assets] },
        async (port, calls) => {
          await expect(port.release(repository, 'v2.17.2')).rejects.toThrow(`HTTP ${status}`);
          expect(await calls()).toEqual([`repos/${repository}/releases/tags/v2.17.2`]);
          await verifyCommandExit(
            draft.tag_name,
            status === 429 || status >= 500 ? 75 : 1,
            new RegExp(`HTTP ${status}`)
          );
          expect(await calls()).toEqual(Array(2).fill(`repos/${repository}/releases/tags/v2.17.2`));
        }
      );
    }
  );

  it.each([
    'missing tag',
    'duplicate tag',
    'published list match',
    'changed ID',
    'changed tag',
    'changed draft state',
    'changed application commit',
  ])('rejects %s during authenticated discovery', async (failure) => {
    const draft = await new TestReleaseStorage().release(repository, 'v2.17.2');
    const fixture: ReleaseTransportFixture = {
      listed: [[draft]],
      byId: structuredClone(draft),
      assetPages: [draft.assets],
    };
    if (failure === 'missing tag') fixture.listed = [[{ ...draft, tag_name: 'v2.17.20' }]];
    if (failure === 'duplicate tag') fixture.listed = [[draft], [{ ...draft, id: 99 }]];
    if (failure === 'published list match') fixture.listed = [[{ ...draft, draft: false }]];
    if (failure === 'changed ID') fixture.byId.id = 99;
    if (failure === 'changed tag') fixture.byId.tag_name = 'v2.17.20';
    if (failure === 'changed draft state') fixture.byId.draft = false;
    if (failure === 'changed application commit') fixture.byId.target_commitish = sourceSha;
    await releaseTransport(fixture, async (port, calls) => {
      await expect(port.release(repository, 'v2.17.2')).rejects.toThrow(/discovery|draft|identity/);
      expect((await calls()).some((endpoint) => endpoint.includes('/assets?'))).toBe(false);
    });
  });
});

async function anonymousHttp(
  release: Release,
  failurePath: string,
  status: number,
  test: (
    requests: { path: string; method: string | undefined; authorization?: string }[]
  ) => Promise<void>,
  routes: ReadonlyMap<string, { release?: Release; stall?: 'headers' | 'body' }> = new Map()
): Promise<void> {
  const requests: { path: string; method: string | undefined; authorization?: string }[] = [];
  const server = createServer((request, response) => {
    const pathname = request.url ?? '';
    requests.push({
      path: pathname,
      method: request.method,
      authorization: request.headers.authorization,
    });
    const route = routes.get(pathname);
    if (route?.stall === 'headers') return;
    if (pathname !== failurePath && pathname.includes('/releases/latest/download/')) {
      response.writeHead(302, {
        Location: pathname.replace('/releases/latest/download/', '/releases/download/v2.17.2/'),
      });
      response.end();
      return;
    }
    response.writeHead(pathname === failurePath ? status : 200, {
      'Content-Type': 'application/json',
    });
    if (route?.stall === 'body') {
      response.write('{"id":');
      return;
    }
    response.end(JSON.stringify(route?.release ?? release));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing TEST HTTP address');
  const realFetch = globalThis.fetch;
  // Send actual HTTP requests to TEST localhost; no response/status mock. Preserve
  // the requested GitHub route so wrong aliases and anonymous auth leakage fail.
  vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'github.com' && url.hostname !== 'api.github.com')
      throw new Error('Unexpected external request in TEST transport');
    return realFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
  });
  try {
    await test(requests);
  } finally {
    vi.unstubAllGlobals();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

async function verifyCommandExit(tag: string, expected: number, message?: RegExp): Promise<void> {
  requirePosixGhFixture();
  const previousArgs = process.argv;
  const previousExit = process.exitCode;
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  process.argv = [
    previousArgs[0] ?? 'node',
    'verify-updater-release.ts',
    '--state',
    'published',
    '--repository',
    repository,
    '--release-tag',
    tag,
  ];
  process.exitCode = undefined;
  try {
    releaseMain('verify');
    await vi.waitFor(() => expect(process.exitCode).toBe(expected));
    expect(stderr).toHaveBeenCalled();
    if (message)
      expect(stderr.mock.calls.map(([details]) => String(details)).join('')).toMatch(message);
  } finally {
    process.argv = previousArgs;
    process.exitCode = previousExit;
    stderr.mockRestore();
  }
}

describe.skipIf(process.platform === 'win32')(
  'anonymous HTTP adapter and verification CLI failure contract',
  () => {
    const endpoints = [
      { kind: 'release', path: `/repos/${repository}/releases/tags/v2.17.2` },
      { kind: 'latest API', path: `/repos/${repository}/releases/latest` },
      { kind: 'tag asset', path: `/${repository}/releases/download/v2.17.2/latest.yml` },
      { kind: 'latest asset', path: `/${repository}/releases/latest/download/latest.yml` },
    ];
    it.each(
      endpoints.flatMap((endpoint) =>
        [502, 503, 408, 404, 401, 403, 429].map((status) => ({ ...endpoint, status }))
      )
    )(
      'preserves $kind HTTP $status through the actual adapter to CLI retry/permanent exit',
      async ({ kind, path: pathname, status }) => {
        const store = manifestlessFull('13.0', '22.0.0');
        const target = await store.release(repository, 'v2.17.2');
        await anonymousHttp(target, pathname, status, async (requests) => {
          await releaseTransport(
            {
              tagResponse: target,
              listed: [],
              byId: target,
              assetPages: [target.assets],
              assetBytes: store.bytes,
            },
            () =>
              verifyCommandExit(
                target.tag_name,
                status >= 500 ||
                  status === 408 ||
                  status === 429 ||
                  (kind === 'release' && status === 404)
                  ? 75
                  : 1
              )
          );
          const port = new GitHubReleasePort();
          let failed: Promise<void>;
          switch (kind) {
            case 'release':
              failed = port.publicRelease(repository, target.tag_name);
              break;
            case 'latest API':
              failed = port.publicLatest(repository, target.tag_name);
              break;
            case 'tag asset':
              failed = port.publicAsset(repository, target.tag_name, 'latest.yml');
              break;
            case 'latest asset':
              failed = port.publicLatestAsset(repository, 'latest.yml');
              break;
            default:
              throw new Error('Unexpected TEST anonymous endpoint');
          }
          await expect(failed).rejects.toMatchObject({ httpStatus: status });
          expect(
            requests.filter((request) => request.path === pathname).length
          ).toBeGreaterThanOrEqual(2);
          expect(requests.every((request) => request.authorization === undefined)).toBe(true);
          if (kind.endsWith('asset'))
            expect(
              requests
                .filter((request) => request.path === pathname)
                .every((request) => request.method === 'HEAD')
            ).toBe(true);
        });
      }
    );
  }
);

// An unbounded fetch (including a stalled JSON body) fails this observable deadline.
// Real Node HTTP is used; only the destination is redirected to TEST localhost.
it('bounds anonymous header and JSON-body stalls and reports HTTP 408 within 40 seconds', async () => {
  const target = await manifestlessFull('13.0', '22.0.0').release(repository, 'v2.17.2');
  const releasePath = `/repos/${repository}/releases/tags/v2.17.2`;
  const latestPath = `/repos/${repository}/releases/latest`;
  await anonymousHttp(
    target,
    '',
    200,
    async (requests) => {
      const started = performance.now();
      const port = new GitHubReleasePort();
      const results = Promise.allSettled([
        port.publicRelease(repository, target.tag_name),
        port.publicLatest(repository, target.tag_name),
      ]);
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([
          results,
          new Promise<never>((_resolve, reject) => {
            watchdog = setTimeout(
              () => reject(new Error('Anonymous requests exceeded 38 seconds')),
              38_000
            );
          }),
        ]);
        expect(performance.now() - started).toBeLessThan(40_000);
        expect(settled).toEqual([
          { status: 'rejected', reason: expect.objectContaining({ httpStatus: 408 }) },
          { status: 'rejected', reason: expect.objectContaining({ httpStatus: 408 }) },
        ]);
        expect(requests).toHaveLength(2);
        expect(requests.map((request) => request.path)).toEqual(
          expect.arrayContaining([latestPath, releasePath])
        );
      } finally {
        clearTimeout(watchdog);
      }
    },
    new Map([
      [releasePath, { stall: 'headers' }],
      [latestPath, { stall: 'body' }],
    ])
  );
}, 45_000);

async function publishedFullManifest(): Promise<TestReleaseStorage> {
  const store = manifestlessFull('13.0', '22.0.0');
  store.releases.get('v2.17.2')!.draft = true;
  const output = await mkdtemp(path.join(tmpdir(), 'TEST-full-propagation-'));
  directories.push(output);
  const { plan } = await prepareDraft(store, {
    repository,
    tag: 'v2.17.2',
    applicationSha: targetSha,
    toolingSha,
    mode: 'full',
    build: { runId: 10, attempt: 1, jobIds: [11, 12, 13, 14, 15] },
    output,
  });
  await stageDraft(store, plan);
  store.releases.get('v2.17.2')!.draft = false;
  return store;
}

it('rejects a manifest alias changed during the final public feed check', async () => {
  const store = await publishedFullManifest();
  const publicLatestAsset = store.publicLatestAsset.bind(store);
  const visibility = vi.spyOn(store, 'publicLatestAsset').mockImplementation(async (repo, name) => {
    await publicLatestAsset(repo, name);
    if (name === 'latest-mac.yml') {
      const alias = store.releases
        .get('v2.17.2')!
        .assets.find((asset) => asset.name === 'Agent.Teams.AI.Setup.exe')!;
      alias.digest = `sha256:${'f'.repeat(64)}`;
    }
  });
  try {
    await expect(verifyPublished(store, repository, 'v2.17.2')).rejects.toThrow(
      'Asset identity/digest changed: Agent.Teams.AI.Setup.exe'
    );
  } finally {
    visibility.mockRestore();
  }
});

describe.skipIf(process.platform === 'win32')('published release propagation identity', () => {
  it.each(['authenticated', 'anonymous'] as const)(
    'retries only the validated frozen previous %s latest ID/tag',
    async (surface) => {
      const store = await publishedFullManifest();
      const target = await store.release(repository, 'v2.17.2');
      const previous = await store.release(repository, 'v2.17.1');
      await anonymousHttp(
        target,
        '',
        200,
        () =>
          releaseTransport(
            {
              tagResponse: target,
              listed: [],
              byId: target,
              assetPages: [target.assets],
              assetBytes: store.bytes,
              latestResponse: surface === 'authenticated' ? previous : target,
            },
            () => verifyCommandExit(target.tag_name, 75)
          ),
        new Map([
          [
            `/repos/${repository}/releases/latest`,
            { release: surface === 'anonymous' ? previous : target },
          ],
        ])
      );
    }
  );
  it.each(
    (['authenticated', 'anonymous'] as const).flatMap((surface) =>
      ['wrong ID', 'wrong tag', 'draft', 'prerelease'].map((failure) => ({ surface, failure }))
    )
  )('rejects $surface previous latest with $failure as permanent', async ({ surface, failure }) => {
    const store = await publishedFullManifest();
    const target = await store.release(repository, 'v2.17.2');
    const previous = await store.release(repository, 'v2.17.1');
    if (failure === 'wrong ID') previous.id = 99;
    if (failure === 'wrong tag') previous.tag_name = 'v2.17.0';
    if (failure === 'draft') previous.draft = true;
    if (failure === 'prerelease') previous.prerelease = true;
    await anonymousHttp(
      target,
      '',
      200,
      () =>
        releaseTransport(
          {
            tagResponse: target,
            listed: [],
            byId: target,
            assetPages: [target.assets],
            assetBytes: store.bytes,
            latestResponse: surface === 'authenticated' ? previous : target,
          },
          () => verifyCommandExit(target.tag_name, 1)
        ),
      new Map([
        [
          `/repos/${repository}/releases/latest`,
          { release: surface === 'anonymous' ? previous : target },
        ],
      ])
    );
  });
  it.each(['invalid digest', 'invalid plan'])(
    'does not trust %s even when authenticated latest is the frozen previous release',
    async (failure) => {
      const store = await publishedFullManifest();
      const target = await store.release(repository, 'v2.17.2');
      const previous = await store.release(repository, 'v2.17.1');
      const asset = target.assets.find((candidate) => candidate.name === MANIFEST)!;
      const manifest = JSON.parse(
        store.content(target.tag_name, MANIFEST).toString()
      ) as PlatformManifest;
      if (failure === 'invalid digest') manifest.inputDigest = 'f'.repeat(64);
      else {
        manifest.input.macProductMinimum = '14.0';
        manifest.inputDigest = digest(canonical(manifest.input));
      }
      const bytes = Buffer.from(JSON.stringify(manifest));
      store.bytes.set(asset.id, bytes);
      asset.size = bytes.length;
      asset.digest = `sha256:${digest(bytes)}`;
      await releaseTransport(
        {
          tagResponse: target,
          listed: [],
          byId: target,
          assetPages: [target.assets],
          assetBytes: store.bytes,
          latestResponse: previous,
        },
        () =>
          verifyCommandExit(
            target.tag_name,
            1,
            failure === 'invalid digest'
              ? /Invalid platform manifest/
              : /Unsupported macOS product minimum/
          )
      );
    }
  );
  it('keeps a manifestless previous latest permanent because it has no trusted frozen baseline', async () => {
    const store = manifestlessFull('13.0', '22.0.0');
    const target = await store.release(repository, 'v2.17.2');
    const previous = await store.release(repository, 'v2.17.1');
    await releaseTransport(
      {
        tagResponse: target,
        listed: [],
        byId: target,
        assetPages: [target.assets],
        assetBytes: store.bytes,
        latestResponse: previous,
      },
      () => verifyCommandExit(target.tag_name, 1)
    );
  });
  it('leaves published source 404 visibility permanent', async () => {
    const target = await manifestlessFull('13.0', '22.0.0').release(repository, 'v2.17.2');
    const sourcePath = `/repos/${repository}/releases/tags/v2.17.1`;
    await anonymousHttp(target, sourcePath, 404, async () => {
      const port = new GitHubReleasePort();
      await expect(port.publicRelease(repository, 'v2.17.1')).rejects.toMatchObject({
        httpStatus: 404,
      });
    });
  });
});

describe.skipIf(process.platform === 'win32')('immutable release upload transport', () => {
  it('posts exact input bytes to frozen numeric release ID without resolving a tag or clobbering', async () => {
    requirePosixGhFixture();
    const directory = await mkdtemp(path.join(tmpdir(), 'TEST-release-upload-'));
    directories.push(directory);
    await writeFile(
      path.join(directory, 'gh'),
      `#!/bin/sh
set -eu
fixture_dir=$(dirname "$0")
printf '%s\\n' "$@" > "$fixture_dir/arguments.txt"
while [ "$#" -gt 0 ]; do
  if [ "$1" = --input ]; then cat "$2" > "$fixture_dir/uploaded.bin"; break; fi
  shift
done
printf '{}'
`
    );
    await chmod(path.join(directory, 'gh'), 0o755);
    const file = path.join(directory, 'feed proof + test.yml');
    const bytes = Buffer.from('real upload payload\n');
    await writeFile(file, bytes);
    vi.stubEnv('PATH', `${directory}${path.delimiter}${process.env.PATH ?? ''}`);
    try {
      await new GitHubReleasePort().upload(repository, 2, file);
      expect(
        (await readFile(path.join(directory, 'arguments.txt'), 'utf8')).trim().split('\n')
      ).toEqual([
        'api',
        'https://uploads.github.com/repos/777genius/agent-teams-ai/releases/2/assets?name=feed%20proof%20%2B%20test.yml',
        '--hostname',
        'github.com',
        '--method',
        'POST',
        '-H',
        'Content-Type: application/octet-stream',
        '--input',
        file,
      ]);
      expect(await readFile(path.join(directory, 'uploaded.bin'))).toEqual(bytes);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

it('refuses a POSIX gh fixture on Windows before invoking its adapter callback', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) throw new Error('Missing process platform descriptor');
  const invoke = vi.fn();
  const target = await new TestReleaseStorage().release(repository, 'v2.17.2');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    await expect(
      releaseTransport(
        { tagResponse: target, listed: [], byId: target, assetPages: [target.assets] },
        () => {
          invoke();
          return Promise.resolve();
        }
      )
    ).rejects.toThrow('POSIX gh fixtures must not resolve real gh.exe on Windows');
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});

it('follows the latest download redirect and preserves failure from its destination', async () => {
  const target = await manifestlessFull('13.0', '22.0.0').release(repository, 'v2.17.2');
  const alias = `/${repository}/releases/latest/download/latest.yml`;
  const destination = `/${repository}/releases/download/v2.17.2/latest.yml`;
  await anonymousHttp(target, destination, 503, async (requests) => {
    await expect(
      new GitHubReleasePort().publicLatestAsset(repository, 'latest.yml')
    ).rejects.toMatchObject({ httpStatus: 503 });
    expect(requests.map((request) => [request.path, request.method])).toEqual([
      [alias, 'HEAD'],
      [destination, 'HEAD'],
    ]);
  });
});

async function buildProducerTransport(
  run: GitHubBuildRun,
  mode: Mode,
  test: (verify: () => Promise<void>, calls: () => Promise<string[]>) => Promise<void>
): Promise<void> {
  requirePosixGhFixture();
  const directory = await mkdtemp(path.join(tmpdir(), 'TEST-build-producer-'));
  directories.push(directory);
  const jobs = [
    { id: 11, run_id: 10, conclusion: 'success', name: 'release-win x64' },
    { id: 12, run_id: 10, conclusion: 'success', name: 'release-win arm64' },
    { id: 13, run_id: 10, conclusion: 'success', name: 'release-linux x64' },
  ];
  if (mode === 'full')
    jobs.push(
      { id: 14, run_id: 10, conclusion: 'success', name: 'release-mac x64' },
      { id: 15, run_id: 10, conclusion: 'success', name: 'release-mac arm64' }
    );
  await writeFile(
    path.join(directory, 'gh'),
    `#!/bin/sh
set -eu
fixture_dir=$(dirname "$0")
[ "$1" = api ]
printf '%s\\n' "$2" >> "$fixture_dir/calls.txt"
case "$2" in
  */actions/runs/10) cat "$fixture_dir/run.json" ;;
  */actions/runs/10/attempts/1/jobs\\?per_page=100) cat "$fixture_dir/jobs.json" ;;
  *) exit 2 ;;
esac
`
  );
  await chmod(path.join(directory, 'gh'), 0o755);
  await writeFile(path.join(directory, 'run.json'), JSON.stringify(run));
  await writeFile(path.join(directory, 'jobs.json'), JSON.stringify([{ jobs }]));
  const proof: BuildProof = { runId: 10, attempt: 1, jobIds: jobs.map((job) => job.id) };
  vi.stubEnv('PATH', `${directory}${path.delimiter}${process.env.PATH ?? ''}`);
  try {
    await test(
      () => new GitHubReleasePort().verifyBuild(repository, targetSha, proof, mode),
      async () => (await readFile(path.join(directory, 'calls.txt'), 'utf8')).trim().split('\n')
    );
  } finally {
    vi.unstubAllEnvs();
  }
}

describe.skipIf(process.platform === 'win32')('trusted build workflow producer transport', () => {
  const releaseWorkflow = '.github/workflows/release.yml';
  const partialWorkflow = '.github/workflows/build-linux-windows-draft.yml';
  const run = { head_sha: targetSha, run_attempt: 1 };
  it.each<{ path: string; event: string; mode: Mode }>([
    { path: releaseWorkflow, event: 'push', mode: 'carry-mac' },
    { path: releaseWorkflow, event: 'workflow_dispatch', mode: 'full' },
    { path: partialWorkflow, event: 'workflow_dispatch', mode: 'carry-mac' },
  ])(
    'accepts reviewed $path / $event for $mode with successful exact-attempt jobs',
    async ({ path: workflow, event, mode }) => {
      await buildProducerTransport(
        { ...run, path: workflow, event },
        mode,
        async (verify, calls) => {
          await expect(verify()).resolves.toBeUndefined();
          expect(await calls()).toEqual([
            `repos/${repository}/actions/runs/10`,
            `repos/${repository}/actions/runs/10/attempts/1/jobs?per_page=100`,
          ]);
        }
      );
    }
  );
  it.each<{ failure: string; path: string; event: string; mode: Mode }>([
    {
      failure: 'unrelated workflow',
      path: '.github/workflows/spoof-build.yml',
      event: 'workflow_dispatch',
      mode: 'carry-mac',
    },
    { failure: 'missing path', path: '', event: 'workflow_dispatch', mode: 'carry-mac' },
    {
      failure: 'noncanonical path suffix',
      path: `${releaseWorkflow}@refs/heads/main`,
      event: 'workflow_dispatch',
      mode: 'carry-mac',
    },
    {
      failure: 'pull request release producer',
      path: releaseWorkflow,
      event: 'pull_request',
      mode: 'carry-mac',
    },
    {
      failure: 'nested workflow release producer',
      path: releaseWorkflow,
      event: 'workflow_run',
      mode: 'carry-mac',
    },
    { failure: 'push partial producer', path: partialWorkflow, event: 'push', mode: 'carry-mac' },
    {
      failure: 'pull request partial producer',
      path: partialWorkflow,
      event: 'pull_request',
      mode: 'carry-mac',
    },
    {
      failure: 'partial producer used for full release',
      path: partialWorkflow,
      event: 'workflow_dispatch',
      mode: 'full',
    },
  ])(
    'rejects $failure before reading/accepting successful similarly named platform jobs',
    async ({ path: workflow, event, mode }) => {
      await buildProducerTransport(
        { ...run, path: workflow, event },
        mode,
        async (verify, calls) => {
          await expect(verify()).rejects.toThrow(
            'Build producer workflow/event/mode is not trusted'
          );
          expect(await calls()).toEqual([`repos/${repository}/actions/runs/10`]);
        }
      );
    }
  );
});

class TestPublicationStorage extends TestReleaseStorage implements PublicationPort {
  readonly visibilityWrites: boolean[] = [];
  lostVisibilityResponse = false;
  afterVisibility: ((draft: boolean) => void) | null = null;
  releaseById(_repository: string, id: number): Promise<Release> {
    const release = [...this.releases.values()].find((value) => value.id === id);
    if (!release) return Promise.reject(new Error('Numeric target missing'));
    return Promise.resolve(structuredClone(release));
  }
  setVisibility(
    _repository: string,
    target: StagePlan['input']['target'],
    draft: boolean
  ): Promise<void> {
    const release = this.releases.get(target.tag)!;
    expect(release.id).toBe(target.id);
    expect(release.target_commitish).toBe(target.applicationSha);
    this.visibilityWrites.push(draft);
    release.draft = draft;
    this.afterVisibility?.(draft);
    if (this.lostVisibilityResponse) {
      this.lostVisibilityResponse = false;
      return Promise.reject(new Error('Accepted visibility write but response lost'));
    }
    return Promise.resolve();
  }
}
async function publicationFixture() {
  const store = new TestPublicationStorage();
  const { plan, planDigest } = await prepared(store);
  await stageDraft(store, plan);
  const manifest = manifestFor(plan);
  const evidence: NativeEvidence = {
    schemaVersion: 1,
    reference: {
      repository,
      runId: 20,
      runAttempt: 1,
      jobId: 21,
      artifactId: 22,
      artifactName: 'mac-source-signature-evidence-20-1',
      artifactSha256: 'a'.repeat(64),
      toolingSha,
      inputDigest: manifest.inputDigest,
    },
    assets: platformNames('2.17.1').mac.map((name) => {
      const o = plan.input.originals.find((p) => p.name === name)!;
      return {
        assetId: o.assetId,
        sha256: o.sha256,
        version: '2.17.1',
        architecture: name.includes('-arm64') ? 'arm64' : 'x64',
        teamIdentifier: '6C84CW694S',
        productMinimum: '12.0',
        commands: [
          'codesign --verify --deep --strict TEST.app',
          'spctl --assess TEST.app',
          'xcrun stapler validate TEST.app',
          'lipo -archs TEST.app/executable',
          'plutil CFBundleShortVersionString TEST.app/Info.plist',
          'plutil LSMinimumSystemVersion TEST.app/Info.plist',
        ].map((command) => ({ command, exitCode: 0, outputSha256: 'b'.repeat(64) })),
      };
    }),
  };
  store.nativeArtifact = {
    schemaVersion: 1,
    inputDigest: manifest.inputDigest,
    toolingSha,
    sourceTag: 'v2.17.1',
    sourceApplicationSha: sourceSha,
    assets: evidence.assets,
  };
  store.add('v2.17.2', MAC_EVIDENCE, Buffer.from(canonical(evidence)));

  store.add(
    'v2.17.2',
    'build-provenance-10-1.json',
    Buffer.from(
      canonical({
        schemaVersion: 1,
        applicationSha: targetSha,
        tag: 'v2.17.2',
        runId: 10,
        attempt: 1,
        jobs: [11, 12, 13].map((id) => ({ id, conclusion: 'success', run_id: 10 })),
      })
    )
  );
  // The independent native adapter has its own forged/stale/outcome contract tests.
  // These cases isolate publication ordering and actual persisted release effects.
  const native = vi.spyOn(nativeReadiness, 'verifyNativeReadiness').mockResolvedValue(undefined);
  const port = {} as NativeReadinessPort;
  const receipt = {} as NativeReadinessReceipt;
  return { store, plan, planDigest, native, port, receipt };
}

describe('carried publication effects and reconciliation', () => {
  afterEach(() => vi.restoreAllMocks());
  it('proves complete bytes and signatures without a visibility write in readiness mode', async () => {
    const f = await publicationFixture();
    const result = await verifyCarryReadiness(f.store, f.port, f.plan, f.planDigest, f.receipt);
    expect(result.phase).toBe('ready');
    expect(result.target.id).toBe(2);
    expect(f.native).toHaveBeenCalledOnce();
    expect(f.store.visibilityWrites).toEqual([]);
    expect(f.store.releases.get('v2.17.2')!.draft).toBe(true);
  });
  it('never publishes after rejected native readiness or unexpected inventory', async () => {
    const f = await publicationFixture();
    f.native.mockRejectedValueOnce(new Error('Native outcome stale'));
    await expect(
      publishCarriedRelease(f.store, f.port, f.plan, f.planDigest, f.receipt)
    ).rejects.toThrow('stale');
    expect(f.store.visibilityWrites).toEqual([]);
    f.store.add('v2.17.2', 'foreign.exe', Buffer.from('unreviewed'));
    await expect(
      publishCarriedRelease(f.store, f.port, f.plan, f.planDigest, f.receipt)
    ).rejects.toThrow('inventory');
    expect(f.store.visibilityWrites).toEqual([]);
  });
  it('reconciles an accepted publication with a lost response without another PATCH', async () => {
    const f = await publicationFixture();
    f.store.lostVisibilityResponse = true;
    const result = await publishCarriedRelease(f.store, f.port, f.plan, f.planDigest, f.receipt);
    expect(result.phase).toBe('published');
    expect(f.store.visibilityWrites).toEqual([false]);
    expect(f.store.releases.get('v2.17.2')!.draft).toBe(false);
  });
  it('rejects inventory added during the final origin read before any visibility write', async () => {
    const f = await publicationFixture();
    const numericRead = f.store.releaseById.bind(f.store);
    let reads = 0;
    vi.spyOn(f.store, 'releaseById').mockImplementation((repo, id) => {
      reads++;
      return numericRead(repo, id);
    });
    const originRead = f.store.release.bind(f.store);
    let changed = false;
    vi.spyOn(f.store, 'release').mockImplementation((repo, tag) => {
      if (reads >= 2 && tag === 'v2.17.2' && !changed) {
        changed = true;
        f.store.add(tag, 'foreign-extra.exe', Buffer.from('unreviewed'));
      }
      return originRead(repo, tag);
    });
    await expect(
      publishCarriedRelease(f.store, f.port, f.plan, f.planDigest, f.receipt)
    ).rejects.toThrow('final origin');
    expect(changed).toBe(true);
    expect(f.store.visibilityWrites).toEqual([]);
  });
  it('retries a transient numeric read after publication without another visibility write', async () => {
    const f = await publicationFixture();
    const read = f.store.releaseById.bind(f.store);
    let failed = false;
    vi.spyOn(f.store, 'releaseById').mockImplementation((repo, id) => {
      if (f.store.visibilityWrites.length && !failed) {
        failed = true;
        return Promise.reject(new Error('Temporary numeric read failure'));
      }
      return read(repo, id);
    });
    const result = await publishCarriedRelease(f.store, f.port, f.plan, f.planDigest, f.receipt);
    expect(failed).toBe(true);
    expect(result.phase).toBe('published');
    expect(f.store.visibilityWrites).toEqual([false]);
  });
  it('retries transient anonymous latest reads without redrafting an intact release', async () => {
    const f = await publicationFixture();
    const read = f.store.publicLatestAsset.bind(f.store);
    let failed = false;
    vi.spyOn(f.store, 'publicLatestAsset').mockImplementation((repo, name) => {
      if (f.store.visibilityWrites.length && !failed) {
        failed = true;
        return Promise.reject(new ReleaseHttpError('Latest has not propagated', 408));
      }
      return read(repo, name);
    });
    const result = await publishCarriedRelease(f.store, f.port, f.plan, f.planDigest, f.receipt);
    expect(failed).toBe(true);
    expect(result.phase).toBe('published');
    expect(f.store.visibilityWrites).toEqual([false]);
  }, 15_000);
  it('redrafts the same ID after public availability fails, including a lost compensation response', async () => {
    const f = await publicationFixture();
    f.store.missingLatestFeed = 'latest-linux.yml';
    f.store.afterVisibility = (draft) => {
      if (draft) f.store.lostVisibilityResponse = true;
    };
    await expect(
      publishCarriedRelease(f.store, f.port, f.plan, f.planDigest, f.receipt)
    ).rejects.toThrow('returned to draft');
    expect(f.store.visibilityWrites).toEqual([false, true]);
    expect(f.store.releases.get('v2.17.2')!.id).toBe(2);
    expect(f.store.releases.get('v2.17.2')!.draft).toBe(true);
  });
  it('contains a corrupted published inventory without requiring the corrupt asset proof to pass', async () => {
    const f = await publicationFixture();
    f.store.afterVisibility = (draft) => {
      if (!draft) f.store.releases.get('v2.17.2')!.assets[0]!.digest = `sha256:${'f'.repeat(64)}`;
    };
    await expect(
      publishCarriedRelease(f.store, f.port, f.plan, f.planDigest, f.receipt)
    ).rejects.toThrow('returned to draft');
    expect(f.store.visibilityWrites).toEqual([false, true]);
    expect(f.store.releases.get('v2.17.2')!.draft).toBe(true);
  });
});
