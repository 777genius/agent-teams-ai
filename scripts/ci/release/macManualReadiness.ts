import { at, list, object } from './nativeReadinessAuthority.js';
import { canonical, digest, platformNames, requireThat } from './contract.js';
import type { StagePlan } from './contract.js';

export const manualCapturePaths = ['fresh220', 'original211', 'manual220'].map(
  (label) => `TEST-mac-manual-evidence/${label}/native-window.png`
);
const predecessor = {
  releaseId: 398386033,
  arm64: {
    id: 595801616,
    size: 249856838,
    sha256: 'ef028b523ace7635abdbd050687b816de78bd887eea4d87a79919b8ea401756e',
  },
  x64: {
    id: 595811076,
    size: 259656716,
    sha256: '7a6f2700813940bdc379bd01db568999099c19bda40383ac3e01241ee305de6d',
  },
};
function equal(actual: unknown, expected: unknown, label: string) {
  requireThat(canonical(actual) === canonical(expected), `Manual Mac proof mismatch: ${label}`);
}
function proof(value: unknown) {
  const result = object(value, 'manual file proof');
  requireThat(
    typeof result.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(result.sha256) &&
      typeof result.size === 'number' &&
      result.size > 0,
    'Invalid manual byte proof'
  );
  return result;
}
export function checkMacManual(
  value: Record<string, unknown>,
  architecture: 'arm64' | 'x64',
  plan: StagePlan,
  planSha256: string,
  inputDigest: string,
  runId: number,
  attempt: number,
  entries: Record<string, Buffer>,
  executionSha = plan.input.toolingSha
) {
  for (const [key, expected] of Object.entries({
    schemaVersion: 1,
    repository: plan.input.repository,
    toolingSha: plan.input.toolingSha,
    sourceSha: plan.input.target.applicationSha,
    version: '2.17.10',
    architecture,
    passed: true,
    cleanupPassed: true,
    minimumOs13ExecutionProven: false,
  }))
    equal(value[key], expected, key);
  if (executionSha !== plan.input.toolingSha || value.executionSha !== undefined)
    equal(value.executionSha, executionSha, 'actual executor SHA');
  requireThat(
    typeof value.actualMacOs === 'string' && /^15\.\d+(?:\.\d+)?$/.test(value.actualMacOs),
    'Actual macOS15 runner proof required'
  );
  const input = object(value.inputs, 'manual inputs');
  for (const [key, expected] of Object.entries({
    schemaVersion: 1,
    toolingSha: plan.input.toolingSha,
    sourceSha: plan.input.target.applicationSha,
    planDigest: planSha256,
    inputDigest,
    runId,
    attempt,
  }))
    equal(input[key], expected, `inputs.${key}`);
  for (const [key, expected] of Object.entries({
    toolingSha: plan.input.toolingSha,
    planDigest: planSha256,
    inputDigest,
  }))
    equal(at(input, 'prepared', key), expected, `prepared.${key}`);
  const producer = object(value.producer, 'manual producer');
  for (const [key, expected] of Object.entries({
    id: runId,
    run_attempt: attempt,
    head_sha: executionSha,
    event: 'workflow_dispatch',
  }))
    equal(at(producer, 'run', key), expected, `producer.${key}`);
  equal(
    String(at(producer, 'run', 'path')).split('@')[0],
    '.github/workflows/updater-mac-manual-migration.yml',
    'producer workflow'
  );
  checkDownloads(input, plan);
  const phases = list(value.phases, 'manual phases').map((item) => object(item, 'phase'));
  checkSignatures(phases, architecture);
  checkProfiles(value, phases, architecture, entries, executionSha !== plan.input.toolingSha);
  const commands = list(value.commands, 'native commands').map((item) => object(item, 'command'));
  const osCommands = commands.filter((item) => item.command === '/usr/bin/sw_vers -productVersion');
  requireThat(
    osCommands.length === 1 &&
      osCommands[0]?.exitCode === 0 &&
      String(osCommands[0].stdout).trim() === value.actualMacOs,
    'Exactly one actual OS command required'
  );
  for (const command of commands) {
    equal(command.exitCode, 0, 'native command result');
    equal(
      command.outputSha256,
      digest(`stdout:\n${String(command.stdout)}\nstderr:\n${String(command.stderr)}`),
      'native command digest'
    );
  }
}

