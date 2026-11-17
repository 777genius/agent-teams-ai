import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

import { managementDigest as digest } from '../../management/identity.js';
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
function decode(encoded: string): Witness {
  if (typeof encoded !== 'string' || !encoded || encoded.length > maximum || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return held();
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded) return held();
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const proof = witnessSchema.parse(value);
  if (new Set(proof.dependencies.map(row => row.path)).size !== proof.dependencies.length ||
      effectiveDigest(proof.descriptorDigest, proof.materializedKeyDigest, proof.dependencies) !== proof.scopeDigest) return held();
  return freeze(proof);
}
function matches(proof: Witness, source: OpenCodeV2SelectedFileDescriptor): boolean {
  return proof.descriptorDigest === source.digest && proof.sourceDigest === source.sourceDigest &&
    proof.namespaceDigest === source.namespaceDigest && proof.authDigest === source.authDigest &&
    proof.providerId === source.providerId && proof.modelId === source.modelId && proof.cwd === source.cwd &&
    proof.dependencies.every(file => selectedFilePaths(source).includes(file.path));
}

/** Called only by the authenticated same-child transform, never to resolve a key in the parent. */
export function createOpenCodeV2FileMaterialization(source: OpenCodeV2SelectedFileDescriptor, check: () => void) {
  const descriptor = parseOpenCodeV2SelectedFileDescriptor(source), allowed = selectedFilePaths(descriptor);
  const captured = new Map<string, Dependency>();
  let total = 0, reads = 0, failed = false;
  const account = (bytes: Buffer) => { total += bytes.length; if (total > aggregateMaximum) return held(); };
  return Object.freeze({
    readFileString(path: string): string {
      try {
        check(); if (++reads > 64 || !allowed.includes(path)) return held();
        let value = '';
        const file = measure(path, check, bytes => { account(bytes); value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); });
        const prior = captured.get(path);
        if (prior && digest(prior) !== digest(file) || !prior && captured.size >= 32) return held();
        captured.set(path, file); return value;
      } catch { failed = true; return held(); }
    },
    issue(key: string, issuer: Witness['issuer']): string {
      check(); if (failed || !keyValid(key) || !captured.size) return held();
      const dependencies = [...captured.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      for (const file of dependencies) if (digest(measure(file.path, check, account)) !== digest(file)) return held();
      const materializedKeyDigest = bytesHash(key);
      const proof = witnessSchema.parse({ schemaVersion: 1, descriptorDigest: descriptor.digest,
        sourceDigest: descriptor.sourceDigest, namespaceDigest: descriptor.namespaceDigest, authDigest: descriptor.authDigest,
        providerId: descriptor.providerId, modelId: descriptor.modelId, cwd: descriptor.cwd, issuer,
        materializedKeyDigest, dependencies, scopeDigest: effectiveDigest(descriptor.digest, materializedKeyDigest, dependencies) });
      const encoded = Buffer.from(JSON.stringify(proof)).toString('base64url');
      if (encoded.length > maximum) return held(); check(); return encoded;
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
  private constructor(readonly descriptorDigest: string, readonly scopeDigest: string,
    readonly encoded: string, private readonly proof: Witness) { Object.freeze(this); }
  /** Original private adapter issuance, never a structurally similar object or caller digest. */
  static selected(value: unknown, providerId: string, modelId: string): value is AcceptedOpenCodeV2FileKey {
    return value instanceof AcceptedOpenCodeV2FileKey && #issued in value &&
      value.proof.providerId === providerId &&
      (value.proof.modelId === modelId || `${providerId}/${value.proof.modelId}` === modelId);
  }
  static accept(source: DeferredOpenCodeV2FileKey, encoded: string,
    issuer: Witness['issuer'], current: () => boolean): AcceptedOpenCodeV2FileKey {
    if (!DeferredOpenCodeV2FileKey.is(source) || !source.isCurrent() || !current()) return held();
    const proof = decode(encoded);
    if (!matches(proof, source.descriptor) || digest(proof.issuer) !== digest(issuer)) return held();
    const result = new AcceptedOpenCodeV2FileKey(source.descriptor.digest, proof.scopeDigest, encoded, proof);
    if (!result.filesCurrent() || !source.isCurrent() || !current()) return held();
    return result;
  }
  static matches(value: unknown, source: DeferredOpenCodeV2FileKey): value is AcceptedOpenCodeV2FileKey {
    return value instanceof AcceptedOpenCodeV2FileKey && #issued in value && DeferredOpenCodeV2FileKey.is(source) &&
      matches(value.proof, source.descriptor);
  }
  /** Only the caller's exact validated, completed/released StoredModelProbe may authorize this cold read. */
  static retained(source: DeferredOpenCodeV2FileKey, encoded: string,
    assertOriginalReleasedRecord: () => void): AcceptedOpenCodeV2FileKey {
    assertOriginalReleasedRecord();
    if (!DeferredOpenCodeV2FileKey.is(source) || !source.isCurrent()) return held();
    const proof = decode(encoded);
    if (!matches(proof, source.descriptor)) return held();
    const result = new AcceptedOpenCodeV2FileKey(source.descriptor.digest, proof.scopeDigest, encoded, proof);
    if (!result.filesCurrent() || !source.isCurrent()) return held();
    assertOriginalReleasedRecord(); return result;
  }
  /** Hash only and acyclic: no outer configuration/owner callback and no child liveness requirement. */
  filesCurrent(): boolean {
    try {
      let total = 0;
      for (const file of this.proof.dependencies) {
        const current = measure(file.path, () => {}, bytes => {
          total += bytes.length; if (total > aggregateMaximum) return held();
        });
        if (digest(current) !== digest(file)) return false;
      }
      return true;
    } catch { return false; }
  }
}
