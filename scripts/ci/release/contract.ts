import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { parse } from 'yaml';

export const MANIFEST = 'release-platform-manifest.json';
export const MAC_EVIDENCE = 'release-source-mac-evidence.json';
export type Mode = 'full' | 'carry-mac';
export interface Asset {
  id: number;
  name: string;
  size: number;
  digest: string;
}
export interface Release {
  id: number;
  tag_name: string;
  target_commitish: string;
  created_at: string;
  draft: boolean;
  prerelease: boolean;
  name: string | null;
  body: string | null;
  assets: Asset[];
}
export interface FileProof {
  name: string;
  size: number;
  sha256: string;
  sha512: string;
}
export interface Original extends FileProof {
  assetId: number;
  releaseId: number;
  tag: string;
}
export interface Snapshot {
  id: number;
  tag: string;
  applicationSha: string;
  createdAt: string;
  name: string | null;
  body: string | null;
}
export interface BuildProof {
  runId: number;
  attempt: number;
  jobIds: number[];
}
export interface StageInput {
  repository: string;
  mode: Mode;
  toolingSha: string;
  target: Snapshot;
  latest: { id: number; tag: string };
  originals: Original[];
  macSource: { release: Snapshot; productMinimum: string } | null;
  build: BuildProof;
  macProductMinimum: string;
}
export interface StagePlan {
  schemaVersion: 1;
  input: StageInput;
  feeds: Record<string, string>;
  aliases: Record<string, string>;
  outputs: FileProof[];
}
export interface PlatformManifest {
  schemaVersion: 1;
  phase: 'assembled';
  input: StageInput;
  inputDigest: string;
  versions: { windows: string; linux: string; mac: string };
  feeds: FileProof[];
  aliases: Record<string, string>;
  outputs: FileProof[];
}
export interface NativeEvidenceReference {
  repository: string;
  runId: number;
  runAttempt: number;
  jobId: number;
  artifactId: number;
  artifactName: string;
  artifactSha256: string;
  toolingSha: string;
  inputDigest: string;
}
export interface NativeProbe {
  assetId: number;
  sha256: string;
  version: string;
  architecture: 'arm64' | 'x64';
  teamIdentifier: string;
  productMinimum: '12.0';
  commands: { command: string; exitCode: number; outputSha256: string }[];
}
export interface NativeEvidence {
  schemaVersion: 1;
  reference: NativeEvidenceReference;
  assets: NativeProbe[];
}
// Producer content excludes its eventual artifact receipt/digest (no self-hash cycle).
export interface NativeProbeArtifact {
  schemaVersion: 1;
  inputDigest: string;
  toolingSha: string;
  sourceTag: string;
  sourceApplicationSha: string;
  assets: NativeProbe[];
}
export interface ReleasePort {
  release(repository: string, tag: string): Promise<Release>;
  tagSha(repository: string, tag: string): Promise<string>;
  latest(repository: string): Promise<Release>;
  minimum(repository: string, sha: string): Promise<string>;
  download(repository: string, asset: Asset, destination: string): Promise<void>;
  upload(repository: string, tag: string, file: string): Promise<void>;
  verifyBuild(repository: string, sha: string, proof: BuildProof, mode: Mode): Promise<void>;
  verifyNative(reference: NativeEvidenceReference): Promise<NativeProbeArtifact>;
  publicAsset(repository: string, tag: string, name: string): Promise<void>;
  publicRelease(repository: string, tag: string): Promise<void>;
  publicLatest(repository: string, tag: string): Promise<void>;
}

