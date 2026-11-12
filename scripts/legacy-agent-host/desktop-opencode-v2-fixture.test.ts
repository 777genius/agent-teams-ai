import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import { prepareDesktopOpenCodeV2Recipe } from './desktop-opencode-v2-fixture.ts';
import { parseOpenCodeQualifiedModelRef } from '../../src/shared/utils/opencodeModelRef.ts';

const bunPath = process.env.OPENCODE_V2_EMBEDDED_BUN;
const bunSha256 = process.env.OPENCODE_V2_EMBEDDED_BUN_SHA256;
const engineDirectory = process.env.OPENCODE_V2_EMBEDDED_GRAPH;
const repo = resolve(import.meta.dirname, '../..');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test(
  'Desktop captures embedded delivery and native management in its original private Host descriptor',
  {
    skip: !bunPath || !bunSha256 || !engineDirectory,
    timeout: 60_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'TEST-desktop-opencode-composition-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    // This file-only composition test starts neither Corepack nor Electron.
    // Synthetic package metadata satisfies the fixture's existing path census only.
    await mkdir(join(root, 'dist/lib'), { recursive: true });
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'corepack', version: 'TEST' })
    );
    await writeFile(
      join(root, 'dist/pnpm.js'),
      'throw new Error("TEST must not execute Corepack");\n'
    );
    await writeFile(
      join(root, 'dist/lib/corepack.cjs'),
      'throw new Error("TEST must not execute Corepack");\n'
    );
    const selection = {
      bunPath: bunPath!,
      bunSha256: bunSha256!,
      engineDirectory: engineDirectory!,
      ...(process.platform === 'darwin'
        ? {
            processCustody: {
              directory: process.env.OPENCODE_V2_EMBEDDED_PROCESS_CUSTODY_DIRECTORY!,
              manifestSha256: process.env.OPENCODE_V2_EMBEDDED_PROCESS_CUSTODY_MANIFEST_SHA256!,
            },
          }
        : {}),
      endpoint: 'http://127.0.0.1:41789',
      managementEndpoint: 'http://127.0.0.1:41791',
      modelUrl: 'http://127.0.0.1:41790',
      imageInput: true,
    };
    const fixture = await prepareDesktopBackendFixture(repo, {
      pnpmEntry: join(root, 'dist/pnpm.js'),
      nativeOpenCodeV2: selection,
      creation: true,
      launchDialog: true,
    });
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const profile = readTeamHostProfile(fixture.profilePath, fixture.pins.profileSha256);
    const member = profile.runtime!.members[0]!;
    assert.equal(member.provider, 'opencode');
    if (member.provider !== 'opencode') throw new Error('Missing exact OpenCode recipe');
    assert.equal(member.nativeGeneration, 'v2');
    assert.equal(member.protocolRevision, '2.1.4');
    assert.equal(member.executable.path, bunPath);
    assert.equal(member.executable.sha256, bunSha256);
    assert.deepEqual(profile.processCustody, selection.processCustody);
    assert.equal(member.embedded?.directory, engineDirectory);
    assert.equal(
      member.embedded?.manifestSha256,
      hash(await readFile(join(engineDirectory!, 'opencode-v2-engine-manifest.json')))
    );
    assert.equal(member.environment.OPENCODE_CONFIG_CONTENT, undefined);
    assert.equal(member.environment.OPENCODE_CLI_PATH, undefined);
    assert.equal(member.environment.OPENCODE_SERVER_PASSWORD, undefined);
    assert.deepEqual(profile.runtime!.providerTemplates, [member]);
    assert.equal(profile.management?.length, 1);
    const management = profile.management![0]!;
    assert.equal(management.provider, 'opencode');
    if (management.provider !== 'opencode') throw new Error('Missing native V2 management recipe');
    assert.equal(management.nativeGeneration, 'v2');
    assert.equal(management.protocolRevision, '2.1.4');
    assert.deepEqual(management.embedded, member.embedded);
    assert.deepEqual(management.executable, member.executable);
    assert.deepEqual(management.nativeModel, { providerId: 'test-local', modelId: 'TEST-model' });
    assert.deepEqual(member.embedded?.providerConfiguration?.models, {
      'TEST-model': {
        name: 'TEST-model',
        limit: { context: 200000, output: 2000 },
        capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
      },
    });
    assert.equal(management.endpoint, selection.managementEndpoint);
    assert.equal(profile.teams[0]!.savedSettings?.model, 'test-local/TEST-model');
    assert.equal(parseOpenCodeQualifiedModelRef(profile.teams[0]!.savedSettings?.model)?.sourceId,
      management.nativeModel?.providerId,
      'the original Composer catalog scope selects the exact native provider');
    assert.equal(profile.teams[0]!.members[0]!.role, 'lead');
    const descriptor = JSON.parse(await readFile(fixture.descriptorPath, 'utf8'));
    assert.deepEqual(
      descriptor.management.map((entry: { projectPath: string | null }) => entry.projectPath),
      [null, join(fixture.root, 'workspace')],
      'global and original Composer project reads are captured explicitly'
    );
    for (const entry of descriptor.management) {
      assert.equal(entry.runtimeId, 'opencode');
      assert.equal(entry.profileId, management.profileId);
      assert.equal(entry.configRevision, management.configRevision);
      assert.deepEqual(entry.owner, descriptor.defaultOwner);
    }
    assert.equal(
      descriptor.owners[0].profile.env.LEGACY_AGENT_HOST_PROFILE_SHA256,
      fixture.pins.profileSha256
    );
    assert.equal(descriptor.owners[0].profile.nodeExecutable, fixture.node);
    assert.equal(descriptor.owners[0].profile.nodeVersion, process.version);
    assert.equal(hash(await readFile(fixture.descriptorPath)), fixture.pins.descriptorSha256);
    assert.equal(JSON.stringify(descriptor).includes('TEST-LOCALHOST-ONLY'), false);
    assert.deepEqual(
      await readdir(member.environment.XDG_DATA_HOME!),
      [],
      'composition runs no engine'
    );
    assert.deepEqual(
      await readdir(join(fixture.root, 'hoststore')),
      [],
      'composition creates no Team state'
    );
    const input = { repo, root: fixture.root, node: fixture.node, identity: member, selection };
    await assert.rejects(
      prepareDesktopOpenCodeV2Recipe({
        ...input,
        selection: { ...selection, modelUrl: 'http://example.com:41790' },
      }),
      /127\.0\.0\.1/
    );
    await assert.rejects(
      prepareDesktopOpenCodeV2Recipe({
        ...input,
        selection: { ...selection, bunPath: fixture.node },
      }),
      /AssertionError/
    );
  }
);
