import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  LEGACY_STOPPED_SOURCE_DIAGNOSTIC_BOUNDARIES,
  RETAINED_LEGACY_OPEN_DIAGNOSTIC_CATEGORIES,
  RETAINED_LEGACY_OPEN_DIAGNOSTIC_NAMESPACE,
  RETAINED_LEGACY_OPEN_DIAGNOSTIC_OUTCOMES,
  RETAINED_LEGACY_OPEN_DIAGNOSTIC_PHASES,
} from '../../src/features/agent-backend/main/infrastructure/stopped-import/retainedLegacyOpenDiagnosticContract.ts';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_RECORDS = 8192;
const UNKNOWN_REASONS = [
  'not-correlated', 'missing-log', 'unreadable-log', 'unsafe-log', 'changed-log',
  'invalid-log', 'log-limit', 'record-absent', 'foreign-record', 'duplicate-record',
] as const;
type UnknownReason = (typeof UNKNOWN_REASONS)[number];
type Phase = (typeof RETAINED_LEGACY_OPEN_DIAGNOSTIC_PHASES)[number];
type Category = (typeof RETAINED_LEGACY_OPEN_DIAGNOSTIC_CATEGORIES)[number];
type Outcome = (typeof RETAINED_LEGACY_OPEN_DIAGNOSTIC_OUTCOMES)[number];

export interface RetainedOpenDiagnosticBinding {
  readonly mainPid: number;
  readonly teamName: string;
  readonly intentId: string;
}
interface ObservedProjection {
  readonly status: 'observed';
  readonly phase: Phase;
  readonly category: Category;
  readonly outcome: Outcome;
  readonly sourceBoundary?: (typeof LEGACY_STOPPED_SOURCE_DIAGNOSTIC_BOUNDARIES)[number];
}
interface UnknownProjection {
  readonly status: 'diagnostic-unknown';
  readonly reason: UnknownReason;
}
export type RetainedOpenDiagnosticProjection = ObservedProjection | UnknownProjection;
interface ExpectedBinding { mainPid: number; operationHash: string }
interface LogInput { main: string; rotated?: string }
interface FileIdentity {
  dev: bigint; ino: bigint; mode: bigint; nlink: bigint; uid: bigint; size: bigint;
  mtimeNs: bigint; ctimeNs: bigint;
  isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean;
}
interface OpenLog {
  stat(): Promise<FileIdentity>;
  read(buffer: Buffer): Promise<number>;
  close(): Promise<void>;
}
/** Finite filesystem seams only; these ports cannot reach an app, runtime or transport. */
export interface RetainedOpenDiagnosticFiles {
  owner(): number | undefined;
  canonical(path: string): Promise<string>;
  named(path: string): Promise<FileIdentity>;
  open(path: string): Promise<OpenLog>;
}
const files: RetainedOpenDiagnosticFiles = {
  owner: () => process.getuid?.(),
  canonical: realpath,
  named: path => lstat(path, { bigint: true }),
  async open(path) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return {
      stat: () => handle.stat({ bigint: true }),
      read: async buffer => (await handle.read(buffer, 0, buffer.length, 0)).bytesRead,
      close: () => handle.close(),
    };
  },
};

const own = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};
const oneOf = <T extends readonly string[]>(value: unknown, values: T): value is T[number] =>
  typeof value === 'string' && values.includes(value);
const unknown = (reason: UnknownReason): UnknownProjection =>
  Object.freeze({ status: 'diagnostic-unknown', reason });
class LogRefusal extends Error {
  readonly reason: UnknownReason;
  constructor(reason: UnknownReason) { super(reason); this.reason = reason; }
}
const refuse: (reason: UnknownReason) => never = (reason) => { throw new LogRefusal(reason); };
const rejection = (error: unknown): UnknownProjection =>
  unknown(error instanceof LogRefusal ? error.reason : 'unreadable-log');
const same = (a: FileIdentity, b: FileIdentity) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink &&
  a.uid === b.uid && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const missing = (error: unknown) => own(error, 'code') === 'ENOENT';