function checkDownloads(input: Record<string, unknown>, plan: StagePlan) {
  const downloads = list(input.downloads, 'manual downloads').map((item) =>
    object(item, 'download')
  );
  equal(downloads.length, 6, 'closed download count');
  for (const arch of ['arm64', 'x64'] as const) {
    const oldName = `Agent.Teams.AI-2.17.1-${arch}.dmg`;
    for (const name of [
      ...platformNames('2.17.10').mac.filter(
        (name) => name.includes(`-${arch}`) && /\.(dmg|zip)$/.test(name)
      ),
      oldName,
    ]) {
      const matches = downloads.filter(
        (item) => item.architecture === arch && at(item, 'proof', 'name') === name
      );
      requireThat(matches.length === 1 && matches[0], 'Missing/duplicate exact Mac archive');
      const item = matches[0];
      const bytes = proof(item.proof);
      if (name === oldName) {
        const pin = predecessor[arch];
        equal(item.releaseId, predecessor.releaseId, 'original211 release');
        equal(item.assetId, pin.id, 'original211 asset');
        equal(bytes.sha256, pin.sha256, 'original211 bytes');
        equal(bytes.size, pin.size, 'original211 size');
      } else {
        const original = plan.input.originals.find(
          (item) => item.name === name && item.tag === plan.input.target.tag
        );
        requireThat(original, 'Missing planned signed Mac archive');
        equal(item.releaseId, plan.input.target.id, 'target archive release');
        equal(item.assetId, original.assetId, 'target archive asset');
        for (const key of ['sha256', 'sha512', 'size'] as const)
          equal(bytes[key], original[key], `archive.${key}`);
      }
    }
  }
}

function phase(phases: Record<string, unknown>[], key: string, label?: string) {
  const matches = phases.filter((item) => (label ? item.label === label : item[key] !== undefined));
  requireThat(
    matches.length === 1 && matches[0],
    `Missing/duplicate manual phase: ${label ?? key}`
  );
  return matches[0];
}

function checkSignatures(phases: Record<string, unknown>[], architecture: string) {
  for (const [key, version, team, minimum] of [
    ['freshSignature', '2.17.10', '86399583GS', '13.0'],
    ['oldSignature', '2.17.1', '6C84CW694S', '12.0'],
    ['replacementSignature', '2.17.10', '86399583GS', '13.0'],
  ] as const) {
    const signature = object(phase(phases, key)[key], 'manual signature');
    for (const [field, expected] of Object.entries({
      version,
      teamIdentifier: team,
      productMinimum: minimum,
      architecture,
    }))
      equal(signature[field], expected, `signature.${field}`);
    if (version === '2.17.10') {
      proof(signature.asar);
      const locks = list(signature.locks, 'runtime locks');
      equal(locks.length, 2, 'runtime lock count');
      for (const [index, version] of ['0.0.106', '0.3.3'].entries()) {
        equal(at(locks[index], 'version'), version, 'runtime version');
        proof(at(locks[index], 'lock'));
        proof(at(locks[index], 'signedInstalledBinary'));
        requireThat(
          /^[a-f0-9]{64}$/.test(String(at(locks[index], 'archiveSha256'))),
          'Missing runtime archive pin'
        );
      }
    }
  }
}

function checkSeededProfile(
  phases: Record<string, unknown>[],
  original: Record<string, unknown>,
  coldSeed: boolean
) {
  const seeded = coldSeed ? phase(phases, '', 'original211-seed') : original;
  equal(seeded.profile, original.profile, 'same owned seeded profile');
  equal(seeded.theme, original.theme, 'cold-loaded seeded preference');
  equal(proof(seeded.configProof), proof(original.configProof), 'cold-loaded seeded config');
  if (coldSeed) equal(original.before, seeded.theme, 'preference before original cold launch');
  requireThat(
    ['dark', 'light'].includes(String(seeded.theme)) &&
      ['dark', 'light', 'system'].includes(String(seeded.before)) && seeded.before !== seeded.theme,
    'Nondefault seeded preference required'
  );
}

