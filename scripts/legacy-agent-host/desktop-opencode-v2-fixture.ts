import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { verifyOpenCodeV2EmbeddedGraph } from '../../packages/legacy-agent-host/dist/adapters/providers/OpenCodeV2EmbeddedGraph.js';
import { runtimeProfileSchema } from '../../packages/legacy-agent-host/dist/composition/runtimeProfile.js';
import { readPackagedProcessArtifact } from '../../packages/legacy-agent-host/dist/process/readPackagedProcessArtifact.js';
import { readOpenCodeV2DeliveryMap } from '../../src/features/opencode-runtime-installer/core/domain/v2Delivery.ts';
import { CONTEXT_MARKER } from '../../packages/legacy-agent-host/tests/fixtures/native-opencode-team/model.ts';
import type { OpenCodeMemberProfile } from '../../packages/legacy-agent-host/dist/composition/runtimeProfile.js';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';

export interface DesktopOpenCodeV2Selection {
  readonly bunPath: string;
  readonly bunSha256: string;
  readonly engineDirectory: string;
  readonly modelUrl: string;
  readonly endpoint: string;
  readonly processCustody?: TeamHostProfile['processCustody'];
}

/** One explicit TEST recipe. It starts no native child, alters no installed selection and grants no model readiness. */
export async function prepareDesktopOpenCodeV2Recipe(options: {
  repo: string;
  root: string;
  node: string;
  selection: DesktopOpenCodeV2Selection;
  identity: Pick<
    OpenCodeMemberProfile,
    'teamId' | 'memberId' | 'principalId' | 'sessionId' | 'generation' | 'configRevision'
  >;
}): Promise<OpenCodeMemberProfile> {
  const { root, selection } = options;
  assert.ok(
    (process.platform === 'linux' && process.arch === 'x64') ||
      (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)),
    'the selected tuple must provide original-process executable custody'
  );
  assert.match(basename(root), /^TEST-desktop-backend-/);
  assert.equal(await realpath(root), root);
  for (const value of [selection.modelUrl, selection.endpoint]) {
    const url = new URL(value);
    assert.equal(url.protocol, 'http:');
    assert.equal(url.hostname, '127.0.0.1');
    assert.ok(url.port);
    assert.equal(url.origin, value, 'only a captured loopback origin is accepted');
  }
  assert.equal(await realpath(selection.bunPath), selection.bunPath);
  assert.equal(await realpath(selection.engineDirectory), selection.engineDirectory);
  assert.match(selection.bunSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    createHash('sha256')
      .update(await readFile(selection.bunPath))
      .digest('hex'),
    selection.bunSha256
  );
  if (process.platform === 'darwin') {
    assert.ok(selection.processCustody, 'Darwin requires its exact packaged custody artifact');
    const artifact = readPackagedProcessArtifact(selection.processCustody);
    assert.equal(
      createHash('sha256')
        .update(await readFile(artifact.path))
        .digest('hex'),
      artifact.sha256
    );
  } else assert.equal(selection.processCustody, undefined);
  const lock: unknown = JSON.parse(await readFile(join(options.repo, 'runtime.lock.json'), 'utf8'));
  const delivery = readOpenCodeV2DeliveryMap(lock)?.[`${process.platform}-${process.arch}`];
  assert.ok(delivery, 'the app ships one exact V2 delivery for this platform');
  assert.equal(delivery.requiredBunVersion, process.platform === 'darwin' ? '1.4.4' : '1.3.11');
  assert.deepEqual(delivery.engineVersions, ['2.1.4']);
  const embedded = {
    directory: selection.engineDirectory,
    manifestSha256: delivery.manifest.sha256,
    version: '2.1.4' as const,
    platform: process.platform,
    arch: process.arch as 'arm64' | 'x64',
    externalDirectory: 'deny' as const,
    providerConfiguration: {
      package: 'aisdk:@ai-sdk/openai-compatible',
      settings: { baseURL: `${selection.modelUrl}/v1`, apiKey: 'TEST-LOCALHOST-ONLY' },
      models: {
        'TEST-model': {
          name: 'TEST-model',
          limit: { context: 200000, output: 2000 },
          capabilities: { tools: true, input: ['text'], output: ['text'] },
        },
      },
    },
  };
  await verifyOpenCodeV2EmbeddedGraph(embedded);
  const folder = join(root, 'providers/opencode-v2');
  for (const name of ['home', 'config', 'data', 'state', 'cache', 'tmp'])
    await mkdir(join(folder, name), { recursive: true, mode: 0o700 });
  const recipe: OpenCodeMemberProfile = {
    ...options.identity,
    provider: 'opencode',
    nativeGeneration: 'v2',
    protocolRevision: '2.1.4',
    cwd: join(root, 'workspace'),
    endpoint: selection.endpoint,
    model: 'TEST-model',
    accountBinding: 'TEST-opencode-localhost-only',
    executable: { path: selection.bunPath, sha256: selection.bunSha256 },
    environment: {
      HOME: join(folder, 'home'),
      TMPDIR: join(folder, 'tmp'),
      XDG_CONFIG_HOME: join(folder, 'config'),
      XDG_DATA_HOME: join(folder, 'data'),
      XDG_STATE_HOME: join(folder, 'state'),
      XDG_CACHE_HOME: join(folder, 'cache'),
      PATH: dirname(options.node) + ':/usr/bin:/bin',
      NO_COLOR: '1',
    },
    embedded,
    nativeOptions: {
      providerId: 'TEST-local',
      agent: 'TEST-member',
      toolApprovalMode: 'manual',
      instructions: CONTEXT_MARKER,
    },
    limits: {
      queuedInputs: 2,
      inputBytes: 8192,
      outputBytes: 1_000_000,
      outputEvents: 1500,
      pendingInteractions: 4,
      timeoutMs: 60_000,
    },
  };
  runtimeProfileSchema.parse({ members: [recipe] });
  return recipe;
}
