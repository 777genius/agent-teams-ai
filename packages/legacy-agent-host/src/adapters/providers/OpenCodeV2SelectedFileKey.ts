import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

import { managementDigest as digest } from '../../management/identity.js';
import { canonicalManagementValue, deriveSecretFingerprint, secretFingerprintKdfSchema,
  secretFingerprintsEqual } from '../../management/secretFingerprint.js';
import type { SecretFingerprintKdf } from '../../management/secretFingerprint.js';
import type { BigIntStats } from 'node:fs';
import type { OpenCodeConfigurationKeyOrigin } from './OpenCodeConfigurationSource.js';

const maximum = 64 * 1024, aggregateMaximum = 256 * 1024;
const held = (): never => { throw new Error('OpenCode V2 selected file source unavailable'); };
const text = z.string().min(1).max(8192).refine(value => !/[\0\r\n]/u.test(value));
const absolute = text.refine(value => isAbsolute(value));
const hash = z.string().length(64).regex(/^[a-f0-9]+$/u);
const id = text.max(256);
const originSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: absolute, digest: hash }).strict(),
  z.object({ kind: z.literal('inline'), digest: hash }).strict(),
]);
const descriptorBody = z.object({
  schemaVersion: z.literal(1), sourceDigest: hash, namespaceDigest: hash, authDigest: hash,
  origin: originSchema, providerId: id, modelId: id, cwd: absolute, home: absolute,
  rawKey: z.string().min(1).max(maximum),
  environment: z.array(z.object({ name: id, value: z.string().max(maximum).nullable() }).strict()).max(256),
}).strict();
export const openCodeV2SelectedFileDescriptorSchema = descriptorBody.extend({ digest: hash }).strict();
export type OpenCodeV2SelectedFileDescriptor = z.infer<typeof openCodeV2SelectedFileDescriptorSchema>;
export type OpenCodeV2SelectedFileMode = 'fresh' | 'restore' | 'catalog';
const identity = z.array(z.string().regex(/^-?\d+$/u)).length(8);
const chainSchema = z.array(z.object({
  path: absolute, canonical: absolute, kind: z.enum(['directory', 'link', 'file']),
  identity: z.array(z.string().regex(/^-?\d+$/u)).min(4).max(8), link: text.nullable(),
}).strict()).min(1).max(8192);
const dependencySchema = z.object({
  path: absolute, canonical: absolute, identity, chain: chainSchema, sha256: hash,
}).strict();
type Dependency = z.infer<typeof dependencySchema>;
const witnessSchema = z.object({
  schemaVersion: z.literal(1), descriptorDigest: hash, sourceDigest: hash,
  namespaceDigest: hash, authDigest: hash, providerId: id, modelId: id, cwd: absolute,
  issuer: z.object({ nonce: hash, pid: z.number().int().positive(), integrationId: id, reference: hash }).strict(),
  materializedKeyDigest: hash, scopeDigest: hash,
  dependencies: z.array(dependencySchema).min(1).max(32),
}).strict();
type Witness = z.infer<typeof witnessSchema>;
const metadataSchema = dependencySchema.omit({ sha256: true }).strict();
type FileMetadata = z.infer<typeof metadataSchema>;
type FileObservation = FileMetadata & { bytes: string };
const kdfSchema = secretFingerprintKdfSchema.refine(value => value.salt.length === 32);
const slowProofSchema = z.object({ fingerprintKdf: kdfSchema, fingerprint: hash }).strict();
const protectedWitnessSchema = z.object({
  schemaVersion: z.literal(2), key: slowProofSchema, files: slowProofSchema, scopeDigest: hash,
  dependencies: z.array(metadataSchema).min(1).max(32),
}).strict();
type ProtectedWitness = z.infer<typeof protectedWitnessSchema>;
const requestSchema = z.object({
  method: z.enum(['GET', 'POST']), deadline: z.number().int().positive().safe(),
}).strict();
type FileRequest = z.infer<typeof requestSchema>;
type Issuer = Witness['issuer'];
const liveWitnessSchema = protectedWitnessSchema.extend({
  issuer: witnessSchema.shape.issuer.extend({ pid: z.number().int().positive().safe() }).strict(),
  request: requestSchema, mac: hash,
}).strict();
type LiveWitness = z.infer<typeof liveWitnessSchema>;
const filePolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('protected'), key: kdfSchema, files: kdfSchema, scopeDigest: hash.optional() }).strict(),
  z.object({ kind: z.literal('legacy'), scopeDigest: hash.optional() }).strict(),
]);
export type OpenCodeV2FilePolicy = z.infer<typeof filePolicySchema>;
type OriginalFilePolicy = Readonly<
  { kind: 'protected'; key: SecretFingerprintKdf; files: SecretFingerprintKdf; scopeDigest: string } |
  { kind: 'legacy'; scopeDigest: string }
