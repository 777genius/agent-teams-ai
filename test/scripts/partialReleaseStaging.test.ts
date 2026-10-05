import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
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
  publicLatest(_repo: string, tag: string): Promise<void> {
    if (tag !== 'v2.17.2' || this.releases.get(tag)!.draft) throw new Error('Not public latest');
    return Promise.resolve();
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
        artifactName: 'mac-source-signatures',
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
});
