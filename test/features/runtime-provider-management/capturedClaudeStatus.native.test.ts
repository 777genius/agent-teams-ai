// @vitest-environment node
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { treeHash } from '../../../packages/legacy-agent-host/tests/fixtures/native-host';
import { DesktopBackendFeature } from '../../../src/features/agent-backend/main';
import { createCapturedRuntimeProviderStatusClient } from '../../../src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderStatusClient';

import type { TeamHostProfile } from '../../../packages/legacy-agent-host/dist/composition/TeamHost';
import type { DesktopBackendDescriptor } from '../../../src/features/agent-backend/main';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const digest = async (path: string) => hash(await readFile(path));
const mainSourcePaths = [
  'src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderStatusClient.ts',
  'src/features/runtime-provider-management/main/adapters/output/capturedClaudeMetadata.ts',
  'src/features/agent-backend/main/infrastructure/CapturedProviderManagement.ts',
  'src/features/agent-backend/main/infrastructure/loadDesktopBackendDescriptor.ts',
  'src/features/agent-backend/main/composition/DesktopBackendFeature.ts',
  'src/main/ipc/agentBackend.ts',
  'src/renderer/components/team/dialogs/TeamModelSelector.tsx',
  'src/shared/types/cliInstaller.ts',
  'test/features/runtime-provider-management/capturedClaudeStatus.native.test.ts',
];