>;
interface FileAcceptance {
  policy: OpenCodeV2FilePolicy;
  password: string;
  request: FileRequest & { originalScopeDigest?: string };
  original?: AcceptedOpenCodeV2FileKey;
}
export const openCodeV2NativeFileWitnessSchema = z.string().min(1).max(maximum).superRefine((value, context) => {
  try { decode(value); } catch { context.addIssue({ code: 'custom', message: 'Invalid private native source witness' }); }
});

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
const bytesHash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const keyValid = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) &&
  Buffer.byteLength(value) <= maximum && !/[\x00-\x1f\x7f]/u.test(value);
const statIdentity = (value: BigIntStats): string[] => [value.dev, value.ino, value.mode, value.uid,
  value.nlink, value.size, value.mtimeNs, value.ctimeNs].map(item => item.toString());

/** Pure classification precedes either owner. Managed failures must never try the manual bridge. */
export function isOpenCodeV2ManagedFileSpelling(raw: string, home: string): boolean {
  if (!/^\{file:[^{}]+\}$/u.test(raw)) return false;
  const value = raw.slice(6, -1), directory = join(home, '.config', 'opencode', 'agent-teams-credentials');
  return value.startsWith('~/.config/opencode/agent-teams-credentials/') ||
    isAbsolute(value) && (value === directory || value.startsWith(directory + '/') ||
      value.startsWith(directory + '\\'));
}

/** Exact native JSON escaping passes; environment cannot introduce another file expression. */
export function selectedFilePaths(raw: OpenCodeV2SelectedFileDescriptor): readonly string[] {
  const input = JSON.stringify({ apiKey: raw.rawKey }), environment = new Map(raw.environment.map(row => [row.name, row.value]));
  const rawCount = [...raw.rawKey.matchAll(/\{file:/gu)].length;
  if (!rawCount || rawCount > 32 || environment.size !== raw.environment.length ||
      Buffer.byteLength(input) > maximum || raw.rawKey.includes('\0')) return held();
  const names = new Set([...input.matchAll(/\{env:([^}]+)\}/gu)].map(row => row[1]!));
  if (names.size !== environment.size || [...names].some(name => !environment.has(name))) return held();
  const paths = new Set<string>();
  for (const escape of [false, true]) {
    const expanded = JSON.stringify(raw.rawKey).replace(/\{env:([^}]+)\}/gu, (_match, name: string) => {
      const value = environment.get(name) ?? '';
      if (value.includes('{file:') || value.includes('\0')) return held();
      return escape ? JSON.stringify(value).slice(1, -1) : value;
    });
    const slots = [...expanded.matchAll(/\{file:[^}]+\}/gu)];
    if (slots.length !== rawCount) return held();
    for (const slot of slots) {
      const value = slot[0].slice(6, -1), expandedPath = value.startsWith('~/') ? join(raw.home, value.slice(2)) : value;
      const path = isAbsolute(expandedPath) ? expandedPath
        : resolve(raw.origin.kind === 'file' ? dirname(raw.origin.path) : raw.cwd, expandedPath);
      if (!absolute.safeParse(path).success) return held();
      paths.add(path);
    }
  }
  if (paths.size > 32) return held();
  return [...paths];
}

export function parseOpenCodeV2SelectedFileDescriptor(value: unknown): OpenCodeV2SelectedFileDescriptor {
  const parsed = openCodeV2SelectedFileDescriptorSchema.parse(value), { digest: commitment, ...body } = parsed;
  if (Buffer.byteLength(JSON.stringify(parsed)) > maximum || digest(body) !== commitment) return held();
  selectedFilePaths(parsed);
  return freeze(parsed);
}

