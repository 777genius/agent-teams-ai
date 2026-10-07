import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { ARM211_SHA } from '../../ci/release/windowsArmPriorFixture.ts';
import { downloadGithubFile } from './github-download.mts';
import { hashFile } from './inputs.mts';
import {
  acquireDecoder,
  arm211ListingEntries,
  assertFixturePath,
  assertRepairManifest,
  embeddedArm211Archive,
} from './windows-arm-prior-fixture.mts';
import { readPeArchitecture } from './windows-native.mts';
import { selectedWindowsPowerShell, windowsShellTestEnvironment } from './windows-powershell.mts';

const execute = promisify(execFile);
const sourceApplicationSha = '395572f9ff2a261cb28224754883a39d2c3c8827';
const sourceName = 'Agent.Teams.AI.Setup.2.17.1-arm64.exe';
const route = 'repos/777genius/agent-teams-ai/releases';

async function run() {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const output = process.argv[2];
  assert(output && path.isAbsolute(output));
  assert.equal(path.basename(output), 'TEST-arm211-archive-listing');
  const parent = await realpath(path.dirname(output));
  assert.equal(path.join(parent, path.basename(output)), output);
  await mkdir(output);
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'TEST-updater-windows-listing-'))
  );
  const guard = (file: string, exists = true) => assertFixturePath(root, file, exists);
  const receipt: Record<string, unknown> = {
    qualifying: false,
    fullOtaProved: false,
    scope: 'original-arm211-archive-listing-only',
    sourceApplicationSha,
    diagnosticHead: process.env.GITHUB_SHA,
    root,
    passed: false,
  };
  const save = () => writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await save();
  try {
    const shell = await selectedWindowsPowerShell();
    const gh = await realpath(path.join(shell.programFiles, 'GitHub CLI', 'gh.exe'));
    assert.equal(
      gh.toLowerCase(),
      path.join(shell.programFiles, 'GitHub CLI', 'gh.exe').toLowerCase()
    );
    const metadata = await execute(gh, ['api', `${route}/398386033`], {
      timeout: 30_000,
      maxBuffer: 1_000_000,
    });
    const release = JSON.parse(metadata.stdout) as {
      id: number;
      tag_name: string;
      draft: boolean;
      prerelease: boolean;
      assets: { id: number; name: string; size: number; digest: string; state: string }[];
    };
    assert.equal(release.id, 398386033);
    assert.equal(release.tag_name, 'v2.17.1');
    assert.equal(release.draft, false);
    assert.equal(release.prerelease, false);
    const assets = release.assets.filter((item) => item.id === 595803042);
    assert.equal(assets.length, 1);
    const asset = assets[0];
    assert(asset);
    assert.equal(asset.name, sourceName);
    assert.equal(asset.size, 196906862);
    assert.equal(asset.digest, `sha256:${ARM211_SHA}`);
    assert.equal(asset.state, 'uploaded');
    receipt.sourceMetadata = { releaseId: release.id, tag: release.tag_name, asset };
    const installer = path.join(root, sourceName);
    await guard(installer, false);
    const transfer = await downloadGithubFile(gh, `${route}/assets/595803042`, installer);
    assert.equal(transfer.exitCode, 0, 'Original asset transfer failed');
    assert.equal(transfer.error, '');
    await guard(installer);
    const source = await hashFile(installer);
    assert.equal(source.sha256, ARM211_SHA);
    assert.equal(source.size, 196906862);
    receipt.installer = source;
    const archive = path.join(root, 'app-arm64.7z');
    await guard(archive, false);
    const bytes = await readFile(installer);
    assert.equal(bytes.length, source.size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
    await writeFile(archive, embeddedArm211Archive(bytes), { flag: 'wx' });
    await guard(archive);
    const archiveProof = await hashFile(archive);
    receipt.archive = archiveProof;
    const decoder = await acquireDecoder(root);
    await guard(decoder.executable);
    assert.equal(decoder.binary.size, 849920);
    assert.equal(
      decoder.binary.sha256,
      '223b873c50380fe9a39f1a22b6abf8d46db506e1c08d08312902f6f3cd1f7ac3'
    );
    const pe = await readPeArchitecture(decoder.executable);
    assert.equal(pe.machine, 0x14c);
    receipt.decoder = { ...decoder, pe };
    await save();
    const env = await windowsShellTestEnvironment(root, shell);
    assert(Object.keys(env).every((key) => !/token|secret|credential|password/iu.test(key)));
    await guard(decoder.executable);
    await guard(archive);
    assert.deepEqual(await hashFile(decoder.executable), decoder.binary);
    assert.deepEqual(await hashFile(archive), archiveProof);
    const listing = await execute(decoder.executable, ['l', '-slt', archive], {
      env,
      cwd: root,
      timeout: 180_000,
      maxBuffer: 2_000_000,
      windowsHide: true,
    }).catch(async (error: unknown) => {
      const failure = error as Error & {
        stdout?: string;
        stderr?: string;
        code?: string | number;
        signal?: string;
      };
      for (const [name, raw] of [
        ['listing.txt', failure.stdout],
        ['listing-stderr.txt', failure.stderr],
      ]) {
        await writeFile(
          path.join(output, name ?? ''),
          Buffer.from(raw ?? '').subarray(0, 2_000_000),
          { flag: 'wx' }
        );
      }
      receipt.decoderFailure = { code: failure.code, signal: failure.signal };
      throw error;
    });
    await writeFile(path.join(output, 'listing.txt'), listing.stdout, { flag: 'wx' });
    await writeFile(path.join(output, 'listing-stderr.txt'), listing.stderr, { flag: 'wx' });
    receipt.listing = await hashFile(path.join(output, 'listing.txt'));
    await save(); // Raw listing and authenticated byte receipts precede the unchanged manifest guard.
    await guard(decoder.executable);
    await guard(archive);
    assert.deepEqual(await hashFile(decoder.executable), decoder.binary);
    assert.deepEqual(await hashFile(archive), archiveProof);
    const entries = arm211ListingEntries(listing.stdout);
    receipt.entryCount = entries.length;
    assertRepairManifest(entries);
    receipt.passed = true;
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    await save();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
