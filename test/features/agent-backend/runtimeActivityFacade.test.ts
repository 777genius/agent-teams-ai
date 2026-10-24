// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createTeamHost } from '../../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import { initialContextDigest } from '../../../packages/legacy-agent-host/dist/team-launch/context.js';
import { hostTeamRunId } from '../../../src/features/agent-backend/contracts';
import { BackendOperationsFacade } from '../../../src/features/agent-backend/main';
import {
  createHostTeamsApi,
  hostTeamSelectionKey,
} from '../../../src/features/agent-backend/renderer';

import type { TeamHostProfile } from '../../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import type { BackendOperationRequest } from '../../../src/features/agent-backend/contracts';
import type { BackendOwnerRouter } from '../../../src/features/agent-backend/main';
import type { TeamsAPI } from '../../../src/shared/types/api';
import type { ReplaceMembersRequest } from '../../../src/shared/types/team';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

type Provider = ReturnType<NonNullable<Parameters<typeof createTeamHost>[2]>['createProvider']>;
type Session = Awaited<ReturnType<Provider['factory']['open']>>['driver'];
type Input = Parameters<Session['submit']>[0];

const cursor = Buffer.from(
  JSON.stringify({ resource: 'a'.repeat(64), hostIncarnation: 'TEST-incarnation', sequence: 7 })
).toString('base64url');
const request: BackendOperationRequest = {
  handle: { handleId: 'captured-handle' },
  commandId: 'read-activity',
  operation: 'runtime.activity.feed',
  payload: { memberId: 'member-A', cursor },
};
const state = {
  phase: 'allocated',
  custody: 'owned',
  sealed: false,
  nativeReady: true,
  queuedInputs: 1,
  activeInputs: 1,
  partial: false,
  diagnostic: null,
  control: { inputId: 'input-A', phase: 'pending', operationRef: 'PRIVATE-operation' },
  interactions: [
    {
      inputId: 'input-A',
      interactionRef: 'permission-A',
      kind: 'permission',
      expiresAt: 1000,
      phase: 'pending',
      operationRef: 'PRIVATE-operation',
    },
  ],
  checkpoints: [{ checkpointId: 'checkpoint-A', reference: 'PRIVATE-checkpoint-payload' }],
};

function setup() {
  const router = {
    request: vi.fn<BackendOwnerRouter['request']>(),
    lookup: vi.fn<BackendOwnerRouter['lookup']>(),
  };
  return { router, facade: new BackendOperationsFacade(router) };
}
const event = (sequence: number, data: unknown) => ({
  sequence,
  eventId: `event-${sequence}`,
  inputId: 'input-A',
  operationRef: 'PRIVATE-operation',
  nativeSessionId: 'PRIVATE-native',
  data,
});
const feed = (events: unknown[]) => ({
  memberId: 'member-A',
  cursor,
  retainedFrom: 1,
  events,
  hasMore: true,
  binding: { storageRoot: '/PRIVATE/root' },
  checkpoint: 'PRIVATE-checkpoint',
});

