import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDocument } from 'yaml';

// Run after the frozen provider's full check and the consumer's frozen install.
// This verifies existing committed pins; it never adopts or rewrites an archive.
const SOURCE = '18a1c276474388a38e2bb00e5a11958c936566e0';
const PROVIDER = '@agent-teams/provider-implementations';
const CONTRACTS = '@agent-teams/provider-session-contracts';
const PROVIDER_FILE = 'agent-teams-provider-implementations-0.0.0.tgz';
const CONTRACTS_FILE = 'agent-teams-provider-session-contracts-0.0.0.tgz';
const PROVIDER_DIR = 'vendor/provider-migration/native-prompt-suggestions-18a1c276';
const CONTRACTS_DIR = 'vendor/provider-migration/opencode-v2-host-9ede557c';
const PROVIDER_ARCHIVE = `${PROVIDER_DIR}/${PROVIDER_FILE}`;
const CONTRACTS_ARCHIVE = `${CONTRACTS_DIR}/${CONTRACTS_FILE}`;
const RECEIPT = `${PROVIDER_DIR}/source-receipt.json`;
const PROVIDER_SHA256 = '26f8fc7083dbc470dd9d3a656e24873b73c78af3da3ffeea802a09a98f253e3c';
const CONTRACTS_SHA256 = 'aaf9506473f6a2868a375a6087e1b4edc561b38f34101ef7a8703a73bb2674db';
const PROVIDER_SPECIFIER = `file:../../${PROVIDER_ARCHIVE}`;
const CONTRACTS_SPECIFIER = `file:../../${CONTRACTS_ARCHIVE}`;
const PROVIDER_RESOLUTION = `file:${PROVIDER_ARCHIVE}`;
const CONTRACTS_RESOLUTION = `file:${CONTRACTS_ARCHIVE}`;
const PROVIDER_VERSION = `${PROVIDER_RESOLUTION}(supports-color@10.2.2)`;
const PIN_FILES = [
  PROVIDER_ARCHIVE,
  CONTRACTS_ARCHIVE,
  RECEIPT,
  'packages/legacy-agent-host/package.json',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Native suggestions adopted pin: ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function integrity(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function readRegularFile(path: string): Buffer {
  const absolute = resolve(path);
  requireCondition(lstatSync(absolute).isFile(), 'expected a regular pin or retained archive file');
  requireCondition(
    realpathSync(absolute) === absolute,
    'pin and archive paths must not use symlinks'
  );
  return readFileSync(absolute);
}

const root = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
requireCondition(realpathSync(process.cwd()) === root, 'run from the consumer repository root');
requireCondition(process.versions.node === '24.21.0', 'expected consumer Node 24.21.0');

function git(args: string[]): string {
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  }).trim();
}

function readRepositoryFile(path: string): Buffer {
  requireCondition(PIN_FILES.includes(path), 'unexpected repository pin path');
  return readRegularFile(join(root, path));
}

function readJson(path: string): Record<string, unknown> {
  return record(
    JSON.parse(readRepositoryFile(path).toString('utf8')),
    `invalid JSON object: ${path}`
  );
}

function readYaml(path: string): Record<string, unknown> {
  const document = parseDocument(readRepositoryFile(path).toString('utf8'), { uniqueKeys: true });
  requireCondition(document.errors.length === 0, `invalid YAML: ${path}`);
  return record(document.toJS({ maxAliasCount: 0 }), `invalid YAML object: ${path}`);
}

const expectedSha = process.env.NATIVE_CONSUMER_SHA;
requireCondition(
  typeof expectedSha === 'string' && /^[0-9a-f]{40}$/.test(expectedSha),
  'NATIVE_CONSUMER_SHA must be the exact event consumer SHA'
);
requireCondition(
  realpathSync(git(['rev-parse', '--show-toplevel'])) === root,
  'unexpected Git repository root'
);
requireCondition(
  git(['rev-parse', 'HEAD']) === expectedSha,
  'consumer checkout SHA differs from event'
);