function expected(binding: RetainedOpenDiagnosticBinding | undefined): ExpectedBinding | undefined {
  const mainPid = own(binding, 'mainPid'), teamName = own(binding, 'teamName'), intentId = own(binding, 'intentId');
  if (!Number.isSafeInteger(mainPid) || Number(mainPid) <= 0 || Number(mainPid) > 0x7fffffff ||
      teamName !== 'test-retained-opencode-v1' ||
      typeof intentId !== 'string' ||
      !['TEST-coexist-retained-original-once', 'TEST-coexist-retained-after-stop-once'].includes(intentId)) return undefined;
  return { mainPid: mainPid as number,
    operationHash: createHash('sha256').update(JSON.stringify(['open', teamName, intentId])).digest('hex') };
}

function parse(value: string): unknown {
  try { return JSON.parse(value); } catch { return refuse('invalid-log'); }
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) refuse('invalid-log');
  return value as Record<string, unknown>;
}

function project(input: LogInput, binding: ExpectedBinding): RetainedOpenDiagnosticProjection {
  const main = own(input, 'main'), rotated = own(input, 'rotated');
  if (typeof main !== 'string' || (rotated !== undefined && typeof rotated !== 'string')) refuse('invalid-log');
  const texts = rotated === undefined ? [main] : [rotated, main];
  let records = 0, selected: ObservedProjection | undefined;
  for (const text of texts) {
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) refuse('log-limit');
    if (text.length > 0 && !text.endsWith('\n')) refuse('invalid-log');
    const lines = text.length === 0 ? [] : text.slice(0, -1).split('\n');
    records += lines.length;
    if (records > MAX_RECORDS) refuse('log-limit');
    for (const line of lines) {
      if (!line || Buffer.byteLength(line) > MAX_LINE_BYTES) refuse('invalid-log');
      const record = exactObject(parse(line), [
        'v', 't', 'level', 'process', 'namespace', 'appVersion', 'platform', 'message',
      ]);
      if (JSON.stringify(record) !== line || record.v !== 1 ||
          typeof record.t !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.t) ||
          !Number.isFinite(Date.parse(record.t)) ||
          !oneOf(record.level, ['diagnostic', 'warn', 'error']) ||
          !oneOf(record.process, ['main', 'renderer']) ||
          typeof record.namespace !== 'string' || typeof record.appVersion !== 'string' ||
          !oneOf(record.platform, ['linux', 'darwin', 'win32', 'aix', 'freebsd', 'openbsd', 'sunos', 'android']) ||
          typeof record.message !== 'string') refuse('invalid-log');
      if (record.namespace !== RETAINED_LEGACY_OPEN_DIAGNOSTIC_NAMESPACE) continue;
      if (record.level !== 'diagnostic' || record.process !== 'main' || record.platform !== 'linux')
        refuse('foreign-record');
      const parsed = parse(record.message);
      const sourceBoundary = own(parsed, 'sourceBoundary');
      const payload = exactObject(parsed, [
        'v', 'mainPid', 'operationHash', 'phase', 'category', 'outcome',
        ...(sourceBoundary === undefined ? [] : ['sourceBoundary']),
      ]);
      if (JSON.stringify(payload) !== record.message || payload.v !== 1 ||
          !Number.isSafeInteger(payload.mainPid) || Number(payload.mainPid) <= 0 ||
          typeof payload.operationHash !== 'string' || !/^[a-f0-9]{64}$/.test(payload.operationHash) ||
          !oneOf(payload.phase, RETAINED_LEGACY_OPEN_DIAGNOSTIC_PHASES) ||
          !oneOf(payload.category, RETAINED_LEGACY_OPEN_DIAGNOSTIC_CATEGORIES) ||
          !oneOf(payload.outcome, RETAINED_LEGACY_OPEN_DIAGNOSTIC_OUTCOMES)) refuse('invalid-log');
      if (sourceBoundary !== undefined &&
          (payload.phase !== 'coordinator-admission' || payload.category !== 'source-unreadable' ||
           !oneOf(sourceBoundary, LEGACY_STOPPED_SOURCE_DIAGNOSTIC_BOUNDARIES))) refuse('invalid-log');
      if (payload.mainPid !== binding.mainPid || payload.operationHash !== binding.operationHash)
        refuse('foreign-record');
      if (selected) refuse('duplicate-record');
      selected = Object.freeze({ status: 'observed', phase: payload.phase,
        category: payload.category, outcome: payload.outcome,
        ...(sourceBoundary === undefined ? {} : { sourceBoundary }) });
    }
  }
  return selected ?? unknown('record-absent');
}