/** In-memory selected-leaf provenance. It exposes neither a key nor a successful credential digest. */
export class DeferredOpenCodeV2FileKey {
  readonly #namespace: string;
  readonly #owner: (() => boolean) | undefined;
  private constructor(readonly descriptor: OpenCodeV2SelectedFileDescriptor,
    readonly isCurrent: () => boolean, owner?: () => boolean) {
    this.#namespace = descriptor.namespaceDigest; this.#owner = owner; Object.freeze(this);
  }
  static capture(input: {
    sourceDigest: string; namespaceDigest: string; authDigest: string; origin: OpenCodeConfigurationKeyOrigin;
    providerId: string; modelId: string; cwd: string; home: string; environment: Readonly<Record<string, string>>;
    isCurrent(): boolean;
  }): DeferredOpenCodeV2FileKey {
    if (!input.isCurrent() || typeof input.origin.value !== 'string' || !input.origin.value.includes('{file:')) return held();
    const { value: rawKey, ...origin } = input.origin;
    const names = [...new Set([...rawKey.matchAll(/\{env:([^}]+)\}/gu)].map(row => row[1]!))];
    const body = descriptorBody.parse({ schemaVersion: 1, sourceDigest: input.sourceDigest,
      namespaceDigest: input.namespaceDigest, authDigest: input.authDigest, origin,
      providerId: input.providerId, modelId: input.modelId, cwd: input.cwd, home: input.home, rawKey,
      environment: names.map(name => ({ name, value: Object.hasOwn(input.environment, name) ? input.environment[name] : null })),
    });
    const descriptor = parseOpenCodeV2SelectedFileDescriptor({ ...body, digest: digest(body) });
    if (!input.isCurrent()) return held();
    return new DeferredOpenCodeV2FileKey(descriptor, input.isCurrent);
  }
  static bind(value: DeferredOpenCodeV2FileKey, owner: () => boolean): DeferredOpenCodeV2FileKey {
    if (!this.is(value)) return held();
    return new DeferredOpenCodeV2FileKey(value.descriptor, owner, owner);
  }
  static is(value: unknown): value is DeferredOpenCodeV2FileKey {
    return value instanceof DeferredOpenCodeV2FileKey && #namespace in value;
  }
  static accepts(value: unknown, namespace: string, owner: () => boolean): value is DeferredOpenCodeV2FileKey {
    return this.is(value) && value.#namespace === namespace && value.#owner === owner;
  }
}

/** No normalization before OS resolution: a manual symlink followed by '..' keeps its real meaning. */
function locate(path: string, check: () => void) {
  if (!absolute.safeParse(path).success) return held();
  const paths: string[] = [];
  for (let value = path;;) {
    paths.push(value); const parent = dirname(value); if (parent === value) break; value = parent;
  }
  const chain: Dependency['chain'] = [];
  for (const name of paths.reverse()) {
    check(); const entry = lstatSync(name, { bigint: true }), last = name === path;
    if (!entry.isSymbolicLink() && !(last ? entry.isFile() : entry.isDirectory())) return held();
    const canonical = realpathSync(name), link = entry.isSymbolicLink() ? readlinkSync(name) : null;
    if (!absolute.safeParse(canonical).success || link !== null && !text.safeParse(link).success) return held();
    chain.push({ path: name, canonical, link, kind: entry.isSymbolicLink() ? 'link' : last ? 'file' : 'directory',
      identity: entry.isDirectory() ? statIdentity(entry).slice(0, 4) : statIdentity(entry) });
    if (Buffer.byteLength(JSON.stringify(chain)) > maximum) return held();
  }
  check(); const canonical = realpathSync(path), entry = lstatSync(canonical, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > BigInt(maximum)) return held();
  return { canonical, identity: statIdentity(entry), chain };
}

