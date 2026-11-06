// @vitest-environment node
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

import { startNativeClaudeModelProbeFixture } from '../../../packages/legacy-agent-host/tests/fixtures/native-claude-model-probe';
import { treeHash } from '../../../packages/legacy-agent-host/tests/fixtures/native-host';
import {
  DesktopBackendFeature,
  FileTeamModelProbeIntents,
  prepareCapturedTeamModels,
} from '../../../src/features/agent-backend/main';
import { createCapturedRuntimeProviderManagementClient } from '../../../src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderManagementClient';

import type { StoredModelProbe } from '../../../packages/legacy-agent-host/dist/management/commandRecords';
import type {
  BackendLaunchModelProbe,
  BackendLaunchModelSelection,
} from '../../../src/features/agent-backend/contracts/launch';
import type { DesktopBackendDescriptor } from '../../../src/features/agent-backend/main';
import type { TeamHostProfile } from '@agent-teams/legacy-agent-host/team-host';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const digest = async (path: string) => hash(await readFile(path));
const sourcePaths = [
  'src/features/runtime-provider-management/main/adapters/output/CapturedModelProbe.ts',
  'src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderManagementClient.ts',
  'src/features/runtime-provider-management/contracts/types.ts',
  'src/main/ipc/agentBackend.ts',
  'packages/legacy-agent-host/package.json',
  'test/features/runtime-provider-management/capturedClaudeModelProbe.native.test.ts',
  'packages/legacy-agent-host/tests/fixtures/native-claude-model-probe.ts',
  'src/features/agent-backend/main/adapters/output/projectLaunchModelProbe.ts',
  'src/features/agent-backend/main/adapters/input/validateBackendOperation.ts',
  'src/features/agent-backend/contracts/launch.ts',
  'src/features/agent-backend/main/application/prepareCapturedTeamModels.ts',
  'src/main/ipc/teams/createPrepareProvisioningHandler.ts',
  'src/shared/utils/teamProvisioningContext.ts',
  'src/features/agent-backend/main/infrastructure/FileTeamModelProbeIntents.ts',
  'src/main/utils/durablePathOperations.ts',
  'src/main/utils/atomicWrite.ts',
  'src/features/agent-backend/main/adapters/output/projectLaunchConfiguration.ts',
];