export function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function basename(name: unknown): asserts name is string {
  requireThat(
    typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name),
    `Unsafe asset name: ${String(name)}`
  );
}
export function compareNames(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => compareNames(a, b));
    const contents = entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',');
    return `{${contents}}`;
  }
  requireThat(
    value === null || ['string', 'number', 'boolean'].includes(typeof value),
    'Unsupported value in immutable plan'
  );
  return JSON.stringify(value);
}
export function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
export function textProof(name: string, bytes: string | Buffer): FileProof {
  return {
    name,
    size: Buffer.byteLength(bytes),
    sha256: digest(bytes),
    sha512: createHash('sha512').update(bytes).digest('base64'),
  };
}
export async function fileProof(file: string, name: string): Promise<FileProof> {
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  for await (const chunk of createReadStream(file)) {
    requireThat(Buffer.isBuffer(chunk), 'Expected binary hash stream');
    sha256.update(chunk);
    sha512.update(chunk);
  }
  return {
    name,
    size: (await stat(file)).size,
    sha256: sha256.digest('hex'),
    sha512: sha512.digest('base64'),
  };
}
export function sameProof(actual: FileProof, expected: FileProof): void {
  requireThat(
    actual.name === expected.name &&
      actual.size === expected.size &&
      actual.sha256 === expected.sha256 &&
      actual.sha512 === expected.sha512,
    `Byte proof mismatch: ${expected.name}`
  );
}
export function version(tag: string): string {
  requireThat(/^v\d+\.\d+\.\d+$/.test(tag), `Stable semantic tag required: ${tag}`);
  return tag.slice(1);
}
export function older(source: string, target: string): boolean {
  const a = version(source).split('.').map(Number);
  const b = version(target).split('.').map(Number);
  for (const [i, left] of a.entries()) {
    const right = b.at(i);
    requireThat(typeof right === 'number', 'Invalid version component');
    if (left !== right) return left < right;
  }
  return false;
}
export function releaseSnapshot(release: Release, sha: string): Snapshot {
  return {
    id: release.id,
    tag: release.tag_name,
    applicationSha: sha,
    createdAt: release.created_at,
    name: release.name,
    body: release.body,
  };
}
export function checkRelease(release: Release, snapshot?: Snapshot, draft?: boolean): void {
  version(release.tag_name);
  requireThat(
    !release.prerelease &&
      !/\[(skip-updater|test-release|internal-release|no-autoupdate)\]/i.test(
        `${release.name}\n${release.body}`
      ),
    'Release is prerelease or has an updater skip marker'
  );
  if (draft !== undefined)
    requireThat(release.draft === draft, `Unexpected release visibility: ${release.tag_name}`);
  if (snapshot)
    requireThat(
      canonical(releaseSnapshot(release, snapshot.applicationSha)) === canonical(snapshot) &&
        release.target_commitish === snapshot.applicationSha,
      `Release metadata changed: ${snapshot.tag}`
    );
  const names = new Set<string>();
  for (const asset of release.assets) {
    basename(asset.name);
    requireThat(!names.has(asset.name), `Duplicate asset: ${asset.name}`);
    names.add(asset.name);
  }
}
export function assetByName(release: Release, name: string): Asset {
  const asset = release.assets.find((item) => item.name === name);
  requireThat(asset, `Missing asset: ${release.tag_name}/${name}`);
  requireThat(
    Number.isSafeInteger(asset.id) &&
      asset.id > 0 &&
      Number.isSafeInteger(asset.size) &&
      asset.size > 0 &&
      /^sha256:[a-f0-9]{64}$/.test(asset.digest),
    `Invalid GitHub byte proof: ${name}`
  );
  return asset;
}
export function checkMetadata(asset: Asset, expected: FileProof, assetId?: number): void {
  requireThat(
    asset.size === expected.size &&
      asset.digest === `sha256:${expected.sha256}` &&
      (assetId === undefined || asset.id === assetId),
    `Asset identity/digest changed: ${expected.name}`
  );
}
export function platformNames(v: string): {
  windows: [string, string];
  linux: [string, string, string, string];
  mac: [string, string, string, string];
} {
  return {
    windows: [`Agent.Teams.AI.Setup.${v}.exe`, `Agent.Teams.AI.Setup.${v}-arm64.exe`],
    linux: [
      `Agent.Teams.AI-${v}.AppImage`,
      `agent-teams-ai_${v}_amd64.deb`,
      `agent-teams-ai-${v}.x86_64.rpm`,
      `agent-teams-ai-${v}.pacman`,
    ],
    mac: [
      `Agent.Teams.AI-${v}-arm64-mac.zip`,
      `Agent.Teams.AI-${v}-arm64.dmg`,
      `Agent.Teams.AI-${v}-x64-mac.zip`,
      `Agent.Teams.AI-${v}-x64.dmg`,
    ],
  };
}
export function aliases(target: string, mac: string): Record<string, string> {
  const t = platformNames(target);
  const m = platformNames(mac);
  return {
    'Agent.Teams.AI.Setup.exe': t.windows[0],
    'Agent.Teams.AI.Setup-arm64.exe': t.windows[1],
    'Claude-Agent-Teams-UI-Setup.exe': t.windows[0],
    [`Claude.Agent.Teams.UI.Setup.${target}.exe`]: t.windows[0],
    'Agent.Teams.AI.AppImage': t.linux[0],
    'agent-teams-ai-amd64.deb': t.linux[1],
    'agent-teams-ai-x86_64.rpm': t.linux[2],
    'agent-teams-ai.pacman': t.linux[3],
    'Claude-Agent-Teams-UI.AppImage': t.linux[0],
    'Claude-Agent-Teams-UI-amd64.deb': t.linux[1],
    'Claude-Agent-Teams-UI-x86_64.rpm': t.linux[2],
    'Claude-Agent-Teams-UI.pacman': t.linux[3],
    [`Claude.Agent.Teams.UI-${target}.AppImage`]: t.linux[0],
    'Agent.Teams.AI-arm64.dmg': m.mac[1],
    'Agent.Teams.AI-x64.dmg': m.mac[3],
    'Claude-Agent-Teams-UI-arm64.dmg': m.mac[1],
    'Claude-Agent-Teams-UI-x64.dmg': m.mac[3],
    [`Claude.Agent.Teams.UI-${mac}-arm64-mac.zip`]: m.mac[0],
    [`Claude.Agent.Teams.UI-${mac}-arm64.dmg`]: m.mac[1],
    [`Claude.Agent.Teams.UI-${mac}-mac.zip`]: m.mac[2],
    [`Claude.Agent.Teams.UI-${mac}.dmg`]: m.mac[3],
  };
}
export function renderFeed(v: string, files: FileProof[], date: string, minimum?: string): string {
  const first = files[0];
  requireThat(first, 'Empty updater feed');
  const minimumLine = minimum ? `minimumSystemVersion: ${minimum}\n` : '';
  const entries = files
    .map((f) => `  - url: ${f.name}\n    sha512: ${f.sha512}\n    size: ${f.size}`)
    .join('\n');
  return `version: ${v}\n${minimumLine}files:\n${entries}\npath: ${first.name}\nsha512: ${first.sha512}\nreleaseDate: '${date}'\n`;
}
export function macAliases(v: string): Record<string, string> {
  const mac = platformNames(v).mac;
  return Object.fromEntries(
    Object.entries(aliases(v, v)).filter(([, source]) => mac.includes(source))
  );
}
export function targetMacNames(v: string): string[] {
  return [
    ...platformNames(v).mac,
    ...Object.keys(macAliases(v)).filter((name) => name.includes(v)),
  ];
}
export function validateFeed(raw: string, v: string, expected: FileProof[]): void {
  const feed = parse(raw) as {
    version?: unknown;
    files?: { url: string; size: number; sha512: string }[];
    path?: unknown;
    sha512?: unknown;
  };
  requireThat(
    feed?.version === v && Array.isArray(feed.files) && feed.files.length === expected.length,
    `Invalid updater feed/version: ${v}`
  );
  const names = new Set<string>();
  for (const item of feed.files) {
    basename(item.url);
    requireThat(!names.has(item.url), `Duplicate feed reference: ${item.url}`);
    names.add(item.url);
    const proof = expected.find((p) => p.name === item.url);
    requireThat(proof, `Unknown feed reference: ${item.url}`);
    requireThat(
      item.size === proof.size && item.sha512 === proof.sha512,
      `Feed byte proof mismatch: ${item.url}`
    );
  }
  const first = expected[0];
  requireThat(
    feed.path === first?.name && feed.sha512 === first?.sha512,
    'Invalid compatibility path/hash'
  );
}
export function manifestFor(plan: StagePlan): PlatformManifest {
  const target = version(plan.input.target.tag);
  const mac = version(plan.input.macSource?.release.tag ?? plan.input.target.tag);
  return {
    schemaVersion: 1,
    phase: 'assembled',
    input: plan.input,
    inputDigest: digest(canonical(plan.input)),
    versions: { windows: target, linux: target, mac },
    feeds: Object.entries(plan.feeds)
      .sort(([a], [b]) => compareNames(a, b))
      .map(([name, raw]) => textProof(name, raw)),
    aliases: plan.aliases,
    outputs: plan.outputs,
  };
}
export function checkInput(input: StageInput): void {
  requireThat(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository), 'Invalid repository');
  requireThat(input.mode === 'full' || input.mode === 'carry-mac', 'Unknown release mode');
  requireThat(
    /^[a-f0-9]{40}$/.test(input.toolingSha) && /^[a-f0-9]{40}$/.test(input.target.applicationSha),
    'Exact application/tooling SHA required'
  );
  requireThat(
    Number.isSafeInteger(input.target.id) &&
      input.target.id > 0 &&
      !Number.isNaN(Date.parse(input.target.createdAt)),
    'Invalid target snapshot'
  );
  requireThat(
    Number.isSafeInteger(input.latest.id) && input.latest.id > 0,
    'Invalid captured public latest'
  );
  version(input.latest.tag);
  requireThat(
    input.macProductMinimum === '12.0' || input.macProductMinimum === '13.0',
    'Unsupported macOS product minimum'
  );
  const names = platformNames(version(input.target.tag));
  const required = [...names.windows, ...names.linux, ...names.windows.map((n) => `${n}.blockmap`)];
  if (input.mode === 'carry-mac') {
    requireThat(
      input.macSource && older(input.macSource.release.tag, input.target.tag),
      'Pinned older Mac source required'
    );
    requireThat(
      input.repository === '777genius/agent-teams-ai',
      'Carry source must use canonical repository'
    );
    requireThat(
      /^[a-f0-9]{40}$/.test(input.macSource.release.applicationSha) &&
        input.macSource.productMinimum === '12.0' &&
        input.macProductMinimum === '12.0',
      'Invalid source application metadata'
    );
    required.push(
      ...platformNames(version(input.macSource.release.tag)).mac,
      ...Object.keys(macAliases(version(input.macSource.release.tag))),
      'latest-mac.yml'
    );
  } else {
    requireThat(input.macSource === null, 'Full release cannot carry Mac');
    required.push(...names.mac);
  }
  requireThat(
    input.originals.length === required.length &&
      new Set(input.originals.map((f) => f.name)).size === required.length,
    'Unexpected original asset set'
  );
  for (const name of required) {
    const original = input.originals.find((f) => f.name === name);
    requireThat(original, `Missing immutable input: ${name}`);
    basename(original.name);
    requireThat(
      /^[a-f0-9]{64}$/.test(original.sha256) &&
        /^[A-Za-z0-9+/]{86}==$/.test(original.sha512) &&
        Number.isSafeInteger(original.size) &&
        original.size > 0 &&
        Number.isSafeInteger(original.assetId) &&
        original.assetId > 0,
      `Invalid original byte proof: ${name}`
    );
    const source =
      input.mode === 'carry-mac' &&
      (name === 'latest-mac.yml' ||
        platformNames(version(input.macSource!.release.tag)).mac.includes(name) ||
        Object.hasOwn(macAliases(version(input.macSource!.release.tag)), name))
        ? input.macSource!.release
        : input.target;
    requireThat(
      original.releaseId === source.id && original.tag === source.tag,
      `Wrong original provenance: ${name}`
    );
  }
}