function measure(path: string, check: () => void, consume: (bytes: Buffer) => void): Dependency {
  let fd: number | undefined; const buffer = Buffer.alloc(maximum + 1);
  try {
    const original = locate(path, check);
    check(); fd = openSync(original.canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || digest(statIdentity(before)) !== digest(original.identity)) return held();
    let length = 0;
    while (length < buffer.length) {
      check(); const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break; length += count;
    }
    check(); const after = fstatSync(fd, { bigint: true }), current = locate(path, check);
    if (length > maximum || BigInt(length) !== before.size || digest(statIdentity(after)) !== digest(original.identity) ||
        digest(current) !== digest(original)) return held();
    const bytes = buffer.subarray(0, length), sha256 = bytesHash(bytes);
    consume(bytes); check(); return { path, ...original, sha256 };
  } finally { buffer.fill(0); if (fd !== undefined) closeSync(fd); }
}

const effectiveDigest = (descriptorDigest: string, key: string, dependencies: readonly Dependency[]) =>
  digest({ kind: 'native-selected-file-key-v1', descriptorDigest, materializedKeyDigest: key, dependencies });
const protectedScope = (proof: Omit<ProtectedWitness, 'schemaVersion' | 'scopeDigest'>): string =>
  digest({ domain: 'agent-teams/opencode-selected-file-scope/v2', ...proof });
const descriptorMaterial = (source: OpenCodeV2SelectedFileDescriptor) => {
  const { digest: _commitment, ...body } = source; return body;
};
const metadata = (file: Dependency): FileMetadata => {
  const { sha256: _privateDigest, ...body } = file; return body;
};
function parsedEncoding(encoded: string): { value: unknown; json: string } {
  if (typeof encoded !== 'string' || !encoded || encoded.length > maximum || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return held();
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded) return held();
  const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { value: JSON.parse(json) as unknown, json };
}
function dependencyOrder(dependencies: readonly FileMetadata[]): boolean {
  return dependencies.every((file, index) => index === 0 || dependencies[index - 1]!.path < file.path);
}
function decode(encoded: string): Witness | ProtectedWitness {
  const { value, json } = parsedEncoding(encoded);
  const legacy = witnessSchema.safeParse(value);
  if (legacy.success) {
    const proof = legacy.data;
    if (new Set(proof.dependencies.map(row => row.path)).size !== proof.dependencies.length ||
        effectiveDigest(proof.descriptorDigest, proof.materializedKeyDigest, proof.dependencies) !== proof.scopeDigest) return held();
    return freeze(proof);
  }
  const proof = protectedWitnessSchema.parse(value);
  if (JSON.stringify(proof) !== json || !dependencyOrder(proof.dependencies) ||
      protectedScope({ key: proof.key, files: proof.files, dependencies: proof.dependencies }) !== proof.scopeDigest) return held();
  return freeze(proof);
}
function matchesLegacy(proof: Witness, source: OpenCodeV2SelectedFileDescriptor): boolean {
  return proof.descriptorDigest === source.digest && proof.sourceDigest === source.sourceDigest &&
    proof.namespaceDigest === source.namespaceDigest && proof.authDigest === source.authDigest &&
    proof.providerId === source.providerId && proof.modelId === source.modelId && proof.cwd === source.cwd &&
    proof.dependencies.every(file => selectedFilePaths(source).includes(file.path));
}

export function parseOpenCodeV2FilePolicy(value: unknown, mode: OpenCodeV2SelectedFileMode): OpenCodeV2FilePolicy | undefined {
  if (mode === 'catalog') return value === undefined ? undefined : held();
  const policy = filePolicySchema.parse(value);
  if (policy.kind === 'protected' && mode === 'restore' && policy.scopeDigest === undefined ||
      policy.kind === 'legacy' && mode === 'fresh' && policy.scopeDigest === undefined) return held();
  return freeze(policy);
}

/** Only the original fresh child chooses salts. Restore cannot infer an algorithm from absence. */
export function originalOpenCodeV2FilePolicy(source: DeferredOpenCodeV2FileKey, mode: OpenCodeV2SelectedFileMode,
  original?: AcceptedOpenCodeV2FileKey | Readonly<{ kind: 'legacy-checkpoint' }>): OpenCodeV2FilePolicy | undefined {
  if (mode === 'catalog') return original === undefined ? undefined : held();
  if (original instanceof AcceptedOpenCodeV2FileKey) {
    if (!AcceptedOpenCodeV2FileKey.matches(original, source) || !original.filesCurrent()) return held();
    if (original.originalPolicy().kind === 'legacy') void original.encoded;
    return parseOpenCodeV2FilePolicy(original.originalPolicy(), mode);
  }
  if (original !== undefined) {
    if (mode !== 'restore' || Object.keys(original).length !== 1 || original.kind !== 'legacy-checkpoint') return held();
    return freeze({ kind: 'legacy' as const });
  }
  if (mode !== 'fresh') return held();
  return freeze({ kind: 'protected' as const,
    key: { version: 1 as const, salt: randomBytes(16).toString('hex') },
    files: { version: 1 as const, salt: randomBytes(16).toString('hex') } });
}

