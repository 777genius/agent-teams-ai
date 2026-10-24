import assert from 'node:assert/strict';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { prepareDesktopBackendFixture, fileDigest } from './desktop-backend-fixture.ts';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
const json = async (path: string): Promise<Row> => row(JSON.parse(await readFile(path, 'utf8')));
const EXPECTED_RECEIPT = 'a2b9b521e4e82eb4cb38820900d912b361be264a3e541ed700348bbdcef6dbf5';
const EXPECTED_PROFILE = '2070d0545bbeb48ef5f9633d79a8ac3b1f404ca384485dc38ae4ec5179563dec';

export interface CapturedActivitySource {
  status: 'SCOPED_PASS';
  nativeRoot: string;
  storeRoot: string;
  profilePath: string;
  receiptPath: string;
  teamId: string;
  teamName: string;
  memberId: string;
  memberName: string;
  canonical: Record<string, { sha256: string; mode: number }>;
  provenance: {
    inputId: string;
    operationRef: string;
    childId: string;
    parentToolRef: string;
    phases: string[];
  };
}

/** Exact canonical files only. The sole live profile lease is separately scoped by its existing contract. */
export async function snapshotCapturedActivityStore(root: string) {
  assert.equal(await realpath(root), root);
  const found: Record<string, { sha256: string; mode: number }> = {};
  let count = 0,
    total = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    assert.ok(depth <= 16);
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      assert.ok(++count <= 4096);
      const path = join(directory, entry.name),
        key = relative(root, path);
      if (key === '.legacy-agent-host-writer.lock') continue;
      const info = await lstat(path);
      assert.equal(
        info.isSymbolicLink(),
        false,
        'canonical store inventory never follows symlinks'
      );
      if (info.isDirectory()) await visit(path, depth + 1);
      else {
        assert.ok(info.isFile());
        assert.ok(info.size <= 32 * 1024 * 1024);
        total += info.size;
        assert.ok(total <= 128 * 1024 * 1024);
        found[key] = {
          sha256: await fileDigest(path),
          mode: info.mode & 0o777,
        };
      }
    }
  };
  await visit(root, 0);
  return found;
}

