import { createHash } from 'node:crypto';

export const OWNER_LOCK_FILENAME = 'hosted-lifecycle-owner.lock.json';
export const STACK_LOCK_FILENAME = 'hosted-stack.lock.json';
export const OWNER_LOCK_TYPE = 'hosted-lifecycle-owner';
export const STACK_LOCK_TYPE = 'hosted-stack';
export const LOCK_SCHEMA_VERSION = 1;
export const MAX_LOCK_BYTES = 1024 * 1024;

// The accepted topology used hosted-lifecycle-owner-runtime.lock.json as a provisional name.
// P3.S5 standardizes the future materialized lock name above; it does not create that lock.
export const LEGACY_HOSTED_OWNER_LOCK_FILENAME = 'hosted-lifecycle-owner-runtime.lock.json';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^[a-f0-9]{40}$/u;
const VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CAPABILITY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const TEXT = /^[\x20-\x7e]+$/u;

const literal = (expected) => (value, path) => {
  if (value !== expected) fail(path, `must equal ${JSON.stringify(expected)}`);
};

const stringMatching = (pattern, description) => (value, path) => {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(path, `must be ${description}`);
  }
};

const sha256 = stringMatching(SHA256, 'a lowercase sha256:<64-hex> digest');
const gitObjectId = stringMatching(GIT_OBJECT_ID, 'a lowercase 40-hex Git object ID');
const version = stringMatching(VERSION, 'an explicit semantic version');
const tag = stringMatching(TAG, 'an explicit immutable tag');
const text = stringMatching(TEXT, 'non-empty printable ASCII text');

const safeRelativePath = (value, path) => {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 240) {
    fail(path, 'must be a non-empty bounded relative path');
  }
  if (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.includes('\\') ||
    value.includes(':') ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    fail(
      path,
      'must be a normalized POSIX relative path without traversal, controls, URL/drive syntax, or backslashes'
    );
  }
};

const capabilities = (value, path) => {
  if (!Array.isArray(value) || value.length === 0) {
    fail(path, 'must be a non-empty array');
  }
  value.forEach((item, index) =>
    stringMatching(CAPABILITY, 'a capability ID')(item, `${path}[${index}]`)
  );
  const sorted = [...value].sort();
  if (new Set(value).size !== value.length || !same(value, sorted)) {
    fail(path, 'must contain unique capability IDs in canonical sort order');
  }
};

const source = (expectedRepository) => ({
  repository: literal(expectedRepository),
  commit: gitObjectId,
  tree: gitObjectId,
  tag,
});

const productToolchain = {
  nodeVersion: version,
  pnpmVersion: version,
  pnpmLockSha256: sha256,
};

const ownerToolchain = {
  nodeVersion: version,
  bunVersion: version,
  bunLockSha256: sha256,
};

const openCodeToolchain = {
  bunVersion: version,
  bunLockSha256: sha256,
};

const entryAndClosure = {
  entryPath: safeRelativePath,
  entrySha256: sha256,
  closureManifestPath: safeRelativePath,
  closureManifestSha256: sha256,
  closureSha256: sha256,
};

const artifact = {
  namespace: text,
  name: text,
  sha256,
  signatureSha256: sha256,
};

const image = {
  reference: text,
  digest: sha256,
};

const signedDocument = {
  path: safeRelativePath,
  sha256,
  signatureSha256: sha256,
};

const protocol = {
  version,
  digest: sha256,
  capabilityDigest: sha256,
  capabilities,
};

const durableState = {
  formatVersion: version,
  compatibilityDigest: sha256,
};

const ineligibleTemporaryRuntime = {
  temporaryRuntime: literal(true),
  productionEligible: literal(false),
  releaseEligible: literal(false),
};

const ownerIdentity = {
  source: source('777genius/agent_teams_orchestrator'),
  toolchain: ownerToolchain,
  build: entryAndClosure,
  artifact,
  image,
  sbom: signedDocument,
  attestation: signedDocument,
  protocol,
  durableState,
  eligibility: ineligibleTemporaryRuntime,
};

const productIdentity = {
  source: source('777genius/agent-teams-ai'),
  toolchain: productToolchain,
  build: entryAndClosure,
  artifact,
  image,
};

const openCodeIdentity = {
  source: source('777genius/opencode-anomaly'),
  toolchain: openCodeToolchain,
  build: entryAndClosure,
  artifact,
  image,
  sbom: signedDocument,
  attestation: signedDocument,
  protocol,
};

