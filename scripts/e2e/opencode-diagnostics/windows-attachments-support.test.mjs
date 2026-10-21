import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { defaultArtifact } from '../anthropic-compatible-status/packaged-default-artifact.ts';
import {
  attachmentRuntimeArguments,
  qualifyAttachmentRuntime,
  selectedModelCatalogObservation,
} from './windows-attachments-support.mts';

const executable = 'C:\\TEST\\AgentTeamsAI.exe';
const candidateFile = 'C:\\TEST\\runtime-candidate-evidence.json';
const runtimeArchive = 'C:\\TEST\\agent-teams-runtime-win32-x64-v0.0.129.zip';

test('attachment provenance selects one explicit immutable candidate or published archive mode', () => {
  assert.deepEqual(attachmentRuntimeArguments([executable, candidateFile]), {
    mode: 'candidate',
    executable,
    candidateFile,
  });
  assert.deepEqual(attachmentRuntimeArguments([executable, '--runtime-archive', runtimeArchive]), {
    mode: 'published',
    executable,
    runtimeArchive,
  });
  for (const args of [
    [],
    [executable],
    [executable, '--runtime-archive'],
    [executable, candidateFile, runtimeArchive],
    [executable, '--runtime-archive', runtimeArchive, candidateFile],
    [executable, '--candidate-evidence', candidateFile],
    [executable, '--runtime-archive', 'relative.zip'],
    [executable, '--runtime-archive', candidateFile],
    [executable, 'C:\\TEST\\other.json'],
    ['C:\\TEST\\Setup.exe', candidateFile],
    ['relative.exe', candidateFile],
  ])
    assert.throws(() => attachmentRuntimeArguments(args));
});