const retainedInput = process.env.NATIVE_REPRODUCED_PACK_DIR;
requireCondition(
  typeof retainedInput === 'string' && retainedInput.length > 0 && !retainedInput.includes('\0'),
  'NATIVE_REPRODUCED_PACK_DIR is required'
);
const retainedRoot = realpathSync(resolve(root, retainedInput));
requireCondition(
  lstatSync(retainedRoot).isDirectory(),
  'retained archive root must be a directory'
);
requireCondition(
  retainedRoot !== realpathSync(join(root, PROVIDER_DIR)) &&
    retainedRoot !== realpathSync(join(root, CONTRACTS_DIR)),
  'retained archives must be separate from committed pins'
);

const providerBytes = readRepositoryFile(PROVIDER_ARCHIVE);
const contractsBytes = readRepositoryFile(CONTRACTS_ARCHIVE);
requireCondition(sha256(providerBytes) === PROVIDER_SHA256, 'committed provider SHA256 mismatch');
requireCondition(
  sha256(contractsBytes) === CONTRACTS_SHA256,
  'committed Session SPI SHA256 mismatch'
);
requireCondition(
  providerBytes.equals(readRegularFile(join(retainedRoot, PROVIDER_FILE))),
  'committed provider differs from the full-check retained archive'
);
requireCondition(
  contractsBytes.equals(readRegularFile(join(retainedRoot, CONTRACTS_FILE))),
  'committed Session SPI differs from the full-check retained archive'
);

// Match the publisher's deterministic receipt exactly, including its historical
// source-only qualification. Native Host/Electron success is proved downstream.
const expectedReceipt = {
  schemaVersion: 1,
  sourceRepository: 'agent-teams-ai/old-provider-implementations',
  sourceCommit: SOURCE,
  qualification: 'source-and-packed-consumer-only',
  nativeHostQualified: false,
  packagedElectronQualified: false,
  fullChecks: [
    { node: '24.21.0', pnpm: '11.18.0', command: 'pnpm check', result: 'PASS', runId: 43640593139 },
    { node: '26.11.1', pnpm: '11.18.0', command: 'pnpm check', result: 'PASS', runId: 43640593139 },
  ],
  checkedArtifact: {
    id: 14130999557,
    name: `opencode-v2-spi-consumer-checked-${SOURCE}`,
    url: 'https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/43640593139/artifacts/14130999557',
  },
  packages: {
    'provider-implementations': {
      file: PROVIDER_FILE,
      newSha256: PROVIDER_SHA256,
      bytes: providerBytes.length,
      integrity: integrity(providerBytes),
    },
    'provider-session-contracts': {
      file: CONTRACTS_FILE,
      existingPath: `../opencode-v2-host-9ede557c/${CONTRACTS_FILE}`,
      newSha256: CONTRACTS_SHA256,
    },
  },
};
requireCondition(
  readRepositoryFile(RECEIPT).equals(Buffer.from(JSON.stringify(expectedReceipt, null, 2) + '\n')),
  'source receipt differs from the deterministic publisher receipt'
);

const hostManifest = readJson('packages/legacy-agent-host/package.json');
const dependencies = record(hostManifest.dependencies, 'missing Host dependencies');
requireCondition(
  dependencies[PROVIDER] === PROVIDER_SPECIFIER,
  'Host provider dependency mismatch'
);
requireCondition(
  dependencies[CONTRACTS] === CONTRACTS_SPECIFIER,
  'Host Session SPI dependency mismatch'
);

const rootManifest = readJson('package.json');
requireCondition(
  typeof rootManifest.packageManager === 'string' &&
    /^pnpm@11\.22\.0(?:\+sha512\.[0-9a-f]+)?$/.test(rootManifest.packageManager),
  'consumer package manager must remain pinned to pnpm 11.22.0'
);
const lock = readYaml('pnpm-lock.yaml');
requireCondition(lock.lockfileVersion === '9.0', 'unexpected lockfile version');
const importers = record(lock.importers, 'missing lockfile importers');
const host = record(importers['packages/legacy-agent-host'], 'missing Host lockfile importer');
const lockedDependencies = record(host.dependencies, 'missing locked Host dependencies');
for (const [name, specifier, version] of [
  [PROVIDER, PROVIDER_SPECIFIER, PROVIDER_VERSION],
  [CONTRACTS, CONTRACTS_SPECIFIER, CONTRACTS_RESOLUTION],
] as const) {
  const dependency = record(lockedDependencies[name], `missing locked dependency: ${name}`);
  requireCondition(
    dependency.specifier === specifier && dependency.version === version,
    `locked Host dependency mismatch: ${name}`
  );
}

