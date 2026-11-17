import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse as parsePath, resolve, sep } from 'node:path';

import { getNodeValue, parseTree } from 'jsonc-parser';

import { openCodeConfigurationReferenceSchema } from '../../composition/openCodeConfigurationReference.js';
import { ManagementCommandError } from '../../management/commandRecords.js';
import { managementDigest } from '../../management/identity.js';

import type { Node as JsoncNode, ParseError } from 'jsonc-parser';
import type { OpenCodeConfigurationReference } from '../../composition/openCodeConfigurationReference.js';

interface Input {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}
type Config = Record<string, unknown>;
type KeySource = { kind: 'file'; path: string; digest: string } | { kind: 'inline'; digest: string };
export type OpenCodeConfigurationKeyOrigin = Readonly<KeySource & { value: unknown }>;
const maximum = 1024 * 1024;
const record = (value: unknown): value is Config =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

export class OpenCodeConfigurationError extends ManagementCommandError {
  constructor(readonly reason: 'configuration-invalid' | 'configuration-changed') {
    super(reason === 'configuration-invalid' ? 'invalid' : 'held');
  }
}
function invalid(): never {
  throw new OpenCodeConfigurationError('configuration-invalid');
}
function changed(): never {
  throw new OpenCodeConfigurationError('configuration-changed');
}

/** Donor precedence: canonical HOME, XDG, explicit file, inline, then project JSON/JSONC. */
function sources(input: Input, scope: 'global' | 'project') {
  const environment = { ...input.environment };
  const value = (name: string) => {
    const matches = Object.keys(environment).filter((key) => key.toUpperCase() === name);
    if (matches.length > 1) invalid();
    return (matches[0] ? environment[matches[0]] : undefined)?.trim();
  };
  const home = value('HOME') || value('USERPROFILE');
  const xdg = value('XDG_CONFIG_HOME') || (home ? join(home, '.config') : undefined);
  if (!home || !xdg || !isAbsolute(home) || !isAbsolute(xdg) || !isAbsolute(input.cwd)) invalid();
  const explicit = value('OPENCODE_CONFIG');
  const global = [
    ...new Set([
      ...[join(home, '.config'), xdg].flatMap((root) =>
        ['opencode.json', 'opencode.jsonc'].map((name) => resolve(root, 'opencode', name))
      ),
      ...(explicit ? [resolve(home, explicit)] : []),
    ]),
  ];
  const project =
    scope === 'project'
      ? ['opencode.json', 'opencode.jsonc'].map((name) => resolve(input.cwd, name))
      : [];
  // Keep project at the end even if an explicit global path named the same file.
  const files = [...global.filter((path) => !project.includes(path)), ...project];
  const inline = value('OPENCODE_CONFIG_CONTENT');
  return { files, projectStart: files.length - project.length, inline };
}

/** Read-only donor paths may contain links; their original mapping belongs to the capture. */
function readSource(path: string) {
  let fd: number | undefined;
  const locate = () => {
    const identities: unknown[] = [];
    const root = parsePath(path).root;
    let directory = root;
    for (const part of dirname(path).slice(root.length).split(sep).filter(Boolean)) {
      directory = join(directory, part);
      let stat;
      try {
        stat = lstatSync(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return {
            identity: { path, identities, missing: directory },
          };
        throw error;
      }
      if (stat.isSymbolicLink()) {
        const target = realpathSync(directory),
          resolved = lstatSync(target);
        if (!resolved.isDirectory()) invalid();
        identities.push([directory, stat.dev, stat.ino, target, resolved.dev, resolved.ino]);
      } else {
        if (!stat.isDirectory()) invalid();
        identities.push([directory, stat.dev, stat.ino]);
      }
    }
    let entry;
    try {
      entry = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { identity: { path, identities, missing: path } };
      throw error;
    }
    const target = realpathSync(path),
      file = lstatSync(target);
    if (!file.isFile() || file.isSymbolicLink() || file.size > maximum) invalid();
    return {
      target,
      file,
      identity: {
        path,
        identities,
        ...(target === path ? {} : { target }),
        ...(entry.isSymbolicLink() ? { link: [entry.dev, entry.ino] } : {}),
        file: [file.dev, file.ino, file.mode, file.uid],
      },
    };
  };
  try {
    const original = locate();
    if (!original.target || !original.file)
      return { digest: managementDigest(original.identity), bytes: undefined };
    const identity = managementDigest(original.identity);
    // Follow the captured config reference once, then open only its canonical file.
    fd = openSync(original.target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.dev !== original.file.dev ||
      before.ino !== original.file.ino ||
      before.size > maximum
    )
      changed();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) changed();
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) changed();
    const after = fstatSync(fd),
      current = locate();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      managementDigest(current.identity) !== identity
    )
      changed();
    return {
      digest: managementDigest({
        ...original.identity,
        bytes: hash(bytes),
      }),
      bytes,
    };
  } catch (error) {
    if (error instanceof OpenCodeConfigurationError) throw error;
    return invalid();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parse(bytes: string | Buffer): Config {
  let raw: string;
  try {
    raw =
      typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalid();
  }
  if (Buffer.byteLength(raw) > maximum) invalid();
  if (!raw.trim()) return {};
  const errors: ParseError[] = [];
  const tree = parseTree(raw, errors, { allowTrailingComma: true, disallowComments: false });
  if (!tree || tree.type !== 'object' || errors.length) invalid();
  const visit = (node: JsoncNode, depth: number) => {
    if (depth > 64) invalid();
    if (node.type === 'number' && !Number.isFinite(node.value)) invalid();
    if (node.type === 'object') {
      const keys = node.children?.map((property) => property.children?.[0]?.value as unknown) ?? [];
      if (new Set(keys).size !== keys.length) invalid();
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(tree, 0);
  const result: unknown = getNodeValue(tree);
  if (!record(result)) invalid();
  return result;
}

function merge(base: Config, override: Config): Config {
  return Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(override)])].map((key) => {
      const next = override[key];
      return [
        key,
        !Object.hasOwn(override, key)
          ? base[key]
          : record(base[key]) && record(next)
            ? merge(base[key], next)
            : next,
      ];
    })
  );
}

