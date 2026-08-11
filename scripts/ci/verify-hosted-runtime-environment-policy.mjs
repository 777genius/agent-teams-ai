#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '../..');
const POLICY_PATH = 'scripts/ci/hosted-runtime-environment-policy.json';
const POLICY_FORMAT = 'agent-teams.hosted-runtime-environment-policy/v1';
const RESULT_FORMAT = 'agent-teams.hosted-runtime-environment-policy-verifier-result/v1';
const KEY_PREFIX = 'HOSTED_LIFECYCLE_';
const KEY_PATTERN = /^HOSTED_LIFECYCLE_[A-Z0-9_]+$/u;
const SOURCE_ROOTS = Object.freeze(['src', 'docker']);
const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.mts',
  '.sh',
  '.ts',
  '.tsx',
]);
const DOCKER_EXTENSIONS = new Set(['.yaml', '.yml']);
const TOP_LEVEL_FIELDS = Object.freeze([
  'format',
  'schemaVersion',
  'authority',
  'environmentKeyPrefix',
  'entries',
]);
const ENTRY_FIELDS = Object.freeze([
  'name',
  'role',
  'secretClass',
  'redactionRule',
  'providerChildExposure',
  'sourceAuthority',
]);
const ROLES = new Set([
  'authentication_material',
  'authentication_secret_reference',
  'forbidden_legacy_bootstrap_control',
  'orchestrator_run_directory',
  'orchestrator_socket_path',
  'owner_admission_manifest_path',
  'owner_high_water_state_root',
  'owner_release_pin_path',
  'test_gate',
]);
const SECRET_CLASSES = new Set(['none', 'hmac_authentication_key', 'secret_reference_path']);
const REDACTION_RULES = new Set(['name_only', 'not_applicable']);
const REQUIRED_SEMANTICS = Object.freeze({
  HOSTED_LIFECYCLE_ORCHESTRATOR_HIGH_WATER_ROOT: Object.freeze({
    role: 'owner_high_water_state_root',
    secretClass: 'none',
    redactionRule: 'not_applicable',
  }),
  HOSTED_LIFECYCLE_ORCHESTRATOR_RUN_DIR: Object.freeze({
    role: 'orchestrator_run_directory',
    secretClass: 'none',
    redactionRule: 'not_applicable',
  }),
  HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET: Object.freeze({
    role: 'orchestrator_socket_path',
    secretClass: 'none',
    redactionRule: 'not_applicable',
  }),
  HOSTED_LIFECYCLE_ORCHESTRATOR_TEST_ONLY_INLINE_TRUST_ANCHOR: Object.freeze({
    role: 'test_gate',
    secretClass: 'none',
    redactionRule: 'not_applicable',
  }),
  HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR: Object.freeze({
    role: 'authentication_material',
    secretClass: 'hmac_authentication_key',
    redactionRule: 'name_only',
  }),
  HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR_FILE: Object.freeze({
    role: 'authentication_secret_reference',
    secretClass: 'secret_reference_path',
    redactionRule: 'name_only',
  }),
  HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_FILE: Object.freeze({
    role: 'owner_admission_manifest_path',
    secretClass: 'none',
    redactionRule: 'not_applicable',
  }),
  HOSTED_LIFECYCLE_OWNER_ARTIFACT_DIGEST: Object.freeze({
    role: 'forbidden_legacy_bootstrap_control',
    secretClass: 'none',
    redactionRule: 'not_applicable',
  }),
  HOSTED_LIFECYCLE_OWNER_AUTHORITY: Object.freeze({
    role: 'forbidden_legacy_bootstrap_control',
    secretClass: 'none',
    redactionRule: 'not_applicable',
  }),
  HOSTED_LIFECYCLE_OWNER_IMAGE_REFERENCE: Object.freeze({
    role: 'forbidden_legacy_bootstrap_control',
    secretClass: 'none',
    redactionRule: 'not_applicable',
  }),
  HOSTED_LIFECYCLE_OWNER_PROTOCOL_VERSION: Object.freeze({
    role: 'forbidden_legacy_bootstrap_control',
    secretClass: 'none',
    redactionRule: 'not_applicable',
  }),
  HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FILE: Object.freeze({
    role: 'owner_release_pin_path',
    secretClass: 'none',
    redactionRule: 'not_applicable',
  }),
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedPath(root, path) {
  return relative(root, path).split(sep).join('/');
}

function isScannableSource(path) {
  const extension = extname(path).toLowerCase();
  return (
    SOURCE_EXTENSIONS.has(extension) ||
    DOCKER_EXTENSIONS.has(extension) ||
    path.endsWith('/Dockerfile')
  );
}

function walkScannableSources(root) {
  const paths = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    const pending = [join(root, sourceRoot)];
    while (pending.length > 0) {
      const directory = pending.pop();
      const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name)
      );
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && isScannableSource(path)) paths.push(path);
      }
    }
  }
  return paths.sort();
}