function observeFiles(dependencies: readonly FileMetadata[], source: OpenCodeV2SelectedFileDescriptor, check: () => void) {
  const allowed = selectedFilePaths(source), files: FileObservation[] = [], snapshots: Dependency[] = [];
  let total = 0;
  for (const file of dependencies) {
    if (!allowed.includes(file.path)) return held();
    let observed = '';
    const current = measure(file.path, check, bytes => {
      total += bytes.length; if (total > aggregateMaximum / 2) return held();
      observed = bytes.toString('base64url');
    });
    if (digest(metadata(current)) !== digest(file)) return held();
    files.push({ ...metadata(current), bytes: observed }); snapshots.push(current);
  }
  return { files, snapshots };
}
const filesPreimage = (source: OpenCodeV2SelectedFileDescriptor, files: readonly FileObservation[]) => ({
  domain: 'agent-teams/opencode-selected-file-files/v2', descriptor: descriptorMaterial(source), files,
});
function liveMac(password: string, wire: Omit<LiveWitness, 'mac'>,
  source: OpenCodeV2SelectedFileDescriptor, files: readonly FileObservation[]): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(password)) return held();
  const key = Buffer.from(password, 'base64url');
  const bytes = Buffer.from(canonicalManagementValue({ domain: 'agent-teams/opencode-selected-file-live/v2',
    wire, descriptor: descriptorMaterial(source), files }));
  try {
    if (key.length !== 32 || key.toString('base64url') !== password) return held();
    return createHmac('sha256', key).update(bytes).digest('hex');
  } finally { key.fill(0); bytes.fill(0); }
}
function encode(value: Witness | ProtectedWitness | LiveWitness): string {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  if (encoded.length > maximum) return held(); return encoded;
}