it.skipIf(process.env.CLAUDE_MODEL_PROBE_NATIVE_GO !== '1')(
  'Main native Claude model tests preserve durable replay, wrong-model rejection and original cancellation',
  async () => {
    const repo = process.cwd();
    const node = await realpath(
      join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node')
    );
    expect(await realpath(process.execPath)).toBe(node);
    const executable = await realpath(process.env.CLAUDE_PATH!);
    expect(await digest(executable)).toBe(process.env.CLAUDE_SHA);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-main-claude-model-probe-')));
    for (const name of [
      'workspace',
      'home',
      'config',
      'tmp',
      'store',
      'bindings',
      'team-workspace',
      'team-home',
      'team-config',
      'worker-workspace',
      'worker-home',
      'worker-config',
    ])
      await mkdir(join(root, name), { mode: 0o700 });
    const marker = join(root, 'unexpected-hook');
    await writeFile(
      join(root, 'config/settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: 'command', command: '/usr/bin/touch "$CLAUDE_MODEL_PROBE_HOOK_MARKER"' },
              ],
            },
          ],
        },
      }),
      { mode: 0o600 }
    );
    await writeFile(
      join(root, 'team-config/settings.json'),
      await readFile(join(root, 'config/settings.json')),
      { mode: 0o600 }
    );
    const model = await startNativeClaudeModelProbeFixture();
    const teamModel = await startNativeClaudeModelProbeFixture({ expectedEffort: 'medium' });
    const workerModel = await startNativeClaudeModelProbeFixture({ expectedEffort: 'high' });
    const sourceSha256 = await treeHash(join(repo, 'packages/legacy-agent-host/src'), '.ts');
    const distSha256 = await treeHash(join(repo, 'packages/legacy-agent-host/dist'), '.js');
    const sources = Object.fromEntries(
      await Promise.all(sourcePaths.map(async (path) => [path, await digest(join(repo, path))]))
    );
    const features: DesktopBackendFeature[] = [];
    const shutdowns: unknown[] = [];
    let completed = false;
    console.log(JSON.stringify({ attempt: join(root, 'attempt.json') }));
    try {
      const hostEntry = await realpath(join(repo, 'packages/legacy-agent-host/dist/cli.js'));
      const owner = {
        ownerId: 'TEST-owner',
        revision: 'TEST-v1',
        profileId: 'TEST-host',
        protocolVersion: 1 as const,
        buildId: 'TEST-claude-probe',
        storageRoot: join(root, 'store'),
        nodeSha256: await digest(node),
        hostEntrySha256: await digest(hostEntry),
      };
      const management = {
        provider: 'claude' as const,
        sdkRevision: '0.3.305' as const,
        profileId: 'TEST-claude',
        accountBinding: 'TEST-api',
        configRevision: 'TEST-probe',
        cwd: join(root, 'workspace'),
        configNamespace: 'custom-directory' as const,
        settingSources: ['user' as const],
        timeoutMs: 15000,
        modelProbeTimeoutMs: 30000,
        executable: { path: executable, sha256: await digest(executable) },
        environment: {
          HOME: join(root, 'home'),
          CLAUDE_CONFIG_DIR: join(root, 'config'),
          PATH: '/usr/bin:/bin',
          ANTHROPIC_BASE_URL: model.endpoint,
          ANTHROPIC_API_KEY: 'TEST-local-no-vendor-access',
          CLAUDE_MODEL_PROBE_HOOK_MARKER: marker,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          DISABLE_AUTOUPDATER: '1',
        },
      };
      const teamScope = {
        projectId: 'TEST-team-project',
        workspaceId: 'TEST-team-workspace',
        teamId: 'TEST-team',
        runId: 'TEST-run',
        memberId: 'TEST-human',
        generation: '1',
      };
      const teamBinding = {
        backendId: owner.ownerId,
        teamId: teamScope.teamId,
        teamName: 'test-team-probe',
      };
      const teamHandle = { handleId: 'TEST-team-handle' };
      const profile: TeamHostProfile = {
        schemaVersion: 1,
        owner,
        principalId: 'TEST-human',
        teams: [
          {
            scope: teamScope,
            binding: teamBinding,
            members: [
              {
                memberId: 'TEST-lead',
                name: 'lead',
                role: 'lead',
                delivery: {
                  ...teamBinding,
                  runId: teamScope.runId,
                  memberId: 'TEST-lead',
                  generation: '1',
                },
              },
            ],
            grants: [
              {
                principalId: 'TEST-human',
                memberName: 'user',
                permissions: ['read', 'task.write', 'message.write', 'admin'],
              },
              {
                principalId: 'TEST-agent',
                memberName: 'lead',
                permissions: ['read', 'task.write', 'message.write'],
              },
            ],
          },
        ],
        management: [management],
        runtime: {
          members: [
            {
              provider: 'claude',
              teamId: teamScope.teamId,
              memberId: 'TEST-lead',
              principalId: 'TEST-agent',
              sessionId: 'TEST-runtime-session',
              generation: 1,
              configRevision: 'TEST-runtime-config',
              cwd: join(root, 'team-workspace'),
              model: 'claude-opus-4-6',
              accountBinding: 'TEST-team-account',
              configNamespace: 'custom-directory',
              executable: management.executable,
              environment: {
                ...management.environment,
                HOME: join(root, 'team-home'),
                CLAUDE_CONFIG_DIR: join(root, 'team-config'),
                ANTHROPIC_BASE_URL: teamModel.endpoint,
              },
              nativeTools: [],
              autoAllowedTools: [],
              nativeOptions: { settingSources: ['user'], effort: 'low', context: 'model-default' },
              limits: {
                queuedInputs: 4,
                inputBytes: 65536,
                outputBytes: 65536,
                outputEvents: 256,
                pendingInteractions: 8,
                timeoutMs: 30000,
              },
            },
          ],
        },
      };
      profile.teams[0]!.members.push({
        memberId: 'TEST-worker',
        name: 'worker',
        role: 'member',
        delivery: {
          ...teamBinding,
          runId: teamScope.runId,
          memberId: 'TEST-worker',
          generation: '1',
        },
      });
      profile.teams[0]!.grants.push({
        principalId: 'TEST-worker-agent',
        memberName: 'worker',
        permissions: ['read', 'task.write', 'message.write'],
      });
      const leadRuntime = profile.runtime!.members[0]!;
      profile.runtime!.members.push({
        ...leadRuntime,
        memberId: 'TEST-worker',
        principalId: 'TEST-worker-agent',
        sessionId: 'TEST-worker-session',
        cwd: join(root, 'worker-workspace'),
        accountBinding: 'TEST-worker-account',
        environment: {
          ...leadRuntime.environment,
          HOME: join(root, 'worker-home'),
          CLAUDE_CONFIG_DIR: join(root, 'worker-config'),
          ANTHROPIC_BASE_URL: workerModel.endpoint,
        },
      });
      await writeFile(
        join(root, 'worker-config/settings.json'),
        await readFile(join(root, 'config/settings.json')),
        { mode: 0o600 }
      );
      const profilePath = join(root, 'host-profile.json'),
        profileBytes = JSON.stringify(profile);
      await writeFile(profilePath, profileBytes, { mode: 0o600 });
      const ref = { ownerId: owner.ownerId, revision: owner.revision };
      const descriptor: DesktopBackendDescriptor = {
        schemaVersion: 1,
        defaultOwner: ref,
        handles: [
          {
            ...teamHandle,
            owner: ref,
            contextId: 'TEST-context',
            scope: teamScope,
            label: 'TEST scoped team',
            members: [
              { memberId: 'TEST-lead', label: 'lead' },
              { memberId: 'TEST-worker', label: 'worker' },
            ],
          },
        ],
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
            profileId: management.profileId,
            configRevision: management.configRevision,
          },
        ],
      };
      const descriptorPath = join(root, 'descriptor.json'),
        descriptorBytes = JSON.stringify(descriptor);
      await writeFile(descriptorPath, descriptorBytes, { mode: 0o600 });
      const open = async () => {
        const backend = new DesktopBackendFeature({
          descriptor: { path: descriptorPath, sha256: hash(descriptorBytes) },
          bindingDirectory: join(root, 'bindings'),
        });
        features.push(backend);
        await backend.initialize();
        const captureClaude = (projectPath: string | null, current?: () => boolean) =>
          backend.captureProviderManagement(
            'TEST-context',
            projectPath,
            { isCurrent: current ?? (() => true) },
            'claude'
          );
        const client = createCapturedRuntimeProviderManagementClient({
          capture: async () => {
            throw new Error('Wrong runtime capture');
          },
          captureClaude,
        });
        return { backend, client, captureClaude };
      };
      const close = async (backend: DesktopBackendFeature) => {
        const result = await backend.shutdown();
        shutdowns.push(result);
        expect(result).toHaveLength(1);
        const settled = result[0];
        expect(settled?.status).toBe('fulfilled');
        if (settled?.status !== 'fulfilled') throw new Error('Host cleanup unresolved');
        expect(settled.value.childExit).toBe('confirmed');
      };
      const input = {
        runtimeId: 'claude' as const,
        providerId: 'anthropic',
        modelId: 'claude-opus-4-6',
        projectPath: join(root, 'workspace'),
        requestGroupId: 'TEST-probe-group',
      };
      const records = async () =>
        (
          await Promise.all(
            (await readdir(join(root, 'store/management-commands')))
              .filter((name) => name.endsWith('.json'))
              .map(
                async (name) =>
                  JSON.parse(
                    await readFile(join(root, 'store/management-commands', name), 'utf8')
                  ) as StoredModelProbe
              )
          )
        ).filter((row) => row.kind === 'model.probe');
      const first = await open();
      const success = await first.client.testModel(input);
      expect(success).toMatchObject({
        runtimeId: 'claude',
        result: { ok: true, availability: 'available', modelId: input.modelId },
      });
      expect(model.observations).toHaveLength(1);
      const saved = (await records())[0]!;
      expect(saved.phase).toBe('completed');
      expect(saved.resourceHeld).toBe(false);
      const target = await first.captureClaude(input.projectPath);
      const replayInput = {
        commandId: saved.commandId,
        providerId: input.providerId,
        modelId: input.modelId,
      };
      expect(await target.request('probe.start', replayInput)).toMatchObject({
        ok: true,
        value: { phase: 'completed', ok: true, commandId: saved.commandId },
      });
      expect(model.observations).toHaveLength(1);
      const selected = await first.backend.facade.invoke({
        handle: teamHandle,
        commandId: 'TEST-launch-read',
        operation: 'team.launch.configuration.read',
        payload: {},
      });
      if (
        !selected.ok ||
        !selected.value ||
        !('launch' in selected.value) ||
        !selected.value.launch ||
        !('members' in selected.value)
      )
        throw new Error('Captured Team selection unavailable');
      expect(
        selected.value.members.map((row) => [row.label, row.role, row.selected?.effort])
      ).toEqual([
        ['lead', 'lead', 'low'],
        ['worker', 'member', 'low'],
      ]);
      const teamSelection: BackendLaunchModelSelection = {
        launchId: selected.value.launch.launchId,
        rosterRevision: selected.value.launch.rosterRevision,
        memberId: 'TEST-lead',
        model: 'claude-opus-4-6',
        effort: 'medium',
        context: 'model-default',
      };
      const teamCommand = 'TEST-team-model-probe';
      const teamProbe = async (
        backend: DesktopBackendFeature,
        action: 'start' | 'read' | 'cancel',
        commandId = teamCommand
      ) => {
        const result = await backend.facade.invoke({
          handle: teamHandle,
          commandId,
          operation: `team.launch.probe.${action}`,
          payload: teamSelection,
        });
        if (
          !result.ok ||
          !result.value ||
          !('phase' in result.value) ||
          !('expiresAt' in result.value)
        )
          throw new Error('Team model probe unavailable');
        return result.value as BackendLaunchModelProbe;
      };
      let teamProof = await teamProbe(first.backend, 'start');
      const teamDeadline = Date.now() + 30000;
      while (teamProof.phase === 'running' && Date.now() < teamDeadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        teamProof = await teamProbe(first.backend, 'read');
      }
      expect(teamProof).toMatchObject({
        phase: 'completed',
        ok: true,
        effort: 'medium',
        context: 'model-default',
        memberId: 'TEST-lead',
      });
      expect(teamModel.observations).toHaveLength(1);
      const prepareTeam = (backend: DesktopBackendFeature, preparationId = 'TEST-preparation-B') =>
        prepareCapturedTeamModels({
          backend: {
            invoke: (request) => backend.facade.invoke(request),
          },
          handle: teamHandle,
          intents: new FileTeamModelProbeIntents(join(root, 'preflight-intents'), root),
          isCurrent: () => backend.authorizeHandle('TEST-context', teamHandle),
          request: {
            cwd: join(root, 'team-workspace'),
            providerId: 'anthropic',
            providerIds: ['anthropic'],
            selectedModelChecks: [
              {
                providerId: 'anthropic',
                model: teamSelection.model,
                effort: 'medium',
                targets: [{ kind: 'lead' }],
              },
              {
                providerId: 'anthropic',
                model: teamSelection.model,
                effort: 'high',
                targets: [{ kind: 'member', name: 'worker' }],
              },
            ],
            limitContext: true,
            preparationId,
          },
        });
      teamModel.setNext('wrong-model');
      const failedTeamPreparation = await prepareTeam(first.backend, 'TEST-preparation-A');
      expect(failedTeamPreparation).toMatchObject({ ready: false });
      expect(teamModel.observations).toHaveLength(2);
      expect(await prepareTeam(first.backend, 'TEST-preparation-A')).toEqual(failedTeamPreparation);
      expect(teamModel.observations).toHaveLength(2);
      const renewedPreparations = await Promise.all(
        ['TEST-preparation-B', 'TEST-preparation-C'].map((id) => prepareTeam(first.backend, id))
      );
      const teamPreparation = renewedPreparations[0]!;
      expect(renewedPreparations.every((entry) => entry.ready)).toBe(true);
      expect(workerModel.observations).toHaveLength(1);
      expect(workerModel.observations[0]?.effort).toBe('high');
      expect(teamPreparation).toMatchObject({ ready: true });
      expect(teamModel.observations).toHaveLength(3);
      expect(await prepareTeam(first.backend)).toEqual(teamPreparation);
      expect(teamModel.observations).toHaveLength(3);
      expect(teamModel.observations[0]?.effort).toBe('medium');
      expect(model.observations).toHaveLength(1); // The Team used its own captured account/endpoint.
      expect(JSON.stringify(teamProof)).not.toMatch(
        /team-home|team-config|team-workspace|accountBinding|profileId|nativeSession/
      );
      expect(await teamProbe(first.backend, 'start')).toMatchObject({
        phase: 'completed',
        ok: true,
      });
      expect(teamModel.observations).toHaveLength(3);
      expect(
        await first.backend.facade.invoke({
          handle: teamHandle,
          commandId: teamCommand,
          operation: 'team.launch.probe.read',
          payload: { ...teamSelection, rosterRevision: 'TEST-stale' },
        })
      ).toMatchObject({ ok: false, code: 'conflict' });
      for (const memberId of ['TEST-lead', 'TEST-worker'])
        expect(
          await first.backend.facade.invoke({
            handle: teamHandle,
            commandId: `TEST-runtime-read-${memberId}`,
            operation: 'runtime.read',
            payload: { memberId },
          })
        ).toMatchObject({ ok: true, value: { phase: 'unopened' } });
      await close(first.backend);
      const second = await open();
      const restored = await second.captureClaude(input.projectPath);
      expect(await restored.request('probe.start', replayInput)).toMatchObject({
        ok: true,
        value: { phase: 'completed', ok: true, commandId: saved.commandId },
      });
      expect(model.observations).toHaveLength(1);
      expect(await teamProbe(second.backend, 'start')).toMatchObject({
        phase: 'completed',
        ok: true,
      });
      expect(await prepareTeam(second.backend)).toEqual(teamPreparation);
      expect(await prepareTeam(second.backend, 'TEST-preparation-A')).toEqual(
        failedTeamPreparation
      );
      expect(await prepareTeam(second.backend, 'TEST-preparation-C')).toEqual(teamPreparation);
      expect(workerModel.observations).toHaveLength(1);
      expect(teamModel.observations).toHaveLength(3);
      teamModel.setNext('hold');
      const heldTeam = await teamProbe(second.backend, 'start', 'TEST-team-model-cancel');
      expect(heldTeam.phase).toBe('running');
      await Promise.race([
        teamModel.waitForHeld(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('Team request was not observed')), 30000).unref()
        ),
      ]);
      expect(await teamProbe(second.backend, 'cancel', 'TEST-team-model-cancel')).toMatchObject({
        phase: 'cancelled',
        ok: false,
      });
      await teamModel.waitForDisconnect();
      expect(teamModel.observations).toHaveLength(4);
      const statePath = join(root, 'store/teams/test-team-probe/.host-owner/state.json');
      const authority = JSON.parse(await readFile(statePath, 'utf8')) as {
        grants: { principalId: string; revoked?: boolean; revision?: number }[];
      };
      const human = authority.grants.find((grant) => grant.principalId === 'TEST-human')!;
      human.revoked = true;
      human.revision = (human.revision ?? 1) + 1;
      await writeFile(statePath, JSON.stringify(authority));
      expect(
        await second.backend.facade.invoke({
          handle: teamHandle,
          commandId: 'TEST-denied-team-probe',
          operation: 'team.launch.probe.start',
          payload: teamSelection,
        })
      ).toMatchObject({ ok: false, code: 'forbidden' });
      expect(teamModel.observations).toHaveLength(4);
      human.revoked = false;
      human.revision += 1;
      await writeFile(statePath, JSON.stringify(authority));
      expect(
        await second.backend.facade.invoke({
          handle: teamHandle,
          commandId: teamCommand,
          operation: 'team.launch.probe.start',
          payload: teamSelection,
        })
      ).toMatchObject({ ok: false, code: 'conflict' });
      expect(
        await second.backend.facade.invoke({
          handle: teamHandle,
          commandId: teamCommand,
          operation: 'team.launch.probe.read',
          payload: teamSelection,
        })
      ).toMatchObject({ ok: false, code: 'conflict' });
      expect(teamModel.observations).toHaveLength(4);
      expect((await prepareTeam(second.backend, 'TEST-preparation-B')).ready).toBe(false);
      expect(teamModel.observations).toHaveLength(4);
      const regrantedTeamPreparation = await prepareTeam(second.backend, 'TEST-preparation-D');
      expect(regrantedTeamPreparation.ready).toBe(true);
      expect(workerModel.observations).toHaveLength(2);
      expect(teamModel.observations).toHaveLength(5);
      model.setNext('wrong-model');
      const wrong = await second.client.testModel({ ...input, requestGroupId: 'TEST-wrong-model' });
      expect(wrong).toMatchObject({
        runtimeId: 'claude',
        result: { ok: false, availability: 'unknown' },
      });
      model.setNext('hold');
      const pending = second.client.testModel({ ...input, requestGroupId: 'TEST-cancel-model' });
      await Promise.race([
        model.waitForHeld(),
        pending.then(() => {
          throw new Error('Probe ended before held request');
        }),
      ]);
      expect(model.failures).toEqual([]);
      expect(await second.client.cancelModelTest({ requestGroupId: 'TEST-cancel-model' })).toEqual({
        ok: true,
      });
      expect((await pending).result?.ok).not.toBe(true);
      await model.waitForDisconnect();
      expect(model.observations).toHaveLength(3);
      expect(model.failures).toEqual([]);
      expect(teamModel.failures).toEqual([]);
      expect(workerModel.failures).toEqual([]);
      const final = await records();
      expect(final.map((row) => row.phase).sort()).toEqual([
        'cancelled',
        'cancelled',
        'completed',
        'completed',
        'completed',
        'completed',
        'completed',
        'completed',
        'completed',
        'completed',
      ]);
      expect(final.every((row) => row.resourceHeld === false)).toBe(true);
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      await close(second.backend);
      expect(await treeHash(join(repo, 'packages/legacy-agent-host/src'), '.ts')).toBe(
        sourceSha256
      );
      expect(await treeHash(join(repo, 'packages/legacy-agent-host/dist'), '.js')).toBe(distSha256);
      expect(
        Object.fromEntries(
          await Promise.all(sourcePaths.map(async (path) => [path, await digest(join(repo, path))]))
        )
      ).toEqual(sources);
      const manifest = JSON.parse(
        await readFile(join(repo, 'packages/legacy-agent-host/package.json'), 'utf8')
      ) as { dependencies: Record<string, string> };
      const archive = manifest.dependencies['@agent-teams/provider-implementations']!;
      expect(archive).toMatch(/^file:.*vendor\/provider-migration\/claude-probe-v\d+\//);
      const receipt = join(root, 'receipt.json');
      await writeFile(
        receipt,
        JSON.stringify(
          {
            scope:
              'Main/captured standalone Host/actual SDK with localhost inference; no Electron/vendor qualification',
            sourceSha256,
            distSha256,
            sources,
            providerArchiveSha256: await digest(
              resolve(repo, 'packages/legacy-agent-host', archive.slice(5))
            ),
            observations: model.observations,
            teamObservations: teamModel.observations,
            teamFailures: teamModel.failures,
            workerObservations: workerModel.observations,
            workerFailures: workerModel.failures,
            teamProof,
            teamPreparation,
            failedTeamPreparation,
            regrantedTeamPreparation,
            failures: model.failures,
            success,
            wrong,
            records: final,
            replayWithoutModelRequests: true,
            shutdowns,
            configuredHookEffectObserved: false,
          },
          null,
          2
        ),
        { mode: 0o600 }
      );
      console.log(
        JSON.stringify({
          receipt,
          modelRequests: model.observations.length,
          replayWithoutModelRequests: true,
        })
      );
      completed = true;
    } finally {
      const cleanup = await Promise.allSettled(features.map((feature) => feature.shutdown()));
      await writeFile(
        join(root, 'attempt.json'),
        JSON.stringify(
          {
            status: completed ? 'PASS' : 'INCOMPLETE',
            sourceSha256,
            distSha256,
            sources,
            observations: model.observations,
            teamObservations: teamModel.observations,
            teamFailures: teamModel.failures,
            workerObservations: workerModel.observations,
            workerFailures: workerModel.failures,
            failures: model.failures,
            cleanup,
          },
          null,
          2
        ),
        { mode: 0o600 }
      );
      await model.close();
      await teamModel.close();
      await workerModel.close();
    }
  },
  120000
);