function sourceDocuments(root, injectedSources) {
  if (injectedSources !== undefined) {
    if (!isRecord(injectedSources)) throw new TypeError('sources_must_be_path_content_record');
    return Object.entries(injectedSources)
      .map(([path, content]) => {
        if (typeof content !== 'string') throw new TypeError(`source_not_text:${path}`);
        return [path.replaceAll('\\', '/'), content];
      })
      .sort(([left], [right]) => left.localeCompare(right));
  }
  return walkScannableSources(root).map((path) => [
    normalizedPath(root, path),
    readFileSync(path, 'utf8'),
  ]);
}

function discoveredNames(content, path) {
  const names = new Set();
  const quotedName = /(['"])(HOSTED_LIFECYCLE_[A-Z0-9_]+)\1/gu;
  for (const match of content.matchAll(quotedName)) names.add(match[2]);

  if (path.startsWith('src/')) {
    const propertyAccess =
      /\b(?:process\s*\.\s*env|environment|env|[A-Za-z_$][\w$]*(?:Environment|Env))\s*(?:\?\.\s*|\.\s*)(HOSTED_LIFECYCLE_[A-Z0-9_]+)/gu;
    for (const match of content.matchAll(propertyAccess)) names.add(match[1]);
  }
  if (path.startsWith('docker/')) {
    for (const match of content.matchAll(/\bHOSTED_LIFECYCLE_[A-Z0-9_]+\b/gu)) names.add(match[0]);
  }
  return names;
}

/** Discovers current source authorities without consulting the authored policy. */
export function discoverHostedLifecycleEnvironmentAccesses(options = {}) {
  const root = resolve(options.root ?? REPOSITORY_ROOT);
  const accessByName = new Map();
  for (const [path, content] of sourceDocuments(root, options.sources)) {
    for (const name of discoveredNames(content, path)) {
      if (!KEY_PATTERN.test(name)) continue;
      const authorities = accessByName.get(name) ?? new Set();
      authorities.add(path);
      accessByName.set(name, authorities);
    }
  }
  return new Map(
    [...accessByName.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, authorities]) => [name, [...authorities].sort()])
  );
}