const packages = record(lock.packages, 'missing lockfile packages');
for (const [name, resolution, bytes] of [
  [PROVIDER, PROVIDER_RESOLUTION, providerBytes],
  [CONTRACTS, CONTRACTS_RESOLUTION, contractsBytes],
] as const) {
  const entry = record(packages[`${name}@${resolution}`], `missing locked package: ${name}`);
  const value = record(entry.resolution, `missing package resolution: ${name}`);
  requireCondition(
    entry.version === '0.0.0' &&
      value.tarball === resolution &&
      value.integrity === integrity(bytes),
    `locked package archive mismatch: ${name}`
  );
}
const snapshots = record(lock.snapshots, 'missing lockfile snapshots');
const providerSnapshot = record(
  snapshots[`${PROVIDER}@${PROVIDER_VERSION}`],
  'missing provider snapshot'
);
const providerDependencies = record(
  providerSnapshot.dependencies,
  'missing provider snapshot dependencies'
);
requireCondition(
  providerDependencies[CONTRACTS] === CONTRACTS_RESOLUTION,
  'provider snapshot Session SPI edge mismatch'
);
record(snapshots[`${CONTRACTS}@${CONTRACTS_RESOLUTION}`], 'missing Session SPI snapshot');

function verifyOverrides(value: unknown, label: string, requireContracts: boolean): void {
  const overrides = record(value ?? {}, `invalid overrides: ${label}`);
  const relevant = Object.entries(overrides).filter(
    ([key]) => key.includes(PROVIDER) || key.includes(CONTRACTS)
  );
  requireCondition(
    relevant.every(([key, pin]) => key === CONTRACTS && pin === CONTRACTS_RESOLUTION),
    `unexpected provider or Session SPI override: ${label}`
  );
  if (requireContracts)
    requireCondition(
      overrides[CONTRACTS] === CONTRACTS_RESOLUTION,
      `missing exact Session SPI override: ${label}`
    );
}

verifyOverrides(lock.overrides, 'lockfile', true);
verifyOverrides(readYaml('pnpm-workspace.yaml').overrides, 'workspace', true);
if (rootManifest.pnpm !== undefined) {
  verifyOverrides(
    record(rootManifest.pnpm, 'invalid root pnpm configuration').overrides,
    'root manifest',
    false
  );
}

// A correct working-tree value cannot qualify an uncommitted pin or lock edit.
git(['ls-files', '--error-unmatch', '--', ...PIN_FILES]);
git([
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--exit-code',
  '--quiet',
  'HEAD',
  '--',
  ...PIN_FILES,
]);
requireCondition(
  git(['rev-parse', 'HEAD']) === expectedSha,
  'consumer HEAD changed during verification'
);

const output = process.env.GITHUB_OUTPUT;
requireCondition(
  typeof output === 'string' && isAbsolute(output),
  'GITHUB_OUTPUT must be an absolute command file'
);
const outputPath = realpathSync(output);
const relativeOutput = relative(root, outputPath);
requireCondition(
  isAbsolute(relativeOutput) || relativeOutput === '..' || relativeOutput.startsWith(`..${sep}`),
  'GITHUB_OUTPUT must be outside the consumer source checkout'
);
requireCondition(lstatSync(output).isFile(), 'GITHUB_OUTPUT must be a regular command file');
appendFileSync(outputPath, `qualified_sha=${expectedSha}\n`);
console.log(
  JSON.stringify({
    verifiedAdoptedPin: {
      consumerSha: expectedSha,
      providerSource: SOURCE,
      providerSha256: PROVIDER_SHA256,
      contractsSha256: CONTRACTS_SHA256,
      retainedArchivesMatch: true,
      nativeHostQualified: false,
      packagedElectronQualified: false,
    },
  })
);