export async function readCapturedActivitySessions(source: CapturedActivitySource): Promise<Row[]> {
  const root = join(source.storeRoot, 'runtime-sessions'),
    result: Row[] = [];
  for (const ns of await readdir(root, { withFileTypes: true })) {
    assert.ok(ns.isDirectory() && /^[a-f0-9]{64}$/.test(ns.name));
    for (const file of await readdir(join(root, ns.name), {
      withFileTypes: true,
    })) {
      if (!/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
      assert.ok(file.isFile());
      result.push(await json(join(root, ns.name, file.name)));
      assert.ok(result.length <= 16);
    }
  }
  return result;
}

export async function assertCapturedActivityUnchanged(
  source: CapturedActivitySource
): Promise<void> {
  assert.equal(await fileDigest(source.profilePath), EXPECTED_PROFILE);
  assert.equal(await fileDigest(source.receiptPath), EXPECTED_RECEIPT);
  assert.deepEqual(
    await snapshotCapturedActivityStore(source.storeRoot),
    source.canonical,
    'readback must not append duplicate closed events, resume unknown input, or change any canonical record'
  );
}

/** Preparation only: fresh app-shell files, ORIGINAL profile/store/owner. No Host/provider launch or business seed. */
export async function prepareDesktopCapturedActivityReadback(
  repo: string,
  pnpmEntry: string,
  nativeRoot: string
) {
  assert.equal(await realpath(nativeRoot), nativeRoot);
  assert.equal(basename(nativeRoot), 'TEST-native-claude-subagent-nLzhgr');
  const profilePath = join(nativeRoot, 'profile.json'),
    receiptPath = join(nativeRoot, 'receipt.json');
  assert.equal(await fileDigest(receiptPath), EXPECTED_RECEIPT);
  assert.equal(await fileDigest(profilePath), EXPECTED_PROFILE);
  const receipt = await json(receiptPath);
  assert.equal(receipt.status, 'SCOPED_PASS');
  assert.equal(receipt.cleanup, true);
  assert.deepEqual(receipt.failures, []);
  const profile = readTeamHostProfile(profilePath, EXPECTED_PROFILE);
  const team = profile.teams.find((team) => team.binding.teamId === 'TEST-team-a');
  assert.ok(team);
  const member = team.members.find((member) => member.memberId === 'a-id');
  assert.ok(member);
  const proof = row(row(receipt.proofs).provenance);
  const source: CapturedActivitySource = {
    status: 'SCOPED_PASS',
    nativeRoot,
    storeRoot: profile.owner.storageRoot,
    profilePath,
    receiptPath,
    teamId: team.binding.teamId,
    teamName: team.binding.teamName,
    memberId: member.memberId,
    memberName: member.name,
    canonical: await snapshotCapturedActivityStore(profile.owner.storageRoot),
    provenance: {
      inputId: String(proof.inputId),
      operationRef: String(proof.operationRef),
      childId: String(proof.childId),
      parentToolRef: String(proof.parentToolRef),
      phases: (proof.phases as unknown[]).map(String),
    },
  };
  await assert.rejects(
    lstat(join(source.storeRoot, '.legacy-agent-host-writer.lock')),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    'original profile has no retained live lease'
  );
  const sessions = await readCapturedActivitySessions(source);
  assert.equal(sessions.length, 2);
  assert.ok(
    sessions.every((session) => session.phase === 'closed' && session.custody === 'released')
  );
  const parent = sessions.find((session) => row(session.binding).memberId === member.memberId);
  assert.ok(parent);
  assert.deepEqual(
    (parent.inputs as unknown[]).map((input) => row(input).phase),
    ['terminal', 'terminal', 'unknown']
  );
  assert.equal(
    await fileDigest(join(repo, 'packages/legacy-agent-host/dist/cli.js')),
    profile.owner.hostEntrySha256
  );

  // Reuse the existing isolated Desktop shell/sentinels/pinned package-manager preparation with no Task seed.
  // Its unused empty descriptor is replaced BEFORE exposure; the original native profile is never rewritten.
  const fixture = await prepareDesktopBackendFixture(repo, { pnpmEntry, seedUiPreferences: true });
  assert.equal(fixture.pins.nodeSha256, profile.owner.nodeSha256);
  const originalDescriptor = await json(fixture.descriptorPath);
  const selected = row((originalDescriptor.owners as unknown[])[0]);
  const capturedProfile = row(selected.profile),
    env = row(capturedProfile.env);
  const owner = {
    ownerId: profile.owner.ownerId,
    revision: profile.owner.revision,
  };
  const handleId = 'TEST-activity-' + runtimeDigest(team.scope).slice(0, 32);
  const descriptor = {
    schemaVersion: 1,
    defaultOwner: owner,
    owners: [
      {
        ...owner,
        storageRoot: source.storeRoot,
        profile: {
          ...capturedProfile,
          profileId: profile.owner.profileId,
          expectedBuildId: profile.owner.buildId,
          env: {
            ...env,
            LEGACY_AGENT_HOST_PROFILE_PATH: profilePath,
            LEGACY_AGENT_HOST_PROFILE_SHA256: EXPECTED_PROFILE,
          },
        },
      },
    ],
    handles: [
      {
        handleId,
        owner,
        contextId: 'local',
        label: 'TEST retained native child Team',
        members: [{ memberId: member.memberId, label: member.name }],
        scope: team.scope,
      },
    ],
  };
  await writeFile(fixture.descriptorPath, JSON.stringify(descriptor), {
    mode: 0o600,
  });
  fixture.handleId = handleId;
  fixture.profilePath = profilePath;
  fixture.pins.profileSha256 = EXPECTED_PROFILE;
  fixture.pins.descriptorSha256 = await fileDigest(fixture.descriptorPath);
  fixture.appEnvironment.AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256 = fixture.pins.descriptorSha256;
  await assertCapturedActivityUnchanged(source);
  return { fixture, source };
}