const ownerLockSchema = {
  schemaVersion: literal(LOCK_SCHEMA_VERSION),
  lockType: literal(OWNER_LOCK_TYPE),
  ...ownerIdentity,
};

const stackLockSchema = {
  schemaVersion: literal(LOCK_SCHEMA_VERSION),
  lockType: literal(STACK_LOCK_TYPE),
  product: productIdentity,
  owner: {
    lockSha256: sha256,
    ...ownerIdentity,
  },
  openCode: openCodeIdentity,
  contracts: {
    hostedProducerProvenanceV2Sha256: literal(
      'sha256:acde43e62b8ab42cc5fd2bbecc22f1b96d68f456bfa188b8c63730751222f498'
    ),
    actualOwnerContractV2Sha256: sha256,
    stackContractSha256: sha256,
  },
  toolchains: {
    productSha256: sha256,
    ownerSha256: sha256,
    openCodeSha256: sha256,
  },
  deploymentRecipe: {
    path: safeRelativePath,
    sha256,
  },
  eligibility: ineligibleTemporaryRuntime,
};

export function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(sortJson(value))}\n`, 'utf8');
}

export function sha256Digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function parseOwnerLock(bytes) {
  return parseCanonicalLock(bytes, ownerLockSchema, OWNER_LOCK_FILENAME);
}

export function parseStackLock(bytes) {
  return parseCanonicalLock(bytes, stackLockSchema, STACK_LOCK_FILENAME);
}

export function verifyHostedLockPair(ownerBytes, stackBytes) {
  const owner = parseOwnerLock(ownerBytes);
  const stack = parseStackLock(stackBytes);

  requireEqual(stack.owner.lockSha256, sha256Digest(ownerBytes), 'owner.lockSha256');
  for (const field of Object.keys(ownerIdentity)) {
    requireEqual(stack.owner[field], owner[field], `owner.${field}`);
  }
  requireEqual(
    stack.toolchains.productSha256,
    sha256Digest(canonicalJsonBytes(stack.product.toolchain)),
    'toolchains.productSha256'
  );
  requireEqual(
    stack.toolchains.ownerSha256,
    sha256Digest(canonicalJsonBytes(owner.toolchain)),
    'toolchains.ownerSha256'
  );
  requireEqual(
    stack.toolchains.openCodeSha256,
    sha256Digest(canonicalJsonBytes(stack.openCode.toolchain)),
    'toolchains.openCodeSha256'
  );

  return { owner, stack };
}

function parseCanonicalLock(input, schema, filename) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    throw new TypeError(`${filename}: input must be bytes`);
  }
  if (input.byteLength > MAX_LOCK_BYTES) {
    throw new Error(`${filename}: input exceeds the ${MAX_LOCK_BYTES}-byte limit`);
  }

  let textValue;
  try {
    textValue = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    throw new Error(`${filename}: bytes must be valid UTF-8`);
  }

  let value;
  try {
    value = JSON.parse(textValue);
  } catch (error) {
    throw new Error(`${filename}: malformed JSON: ${error.message}`);
  }

  validateShape(value, schema, '$');
  if (!Buffer.from(input).equals(canonicalJsonBytes(value))) {
    throw new Error(
      `${filename}: bytes are not the single canonical representation ` +
        '(sorted keys, no duplicate keys, one trailing newline)'
    );
  }
  return value;
}

function validateShape(value, schema, path) {
  if (!isPlainObject(value)) fail(path, 'must be an object');

  const expected = Object.keys(schema).sort();
  const actual = Object.keys(value).sort();
  if (!same(actual, expected)) {
    const missing = expected.filter((key) => !actual.includes(key));
    const unknown = actual.filter((key) => !expected.includes(key));
    fail(path, `fields mismatch; missing=[${missing.join(',')}], unknown=[${unknown.join(',')}]`);
  }

  for (const key of expected) {
    const rule = schema[key];
    if (typeof rule === 'function') {
      rule(value[key], `${path}.${key}`);
    } else {
      validateShape(value[key], rule, `${path}.${key}`);
    }
  }
}

function requireEqual(actual, expected, path) {
  if (!same(actual, expected)) {
    fail(`$.${path}`, 'does not match its cross-lock binding');
  }
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])])
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}
