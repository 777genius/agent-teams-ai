import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import {
  MAC_EVIDENCE,
  MANIFEST,
  canonical,
  digest,
  macAliases,
  manifestFor,
  platformNames,
  renderFeed,
  textProof,
} from '../../scripts/ci/release/contract.js';
import type {
  Asset,
  BuildProof,
  NativeEvidence,
  NativeEvidenceReference,
  NativeProbeArtifact,
  Release,
  ReleasePort,
} from '../../scripts/ci/release/contract.js';
import { GitHubReleasePort, validateNativeProducer } from '../../scripts/ci/release/github.js';
import type { NativeProducerMetadata } from '../../scripts/ci/release/github.js';
import { verifyPublished } from '../../scripts/ci/release/validation.js';

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
  minimum(): Promise<string> {
    return Promise.resolve('12.0');
  }
  async download(_repo: string, asset: Asset, destination: string): Promise<void> {
    await writeFile(destination, this.bytes.get(asset.id)!);
  }
  async upload(_repo: string, tag: string, file: string): Promise<void> {
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
    await expect(verifyPublished(store, repository, 'v2.17.2')).rejects.toThrow(MAC_EVIDENCE);
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
}
async function releaseTransport(
  fixture: ReleaseTransportFixture,
  test: (port: GitHubReleasePort, calls: () => Promise<string[]>) => Promise<void>
): Promise<void> {
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
  vi.stubEnv('PATH', `${directory}${path.delimiter}${process.env.PATH ?? ''}`);
  try {
    await test(new GitHubReleasePort(), async () =>
      (await readFile(path.join(directory, 'calls.txt'), 'utf8')).trim().split('\n')
    );
  } finally {
    vi.unstubAllEnvs();
  }
}

describe('authenticated draft release transport', () => {
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
    'propagates HTTP %s without treating auth/rate/transport failure as draft absence',
    async (status) => {
      const draft = await new TestReleaseStorage().release(repository, 'v2.17.2');
      await releaseTransport(
        { tagStatus: status, listed: [[draft]], byId: draft, assetPages: [draft.assets] },
        async (port, calls) => {
          await expect(port.release(repository, 'v2.17.2')).rejects.toThrow(`HTTP ${status}`);
          expect(await calls()).toEqual([`repos/${repository}/releases/tags/v2.17.2`]);
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