function exactFields(value, expected, location, violations) {
  if (!isRecord(value)) {
    violations.push(`${location}:record_required`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    violations.push(`${location}:fields_invalid`);
    return false;
  }
  return true;
}

function sameValues(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function validatePolicyHeader(policy, violations) {
  if (!exactFields(policy, TOP_LEVEL_FIELDS, 'policy', violations)) return false;
  if (policy.format !== POLICY_FORMAT) violations.push('policy:format_invalid');
  if (policy.schemaVersion !== 1) violations.push('policy:schema_version_invalid');
  if (policy.authority !== 'mutable_current_head_source')
    violations.push('policy:authority_invalid');
  if (policy.environmentKeyPrefix !== KEY_PREFIX) violations.push('policy:key_prefix_invalid');
  if (!Array.isArray(policy.entries)) {
    violations.push('policy:entries_array_required');
    return false;
  }
  return true;
}

function validateEntry(entry, index, violations) {
  const location = `policy_entry:${index}`;
  if (!exactFields(entry, ENTRY_FIELDS, location, violations)) return false;
  const name = KEY_PATTERN.test(entry.name) ? entry.name : `<index-${index}>`;
  const namedLocation = `policy_entry:${name}`;
  if (!KEY_PATTERN.test(entry.name)) violations.push(`${location}:name_invalid`);
  if (!ROLES.has(entry.role)) violations.push(`${namedLocation}:role_invalid`);
  if (!SECRET_CLASSES.has(entry.secretClass))
    violations.push(`${namedLocation}:secret_class_invalid`);
  if (!REDACTION_RULES.has(entry.redactionRule))
    violations.push(`${namedLocation}:redaction_rule_invalid`);
  if (entry.providerChildExposure !== 'forbidden') {
    violations.push(`${namedLocation}:provider_child_exposure_forbidden`);
  }
  if (
    !Array.isArray(entry.sourceAuthority) ||
    entry.sourceAuthority.length === 0 ||
    entry.sourceAuthority.some(
      (path) =>
        typeof path !== 'string' ||
        path.length === 0 ||
        path.startsWith('/') ||
        path.includes('\\') ||
        path.split('/').includes('..')
    )
  ) {
    violations.push(`${namedLocation}:source_authority_invalid`);
  } else if (new Set(entry.sourceAuthority).size !== entry.sourceAuthority.length) {
    violations.push(`${namedLocation}:source_authority_duplicate`);
  }

  const required = REQUIRED_SEMANTICS[entry.name];
  if (required !== undefined) {
    for (const field of ['role', 'secretClass', 'redactionRule']) {
      if (entry[field] !== required[field]) {
        violations.push(`${namedLocation}:${field}_semantic_downgrade`);
      }
    }
  }
  if (entry.secretClass === 'none' && entry.redactionRule !== 'not_applicable') {
    violations.push(`${namedLocation}:non_secret_redaction_invalid`);
  }
  if (entry.secretClass !== 'none' && entry.redactionRule !== 'name_only') {
    violations.push(`${namedLocation}:secret_redaction_must_be_name_only`);
  }
  return typeof entry.name === 'string' && KEY_PATTERN.test(entry.name);
}

/** Validates exact current-source coverage, classification, redaction, and child exposure. */
export function validateHostedRuntimeEnvironmentPolicy(policy, discovered) {
  const violations = [];
  if (!validatePolicyHeader(policy, violations)) return violations;

  const entriesByName = new Map();
  for (const [index, entry] of policy.entries.entries()) {
    if (!validateEntry(entry, index, violations)) continue;
    if (entriesByName.has(entry.name)) violations.push(`policy_entry:${entry.name}:duplicate`);
    else entriesByName.set(entry.name, entry);
  }

  for (const [name, authorities] of discovered) {
    const entry = entriesByName.get(name);
    if (entry === undefined) {
      violations.push(`coverage:missing_policy_entry:${name}`);
      continue;
    }
    if (Array.isArray(entry.sourceAuthority) && !sameValues(entry.sourceAuthority, authorities)) {
      violations.push(`policy_entry:${name}:source_authority_stale`);
    }
  }
  for (const name of entriesByName.keys()) {
    if (!discovered.has(name)) violations.push(`coverage:policy_entry_without_source:${name}`);
  }
  return [...new Set(violations)].sort();
}

function loadPolicy(root, injectedPolicy) {
  if (injectedPolicy !== undefined) return injectedPolicy;
  return JSON.parse(readFileSync(join(root, POLICY_PATH), 'utf8'));
}

/** Returns names and violations only; environment values and source contents never enter results. */
export function verifyHostedRuntimeEnvironmentPolicy(options = {}) {
  const root = resolve(options.root ?? REPOSITORY_ROOT);
  let policy;
  let discovered;
  try {
    policy = loadPolicy(root, options.policy);
  } catch {
    return {
      format: RESULT_FORMAT,
      status: 'failed',
      summary: { discoveredKeys: 0, policyEntries: 0, violations: 1 },
      violations: ['policy:unreadable_or_invalid_json'],
    };
  }
  try {
    discovered = discoverHostedLifecycleEnvironmentAccesses({ root, sources: options.sources });
  } catch {
    return {
      format: RESULT_FORMAT,
      status: 'failed',
      summary: {
        discoveredKeys: 0,
        policyEntries: Array.isArray(policy?.entries) ? policy.entries.length : 0,
        violations: 1,
      },
      violations: ['source_authority:discovery_failed'],
    };
  }
  const violations = validateHostedRuntimeEnvironmentPolicy(policy, discovered);
  return {
    format: RESULT_FORMAT,
    status: violations.length === 0 ? 'passed' : 'failed',
    summary: {
      discoveredKeys: discovered.size,
      policyEntries: Array.isArray(policy?.entries) ? policy.entries.length : 0,
      violations: violations.length,
    },
    violations,
  };
}

const invokedPath =
  process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const result = verifyHostedRuntimeEnvironmentPolicy();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'passed') process.exitCode = 1;
}