function checkProfiles(
  value: Record<string, unknown>,
  phases: Record<string, unknown>[],
  architecture: string,
  entries: Record<string, Buffer>,
  coldSeed: boolean
) {
  const replacement = phase(phases, 'replacementSignature');
  equal(
    proof(replacement.profileBefore),
    proof(replacement.preservedBeforeLaunch),
    'preserved config bytes'
  );
  const original = phase(phases, '', 'original211');
  const migrated = phase(phases, '', 'manual220');
  equal(original.profile, migrated.profile, 'same owned migration profile');
  checkSeededProfile(phases, original, coldSeed);
  equal(migrated.before, original.theme, 'preference before replacement');
  equal(migrated.theme, original.theme, 'retained painted preference');
  equal(proof(original.configProof), proof(replacement.profileBefore), 'seeded config');
  // The new application may persist normalized defaults after reading the original config.
  proof(migrated.configProof);
  const projectPath = String(original.profile) + '/TEST-migration-project';
  for (const item of [original, migrated]) {
    equal(
      item.migrationState,
      {
        theme: original.theme,
        projectPaths: [projectPath],
        team: { teamName: 'TEST-manual-migration-team', projectPath, memberCount: 0 },
      },
      'retained passive project and team through public API'
    );
  }
  const passive = [proof(original.passiveTeamProof), proof(original.passiveProjectProof)];
  equal(
    [proof(migrated.passiveTeamProof), proof(migrated.passiveProjectProof)],
    passive,
    'retained passive bytes after launch'
  );
  equal(
    list(replacement.passiveBefore, 'passive before replacement').map(proof),
    passive,
    'seeded passive bytes'
  );
  equal(
    list(replacement.passivePreserved, 'passive after replacement').map(proof),
    passive,
    'preserved passive bytes before launch'
  );
  const root = String(value.ownedRoot);
  requireThat(/^\/.+\/TEST-mac-manual-owned-[^/]+$/.test(root), 'Missing owned sandbox root');
  for (const [index, label] of ['fresh220', 'original211', 'manual220'].entries()) {
    const item = phase(phases, '', label);
    const roots = object(item.roots, 'owned roots');
    const profile = `${root}/${label === 'fresh220' ? 'fresh-profile' : 'migration-profile'}`;
    equal(item.profile, profile, 'owned profile');
    for (const [key, expected] of Object.entries({
      home: `${profile}/home`,
      nodeHome: `${profile}/home`,
      userData: `${profile}/user-data`,
      arch: architecture,
      version: label === 'original211' ? '2.17.1' : '2.17.10',
      packaged: true,
    }))
      equal(roots[key], expected, `roots.${key}`);
    const executable = `${root}/Agent Teams AI.app/Contents/MacOS/Agent Teams AI`;
    equal(roots.executable, executable, 'owned executable');
    const painted = object(item.painted, 'painted native window');
    const owner = object(painted.owner, 'native owner');
    requireThat(Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0, 'Missing native PID');
    equal(owner.command, executable, 'native capture executable');
    equal(painted.kCGWindowOwnerPID, owner.pid, 'window owner');
    for (const key of ['foregroundBefore', 'foregroundAfter'])
      equal(item[key], { pid: owner.pid, executable }, 'actual foreground owner');
    const pixels = object(painted.pixels, 'native pixels');
    requireThat(
      Number(pixels.width) >= 300 &&
        Number(pixels.height) >= 200 &&
        Number(pixels.distinctColors) >= 32,
      'Blank native capture'
    );
    const capturePath = manualCapturePaths[index];
    requireThat(capturePath, 'Missing fixed native capture path');
    const bytes = entries[capturePath];
    requireThat(Buffer.isBuffer(bytes) && bytes.length > 1000, 'Missing native screenshot bytes');
    equal(digest(bytes), painted.sha256, 'actual native screenshot hash');
  }
}
