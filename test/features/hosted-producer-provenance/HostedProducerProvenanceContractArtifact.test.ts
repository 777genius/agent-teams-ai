import { createHash } from 'node:crypto';
import { readdirSync,readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const CONTRACT = 'claude-team/hosted-producer-provenance';
const SCHEMA_SHA256 = 'ef6aa8ac1f139d2b5e9312da8ff1e6dac21da788d46eefbd6e3d43da27da23ba';
const SUPERSEDED_V2_DIGEST = 'acde43e62b8ab42cc5fd2bbecc22f1b96d68f456bfa188b8c63730751222f498';
const HISTORICAL_DIGEST = '3f5ad01985ddc33b90bf3f6772288316674202a640be5bb6f4e1669319be529d';
const CONTRACTS = resolve(process.cwd(), 'src/features/hosted-producer-provenance/contracts');
const SCHEMA_PATH = resolve(CONTRACTS, 'hosted-producer-provenance-v2.schema.json');
const GOLDEN_PATH = resolve(CONTRACTS, 'hosted-producer-provenance-v2.golden.json');

type Json = null | boolean | number | string | Json[] | JsonObject;
type JsonObject = { [key: string]: Json };
type RecordFixture = JsonObject & {
  emissionNonce: string;
  native: JsonObject;
  operationNonce: string | null;
  previousRecordSha256: string | null;
  producer: JsonObject;
  recordType: string;
  sequence: number;
  stream: string;
};
type OperationGroup = { id: string; joinEvidence?: JsonObject; records: RecordFixture[] };
type InvalidDocument = {
  expectedCode: string;
  id: string;
  input: { encoding: 'base64' | 'hex' | 'utf8'; value: string };
  layer: string;
};
type InvalidFixture = {
  base: JsonObject;
  expectedCode: string;
  id: string;
  layer: string;
  materializedRecordCount?: number;
  mutation: JsonObject;
  retained?: JsonObject;
};
type ContractInstance = JsonObject & {
  expectedProducer: JsonObject;
  producerRole: string;
  streams: JsonObject;
};
type Golden = {
  canonicalExamples: Array<{ canonicalUtf8: string; recordIndex: number; sha256: string }>;
  invalidDocuments: InvalidDocument[];
  invalidFixtures: InvalidFixture[];
  metadata: JsonObject;
  operationGroups: OperationGroup[];
  validContractInstances: ContractInstance[];
  validRecords: RecordFixture[];
};
type SchemaValidate = ((value: unknown) => boolean) & { errors?: unknown };
type AjvConstructor = new (options: JsonObject) => { compile: (schema: Json) => SchemaValidate };
type FixtureResult = { earlierFailures: string[]; layer: string; primaryFailures: string[] };
type AjvError = { instancePath: string; keyword: string; params: JsonObject };

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalJson(value: Json): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError('non-canonical-number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function parseCanonicalArtifact(path: string): { bytes: Buffer; value: Json } {
  const bytes = readFileSync(path);
  if (
    bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ||
    bytes.includes(0x0d) ||
    bytes.at(-1) !== 0x0a ||
    bytes.at(-2) === 0x0a
  ) {
    throw new TypeError(`non-canonical-artifact:${path}`);
  }
  const source = bytes.toString('utf8');
  const value = JSON.parse(source) as Json;
  if (`${canonicalJson(value)}\n` !== source) throw new TypeError(`non-canonical-json:${path}`);
  return { bytes, value };
}

function loadDraft202012(): AjvConstructor {
  const require = createRequire(import.meta.url);
  try {
    const loaded = require('ajv/dist/2020.js') as { default?: unknown };
    return (loaded.default ?? loaded) as AjvConstructor;
  } catch {
    const store = resolve(process.cwd(), 'node_modules/.pnpm');
    const packageDirectory = readdirSync(store)
      .sort()
      .reverse()
      .find((entry) => /^ajv@8\./u.test(entry));
    if (!packageDirectory) throw new Error('Draft 2020-12 validator Ajv is unavailable');
    const loaded = require(resolve(store, packageDirectory, 'node_modules/ajv/dist/2020.js')) as {
      default?: unknown;
    };
    return (loaded.default ?? loaded) as AjvConstructor;
  }
}

function documentBytes(document: InvalidDocument): Buffer {
  if (document.input.encoding === 'base64') return Buffer.from(document.input.value, 'base64');
  if (document.input.encoding === 'hex') return Buffer.from(document.input.value, 'hex');
  return Buffer.from(document.input.value, 'utf8');
}

class JsonInputError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function detectDuplicateKeysAndNumbers(source: string): void {
  let index = 0;
  const whitespace = () => {
    while (/\s/u.test(source[index] ?? '')) index += 1;
  };
  const string = (): string => {
    const start = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === '\\') {
        index += 2;
      } else if (source[index] === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index)) as string;
      } else {
        index += 1;
      }
    }
    throw new JsonInputError('json_syntax');
  };
  const value = (): void => {
    whitespace();
    if (source[index] === '{') {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (source[index] === '}') {
        index += 1;
        return;
      }
      while (true) {
        if (source[index] !== '"') throw new JsonInputError('json_syntax');
        const key = string();
        if (keys.has(key)) throw new JsonInputError('duplicate_key');
        keys.add(key);
        whitespace();
        if (source[index] !== ':') throw new JsonInputError('json_syntax');
        index += 1;
        value();
        whitespace();
        if (source[index] === '}') {
          index += 1;
          return;
        }
        if (source[index] !== ',') throw new JsonInputError('json_syntax');
        index += 1;
        whitespace();
      }
    }
    if (source[index] === '[') {
      index += 1;
      whitespace();
      if (source[index] === ']') {
        index += 1;
        return;
      }
      while (true) {
        value();
        whitespace();
        if (source[index] === ']') {
          index += 1;
          return;
        }
        if (source[index] !== ',') throw new JsonInputError('json_syntax');
        index += 1;
      }
    }
    if (source[index] === '"') {
      string();
      return;
    }
    for (const literal of ['true', 'false', 'null']) {
      if (source.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(source.slice(index))?.[0];
    if (!token) throw new JsonInputError('json_syntax');
    index += token.length;
    if (/[eE]/u.test(token)) throw new JsonInputError('exponent_number');
    if (token === '-0') throw new JsonInputError('negative_zero');
    if (token.includes('.')) throw new JsonInputError('non_integer');
    if (!Number.isSafeInteger(Number(token))) throw new JsonInputError('unsafe_integer');
  };
  value();
  whitespace();
  if (index !== source.length) throw new JsonInputError('json_syntax');
}

function rejectDocument(bytes: Buffer): string | null {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return 'bom';
  if (bytes.includes(0x0d)) return 'crlf';
  if (bytes.at(-1) !== 0x0a || bytes.at(-2) === 0x0a) return 'blank_line';
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return 'utf8';
  }
  const json = source.slice(0, -1);
  try {
    detectDuplicateKeysAndNumbers(json);
  } catch (error) {
    return error instanceof JsonInputError ? error.code : 'json_syntax';
  }
  try {
    const parsed = JSON.parse(json) as Json;
    return `${canonicalJson(parsed)}\n` === source ? null : 'unsigned_utf8_order';
  } catch {
    return 'json_syntax';
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function pointerParts(pointer: string): string[] {
  return pointer
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function pointerValue(root: Json, pointer: string): Json {
  let current = root;
  for (const part of pointerParts(pointer)) current = (current as JsonObject)[part]!;
  return current;
}

function mutate(root: JsonObject, mutation: JsonObject): void {
  const parts = pointerParts(mutation.path as string);
  const key = parts.pop()!;
  let parent: JsonObject = root;
  for (const part of parts) parent = parent[part] as JsonObject;
  if (mutation.op === 'remove') delete parent[key];
  else parent[key] = mutation.value;
}

function selectRecord(records: RecordFixture[], selector: JsonObject): RecordFixture {
  const matches = records.filter(
    (record) => record.stream === selector.stream && record.recordType === selector.recordType
  );
  return matches[(selector.ordinal as number | undefined) ?? 0]!;
}

function canonicalWithRaw(value: Json, path: string[], rawJson: string): string {
  if (path.length === 0) return rawJson;
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error('bad raw path');
  const [next, ...rest] = path;
  return `{${Object.entries(value)
    .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
    .map(([key, entry]) =>
      `${JSON.stringify(key)}:${key === next ? canonicalWithRaw(entry, rest, rawJson) : canonicalJson(entry)}`
    )
    .join(',')}}`;
}

function instanceFor(record: RecordFixture, instances: ContractInstance[]): ContractInstance | undefined {
  return instances.find((instance) => instance.producerRole === record.producer.role);
}

function mapDraft202012Error(
  record: RecordFixture,
  errors: unknown,
  instances: ContractInstance[]
): string {
  if (!Array.isArray(errors) || errors.length === 0) throw new Error('missing-ajv-draft-2020-12-error');
  const ajvErrors = errors as AjvError[];
  const hasError = (instancePath: string, keyword: string, parameter?: [string, Json]): boolean =>
    ajvErrors.some((error) =>
      error.instancePath === instancePath && error.keyword === keyword &&
      (parameter === undefined || error.params[parameter[0]] === parameter[1])
    );
  const mapped = (condition: boolean, code: string, errorPresent: boolean): string | null => {
    if (!condition) return null;
    if (!errorPresent) throw new Error(`ajv-error-map-missing:${code}`);
    return code;
  };
  let code = mapped(record.version !== 2, 'unsupported_version', hasError('/version', 'const'));
  if (code) return code;
  if (!['browser', 'opencode', 'owner', 'product-producer'].includes(record.producer.role as string)) {
    code = mapped(true, 'role', hasError('/producer/role', 'enum'));
    if (code) return code;
  }
  code = mapped(record.producer.implementationId === undefined, 'missing_key',
    hasError('/producer', 'required', ['missingProperty', 'implementationId']));
  if (code) return code;
  code = mapped(typeof record.sequence === 'string', 'numeric_coercion', hasError('/sequence', 'type'));
  if (code) return code;
  code = mapped('debug' in record.native, 'unknown_key',
    hasError('/native', 'additionalProperties', ['additionalProperty', 'debug']));
  if (code) return code;
  code = mapped(record.native.outcome === 'unknown', 'outcome', hasError('/native/outcome', 'enum'));
  if (code) return code;
  code = mapped(record.native.status === 201, 'status_outcome', hasError('/native/status', 'const'));
  if (code) return code;
  if (
    record.recordType === 'hosted-reply-raw' &&
    record.native.configGeneration === null &&
    record.native.runtimeInstanceId !== null
  ) {
    code = mapped(true, 'nullability', hasError('/native/runtimeInstanceId', 'type'));
    if (code) return code;
  }
  const roleInstance = instanceFor(record, instances);
  code = mapped(Boolean(roleInstance && !(record.stream in roleInstance.streams)), 'stream',
    hasError('/stream', 'const'));
  if (code) return code;
  if (roleInstance && record.recordType === 'producer-open') {
    const expectedFd = (roleInstance.streams[record.stream] as JsonObject | undefined)?.fd;
    code = mapped((record.native.descriptor as JsonObject).fd !== expectedFd, 'descriptor_fd',
      hasError('/native/descriptor/fd', 'const'));
    if (code) return code;
  }
  return 'schema';
}

function rejectRecord(
  record: RecordFixture,
  instances: ContractInstance[],
  validateRecord: SchemaValidate
): string | null {
  if (!validateRecord(record)) {
    return mapDraft202012Error(record, validateRecord.errors, instances);
  }
  if (
    record.contractSha256 === HISTORICAL_DIGEST ||
    record.contractSha256 === SUPERSEDED_V2_DIGEST
  ) {
    return 'old_digest';
  }
  const instance = instanceFor(record, instances);
  if (!instance) return 'role';
  if (record.producer.implementationId !== instance.expectedProducer.implementationId) return 'implementation';
  if (record.producer.artifactManifestSha256 !== instance.expectedProducer.artifactManifestSha256) {
    return 'artifact';
  }
  if (record.producer.moduleSha256 !== instance.expectedProducer.moduleSha256) return 'module';
  if (record.producer.exeSha256 !== instance.expectedProducer.executableSha256) return 'executable';
  return null;
}

function rejectChain(records: RecordFixture[]): string | null {
  if (new Set(records.map((record) => record.emissionNonce)).size !== records.length) {
    return 'emission_nonce_unique';
  }
  const streams = new Map<string, RecordFixture[]>();
  for (const record of records) {
    const entries = streams.get(record.stream) ?? [];
    entries.push(record);
    streams.set(record.stream, entries);
  }
  for (const chain of streams.values()) {
    chain.sort((left, right) => left.sequence - right.sequence);
    if (chain[0]?.recordType !== 'producer-open' || chain[0].previousRecordSha256 !== null) {
      return 'chain_open';
    }
    if (chain.at(-1)?.recordType !== 'producer-close') return 'chain_close';
    for (let index = 0; index < chain.length; index += 1) {
      if (chain[index].sequence !== index) return 'chain_sequence';
      if (index > 0) {
        const expected = sha256(`${canonicalJson(chain[index - 1])}\n`);
        if (chain[index].previousRecordSha256 !== expected) return 'chain_predecessor';
      }
    }
  }
  return null;
}

function semanticRecords(group: OperationGroup): RecordFixture[] {
  return group.records.filter((record) => !record.recordType.startsWith('producer-'));
}

function rejectNonceGrouping(group: OperationGroup): string | null {
  const records = semanticRecords(group);
  return new Set(records.map((record) => record.operationNonce)).size === 1 ? null : 'operation_nonce';
}

function rejectOperationSemantics(group: OperationGroup): string | null {
  const records = semanticRecords(group);
  const raw = records.filter((record) => record.recordType === 'hosted-reply-raw');
  const typed = records.filter((record) => record.recordType === 'hosted-reply');
  const effects = records.filter((record) => record.recordType === 'conditional-reply-effect');
  const decisions = records.filter((record) => record.recordType === 'decision-compare-and-claim-verified');
  const http = records.filter((record) => record.recordType === 'approval-http-response-finalized');
  if (raw.length !== typed.length) return 'semantic_consumption';
  if (typed.length > 0) {
    const reply = typed[0];
    const rawReply = raw[0];
    for (const key of ['requestId', 'requestIncarnation', 'runtimeInstanceId', 'sessionId', 'sessionIncarnation']) {
      if (reply.native[key] !== rawReply.native[key]) return 'semantic_consumption';
    }
    if (reply.native.outcome !== rawReply.native.outcome || reply.native.status !== rawReply.native.status) {
      return 'semantic_consumption';
    }
    const requiredEffects = reply.native.outcome === 'applied' ? 1 : 0;
    if (effects.length !== requiredEffects) return 'operation_effect_cardinality';
    if (effects.length === 1) {
      const expectedDecision = reply.native.decision === 'allow_once' ? 'once' : 'reject';
      if (effects[0].native.decision !== expectedDecision) return 'decision_mapping';
      for (const key of ['requestId', 'requestIncarnation', 'runtimeInstanceId', 'sessionId', 'sessionIncarnation']) {
        if (effects[0].native[key] !== reply.native[key]) return 'semantic_consumption';
      }
    }
  }
  if (decisions.length > 0 || http.length > 0) {
    if (decisions.length !== 1 || http.length !== 1) return 'semantic_consumption';
    for (const key of ['requestId', 'sessionId', 'actorId', 'bootId', 'deploymentId']) {
      if (decisions[0].native[key] !== http[0].native[key]) return 'semantic_consumption';
    }
    if (decisions[0].native.outcome !== http[0].native.outcome) return 'decision_mapping';
    const idempotency = group.joinEvidence?.idempotencyKeyUtf8 as string;
    if (decisions[0].native.idempotencyKeySha256 !== sha256(idempotency)) return 'idempotency_digest';
  }
  const browser = records.find((record) => record.recordType === 'browser-negative-response-observed');
  if (browser) {
    if (
      browser.native.requestBodySha256 !== sha256(group.joinEvidence?.requestBodyUtf8 as string) ||
      browser.native.responseBodySha256 !== sha256(group.joinEvidence?.responseBodyUtf8 as string)
    ) {
      return 'wire_hash';
    }
  }
  return null;
}

function rejectOperationGroup(group: OperationGroup): string | null {
  return rejectChain(group.records) ?? rejectNonceGrouping(group) ?? rejectOperationSemantics(group);
}

function rechain(records: RecordFixture[]): void {
  const streams = new Map<string, RecordFixture[]>();
  for (const record of records) {
    const entries = streams.get(record.stream) ?? [];
    entries.push(record);
    streams.set(record.stream, entries);
  }
  for (const chain of streams.values()) {
    chain.sort((left, right) => left.sequence - right.sequence);
    let predecessor: string | null = null;
    for (let index = 0; index < chain.length; index += 1) {
      chain[index].sequence = index;
      chain[index].previousRecordSha256 = predecessor;
      predecessor = sha256(`${canonicalJson(chain[index])}\n`);
    }
  }
}

function materializeOwnerMutationFixture(
  fixture: InvalidFixture,
  golden: Golden
): { record: RecordFixture; records: RecordFixture[] } {
  const records = clone(golden.validRecords.filter((record) => record.stream === fixture.base.stream));
  const targetCount = fixture.materializedRecordCount!;
  const semanticTemplates = records.filter((record) =>
    record.recordType !== 'producer-open' && record.recordType !== 'producer-close'
  );
  const close = records.pop()!;
  for (let index = 0; records.length + 1 < targetCount; index += 1) {
    const added = clone(semanticTemplates[index % semanticTemplates.length]);
    added.emissionNonce = sha256(`${fixture.id}:emission:${index}`);
    added.operationNonce = sha256(`${fixture.id}:operation:${index}`);
    records.push(added);
  }
  records.push(close);
  const record = selectRecord(records, fixture.base);
  mutate(record, fixture.mutation);
  rechain(records);
  return { record, records };
}

function mutatedGroup(fixture: InvalidFixture, golden: Golden): OperationGroup {
  const groupId = fixture.base.operationGroupId as string;
  const source = golden.operationGroups.find((candidate) => candidate.id === groupId)!;
  const group = clone(source);
  const mutation = fixture.mutation;
  if (mutation.op === 'replace-selected') {
    const record = group.records.find((entry) => entry.recordType === mutation.recordType)!;
    mutate(record, { op: 'replace', path: mutation.path, value: mutation.value });
  } else if (mutation.op === 'duplicate-selected') {
    const record = clone(group.records.find((entry) => entry.recordType === mutation.recordType)!);
    record.emissionNonce = sha256(`duplicate:${record.emissionNonce}`);
    group.records.splice(group.records.indexOf(group.records.find((entry) => entry.recordType === 'producer-close' && entry.stream === record.stream)!), 0, record);
  } else if (mutation.op === 'remove-selected') {
    group.records = group.records.filter((entry) => entry.recordType !== mutation.recordType);
  } else if (mutation.op === 'replace-retained-bytes') {
    group.joinEvidence = { ...group.joinEvidence };
    group.joinEvidence[mutation.domain as string] = Buffer.from(
      mutation.valueBase64 as string,
      'base64'
    ).toString('utf8');
  }
  rechain(group.records);
  return group;
}

function sameJson(left: Json, right: Json): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function rejectContractEvidence(fixture: InvalidFixture): string | null {
  const evidence = clone(fixture.base);
  mutate(evidence, fixture.mutation);
  const contractPin = evidence.contractPin as JsonObject | undefined;
  if (
    contractPin?.acceptedSha256 === SCHEMA_SHA256 &&
    (contractPin.presentedSha256 === HISTORICAL_DIGEST ||
      contractPin.presentedSha256 === SUPERSEDED_V2_DIGEST)
  ) {
    return 'old_digest';
  }
  const contractBinding = evidence.contractBinding as JsonObject | undefined;
  if (contractBinding) {
    const expectedProducer = contractBinding.expectedProducer as JsonObject;
    const observedProducer = contractBinding.observedProducer as JsonObject;
    if (observedProducer.implementationId !== expectedProducer.implementationId) return 'implementation';
    if (observedProducer.artifactManifestSha256 !== expectedProducer.artifactManifestSha256) return 'artifact';
    if (observedProducer.moduleSha256 !== expectedProducer.moduleSha256) return 'module';
    if (observedProducer.exeSha256 !== expectedProducer.executableSha256) return 'executable';
  }
  const compatibility = evidence.compatibility as JsonObject | undefined;
  if (
    compatibility?.oldDigestAccepted !== undefined &&
    (compatibility.oldDigestAccepted !== false || compatibility.supersededSha256 === SCHEMA_SHA256)
  ) {
    return 'compatibility_fallback';
  }
  const candidatePin = evidence.candidatePin as JsonObject | undefined;
  if (
    candidatePin?.source === 'containing-artifact-bytes' &&
    candidatePin.value === evidence.containingBytesSha256
  ) {
    return 'self_hash';
  }
  const candidate = evidence.candidate as JsonObject | undefined;
  if (!candidate) return null;
  const expected = evidence.expected as JsonObject;
  const observed = evidence.observed as JsonObject;
  const candidatePins = evidence.candidatePins as JsonObject;
  const buildPins = evidence.buildPins as JsonObject;
  const observedLstat = observed.lstat as JsonObject;
  const expectedDescriptor = expected.descriptor as JsonObject;
  const observedDescriptor = observed.descriptor as JsonObject;
  if (
    candidate.requestedPath !== candidate.canonicalPath ||
    observed.openedPath !== candidate.canonicalPath ||
    observed.canonicalPath !== candidate.canonicalPath ||
    observed.realpath !== candidate.canonicalPath ||
    observedLstat.kind !== 'regular-file' ||
    !sameJson(observedDescriptor, expectedDescriptor) ||
    observedLstat.device !== expectedDescriptor.device ||
    observedLstat.inode !== expectedDescriptor.inode
  ) {
    return 'pinned_inode';
  }
  if (
    expected.openedSha256 !== candidatePins.executableSha256 ||
    expected.openedSha256 !== buildPins.executableSha256 ||
    candidatePins.artifactManifestSha256 !== buildPins.artifactManifestSha256 ||
    candidatePins.moduleSha256 !== buildPins.moduleSha256 ||
    observed.openedSha256 !== expected.openedSha256
  ) {
    return 'pinned_bytes';
  }
  const postOpen = observed.postOpen as JsonObject;
  const postOpenLstat = postOpen.lstat as JsonObject;
  if (
    postOpen.canonicalPath !== candidate.canonicalPath ||
    postOpen.realpath !== candidate.canonicalPath ||
    postOpenLstat.kind !== 'regular-file' ||
    !sameJson(postOpen.descriptor as Json, expectedDescriptor) ||
    postOpenLstat.device !== expectedDescriptor.device ||
    postOpenLstat.inode !== expectedDescriptor.inode ||
    postOpen.openedSha256 !== expected.openedSha256
  ) {
    return 'pinned_descriptor';
  }
  return null;
}

function rejectOwnerMutation(record: RecordFixture, retained: JsonObject): string | null {
  const previousBytes = Buffer.from(retained.previousWalUtf8 as string);
  const nextBytes = Buffer.from(retained.nextWalUtf8 as string);
  const previous = JSON.parse(previousBytes.toString('utf8')) as JsonObject;
  const next = JSON.parse(nextBytes.toString('utf8')) as JsonObject;
  const stateDelta = record.native.stateDelta as JsonObject;
  if (
    stateDelta.previousStateSha256 !== sha256(previousBytes) ||
    stateDelta.nextStateSha256 !== sha256(nextBytes) ||
    (record.native.wal as JsonObject).sha256 !== sha256(nextBytes)
  ) {
    return 'wire_hash';
  }
  const changedKeys = [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .filter((key) => !sameJson(previous[key] ?? null, next[key] ?? null))
    .sort();
  const declared = record.native.mutation as JsonObject;
  return changedKeys.length === 1 && changedKeys[0] === 'revision' &&
    declared.kind === 'admission-reconciled' && declared.outcome === 'published'
    ? null
    : 'owner_mutation';
}

function rejectRetainedMutation(fixture: InvalidFixture, golden: Golden): string | null {
  const base = selectRecord(golden.validRecords, fixture.base);
  const mutation = fixture.mutation;
  const original = Buffer.from(mutation.originalBase64 as string, 'base64');
  const changed = Buffer.from(mutation.mutatedBase64 as string, 'base64');
  return pointerValue(base, mutation.field as string) === sha256(original) && sha256(changed) !== sha256(original)
    ? 'wire_hash'
    : null;
}

function executeInvalidFixture(
  fixture: InvalidFixture,
  golden: Golden,
  validateRecord: SchemaValidate
): FixtureResult {
  const result = (primary: string | null, earlierFailures: Array<string | null> = []): FixtureResult => ({
    earlierFailures: earlierFailures.filter((failure): failure is string => failure !== null),
    layer: fixture.layer,
    primaryFailures: primary === null ? [] : [primary],
  });
  if (fixture.layer === 'canonical-serializer') {
    const base = selectRecord(golden.validRecords, fixture.base);
    const input = `${canonicalWithRaw(base, pointerParts(fixture.mutation.path as string), fixture.mutation.rawJson as string)}\n`;
    return result(rejectDocument(Buffer.from(input)));
  }
  if (fixture.layer === 'draft-2020-12-validator') {
    const base = selectRecord(golden.validRecords, fixture.base);
    const record = clone(base);
    mutate(record, fixture.mutation);
    const valid = validateRecord(record);
    return result(valid ? null : mapDraft202012Error(record, validateRecord.errors, golden.validContractInstances));
  }
  if (fixture.layer === 'contract-instance-verifier') {
    if (!('recordType' in fixture.base)) return result(rejectContractEvidence(fixture));
    const record = clone(selectRecord(golden.validRecords, fixture.base));
    mutate(record, fixture.mutation);
    const valid = validateRecord(record);
    return result(
      valid ? rejectRecord(record, golden.validContractInstances, validateRecord) : null,
      [valid ? null : mapDraft202012Error(record, validateRecord.errors, golden.validContractInstances)]
    );
  }
  if (fixture.id === 'owner-mutation-state-disagreement') {
    const { record, records } = materializeOwnerMutationFixture(fixture, golden);
    const recordFailures = records.map((entry) => rejectRecord(entry, golden.validContractInstances, validateRecord));
    return result(rejectOwnerMutation(record, fixture.retained!), [...recordFailures, rejectChain(records)]);
  }
  if (fixture.mutation.op === 'retained-byte-mutation') {
    const base = selectRecord(golden.validRecords, fixture.base);
    return result(rejectRetainedMutation(fixture, golden), [
      rejectRecord(base, golden.validContractInstances, validateRecord),
    ]);
  }
  if (fixture.id === 'duplicate-emission-nonce') {
    const records = clone(golden.validRecords.filter((record) => record.stream === fixture.base.stream));
    const from = records.find((record) => record.recordType === fixture.mutation.fromRecordType)!;
    const to = records.find((record) => record.recordType === fixture.mutation.toRecordType)!;
    to.emissionNonce = from.emissionNonce;
    rechain(records);
    return result(rejectChain(records), records.map((entry) =>
      rejectRecord(entry, golden.validContractInstances, validateRecord)
    ));
  }
  if (fixture.id === 'reused-operation-nonce') {
    const [leftId, rightId] = fixture.base.operationGroupIds as string[];
    const left = clone(golden.operationGroups.find((group) => group.id === leftId)!);
    const right = clone(golden.operationGroups.find((group) => group.id === rightId)!);
    const reused = semanticRecords(left)[0].operationNonce;
    for (const record of semanticRecords(right)) record.operationNonce = reused;
    rechain(right.records);
    const primary = new Set([...semanticRecords(left), ...semanticRecords(right)].map((record) => record.operationNonce)).size === 1
      ? 'operation_nonce_reuse' : null;
    return result(primary, [rejectChain(left.records), rejectChain(right.records),
      ...[...left.records, ...right.records].map((record) =>
        rejectRecord(record, golden.validContractInstances, validateRecord)
      )]);
  }
  const group = mutatedGroup(fixture, golden);
  const recordFailures = group.records.map((record) =>
    rejectRecord(record, golden.validContractInstances, validateRecord)
  );
  const chainFailure = rejectChain(group.records);
  const nonceFailure = rejectNonceGrouping(group);
  if (fixture.layer === 'nonce-grouping-verifier') {
    return result(nonceFailure, [...recordFailures, chainFailure]);
  }
  return result(rejectOperationSemantics(group), [...recordFailures, chainFailure, nonceFailure]);
}

describe('hosted producer provenance v2 frozen artifacts', () => {
  const schemaArtifact = parseCanonicalArtifact(SCHEMA_PATH);
  const goldenArtifact = parseCanonicalArtifact(GOLDEN_PATH);
  const schema = schemaArtifact.value as JsonObject;
  const golden = goldenArtifact.value as unknown as Golden;
  const Ajv2020 = loadDraft202012();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validateRecord = ajv.compile(schema);
  const contractInstanceSchema = clone(schema);
  delete contractInstanceSchema.$id;
  contractInstanceSchema.$ref = '#/$defs/contractInstance';
  const validateContractInstance = ajv.compile(contractInstanceSchema);

  it('pins canonical schema identity and all four contract instances', () => {
    expect(schemaArtifact.bytes).toHaveLength(56_415);
    expect(sha256(schemaArtifact.bytes)).toBe(SCHEMA_SHA256);
    expect(schemaArtifact.bytes.toString()).not.toContain(SCHEMA_SHA256);
    expect((schema['x-contract'] as JsonObject).contract).toBe(CONTRACT);
    expect(golden.validContractInstances).toHaveLength(4);
    for (const instance of golden.validContractInstances) {
      expect(validateContractInstance(instance), JSON.stringify(validateContractInstance.errors)).toBe(true);
    }
    for (const rejectedDigest of [HISTORICAL_DIGEST, SUPERSEDED_V2_DIGEST]) {
      const oldDigestInstance = clone(golden.validContractInstances[0]);
      oldDigestInstance.contractSha256 = rejectedDigest;
      expect(validateContractInstance(oldDigestInstance)).toBe(false);
      const oldDigestRecord = clone(
        golden.validRecords.find((record) => record.recordType === 'owner-wal-published')!
      );
      oldDigestRecord.contractSha256 = rejectedDigest;
      expect(validateRecord(oldDigestRecord)).toBe(false);
    }
  });

  it('pins the exact WAL3 amendment shape and the P2 image-verification boundary', () => {
    const definitions = schema.$defs as JsonObject;
    const stateDelta = definitions.stateDelta as JsonObject;
    const deltaProperties = stateDelta.properties as JsonObject;
    const changedFields = deltaProperties.changedFields as JsonObject;
    const collectionSizes = deltaProperties.collectionSizes as JsonObject;
    expect((changedFields.items as JsonObject).enum).toEqual([
      'actorMembers', 'admissionDigest', 'admissionGeneration', 'bindings', 'deliveries',
      'ingress', 'retiredIngress', 'revision', 'routes', 'schemaVersion', 'writerFence',
    ]);
    expect(collectionSizes.required).toEqual([
      'actorMembers', 'bindings', 'deliveries', 'ingress', 'retiredIngress', 'routes',
    ]);
    expect(Object.keys(collectionSizes.properties as JsonObject).sort()).toEqual(
      collectionSizes.required
    );
    expect(((definitions.ownerMutation as JsonObject).oneOf as Json[])).toHaveLength(12);
    const contractMetadata = schema['x-contract'] as JsonObject;
    expect(contractMetadata.compatibility).toMatchObject({
      acceptedVersions: [2],
      oldDigestAccepted: false,
      simultaneousV1V2Accepted: false,
      supersededSha256: SUPERSEDED_V2_DIGEST,
      translationAccepted: false,
    });
    expect(golden.metadata).toMatchObject({
      oldDigestAccepted: false,
      supersededSha256: SUPERSEDED_V2_DIGEST,
    });
    expect(contractMetadata.ownerMutationVerification).toContain('raw stored predecessor P');
    expect(contractMetadata.ownerMutationVerification).toContain('working M');
    expect(contractMetadata.ownerMutationVerification).toContain('schema-3 N');
    expect(contractMetadata.ownerMutationVerification).toContain('mandatory P2 verification');

    const quarantine = clone(
      golden.validRecords.find(
        (record) => (record.native.mutation as JsonObject | undefined)?.kind === 'binding-quarantined'
      )!
    );
    expect(validateRecord(quarantine), JSON.stringify(validateRecord.errors)).toBe(true);
    for (const mutateRecord of [
      (record: RecordFixture) => {
        delete ((record.native.stateDelta as JsonObject).collectionSizes as JsonObject).bindings;
      },
      (record: RecordFixture) => {
        ((record.native.stateDelta as JsonObject).collectionSizes as JsonObject).quarantine = {
          next: 1,
          previous: 0,
        };
      },
      (record: RecordFixture) => {
        (record.native.mutation as JsonObject).outcome = 'admitted';
      },
    ]) {
      const invalid = clone(quarantine);
      mutateRecord(invalid);
      expect(validateRecord(invalid)).toBe(false);
    }
  });

  it('validates every positive record and exhaustive admitted variant tuple', () => {
    for (const record of golden.validRecords) {
      expect(validateRecord(record), JSON.stringify(validateRecord.errors)).toBe(true);
      expect(rejectRecord(record, golden.validContractInstances, validateRecord)).toBeNull();
    }
    const expectedCounts: Record<string, number> = {
      'approval-http-response-finalized': 20,
      'approval-http-unadmitted-response-finalized': 3,
      'browser-negative-response-observed': 6,
      'conditional-reply-effect': 4,
      'coordination-sse-write-succeeded': 3,
      'decision-compare-and-claim-verified': 4,
      'hosted-capability': 1,
      'hosted-observe': 2,
      'hosted-reply': 8,
      'hosted-reply-raw': 8,
      'owner-wal-published': 12,
      'producer-close': 6,
      'producer-open': 6,
    };
    expect(
      Object.fromEntries(
        Object.keys(expectedCounts).map((recordType) => [
          recordType,
          golden.validRecords.filter((record) => record.recordType === recordType).length,
        ])
      )
    ).toEqual(expectedCounts);
    expect(golden.validRecords).toHaveLength(83);

    const variants = (recordType: string, project: (native: JsonObject) => Json[]) =>
      golden.validRecords
        .filter((record) => record.recordType === recordType)
        .map((record) => JSON.stringify(project(record.native)))
        .sort();
    const expected = (entries: Json[][]) => entries.map((entry) => JSON.stringify(entry)).sort();
    expect(variants('decision-compare-and-claim-verified', (native) => [native.decision, native.outcome])).toEqual(
      expected([
        ['allow', 'committed'], ['allow', 'idempotent_replay'],
        ['deny', 'committed'], ['deny', 'idempotent_replay'],
      ])
    );
    expect(variants('approval-http-unadmitted-response-finalized', (native) => [native.routeId, native.status, native.outcome])).toEqual(
      expected([
        ['team-approvals.page.v1', 503, 'unadmitted'],
        ['team-approvals.preview.v1', 503, 'unadmitted'],
        ['team-approvals.decision.v1', 503, 'unadmitted'],
      ])
    );
    expect(variants('approval-http-response-finalized', (native) => [native.routeId, native.status, native.outcome])).toEqual(
      expected([
        ['team-approvals.page.v1', 200, 'success'],
        ['team-approvals.page.v1', 400, 'invalid_request'],
        ['team-approvals.page.v1', 404, 'not_found'],
        ['team-approvals.page.v1', 503, 'cancelled'],
        ['team-approvals.page.v1', 503, 'unavailable'],
        ['team-approvals.preview.v1', 200, 'success'],
        ['team-approvals.preview.v1', 400, 'invalid_request'],
        ['team-approvals.preview.v1', 409, 'stale_generation'],
        ['team-approvals.preview.v1', 404, 'not_found'],
        ['team-approvals.preview.v1', 503, 'cancelled'],
        ['team-approvals.preview.v1', 503, 'unavailable'],
        ['team-approvals.decision.v1', 200, 'committed'],
        ['team-approvals.decision.v1', 200, 'idempotent_replay'],
        ['team-approvals.decision.v1', 409, 'already_resolved'],
        ['team-approvals.decision.v1', 400, 'invalid_request'],
        ['team-approvals.decision.v1', 409, 'stale_generation'],
        ['team-approvals.decision.v1', 409, 'conflict'],
        ['team-approvals.decision.v1', 410, 'expired'],
        ['team-approvals.decision.v1', 404, 'not_found'],
        ['team-approvals.decision.v1', 503, 'unavailable'],
      ])
    );
    expect(variants('coordination-sse-write-succeeded', (native) => [native.frameKind, native.eventId, native.eventType])).toEqual(
      expected([
        ['coordination_event', 'event_1', 'task_updated'],
        ['heartbeat', null, null],
        ['resync_required', null, 'resync_required'],
      ])
    );
    expect(variants('browser-negative-response-observed', (native) => [native.requestFamily, native.httpStatus, native.observedOutcome])).toEqual(
      expected([
        ['approval-page', 403, 'cross_team_list_rejected'],
        ['approval-page', 404, 'cross_team_list_rejected'],
        ['approval-preview', 403, 'cross_team_preview_rejected'],
        ['approval-preview', 404, 'cross_team_preview_rejected'],
        ['approval-decision', 403, 'cross_team_decide_rejected'],
        ['approval-decision', 404, 'cross_team_decide_rejected'],
      ])
    );
    expect(variants('hosted-capability', (native) => [native.status, native.outcome])).toEqual(
      expected([[200, 'ok']])
    );
    expect(variants('hosted-observe', (native) => [native.status, native.outcome])).toEqual(
      expected([[200, 'ok'], [500, 'overflow']])
    );
    expect(variants('hosted-reply', (native) => [
      native.status, native.outcome, native.decision,
      native.configGeneration !== null, native.runtimeInstanceId !== null,
      'responseSha256' in native,
    ])).toEqual(expected([
      [400, 'bad-request', 'allow_once', false, false, false],
      [400, 'bad-request', 'reject', false, false, false],
      [412, 'precondition-failed', 'allow_once', false, false, false],
      [412, 'precondition-failed', 'reject', false, false, false],
      [409, 'conflict', 'allow_once', false, false, false],
      [409, 'conflict', 'reject', false, false, false],
      [200, 'applied', 'allow_once', true, true, true],
      [200, 'applied', 'reject', true, true, true],
    ]));
    expect(variants('hosted-reply-raw', (native) => [
      native.status, native.outcome, native.configGeneration !== null,
      native.runtimeInstanceId !== null, 'responseSha256' in native,
    ])).toEqual(expected([
      [404, 'unavailable', false, false, true],
      [400, 'body-read-failed', false, false, true],
      [400, 'invalid-json', false, false, true],
      [400, 'invalid-schema', false, false, true],
      [400, 'bad-request', false, false, true],
      [409, 'conflict', false, false, true],
      [412, 'precondition-failed', false, false, true],
      [200, 'applied', true, true, true],
    ]));
    expect(variants('conditional-reply-effect', (native) => [
      native.decision, native.outcome, native.configGeneration !== null,
      native.runtimeInstanceId !== null, native.permissionDigest !== null,
    ])).toEqual(expected([
      ['once', 'applied', true, true, true],
      ['once', 'mismatch', true, true, false],
      ['reject', 'applied', true, true, true],
      ['reject', 'mismatch', true, true, false],
    ]));
    expect(variants('owner-wal-published', (native) => {
      const mutation = native.mutation as JsonObject;
      return [mutation.kind, mutation.outcome, mutation.phase ?? null];
    })).toEqual(expected([
      ['admission-reconciled', 'published', null],
      ['ingress-admitted', 'admitted', null],
      ['binding-quarantined', 'quarantined', null],
      ['ingress-lease-claimed', 'claimed', null],
      ['ingress-acknowledged', 'acknowledged', null],
      ['delivery-started', 'started', null],
      ['delivery-settled', 'delivered', 'completed'],
      ['delivery-settled', 'stale_generation', 'rejected'],
      ['delivery-settled', 'expired', 'rejected'],
      ['delivery-settled', 'wrong_lane', 'rejected'],
      ['delivery-settled', 'self_approval', 'rejected'],
      ['delivery-settled', 'unavailable', 'rejected'],
    ]));
  });

  it('proves every admitted stream is a complete canonical hash chain ending in close', () => {
    expect(rejectChain(golden.validRecords)).toBeNull();
    expect(new Set(golden.validRecords.map((record) => record.stream)).size).toBe(6);
    expect(golden.canonicalExamples).toHaveLength(83);
    for (const example of golden.canonicalExamples) {
      const record = golden.validRecords[example.recordIndex];
      expect(example.canonicalUtf8).toBe(canonicalJson(record));
      expect(example.sha256).toBe(sha256(`${example.canonicalUtf8}\n`));
    }
  });

  it('validates complete operation histories, nonce cardinality, mappings, effects, and joins', () => {
    expect(golden.operationGroups.map((group) => [group.id, group.records.length])).toEqual([
      ['browser-independent', 3],
      ['opencode-applied', 7],
      ['opencode-failed', 4],
      ['product-decision-http', 6],
    ]);
    for (const group of golden.operationGroups) {
      for (const record of group.records) {
        expect(validateRecord(record), JSON.stringify(validateRecord.errors)).toBe(true);
        expect(rejectRecord(record, golden.validContractInstances, validateRecord)).toBeNull();
      }
      expect(rejectOperationGroup(group)).toBeNull();
    }
  });

  it('executes every raw parser, duplicate-key, and canonical-number rejection', () => {
    expect(golden.invalidDocuments).toHaveLength(10);
    for (const document of golden.invalidDocuments) {
      expect(rejectDocument(documentBytes(document)), `${document.layer}:${document.id}`).toBe(
        document.expectedCode
      );
    }
  });

  it('materializes the owner mutation negative as exactly 20 otherwise valid records', () => {
    const fixture = golden.invalidFixtures[20];
    expect(fixture.id).toBe('owner-mutation-state-disagreement');
    expect(fixture.materializedRecordCount).toBe(20);
    const { record, records } = materializeOwnerMutationFixture(fixture, golden);
    expect(records).toHaveLength(20);
    expect(new Set(records.map((entry) => entry.emissionNonce)).size).toBe(20);
    expect(rejectChain(records)).toBeNull();
    for (const entry of records) {
      expect(validateRecord(entry), JSON.stringify(validateRecord.errors)).toBe(true);
      expect(rejectRecord(entry, golden.validContractInstances, validateRecord)).toBeNull();
    }
    expect(rejectOwnerMutation(record, fixture.retained!)).toBe('owner_mutation');
  });

  it('materializes and executes every mandatory layer-specific negative with its exact code', () => {
    expect(golden.invalidFixtures).toHaveLength(43);
    for (const fixture of golden.invalidFixtures) {
      const outcome = executeInvalidFixture(fixture, golden, validateRecord);
      expect(outcome.layer, fixture.id).toBe(fixture.layer);
      expect(outcome.earlierFailures, `${fixture.layer}:${fixture.id}:earlier`).toEqual([]);
      expect(outcome.primaryFailures, `${fixture.layer}:${fixture.id}:primary`).toEqual([
        fixture.expectedCode,
      ]);
    }
    const mandatory = [
      'artifact-mismatch', 'artifact-self-hash-cycle', 'blank-line', 'bom',
      'browser-wire-hash-mismatch', 'compatibility-fallback', 'crlf', 'duplicate-emission-nonce',
      'duplicate-key', 'executable-mismatch', 'exponent', 'float', 'http-one-byte-change',
      'implementation-mismatch', 'invalid-nullability', 'invalid-outcome', 'invalid-status-pair',
      'locale-order', 'manifest-self-hash-cycle', 'missing-key', 'module-mismatch', 'negative-zero',
      'noncanonical-utf8', 'numeric-string', 'old-digest', 'opencode-cross-stream-nonce-mismatch',
      'opencode-decision-mismatch', 'opencode-extra-effect', 'opencode-missing-effect',
      'owner-mutation-state-disagreement', 'post-open-replacement',
      'private-opencode-v1', 'product-idempotency-digest-mismatch',
      'product-operation-nonce-mismatch', 'record-self-hash-cycle', 'reused-operation-nonce',
      'role-alias', 'role-prefix', 'role-wildcard', 'same-path-changed-bytes', 'self-hash-cycle',
      'split-role', 'sse-whitespace-change', 'symlink-inode-substitution', 'unconsumed-semantic-record',
      'superseded-v2-digest', 'unknown-key', 'unsafe-integer', 'utf16-order', 'wal-one-byte-change',
      'wrong-fd', 'wrong-stream',
    ];
    const ids = [
      ...golden.invalidDocuments.map((fixture) => fixture.id),
      ...golden.invalidFixtures.map((fixture) => fixture.id),
    ].filter((id) => id !== 'json-syntax');
    expect(ids.sort()).toEqual(mandatory.sort());
  });

  it('proves all 53 negatives have one intended primary failure and no earlier competitor', () => {
    const structured = golden.invalidFixtures.map((fixture) => ({
      ...executeInvalidFixture(fixture, golden, validateRecord),
      id: fixture.id,
    }));
    const documents = golden.invalidDocuments.map((fixture) => ({
      earlierFailures: [],
      id: fixture.id,
      layer: fixture.layer,
      primaryFailures: [rejectDocument(documentBytes(fixture))],
    }));
    const outcomes = [...documents, ...structured];
    expect(outcomes).toHaveLength(53);
    for (const outcome of outcomes) {
      expect(outcome.earlierFailures, `${outcome.id}:earlier`).toEqual([]);
      expect(outcome.primaryFailures, `${outcome.id}:primary`).toHaveLength(1);
      expect(outcome.primaryFailures[0], `${outcome.id}:missing-primary`).not.toBeNull();
    }
    expect(
      Object.fromEntries(
        [...new Set(outcomes.map((outcome) => outcome.layer))]
          .sort()
          .map((layer) => [layer, outcomes.filter((outcome) => outcome.layer === layer).length])
      )
    ).toEqual({
      'canonical-serializer': 6,
      'contract-instance-verifier': 14,
      'cross-record-join-verifier': 10,
      'draft-2020-12-validator': 13,
      'duplicate-key-detector': 1,
      'hash-chain-verifier': 1,
      'json-parser': 5,
      'nonce-grouping-verifier': 3,
    });
  });
});