/** Closed projection only. Count, PID, hash and log text never become operation authority. */
export function projectRetainedOpenDiagnostics(input: LogInput,
  binding: RetainedOpenDiagnosticBinding | undefined): RetainedOpenDiagnosticProjection {
  try {
    const owner = expected(binding);
    return owner ? project(input, owner) : unknown('not-correlated');
  } catch (error) { return rejection(error); }
}

/** One bounded read after original cleanup; no directory scan, retry, app or process observation. */
export async function readRetainedOpenDiagnostic(input: {
  root: string | undefined; binding: RetainedOpenDiagnosticBinding | undefined;
}, io: RetainedOpenDiagnosticFiles = files): Promise<RetainedOpenDiagnosticProjection> {
  try {
    const owner = expected(input.binding);
    if (!owner || typeof input.root !== 'string' || !isAbsolute(input.root)) return unknown('not-correlated');
    const uid = io.owner();
    if (!Number.isSafeInteger(uid) || Number(uid) < 0) return unknown('unsafe-log');
    const directories = [input.root, join(input.root, 'userData'), join(input.root, 'userData', 'logs')];
    const parents: FileIdentity[] = [];
    for (const path of directories) {
      const value = await io.named(path);
      if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== BigInt(uid!) ||
          await io.canonical(path) !== path) refuse('unsafe-log');
      parents.push(value);
    }
    const root = parents[0]!;
    if ((root.mode & 0o077n) !== 0n) refuse('unsafe-log');
    const loaded: { path: string; identity: FileIdentity | undefined; text: string | undefined }[] = [];
    for (const name of ['app-errors.1.ndjson', 'app-errors.ndjson']) {
      const path = join(directories[2]!, name);
      let named: FileIdentity;
      try { named = await io.named(path); }
      catch (error) {
        if (missing(error) && name === 'app-errors.1.ndjson') {
          loaded.push({ path, identity: undefined, text: undefined }); continue;
        }
        if (missing(error)) refuse('missing-log');
        throw error;
      }
      if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n ||
          named.uid !== BigInt(uid!) || await io.canonical(path) !== path) refuse('unsafe-log');
      if (named.size < 0n || named.size > BigInt(MAX_FILE_BYTES)) refuse('log-limit');
      const handle = await io.open(path);
      let text: string;
      try {
        if (!same(named, await handle.stat())) refuse('changed-log');
        const buffer = Buffer.alloc(Number(named.size) + 1);
        const bytes = await handle.read(buffer);
        if (bytes !== Number(named.size) || !same(named, await handle.stat()) ||
            !same(named, await io.named(path))) refuse('changed-log');
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
      } finally { await handle.close(); }
      loaded.push({ path, identity: named, text });
    }
    // Include the interval between both reads; rotation/replacement never selects a last record.
    for (let index = 0; index < directories.length; index++)
      if (!same(parents[index]!, await io.named(directories[index]!))) refuse('changed-log');
    for (const item of loaded) {
      let now: FileIdentity | undefined;
      try { now = await io.named(item.path); } catch (error) { if (!missing(error)) throw error; }
      if (item.identity ? !now || !same(item.identity, now) : now !== undefined) refuse('changed-log');
    }
    return project({ main: loaded[1]!.text!, rotated: loaded[0]!.text }, owner);
  } catch (error) { return rejection(error); }
}