it.skipIf(process.env.CLAUDE_METADATA_NATIVE_GO !== '1')(
  'Main captured selection → standalone Host → actual Claude SDK metadata, without Team bootstrap',
  async () => {
    const repo = process.cwd();
    const node = await realpath(
      join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node')
    );
    expect(await realpath(process.execPath)).toBe(node);
    const executable = await realpath(process.env.CLAUDE_PATH!);
    expect(await digest(executable)).toBe(process.env.CLAUDE_SHA);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-main-claude-metadata-')));
    for (const name of ['workspace', 'home', 'config', 'tmp', 'store', 'bindings'])
      await mkdir(join(root, name), { mode: 0o700 });
    const hookMarker = join(root, 'unexpected-hook-effect');
    await writeFile(join(root, 'config/settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/usr/bin/touch "$CLAUDE_METADATA_TEST_HOOK_MARKER"' }] }] } }), { mode: 0o600 });
    const sourceSha256 = await treeHash(join(repo, 'packages/legacy-agent-host/src'), '.ts');
    const distSha256 = await treeHash(join(repo, 'packages/legacy-agent-host/dist'), '.js');
    const mainSources = Object.fromEntries(
      await Promise.all(mainSourcePaths.map(async (path) => [path, await digest(join(repo, path))]))
    );
    let modelRequests = 0;
    const server = createServer((_request, response) => {
      modelRequests++;
      response.writeHead(503);
      response.end('TEST metadata must not execute a model');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address !== 'object')
      throw new Error('TEST metadata listener unavailable');
    let feature: DesktopBackendFeature | undefined;
    try {
      const hostEntry = await realpath(join(repo, 'packages/legacy-agent-host/dist/cli.js'));
      const owner = {
        ownerId: 'TEST-owner',
        revision: 'TEST-v1',
        profileId: 'TEST-host',
        protocolVersion: 1 as const,
        buildId: 'TEST-claude-metadata',
        storageRoot: join(root, 'store'),
        nodeSha256: await digest(node),
        hostEntrySha256: await digest(hostEntry),
      };
      const managementProfile = {
        provider: 'claude' as const,
        sdkRevision: '0.3.305' as const,
        profileId: 'TEST-claude',
        accountBinding: 'TEST-local',
        configRevision: 'TEST-metadata',
        cwd: join(root, 'workspace'),
        configNamespace: 'custom-directory' as const,
        settingSources: ['user' as const],
        timeoutMs: 15000,
        executable: { path: executable, sha256: await digest(executable) },
        environment: {
          HOME: join(root, 'home'),
          PATH: '/usr/bin:/bin',
          CLAUDE_CONFIG_DIR: join(root, 'config'),
          CLAUDE_METADATA_TEST_HOOK_MARKER: hookMarker,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
          ANTHROPIC_API_KEY: 'TEST-local-no-vendor-access',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          DISABLE_AUTOUPDATER: '1',
        },
      };
      const hostProfile: TeamHostProfile = {
        schemaVersion: 1,
        owner,
        principalId: 'TEST-human',
        teams: [],
        management: [managementProfile],
      };
      const profilePath = join(root, 'host-profile.json'),
        profileBytes = JSON.stringify(hostProfile);
      await writeFile(profilePath, profileBytes, { mode: 0o600 });
      const ref = { ownerId: owner.ownerId, revision: owner.revision };
      const descriptor: DesktopBackendDescriptor = {
        schemaVersion: 1,
        defaultOwner: ref,
        handles: [],
        owners: [
          {
            ...ref,
            storageRoot: owner.storageRoot,
            profile: {
              profileId: owner.profileId,
              nodeExecutable: node,
              nodeVersion: 'v24.21.0',
              nodeSha256: owner.nodeSha256,
              hostEntry,
              hostEntrySha256: owner.hostEntrySha256,
              expectedBuildId: owner.buildId,
              cwd: join(root, 'workspace'),
              env: {
                HOME: join(root, 'home'),
                TMPDIR: join(root, 'tmp'),
                PATH: '/usr/bin:/bin',
                LEGACY_AGENT_HOST_PROFILE_PATH: profilePath,
                LEGACY_AGENT_HOST_PROFILE_SHA256: hash(profileBytes),
              },
              startupTimeoutMs: 15000,
              requestTimeoutMs: 25000,
              writeTimeoutMs: 2000,
              shutdownTimeoutMs: 5000,
            },
          },
        ],
        management: [
          {
            runtimeId: 'claude',
            owner: ref,
            contextId: 'TEST-context',
            projectPath: join(root, 'workspace'),
            profileId: managementProfile.profileId,
            configRevision: managementProfile.configRevision,
          },
        ],
      };
      const descriptorPath = join(root, 'descriptor.json'),
        descriptorBytes = JSON.stringify(descriptor);
      await writeFile(descriptorPath, descriptorBytes, { mode: 0o600 });
      const backend = new DesktopBackendFeature({
        descriptor: { path: descriptorPath, sha256: hash(descriptorBytes) },
        bindingDirectory: join(root, 'bindings'),
      });
      feature = backend;
      await backend.initialize();
      const port = createCapturedRuntimeProviderStatusClient({
        capture: async () => {
          throw new Error('Wrong runtime selection');
        },
        captureClaude: (projectPath) =>
          backend.captureProviderManagement(
            'TEST-context',
            projectPath,
            { isCurrent: () => true },
            'claude'
          ),
        readHealth: () => backend.readRuntimeHealth('TEST-context', { isCurrent: () => true }),
      });
      const status = await port.getProviderStatus('anthropic', {
        projectPath: join(root, 'workspace'),
      });
      expect(status.statusCheckOutcome).toBe('model_only');
      expect(status.modelCatalog?.source).toBe('claude-sdk');
      expect(status.modelCatalog?.models.length).toBeGreaterThan(0);
      expect(new Set(status.models).size).toBe(status.models.length);
      expect(status.authenticated).toBe(false);
      expect(status.capabilities.teamLaunch).toBe(false);
      expect(modelRequests).toBe(0);
      await expect(access(hookMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      const shutdown = await backend.shutdown();
      expect(shutdown.length).toBe(1);
      const closed = shutdown[0];
      expect(closed?.status).toBe('fulfilled');
      if (closed?.status !== 'fulfilled') throw new Error('TEST Host shutdown was not confirmed');
      expect(closed.value.childExit).toBe('confirmed');
      expect(await treeHash(join(repo, 'packages/legacy-agent-host/src'), '.ts')).toBe(
        sourceSha256
      );
      expect(await treeHash(join(repo, 'packages/legacy-agent-host/dist'), '.js')).toBe(distSha256);
      expect(
        Object.fromEntries(
          await Promise.all(
            mainSourcePaths.map(async (path) => [path, await digest(join(repo, path))])
          )
        )
      ).toEqual(mainSources);
      const receipt = join(root, 'receipt.json');
      await writeFile(
        receipt,
        JSON.stringify(
          {
            scope:
              'Main management transport and actual SDK; no Electron dialog/vendor auth qualification',
            mainSources,
            sourceSha256,
            distSha256,
            providerArchiveSha256: await digest(
              join(
                repo,
                'vendor/provider-migration/claude-probe-v1/agent-teams-provider-implementations-0.0.0.tgz'
              )
            ),
            status,
            modelRequests,
            configuredHookEffectObserved: false,
            shutdown,
          },
          null,
          2
        ),
        { mode: 0o600 }
      );
      console.log(JSON.stringify({ receipt, modelCount: status.models.length, modelRequests }));
    } finally {
      if (feature) await feature.shutdown();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  },
  60000
);