test('published proof uses the locked archive and anonymous manifest, then rejects post-run drift and candidate masquerade', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-attachment-public-proof-'));
  try {
    const repo = path.join(root, 'repo');
    const source = path.join(root, 'source');
    const runtime = path.join(source, 'runtime');
    const packaged = path.join(repo, 'package/resources/runtime');
    const binary = process.platform === 'win32' ? 'claude-multimodel.exe' : 'claude-multimodel';
    const bun = process.platform === 'win32' ? 'bun/bun.exe' : 'bun/bun';
    const sourceCommit = 'a'.repeat(40);
    const files = {
      [binary]: 'TEST compiled runtime',
      VERSION: '0.0.129',
      COMMIT_SHA: sourceCommit,
      'local-cli/cli.js': 'TEST entry',
      [bun]: 'TEST Bun',
      'opencode-console/opencode.exe': 'TEST archive-owned console wrapper',
    };
    for (const [relative, bytes] of Object.entries(files)) {
      const file = path.join(runtime, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
    }
    await mkdir(path.dirname(packaged), { recursive: true });
    await cp(runtime, packaged, { recursive: true });
    const archive = path.join(root, 'agent-teams-runtime-TEST-v0.0.129.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', source, 'runtime']);
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const asset = {
      file: path.basename(archive),
      archiveKind: 'tar.gz',
      binaryName: binary,
      sha256: hash(await readFile(archive)),
    };
    const lock = {
      version: '0.0.129',
      cliVersion: '0.0.129',
      sourceRef: 'v0.0.129',
      sourceRepository: 'TEST/sdk',
      releaseRepository: 'TEST/runtime',
      releaseTag: 'runtime-v0.0.129',
      assets: { [`${process.platform}-${process.arch}`]: asset },
    };
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, 'runtime.lock.json'), JSON.stringify(lock));
    const manifest = {
      version: lock.version,
      targetReleaseTag: lock.releaseTag,
      sourceRepository: lock.sourceRepository,
      sourceRef: lock.sourceRef,
      sourceCommit,
      assets: lock.assets,
    };
    let currentManifest = manifest;
    let reads = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(
        url,
        'https://github.com/TEST/runtime/releases/download/runtime-v0.0.129/agent-teams-runtime-manifest-v0.0.129.json'
      );
      assert(!options?.headers, 'Public manifest lookup must not inherit authorization');
      reads++;
      return new Response(JSON.stringify(currentManifest), { status: 200 });
    });
    const appFile = path.join(
      repo,
      'package',
      process.platform === 'win32' ? 'AgentTeamsAI.exe' : 'AgentTeamsAI'
    );
    await writeFile(appFile, 'TEST app');
    await writeFile(path.join(repo, 'package/resources/app.asar'), 'TEST asar');
    const renderer = path.join(repo, 'package/resources/app.asar.unpacked/out/renderer/index.html');
    await mkdir(path.dirname(renderer), { recursive: true });
    await writeFile(renderer, 'TEST renderer');
    const artifact = await defaultArtifact(appFile);
    const input = { mode: 'published', executable: appFile, runtimeArchive: archive };
    const before = await qualifyAttachmentRuntime(input, artifact, root, repo);
    const after = await qualifyAttachmentRuntime(input, artifact, root, repo);
    assert.deepEqual(after, before);
    assert.equal(before.delivery.archive.sha256, asset.sha256);
    assert.equal(before.delivery.sourceCommit, sourceCommit);
    assert.equal(reads, 2);
    await writeFile(path.join(repo, 'package/resources/app.asar'), 'changed after launch');
    await assert.rejects(
      qualifyAttachmentRuntime(input, artifact, root, repo),
      /app artifact changed/
    );
    await writeFile(path.join(repo, 'package/resources/app.asar'), 'TEST asar');
    await assert.rejects(
      qualifyAttachmentRuntime(input, { ...artifact, candidate: { testOnly: true } }, root, repo),
      /cannot use candidate/
    );
    currentManifest = { ...manifest, sourceRef: 'unreviewed' };
    await assert.rejects(qualifyAttachmentRuntime(input, artifact, root, repo));
    currentManifest = { ...manifest, assets: {} };
    await assert.rejects(
      qualifyAttachmentRuntime(input, artifact, root, repo),
      /manifest asset pins/
    );
    currentManifest = manifest;
    await writeFile(path.join(packaged, 'local-cli/cli.js'), 'changed after initial proof');
    await assert.rejects(
      qualifyAttachmentRuntime(input, artifact, root, repo),
      /differs from final public archive/
    );
    await writeFile(path.join(packaged, 'local-cli/cli.js'), files['local-cli/cli.js']);
    await writeFile(path.join(packaged, 'TEST-CANDIDATE.json'), '{}');
    await assert.rejects(
      qualifyAttachmentRuntime(input, artifact, root, repo),
      /Unexpected file|Ambient TEST candidate/
    );
    await rm(path.join(packaged, 'TEST-CANDIDATE.json'));
    await writeFile(archive, 'wrong archive bytes');
    await assert.rejects(
      qualifyAttachmentRuntime(input, artifact, root, repo),
      /differs from reviewed lock/
    );
    await assert.rejects(
      qualifyAttachmentRuntime(
        { mode: 'candidate', executable, candidateFile },
        { ...artifact, candidate: undefined },
        root,
        repo
      ),
      /candidate identity required/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('selected model observation preserves unknown declarations and catalog errors without granting admission or retaining secrets', () => {
  const selected = {
    providerId: 'openrouter',
    model: 'openrouter/openai/gpt-5.4-mini',
    projectPath: 'C:\\TEST\\project',
  };
  const row = {
    providerId: 'openrouter',
    modelId: 'openai/gpt-5.4-mini',
    declaredInputModalities: ['text', 'image'],
    auth: 'TEST-secret',
  };
  const response = {
    schemaVersion: 1,
    runtimeId: 'opencode',
    models: {
      runtimeId: 'opencode',
      providerId: 'openrouter',
      catalogState: 'fresh',
      freshUntil: '2026-10-21T20:00:00.000Z',
      diagnostics: ['TEST-secret'],
      models: [row],
    },
    auth: 'TEST-secret',
  };
  const observed = selectedModelCatalogObservation(selected, response);
  assert.equal(observed.admissionAuthority, false);
  assert.equal(observed.separateAppApiAttempt, true);
  assert.deepEqual(observed.selectedRow.declaredInputModalities, ['text', 'image']);
  assert(!JSON.stringify(observed).includes('TEST-secret'));
  const unknown = selectedModelCatalogObservation(selected, {
    ...response,
    models: { ...response.models, models: [{ ...row, declaredInputModalities: null }] },
  });
  assert.equal(unknown.selectedRow.declaredInputModalities, null);
  const redacted = selectedModelCatalogObservation(selected, {
    ...response,
    models: {
      ...response.models,
      models: [{ ...row, declaredInputModalities: ['syntheticsecret'] }],
    },
  });
  assert.equal(redacted.selectedRow.declarationRedacted, true);
  assert(!JSON.stringify(redacted).includes('syntheticsecret'));
  const missing = selectedModelCatalogObservation(selected, {
    ...response,
    models: { ...response.models, models: [{ ...row, providerId: 'foreign' }] },
  });
  assert.equal(missing.matchingRows, 0);
  assert.equal(missing.selectedRow, null);
  const failed = selectedModelCatalogObservation(selected, {
    schemaVersion: 1,
    runtimeId: 'opencode',
    error: { code: 'runtime-unhealthy', message: 'TEST-secret', details: { auth: 'TEST-secret' } },
  });
  assert.equal(failed.outcome, 'catalog-error');
  assert.equal(failed.errorCode, 'runtime-unhealthy');
  assert.equal(failed.selectedRow, null);
  assert(!JSON.stringify(failed).includes('TEST-secret'));
});

test('normal PR packaged workflow always executes attachment proof using an explicit public archive or candidate', async () => {
  const workflow = parse(
    await readFile(
      new URL('../../../.github/workflows/opencode-packaged-e2e.yml', import.meta.url),
      'utf8'
    )
  );
  const steps = workflow.jobs['packaged-windows'].steps;
  const fixture = steps.find((step) =>
    step.name?.startsWith('Prove compiled legacy Windows saved-file')
  );
  assert(fixture);
  assert.equal(fixture.if, undefined);
  assert(fixture.run.includes('--runtime-archive $archive'));
  assert(fixture.run.includes('$executable $candidate'));
  const archive = steps.find(
    (step) => step.name === 'Download and hash the locked public runtime archive'
  );
  assert.equal(
    archive.if,
    "inputs.runtime_candidate_run == '' && inputs.runtime_candidate_sha == ''"
  );
  assert(archive.run.includes('Get-FileHash $archive -Algorithm SHA256'));
});