/** Per-child original preparation; private comparison hashes never enter its durable proof. */
class PreparedFileMaterial {
  readonly #issued = true;
  readonly #descriptor: string;
  readonly #key: string;
  readonly #dependencies: readonly Dependency[];
  constructor(readonly proof: ProtectedWitness, descriptor: string, key: string, dependencies: readonly Dependency[]) {
    this.#descriptor = descriptor; this.#key = key; this.#dependencies = dependencies; Object.freeze(this);
  }
  static matches(value: unknown, source: OpenCodeV2SelectedFileDescriptor, key: string,
    dependencies: readonly Dependency[], policy: OpenCodeV2FilePolicy): value is PreparedFileMaterial {
    return value instanceof PreparedFileMaterial && #issued in value && policy.kind === 'protected' &&
      value.#descriptor === source.digest && value.#key === bytesHash(key) &&
      digest(value.#dependencies) === digest(dependencies) &&
      digest(value.proof.key.fingerprintKdf) === digest(policy.key) &&
      digest(value.proof.files.fingerprintKdf) === digest(policy.files) &&
      (policy.scopeDigest === undefined || value.proof.scopeDigest === policy.scopeDigest);
  }
}

/** Called only by the authenticated same-child transform, never to resolve a key in the parent. */
export function createOpenCodeV2FileMaterialization(source: OpenCodeV2SelectedFileDescriptor, check: () => void,
  originalPolicy: OpenCodeV2FilePolicy) {
  const descriptor = parseOpenCodeV2SelectedFileDescriptor(source), allowed = selectedFilePaths(descriptor);
  const policy = freeze(filePolicySchema.parse(originalPolicy));
  const captured = new Map<string, Dependency>();
  const contents = new Map<string, string>();
  let total = 0, reads = 0, failed = false, preparing = false, issued = false;
  let prepared: { wire: string; key: string; issuer: string } | undefined;
  const account = (bytes: Buffer) => { total += bytes.length; if (total > aggregateMaximum) return held(); };
  const dependencies = () => [...captured.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const current = (rows: readonly Dependency[], consume: (bytes: Buffer) => void) => {
    for (const file of rows) if (digest(measure(file.path, check, consume)) !== digest(file)) return held();
  };
  return Object.freeze({
    readFileString(path: string): string {
      try {
        check(); if (failed || preparing || ++reads > 64 || !allowed.includes(path)) return held();
        let value = '';
        const file = measure(path, check, bytes => { account(bytes);
          value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); contents.set(path, bytes.toString('base64url')); });
        const prior = captured.get(path);
        if (prior && digest(prior) !== digest(file) || !prior && captured.size >= 32) return held();
        captured.set(path, file); return value;
      } catch { failed = true; return held(); }
    },
    async prepareIssue(key: string, issuer: Issuer, request: FileRequest, password: string,
      original?: PreparedFileMaterial): Promise<PreparedFileMaterial | undefined> {
      try {
        check(); if (failed || preparing || !keyValid(key) || !captured.size) return held();
        preparing = true;
        const rows = dependencies(), files = rows.map(file => ({ ...metadata(file), bytes: contents.get(file.path)! }));
        const unique = files.reduce((sum, file) => sum + Buffer.byteLength(file.bytes, 'base64url'), 0);
        // Keep the old R + U <= 256KiB admission and reserve its final pass. The extra pre-effect pass is <= U.
        if (total + unique > aggregateMaximum || unique > aggregateMaximum / 2) return held();
        request = requestSchema.parse(request); issuer = witnessSchema.shape.issuer.parse(issuer);
        if (Date.now() >= request.deadline) return held();
        let proof: ProtectedWitness | undefined, originalMaterial: PreparedFileMaterial | undefined;
        if (policy.kind === 'protected') {
          const placeholder = { schemaVersion: 2 as const, key: { fingerprintKdf: policy.key, fingerprint: '0'.repeat(64) },
            files: { fingerprintKdf: policy.files, fingerprint: '0'.repeat(64) }, scopeDigest: '0'.repeat(64),
            dependencies: rows.map(metadata), issuer, request, mac: '0'.repeat(64) };
          encode(liveWitnessSchema.parse(placeholder)); // Refuse an oversized final wire before expensive work or Connect.
          if (original !== undefined) {
            if (!PreparedFileMaterial.matches(original, descriptor, key, rows, policy)) return held();
            originalMaterial = original; proof = original.proof;
          } else {
            const keyProof = await deriveSecretFingerprint({ domain: 'agent-teams/opencode-selected-file-key/v2', key }, policy.key);
            check(); if (Date.now() >= request.deadline) return held();
            const filesProof = await deriveSecretFingerprint(filesPreimage(descriptor, files), policy.files);
            check(); if (Date.now() >= request.deadline) return held();
            const body = { key: keyProof, files: filesProof, dependencies: rows.map(metadata) };
            proof = freeze(protectedWitnessSchema.parse({ schemaVersion: 2, ...body, scopeDigest: protectedScope(body) }));
            if (policy.scopeDigest !== undefined && policy.scopeDigest !== proof.scopeDigest) return held();
            originalMaterial = new PreparedFileMaterial(proof, descriptor.digest, bytesHash(key), freeze(rows));
          }
        }
        let extra = 0;
        current(rows, bytes => { extra += bytes.length; if (extra > aggregateMaximum / 2) return held(); });
        check(); if (Date.now() >= request.deadline) return held();
        let wire: string;
        if (proof) {
          const body = { ...proof, issuer, request };
          wire = encode(liveWitnessSchema.parse({ ...body, mac: liveMac(password, body, descriptor, files) }));
        } else {
          if (original !== undefined) return held();
          const materializedKeyDigest = bytesHash(key);
          const legacy = witnessSchema.parse({ schemaVersion: 1, descriptorDigest: descriptor.digest,
            sourceDigest: descriptor.sourceDigest, namespaceDigest: descriptor.namespaceDigest, authDigest: descriptor.authDigest,
            providerId: descriptor.providerId, modelId: descriptor.modelId, cwd: descriptor.cwd, issuer,
            materializedKeyDigest, dependencies: rows,
            scopeDigest: effectiveDigest(descriptor.digest, materializedKeyDigest, rows) });
          if (policy.scopeDigest !== undefined && policy.scopeDigest !== legacy.scopeDigest ||
              request.method === 'POST' && policy.scopeDigest === undefined) return held();
          wire = encode(legacy);
        }
        check(); if (Date.now() >= request.deadline) return held();
        prepared = { wire, key: bytesHash(key), issuer: digest(issuer) };
        return originalMaterial;
      } catch { failed = true; return held(); }
      finally { contents.clear(); }
    },
    issue(key: string, issuer: Issuer): string {
      check(); if (failed || issued || !prepared || prepared.key !== bytesHash(key) || prepared.issuer !== digest(issuer)) return held();
      current(dependencies(), account); check(); issued = true; return prepared.wire;
    },
    materializedKey(key: unknown): string {
      check(); if (failed || !keyValid(key) || !captured.size) return held();
      return key;
    },
  });
}

/** Pure reference: integration is selected by the original parent catalog, not guessed by this helper. */
export const openCodeV2SelectedSourceReference = (descriptor: OpenCodeV2SelectedFileDescriptor,
  nonce: string, integrationId: string, mode: OpenCodeV2SelectedFileMode): string =>
  digest({ descriptor: descriptor.digest, nonce, integrationId, mode });

export class AcceptedOpenCodeV2FileKey {
  readonly #issued = true;
  readonly #source: Readonly<Pick<OpenCodeV2SelectedFileDescriptor, 'digest' | 'providerId' | 'modelId'>>;
  readonly #proof: Witness | ProtectedWitness;
  readonly #snapshots: readonly Dependency[];
  readonly #originalEncoding: string | undefined;
  private constructor(source: OpenCodeV2SelectedFileDescriptor, proof: Witness | ProtectedWitness,
    snapshots: readonly Dependency[], originalEncoding?: string) {
    this.#source = Object.freeze({ digest: source.digest, providerId: source.providerId, modelId: source.modelId });
    this.#proof = proof; this.#snapshots = snapshots;
    this.#originalEncoding = originalEncoding; Object.freeze(this);
  }
  get descriptorDigest(): string { return this.#source.digest; }
  get scopeDigest(): string { return this.#proof.scopeDigest; }
  get encoded(): string { return this.#originalEncoding ?? held(); }
  originalPolicy(): OriginalFilePolicy {
    return this.#proof.schemaVersion === 1 ? freeze({ kind: 'legacy', scopeDigest: this.scopeDigest }) :
      freeze({ kind: 'protected', key: this.#proof.key.fingerprintKdf, files: this.#proof.files.fingerprintKdf,
        scopeDigest: this.scopeDigest });
  }
  /** Original private adapter issuance, never a structurally similar object or caller digest. */
  static selected(value: unknown, providerId: string, modelId: string): value is AcceptedOpenCodeV2FileKey {
    return value instanceof AcceptedOpenCodeV2FileKey && #issued in value &&
      value.#source.providerId === providerId &&
      (value.#source.modelId === modelId || `${providerId}/${value.#source.modelId}` === modelId);
  }
  static accept(source: DeferredOpenCodeV2FileKey, encoded: string,
    issuer: Issuer, current: () => boolean, input: FileAcceptance): AcceptedOpenCodeV2FileKey {
    let deadline = input.request.deadline;
    const check = () => { if (!DeferredOpenCodeV2FileKey.is(source) || !source.isCurrent() || !current() ||
      !Number.isSafeInteger(deadline) || Date.now() >= deadline) return held(); };
    check(); const policy = filePolicySchema.parse(input.policy);
    let result: AcceptedOpenCodeV2FileKey;
    if (policy.kind === 'legacy') {
      const proof = decode(encoded), expected = policy.scopeDigest ?? input.request.originalScopeDigest;
      if (policy.scopeDigest === undefined && input.request.method !== 'GET' ||
          proof.schemaVersion !== 1 || !expected || proof.scopeDigest !== expected ||
          input.request.originalScopeDigest !== undefined && input.request.originalScopeDigest !== expected ||
          !matchesLegacy(proof, source.descriptor) || digest(proof.issuer) !== digest(issuer)) return held();
      let originalEncoding: string | undefined;
      if (input.original !== undefined) {
        if (!this.matches(input.original, source) || input.original.originalPolicy().kind !== 'legacy' ||
            input.original.scopeDigest !== expected) return held();
        originalEncoding = input.original.encoded;
      }
      result = new AcceptedOpenCodeV2FileKey(source.descriptor, proof, proof.dependencies, originalEncoding);
    } else {
      const parsed = parsedEncoding(encoded), live = liveWitnessSchema.parse(parsed.value);
      if (JSON.stringify(live) !== parsed.json || !dependencyOrder(live.dependencies) ||
          digest(live.issuer) !== digest(issuer) || live.request.method !== input.request.method ||
          live.request.deadline > input.request.deadline || Date.now() >= live.request.deadline ||
          digest(live.key.fingerprintKdf) !== digest(policy.key) || digest(live.files.fingerprintKdf) !== digest(policy.files) ||
          policy.scopeDigest !== undefined && live.scopeDigest !== policy.scopeDigest ||
          input.request.originalScopeDigest !== undefined && live.scopeDigest !== input.request.originalScopeDigest) return held();
      deadline = live.request.deadline;
      const observed = observeFiles(live.dependencies, source.descriptor, check), { mac, ...body } = live;
      if (!timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(liveMac(input.password, body, source.descriptor, observed.files), 'hex')))
        return held();
      const proof = protectedWitnessSchema.parse({ schemaVersion: 2, key: live.key, files: live.files,
        scopeDigest: live.scopeDigest, dependencies: live.dependencies });
      if (protectedScope({ key: proof.key, files: proof.files, dependencies: proof.dependencies }) !== proof.scopeDigest) return held();
      result = new AcceptedOpenCodeV2FileKey(source.descriptor, freeze(proof), freeze(observed.snapshots), encode(proof));
      check(); if (Date.now() >= live.request.deadline) return held();
    }
    if (!result.filesCurrent()) return held(); check();
    return result;
  }
  static matches(value: unknown, source: DeferredOpenCodeV2FileKey): value is AcceptedOpenCodeV2FileKey {
    return value instanceof AcceptedOpenCodeV2FileKey && #issued in value && DeferredOpenCodeV2FileKey.is(source) &&
      value.descriptorDigest === source.descriptor.digest;
  }
  /** Only the caller's exact validated, completed/released StoredModelProbe may authorize this cold read. */
  static async retained(source: DeferredOpenCodeV2FileKey, encoded: string,
    assertOriginalReleasedRecord: () => void): Promise<AcceptedOpenCodeV2FileKey> {
    assertOriginalReleasedRecord();
    if (!DeferredOpenCodeV2FileKey.is(source) || !source.isCurrent()) return held();
    const proof = decode(encoded);
    let snapshots: readonly Dependency[];
    if (proof.schemaVersion === 1) {
      if (!matchesLegacy(proof, source.descriptor)) return held(); snapshots = proof.dependencies;
    } else {
      const observed = observeFiles(proof.dependencies, source.descriptor, () => {
        if (!source.isCurrent()) return held();
      });
      const expected = await deriveSecretFingerprint(filesPreimage(source.descriptor, observed.files), proof.files.fingerprintKdf);
      assertOriginalReleasedRecord();
      if (!source.isCurrent() || !secretFingerprintsEqual(expected.fingerprint, proof.files.fingerprint)) return held();
      snapshots = freeze(observed.snapshots);
    }
    const result = new AcceptedOpenCodeV2FileKey(source.descriptor, proof, snapshots, encoded);
    if (!result.filesCurrent() || !source.isCurrent()) return held();
    assertOriginalReleasedRecord(); return result;
  }
  /** Hash only and acyclic: no outer configuration/owner callback and no child liveness requirement. */
  filesCurrent(): boolean {
    try {
      let total = 0;
      for (const file of this.#snapshots) {
        const current = measure(file.path, () => {}, bytes => {
          total += bytes.length; if (total > aggregateMaximum) return held();
        });
        if (digest(current) !== digest(file)) return false;
      }
      return true;
    } catch { return false; }
  }
}
