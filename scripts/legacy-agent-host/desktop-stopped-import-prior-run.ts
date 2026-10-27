// Source preparation only. The existing desktop smoke owns all import/Launch acceptance.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { LEGACY_IMPORT_TEAM } from './desktop-stopped-import-fixture.ts';

// These are existing Main owners, loaded by the installed tsx source loader only for fixture setup.
// Their aliases/Node sources are outside the standalone Host script compiler's public closure.
const mainModule = (path: string): Promise<Record<string, unknown>> =>
  import(pathToFileURL(join(import.meta.dirname, '../../src/main', path)).href);
const processOwner = await mainModule('utils/childProcess.ts');
const stopOwner = await mainModule('services/team/provisioning/LegacyNativeStopRelease.ts');
const pathOwner = await mainModule('utils/pathDecoder.ts');
const launchOwner = await mainModule('services/team/TeamLaunchStateStore.ts');
for (const [module, names] of [
  [processOwner, ['spawnCli', 'killProcessTreeAndWait']],
  [stopOwner, ['captureLegacyNativeStop', 'readLegacyNativeStopRelease']],
  [pathOwner, ['setClaudeBasePathOverride']],
  [launchOwner, ['TeamLaunchStateStore']],
] as const)
  for (const name of names) assert.equal(typeof module[name], 'function');
const spawnCli = processOwner.spawnCli as (
  binary: string,
  args: string[],
  options: SpawnOptions
) => ChildProcess;
const killProcessTreeAndWait = processOwner.killProcessTreeAndWait as (
  child: ChildProcess
) => Promise<void>;
const setClaudeBasePathOverride = pathOwner.setClaudeBasePathOverride as (path: string) => void;
const captureLegacyNativeStop = stopOwner.captureLegacyNativeStop as (
  root: string,
  run: {
    teamName: string;
    runId: string;
    detectedSessionId: string;
    child: ChildProcess;
    expectedMembers: never[];
    allEffectiveMembers: never[];
    mixedSecondaryLanes: never[];
    request: { providerId: string; members: never[] };
  },
  current: () => boolean
) => { complete(): Record<string, unknown> | null } | null;
const readLegacyNativeStopRelease = stopOwner.readLegacyNativeStopRelease as (
  root: string,
  team: string
) => unknown;
const TeamLaunchStateStore = launchOwner.TeamLaunchStateStore as new () => {
  beginStop(teamName: string): Promise<unknown>;
  markStopped(teamName: string, authority: unknown, proof: unknown): Promise<void>;
};

const root = resolve(process.argv[2]!);
assert.match(basename(root), /^TEST-desktop-backend-[A-Za-z0-9]+$/);
assert.equal(process.env.CLAUDE_ROOT, join(root, 'claude'));
assert.equal(process.env.HOME, join(root, 'home'));
setClaudeBasePathOverride(join(root, 'claude'));
assert.notEqual(process.platform, 'win32');
const team = join(root, 'claude/teams', LEGACY_IMPORT_TEAM);
const identity = lstatSync(team);
assert.ok(identity.isDirectory() && !identity.isSymbolicLink());
const current = () => {
  const now = lstatSync(team);
  return now.dev === identity.dev && now.ino === identity.ino && !now.isSymbolicLink();
};
if (process.argv[3] === '--read-only') {
  const marker = JSON.parse(readFileSync(join(team, 'launch-stopped.json'), 'utf8'));
  const censusOwner = await mainModule('services/team/provisioning/LegacyNativeStopCensus.ts');
  const parse = stopOwner.parseLegacyNativeStopRelease as (
    value: unknown
  ) => Record<string, unknown> | null;
  const census = censusOwner.readLegacyNativeCensus as (
    directory: string,
    target: unknown
  ) => unknown;
  const parsed = parse(marker.nativeRelease);
  let currentCensus: unknown;
  try {
    currentCensus = parsed ? census(team, parsed.target) : { error: 'unparseable-proof' };
  } catch (error) {
    currentCensus = { error: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(
    JSON.stringify({
      nodeVersion: process.versions.node,
      canonicalReleaseCurrent: readLegacyNativeStopRelease(team, LEGACY_IMPORT_TEAM) !== null,
      proofParseable: parsed !== null,
      proofCensus: parsed?.census,
      currentCensus,
    })
  );
} else {
  const write = (file: string, value: unknown) =>
    writeFileSync(join(team, file), JSON.stringify(value), { mode: 0o600 });
  const meta = JSON.parse(readFileSync(join(team, 'team.meta.json'), 'utf8'));
  const sourceRunId = `TEST-prior-run-${randomUUID()}`;
  const sourceSessionId = `TEST-synthetic-source-session-${randomUUID()}`;
  write('config.json', {
    name: LEGACY_IMPORT_TEAM,
    leadAgentId: `team-lead@${LEGACY_IMPORT_TEAM}`,
    leadSessionId: sourceSessionId,
    members: [{ name: 'team-lead', agentType: 'team-lead', providerId: 'anthropic' }],
  });
  write('members.meta.json', { version: 1, members: [] });
  write('launch-state.json', {
    version: 2,
    teamName: LEGACY_IMPORT_TEAM,
    publicationRunId: sourceRunId,
    leadSessionId: sourceSessionId,
    expectedMembers: [],
    members: {},
  });
  write('launch-freshness.json', {
    version: 1,
    teamName: LEGACY_IMPORT_TEAM,
    kind: 'launch',
    runId: sourceRunId,
  });
  // A real source-owned child supplies custody proof. No source provider inference or native history is fabricated.
  const child = spawnCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: root,
    env: { HOME: process.env.HOME, PATH: process.env.PATH },
    detached: true,
    stdio: 'ignore',
  });
  let stopped = false;
  try {
    const captured = captureLegacyNativeStop(
      join(root, 'claude/teams'),
      {
        teamName: LEGACY_IMPORT_TEAM,
        runId: sourceRunId,
        detectedSessionId: sourceSessionId,
        child,
        expectedMembers: [],
        allEffectiveMembers: [],
        mixedSecondaryLanes: [],
        request: { providerId: 'anthropic', members: [] },
      },
      current
    );
    assert.ok(captured, 'existing source owner captures the actual child identity before Stop');
    assert.equal(captured.complete(), null, 'a live captured child is not a release witness');
    const store = new TeamLaunchStateStore();
    const authority = await store.beginStop(LEGACY_IMPORT_TEAM);
    await killProcessTreeAndWait(child);
    stopped = true;
    const proof = captured.complete();
    assert.ok(proof, 'existing process owner confirms physical exit before publication');
    await store.markStopped(LEGACY_IMPORT_TEAM, authority, proof);
    assert.deepEqual(readLegacyNativeStopRelease(team, LEGACY_IMPORT_TEAM), proof);
    const evidence = {
      scope:
        'Synthetic solo legacy product/run records with an actual source-owned TEST Node child and existing captured Stop publication; no old provider inference',
      sourceRunId,
      sourceSessionId,
      sourceNativeInputs: 0,
      savedSettings: meta,
      proof,
      childExit: { exitCode: child.exitCode, signalCode: child.signalCode },
    };
    writeFileSync(join(root, 'stopped-import-prior-run.json'), JSON.stringify(evidence, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
  } finally {
    if (!stopped) await killProcessTreeAndWait(child);
  }
}