/** A private, read-only capture. Publication owns the reference; callers own allocation and journals. */
export function captureOpenCodeConfigurationSource(
  raw: Input,
  expected?: OpenCodeConfigurationReference,
  ownerCurrent: () => boolean = () => true,
  scope: 'global' | 'project' = expected?.scope ?? 'project'
) {
  const input = structuredClone(raw),
    selected = sources(input, scope);
  const read = () => {
    if (!ownerCurrent()) changed();
    const files = selected.files.map((path) => ({ path, ...readSource(path) }));
    const reference = openCodeConfigurationReferenceSchema.parse({
      scope,
      files: files.map(({ path, digest }) => ({ path, digest })),
      inlineDigest: selected.inline === undefined ? null : hash(selected.inline),
    });
    if (!ownerCurrent()) changed();
    return { files, reference };
  };
  const original = read(),
    fingerprint = managementDigest(original.reference);
  if (
    expected &&
    fingerprint !== managementDigest(openCodeConfigurationReferenceSchema.parse(expected))
  )
    changed();
  const isCurrent = () => {
    try {
      return managementDigest(read().reference) === fingerprint;
    } catch {
      return false;
    }
  };
  let config: Config = {};
  const documents: { value: Config; origin: KeySource }[] = [];
  const apply = (value: Config, origin: KeySource) => {
    documents.push({ value, origin });
    config = merge(config, value);
  };
  for (let index = 0; index <= original.files.length; index++) {
    if (index === selected.projectStart && selected.inline !== undefined)
      apply(parse(selected.inline), { kind: 'inline', digest: hash(selected.inline) });
    const file = original.files[index];
    if (file?.bytes !== undefined)
      apply(parse(file.bytes), { kind: 'file', path: file.path, digest: file.digest });
  }
  if (!isCurrent()) changed();
  return Object.freeze({
    reference: structuredClone(original.reference),
    digest: fingerprint,
    isCurrent,
    /** Pure joins to the already captured documents; callers retain the original freshness checks. */
    matchesConfiguration: (value: unknown) => managementDigest(value) === managementDigest(config),
    selectedKeyOrigin: (providerId: string): OpenCodeConfigurationKeyOrigin | undefined => {
      if (!ownerCurrent()) changed();
      let origin: OpenCodeConfigurationKeyOrigin | undefined;
      const parts = ['provider', providerId, 'options', 'apiKey'];
      for (const document of documents) {
        let value: unknown = document.value;
        for (let index = 0; index < parts.length; index++) {
          if (!record(value)) { origin = undefined; break; }
          const part = parts[index]!;
          if (!Object.hasOwn(value, part)) break;
          value = value[part];
          if (index === parts.length - 1)
            origin = { ...document.origin, value: structuredClone(value) };
        }
      }
      const provider = record(config.provider) ? config.provider[providerId] : undefined;
      const options = record(provider) && record(provider.options) ? provider.options : undefined;
      if (origin && (!options || !Object.hasOwn(options, 'apiKey') ||
          managementDigest(origin.value) !== managementDigest(options.apiKey))) changed();
      if (!ownerCurrent()) changed();
      return origin;
    },
    read: () => {
      if (!isCurrent()) changed();
      return structuredClone(config);
    },
  });
}