describe('finite Runtime activity facade', () => {
  it('projects actual NDJSON Runtime activity through the production facade after a canonical Team input', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-activity-facade-')));
    const input = new PassThrough(),
      output = new PassThrough();
    const owner: TeamHostProfile['owner'] = {
      ownerId: 'TEST-backend',
      revision: '1',
      storageRoot: root,
      profileId: 'TEST-profile',
      protocolVersion: 1,
      buildId: 'TEST-activity',
      nodeSha256: 'a'.repeat(64),
      hostEntrySha256: 'b'.repeat(64),
    };
    const scope = {
      projectId: 'TEST-project',
      workspaceId: 'TEST-workspace',
      teamId: 'TEST-team',
      runId: 'TEST-run',
      memberId: 'human',
      generation: '1',
    };
    const binding = { backendId: owner.ownerId, teamId: scope.teamId, teamName: 'test-activity' };
    let firstSubmitted!: (value: Input) => void;
    const firstTurn = new Promise<Input>((resolve) => {
      firstSubmitted = resolve;
    });
    let nativeOpens = 0;
    const nativeInputs: Input[] = [];
    const nativeProfiles: Parameters<
      NonNullable<Parameters<typeof createTeamHost>[2]>['createProvider']
    >[0]['profile'][] = [];
    const host = createTeamHost(
      {
        schemaVersion: 1,
        owner,
        principalId: 'human',
        teams: [
          {
            binding,
            scope,
            savedSettings: {
              cwd: root,
              prompt: 'TEST original configured prompt',
              skipPermissions: false,
            },
            members: [
              {
                memberId: 'member-A',
                name: 'alice',
                role: 'lead',
                delivery: { ...binding, runId: scope.runId, memberId: 'member-A', generation: '1' },
              },
            ],
            grants: [
              {
                principalId: 'human',
                memberName: 'user',
                permissions: ['read', 'admin', 'message.write'],
              },
              {
                principalId: 'alice-session',
                memberName: 'alice',
                permissions: ['read', 'message.write', 'task.write'],
              },
            ],
          },
        ],
        runtime: {
          members: [
            {
              teamId: scope.teamId,
              memberId: 'member-A',
              principalId: 'alice-session',
              provider: 'claude',
              sessionId: 'PRIVATE-session-config',
              generation: 1,
              configRevision: 'PRIVATE-config',
              cwd: root,
              model: 'TEST-model',
              accountBinding: 'PRIVATE-account',
              environment: { HOME: root },
              executable: { path: '/TEST/no-process', sha256: 'c'.repeat(64) },
              nativeTools: [],
              autoAllowedTools: [],
              limits: {
                queuedInputs: 4,
                inputBytes: 65536,
                outputBytes: 65536,
                outputEvents: 64,
                pendingInteractions: 4,
                timeoutMs: 1000,
              },
            },
          ],
        },
      },
      { input, output },
      {
        createProvider(context) {
          let sealed = false;
          let submitted!: (value: Input) => void;
          const turn = new Promise<Input>((resolve) => {
            submitted = resolve;
          });
          let closeObservation!: () => void;
          const closed = new Promise<void>((resolve) => {
            closeObservation = resolve;
          });
          nativeProfiles.push(structuredClone(context.profile));
          const session: Session = {
            sessionRef: 'PRIVATE-native-session',
            submit: async (value) => {
              nativeInputs.push(structuredClone(value));
              firstSubmitted(value);
              submitted(value);
              return {
                ok: true,
                value: {
                  inputId: value.inputId,
                  operationRef: value.operationRef,
                  delivery: 'client-consumed',
                  providerAcceptance: 'unknown',
                },
              };
            },
            async *observe() {
              const value = await turn;
              const source = {
                sessionRef: session.sessionRef,
                inputId: value.inputId,
                operationRef: value.operationRef,
              };
              yield {
                ...source,
                kind: 'text',
                messageRef: 'answer-1',
                block: 0,
                text: 'Actual host observation',
                phase: 'complete',
              };
              context.onProgress();
              yield { ...source, kind: 'usage', outputTokens: 3 };
              context.onProgress();
              yield { ...source, kind: 'result', outcome: 'succeeded' };
              context.onProgress();
              await closed;
            },
            checkReadiness: async () => ({ ok: true, value: undefined }),
            respondToInteraction: async () => ({ ok: true, value: undefined }),
            interrupt: async () => ({
              ok: true,
              value: { requested: true, terminal: 'unconfirmed' },
            }),
            checkpoint: () => ({ ok: false, code: 'unsupported' }),
            close: async () => {
              closeObservation();
              return { logicallyClosed: true, cleanup: 'confirmed' };
            },
          };
          return {
            factory: {
              open: async () => {
                nativeOpens++;
                return { driver: session, capabilities: ['session.conversation'] };
              },
            },
            isReady: () => !sealed && context.isCurrent(),
            initialContextEvidence: () =>
              !sealed && context.isCurrent()
                ? {
                    kind: 'native-configuration',
                    contextDigest: initialContextDigest(context.instructions),
                    generation: context.endpoint.binding.generation,
                    configRevision: context.request.configRevision,
                  }
                : undefined,
            seal: () => {
              sealed = true;
            },
            cleanup: async () => true,
          };
        },
      }
    );
    const replies = new Map<number, (value: JsonValue) => void>();
    let sequence = 0,
      tail = '';
    output.on('data', (chunk: Buffer) => {
      tail += chunk.toString();
      let newline: number;
      while ((newline = tail.indexOf('\n')) >= 0) {
        const frame = JSON.parse(tail.slice(0, newline)) as { id: number; result: JsonValue };
        tail = tail.slice(newline + 1);
        replies.get(frame.id)!(frame.result);
        replies.delete(frame.id);
      }
    });
    const rpc = (method: string, params: unknown) =>
      new Promise<JsonValue>((resolve) => {
        const id = ++sequence;
        replies.set(id, resolve);
        input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    try {
      await rpc('host.handshake', { protocolVersion: 1 });
      const router = {
        request: async (
          _handle: unknown,
          command: { commandId: string; method: string; payload: unknown }
        ) =>
          rpc(command.method, {
            commandId: command.commandId,
            binding: { schemaVersion: 1, handleId: 'captured-handle', owner, scope },
            payload: command.payload,
          }),
        lookup: vi.fn<BackendOwnerRouter['lookup']>(),
      };
      const facade = new BackendOperationsFacade(router);
      const legacy = {
        getData: vi.fn(),
        getSavedRequest: vi.fn(),
        replaceMembers: vi.fn(),
        launchTeam: vi.fn(),
        processAlive: vi.fn(),
        stop: vi.fn(),
        getProvisioningStatus: vi.fn(),
        cancelProvisioning: vi.fn(),
      } as unknown as TeamsAPI;
      const key = hostTeamSelectionKey('captured-handle');
      let maskedRosterAck = false;
      let maskedLaunchAck = false;
      const rosterWire: BackendOperationRequest[] = [];
      const teams = createHostTeamsApi(legacy, {
        getConnections: async () => ({
          state: 'ready',
          bindings: [{ handle: { handleId: 'captured-handle' }, label: 'TEST team', members: [] }],
        }),
        invoke: async (request) => {
          if (
            request.operation === 'team.roster.replace' ||
            request.operation === 'team.roster.lookup'
          )
            rosterWire.push(structuredClone(request));
          const result = await facade.invoke(request);
          if (
            !maskedLaunchAck &&
            request.operation === 'team.launch.start' &&
            request.commandId === 'TEST-ordinary-launch' &&
            result.ok
          ) {
            maskedLaunchAck = true;
            return { ok: false, code: 'unavailable', outcome: 'unknown' };
          }
          if (
            !maskedRosterAck &&
            request.operation === 'team.roster.replace' &&
            request.commandId === 'TEST-member-false' &&
            result.ok
          ) {
            maskedRosterAck = true;
            return { ok: false, code: 'unavailable', outcome: 'unknown' };
          }
          return result;
        },
      });
      const savedBeforeOpen = await teams.getSavedRequest(key);
      expect(savedBeforeOpen).toMatchObject({
        cwd: root,
        skipPermissions: false,
        prompt: 'TEST original configured prompt',
      });
      expect(savedBeforeOpen?.model).toBeUndefined();
      expect(legacy.getSavedRequest).not.toHaveBeenCalled();
      expect(
        await facade.invoke({
          ...request,
          operation: 'runtime.open',
          payload: { memberId: 'member-A' },
        })
      ).toMatchObject({ ok: true });
      const selected = await facade.invoke({
        ...request,
        operation: 'team.launch.configuration.read',
        payload: {},
      });
      if (!selected.ok || !selected.value || !('launch' in selected.value) || !selected.value.launch)
        throw new Error('Missing actual launch');
      const runId = hostTeamRunId(
        'captured-handle',
        selected.value.launch.launchId,
        selected.value.launch.rosterRevision
      );
      const ready = await teams.getProvisioningStatus(runId);
      expect(ready.state).toBe('ready');
      expect(Date.parse(ready.updatedAt)).toBeGreaterThanOrEqual(Date.parse(ready.startedAt));
      expect(
        await facade.invoke({
          ...request,
          commandId: 'human-input',
          operation: 'message.send',
          payload: { to: 'alice', text: 'Observe actual Team input' },
        })
      ).toMatchObject({ ok: true });
      const nativeInput = await firstTurn;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const projected = await facade.invoke({
        ...request,
        operation: 'runtime.activity.snapshot',
        payload: { memberId: 'member-A' },
      });
      expect(projected).toMatchObject({
        ok: true,
        value: {
          memberId: 'member-A',
          events: [],
          hasMore: false,
          latest: {
            text: [
              {
                inputId: nativeInput.inputId,
                data: { kind: 'text', text: 'Actual host observation' },
              },
            ],
            usage: [{ data: { kind: 'usage', outputTokens: 3 } }],
          },
        },
      });
      expect(JSON.stringify(projected)).not.toContain('PRIVATE-');
      expect(JSON.stringify(projected)).not.toContain(nativeInput.operationRef);
      expect(JSON.stringify(projected)).not.toContain(root);
      expect((await teams.getData(key)).isAlive).toBe(true);
      await teams.cancelProvisioning(runId);
      expect((await teams.getProvisioningStatus(runId)).state).toBe('cancelled');
      await teams.stop(key);
      expect(await teams.processAlive(key)).toBe(false);
      expect((await teams.getData(key)).isAlive).toBe(false);
      expect(legacy.stop).not.toHaveBeenCalled();
      expect(legacy.processAlive).not.toHaveBeenCalled();
      expect(legacy.cancelProvisioning).not.toHaveBeenCalled();
      expect(legacy.getProvisioningStatus).not.toHaveBeenCalled();
      const roster = await facade.invoke({
        ...request,
        operation: 'team.roster.read',
        payload: {},
      });
      if (!roster.ok || !roster.value || !('removedMembers' in roster.value))
        throw new Error('Missing roster');
      const replacement: ReplaceMembersRequest = {
        command: { commandId: 'TEST-facade-roster', idempotencyKey: 'TEST-facade-roster' },
        configuration: {
          expectedRevision: roster.value.revision,
          savedSettings: {
            cwd: root,
            prompt: 'TEST updated configured prompt',
            fastMode: 'off',
            skipPermissions: false,
            syncModelsWithLead: false,
            limitContext: false,
            allowExperimentalLocalModels: false,
          },
        },
        members: [
          {
            name: 'worker',
            workflow: 'TEST existing settings',
            providerId: 'anthropic',
            fastMode: 'off',
            mcpPolicy: { mode: 'inheritScopes', scopes: { user: false, project: true } },
          },
        ],
      };
      await teams.replaceMembers(key, replacement);
      const applied = await facade.invoke({
        ...request,
        commandId: replacement.command!.commandId,
        operation: 'team.roster.lookup',
        payload: {},
      });
      expect(applied).toMatchObject({
        ok: true,
        value: { commandId: replacement.command!.commandId },
      });
      await teams.replaceMembers(key, replacement);
      await expect(
        teams.replaceMembers(key, {
          ...replacement,
          command: { commandId: 'TEST-stale-roster', idempotencyKey: 'TEST-stale-roster' },
        })
      ).rejects.toMatchObject({
        code: 'conflict',
        outcome: 'rejected',
        commandId: 'TEST-stale-roster',
      });
      const configured = await facade.invoke({
        ...request,
        operation: 'team.roster.read',
        payload: {},
      });
      expect(configured).toMatchObject({
        ok: true,
        value: {
          members: [
            { memberId: 'member-A', name: 'alice', role: 'lead' },
            {
              name: 'worker',
              role: 'member',
              settings: {
                workflow: 'TEST existing settings',
                fastMode: 'off',
                mcpPolicy: { scopes: { user: false, project: true } },
              },
            },
          ],
        },
      });
      expect(JSON.stringify(configured)).not.toContain('PRIVATE-');
      const savedRequest = await teams.getSavedRequest(key);
      expect(savedRequest).toMatchObject({
        teamName: key,
        cwd: root,
        prompt: 'TEST updated configured prompt',
        fastMode: 'off',
        skipPermissions: false,
        syncModelsWithLead: false,
        limitContext: false,
        allowExperimentalLocalModels: false,
        members: [{ name: 'worker', workflow: 'TEST existing settings' }],
      });
      expect(savedRequest?.model).toBeUndefined();
      const originalData = await teams.getData(key);
      expect(
        originalData.members.find((member) => member.name === 'alice')?.configuredRuntimeSettings
      ).toMatchObject({ fastMode: 'off', model: undefined });
      expect(originalData.members.find((member) => member.name === 'worker')?.workflow).toBe(
        'TEST existing settings'
      );
      for (const targetKind of ['member', 'lead'] as const) {
        for (const clear of [false, true]) {
          const saved = await teams.getSavedRequest(key);
          const data = await teams.getData(key);
          expect(saved).not.toBeNull();
          const memberName = targetKind === 'lead' ? 'alice' : 'worker';
          const target = data.members.find((member) => member.name === memberName)!;
          expect(target.configuredSettingsFingerprint).toMatch(/^[a-f0-9]{64}$/);
          const model = clear ? null : `TEST-${targetKind}-chosen`;
          const commandId = `TEST-${targetKind}-${clear}`;
          const intent: ReplaceMembersRequest = {
            command: { commandId, idempotencyKey: commandId },
            configuration: { expectedRevision: saved!.savedSettingsFingerprint! },
            members: structuredClone(saved!.members),
            memberSettingsRelaunch: {
              memberName,
              targetKind,
              expectedFingerprint: target.configuredSettingsFingerprint!,
              expectedTeamSettingsFingerprint: saved!.savedSettingsFingerprint!,
              baseline: data.members.map((member) => ({
                memberName: member.name,
                expectedFingerprint: member.configuredSettingsFingerprint!,
              })),
              model,
              effort: clear ? null : 'ultra',
            },
          };
          if (targetKind === 'lead') {
            const ownerConfig = await facade.invoke({
              ...request,
              operation: 'team.roster.read',
              payload: {},
            });
            if (
              !ownerConfig.ok ||
              !ownerConfig.value ||
              !('removedMembers' in ownerConfig.value) ||
              !ownerConfig.value.savedSettings
            )
              throw new Error('Missing configured owner settings');
            intent.configuration!.savedSettings = { ...ownerConfig.value.savedSettings };
            if (clear) {
              delete intent.configuration!.savedSettings.model;
              delete intent.configuration!.savedSettings.effort;
            } else {
              intent.configuration!.savedSettings.model = model!;
              intent.configuration!.savedSettings.effort = 'ultra';
            }
          } else {
            const worker = intent.members.find((member) => member.name === memberName)!;
            if (clear) {
              delete worker.model;
              delete worker.effort;
            } else {
              worker.model = model!;
              worker.effort = 'ultra';
            }
          }
          const wireStart = rosterWire.length;
          await teams.replaceMembers(key, intent);
          if (commandId === 'TEST-member-false') {
            expect(maskedRosterAck).toBe(true);
            expect(rosterWire.slice(wireStart).map((row) => row.operation)).toEqual([
              'team.roster.replace',
              'team.roster.lookup',
            ]);
            expect(rosterWire[wireStart + 1]).toMatchObject({
              handle: { handleId: 'captured-handle' },
              commandId,
              payload: { expected: rosterWire[wireStart].payload },
            });
          } else await teams.replaceMembers(key, intent);
          const after = await teams.getSavedRequest(key);
          const settings =
            targetKind === 'lead'
              ? after!
              : after!.members.find((member) => member.name === memberName)!;
          expect(settings.model ?? null).toBe(model);
          expect(settings.effort ?? null).toBe(clear ? null : 'ultra');
          await expect(
            teams.replaceMembers(key, {
              ...intent,
              command: { commandId: `${commandId}-stale`, idempotencyKey: `${commandId}-stale` },
            })
          ).rejects.toMatchObject({ code: 'conflict', outcome: 'rejected' });
        }
      }
      expect(nativeOpens).toBe(1);
      expect(legacy.replaceMembers).not.toHaveBeenCalled();
      const source = await teams.getSavedRequest(key);
      await teams.replaceMembers(key, {
        command: { commandId: 'TEST-launch-source', idempotencyKey: 'TEST-launch-source' },
        configuration: {
          expectedRevision: source!.savedSettingsFingerprint!,
          savedSettings: {
            cwd: root,
            prompt: 'TEST ordinary launch prompt',
            model: 'TEST-ordinary-model',
            effort: 'medium',
            fastMode: 'off',
            skipPermissions: false,
            limitContext: true,
          },
        },
        members: [],
      });
      const launchRequest = {
        teamName: key,
        cwd: root,
        command: { commandId: 'TEST-ordinary-launch', idempotencyKey: 'TEST-ordinary-launch' },
        savedRosterCommandId: 'TEST-launch-source',
      };
      await expect(teams.launchTeam(launchRequest)).rejects.toThrow('unknown');
      expect(maskedLaunchAck).toBe(true);
      const launched = await teams.launchTeam(launchRequest);
      for (let i = 0; i < 50 && nativeInputs.length < 2; i++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(nativeOpens).toBe(2);
      expect(nativeInputs.map((input) => input.content)).toEqual([
        'Observe actual Team input',
        'TEST ordinary launch prompt',
      ]);
      expect(nativeProfiles[1]).toMatchObject({
        model: 'TEST-ordinary-model',
        cwd: root,
        nativeOptions: { effort: 'medium', fastMode: false, permissionMode: 'default' },
      });
      expect(nativeProfiles[1].sessionId).not.toBe(nativeProfiles[0].sessionId);
      expect(nativeProfiles[1].principalId).not.toBe(nativeProfiles[0].principalId);
      expect((await teams.getProvisioningStatus(launched.runId)).state).toBe('ready');
      expect((await teams.getProvisioningStatus(runId)).state).toBe('cancelled');
      const historical = await facade.invoke({
        ...request,
        operation: 'runtime.activity.snapshot',
        payload: { memberId: 'member-A', expectedGeneration: '1' },
      });
      expect(historical).toMatchObject({
        ok: true,
        value: {
          latest: {
            text: [
              expect.objectContaining({
                data: expect.objectContaining({ text: 'Actual host observation' }),
              }),
            ],
          },
        },
      });
      await teams.cancelProvisioning(launched.runId);
      expect((await teams.getProvisioningStatus(launched.runId)).state).toBe('cancelled');
      expect(legacy.launchTeam).not.toHaveBeenCalled();
    } finally {
      await host.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes opaque continuation as control and projects normalized content without technical authority', async () => {
    const { router, facade } = setup();
    router.request.mockResolvedValue({
      ok: true,
      value: feed([
        event(1, {
          kind: 'text',
          messageRef: 'message-A',
          block: 0,
          text: 'Visible text',
          phase: 'complete',
          native: 'PRIVATE-native',
        }),
        event(2, {
          kind: 'tool',
          messageRef: 'message-A',
          toolRef: 'tool-A',
          name: 'Read',
          input: { path: 'TEST.txt' },
        }),
        event(3, {
          kind: 'tool-result',
          toolRef: 'tool-A',
          content: ['Tool output'],
          isError: false,
        }),
        event(4, {
          kind: 'usage',
          inputTokens: 12,
          cumulativeCostUsd: 0.25,
          rawPayload: 'PRIVATE-usage',
        }),
        event(5, {
          kind: 'interaction',
          interactionRef: 'permission-A',
          request: {
            kind: 'permission',
            tool: 'Write',
            input: { path: 'TEST.txt' },
            native: 'PRIVATE-native',
          },
        }),
        event(6, { kind: 'result', outcome: 'succeeded', nativeResult: 'PRIVATE-native' }),
        event(7, { kind: 'state', state }),
      ]),
    } as JsonValue);
    const result = await facade.invoke(request);
    expect(result.ok).toBe(true);
    expect(router.request).toHaveBeenCalledExactlyOnceWith(request.handle, {
      commandId: request.commandId,
      method: 'runtime.activity.feed',
      payload: request.payload,
      control: true,
    });
    expect(router.lookup).not.toHaveBeenCalled();
    const projected = result as {
      ok: true;
      value: { hasMore: boolean; cursor: string; events: { data: Record<string, unknown> }[] };
    };
    expect(projected.value.cursor).toBe(cursor);
    expect(projected.value.hasMore).toBe(true);
    expect(projected.value.events[0]!.data).toEqual({
      kind: 'text',
      messageRef: 'message-A',
      block: 0,
      text: 'Visible text',
      phase: 'complete',
    });
    expect(projected.value.events[3]!.data).toEqual({
      kind: 'usage',
      inputTokens: 12,
      cumulativeCostUsd: 0.25,
    });
    expect(projected.value.events[4]!.data).toEqual({
      kind: 'interaction',
      interactionRef: 'permission-A',
      request: { kind: 'permission', tool: 'Write', input: { path: 'TEST.txt' } },
    });
    const serialized = JSON.stringify(result);
    for (const privateField of [
      'PRIVATE-',
      'operationRef',
      'binding',
      'checkpoints',
      'nativeSessionId',
    ])
      expect(serialized).not.toContain(privateField);
  });

  it('preserves snapshot/gap semantics and unknown usage without fabricating attribution', async () => {
    const { router, facade } = setup();
    const sessionUsage = {
      sequence: 2,
      eventId: 'usage-session',
      data: { kind: 'usage', outputTokens: 9 },
    };
    router.request.mockResolvedValue({
      ok: true,
      value: {
        ...feed([]),
        hasMore: false,
        state,
        gap: { reason: 'retention' },
        latest: {
          text: [],
          tools: [],
          usage: [sessionUsage],
          interactions: [],
          compaction: event(3, { kind: 'compaction', sourceRef: 'epoch-1', reason: 'automatic' }),
        },
      },
    } as JsonValue);
    const result = await facade.invoke({
      ...request,
      operation: 'runtime.activity.snapshot',
      payload: { memberId: 'member-A' },
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        cursor,
        retainedFrom: 1,
        events: [],
        hasMore: false,
        gap: { reason: 'retention' },
        latest: { usage: [sessionUsage] },
      },
    });
    expect(JSON.stringify(result)).not.toContain('inputTokens');
    expect(JSON.stringify(result)).not.toContain('PRIVATE-');
    expect(router.request).toHaveBeenCalledWith(
      request.handle,
      expect.objectContaining({ method: 'runtime.activity.snapshot', control: true })
    );
  });

  it.each([
    { ...request, payload: { memberId: 'member-A', cursor: 'x'.repeat(1025) } },
    { ...request, payload: { memberId: 'member-A', cursor: '{"resource":"other"}' } },
    { ...request, payload: { memberId: 'member-A', cursor, binding: { memberId: 'member-B' } } },
    { ...request, operation: 'runtime.activity.raw', payload: { memberId: 'member-A' } },
  ])('rejects unbounded or authority-selecting input before dispatch: %j', async (invalid) => {
    const { router, facade } = setup();
    expect(await facade.invoke(invalid)).toEqual({
      ok: false,
      code: 'invalid',
      outcome: 'not-dispatched',
    });
    expect(router.request).not.toHaveBeenCalled();
  });

  it('fails closed for wrong-member/oversized/unsafe diagnostic replies and preserves current read refusal', async () => {
    const { router, facade } = setup();
    const broken = [
      { ...feed([]), memberId: 'other-member' },
      feed([event(1, { kind: 'diagnostic', code: 'PRIVATE-token /private/config' })]),
      feed([
        event(1, {
          kind: 'text',
          messageRef: 'A',
          block: 0,
          phase: 'complete',
          text: 'x'.repeat(129 * 1024),
        }),
      ]),
    ];
    for (const value of broken) {
      router.request.mockResolvedValueOnce({ ok: true, value } as JsonValue);
      expect(await facade.invoke(request)).toEqual({ ok: false, code: 'hold', outcome: 'unknown' });
    }
    router.request.mockResolvedValueOnce({ ok: false, code: 'forbidden', outcome: 'rejected' });
    expect(await facade.invoke(request)).toEqual({
      ok: false,
      code: 'forbidden',
      outcome: 'rejected',
    });
  });
});
