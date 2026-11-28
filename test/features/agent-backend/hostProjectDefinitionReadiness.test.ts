// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { captureReadinessPreparation } from '../../../packages/legacy-agent-host/dist/adapters/providers/OpenCodeReadinessOrigin.js';
import { digest } from '../../../packages/legacy-agent-host/dist/team/identity.js';
import { replaceRosterPayloadSchema } from '../../../packages/legacy-agent-host/dist/team/rosterSchema.js';
import { openProjectTeamFixture } from '../../../packages/legacy-agent-host/tests/projectTeamFixture';
import { captureBackendPayload } from '../../../src/features/agent-backend/main/application/backendBinding';
import { BackendOwnerRouter } from '../../../src/features/agent-backend/main/application/BackendOwnerRouter';
import { requestWithLocalModelReadiness } from '../../../src/features/agent-backend/main/infrastructure/CapturedLocalModelReadiness';
import * as readiness from '../../../src/features/agent-backend/main/infrastructure/CapturedReadinessOrigin';
import { FileHandleBindingStore } from '../../../src/features/agent-backend/main/infrastructure/FileHandleBindingStore';

import type { LiveRosterOperation } from '../../../packages/legacy-agent-host/dist/composition/executeLiveRosterMembership.js';
import type { JsonValue } from '../../../packages/legacy-agent-host/dist/contracts.js';
import type { LiveRosterCaptureView } from '../../../packages/legacy-agent-host/dist/team/liveRosterMembership.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});

function reordered(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(reordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reordered(item)]));
  return value;
}

function fixture(change?: 'logical-payload' | 'logical-command' | 'child-payload' | 'child-command') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-project-definition-readiness-')));
  let first: LiveRosterOperation | undefined;
  let view: LiveRosterCaptureView | undefined;
  let admissions = 0;
  const childCalls: LiveRosterOperation[] = [];
  const f = openProjectTeamFixture(root, {
    // Controlled native boundary: real Host fanout and both readiness consumers run,
    // but this fixture never probes a provider or launches a native process.
    async executeLive(input) {
      childCalls.push(structuredClone(input));
      const payload = replaceRosterPayloadSchema.parse(input.payload);
      if (input.conversation.phase === 'capture') {
        first = structuredClone(input);
        view = {
          schemaVersion: 1, commandId: input.commandId, teamId: input.teamId,
          requestDigest: digest({ commandId: input.commandId, payload }),
          expectedRevision: payload.expectedRevision, launchId: 'TEST-existing-launch',
          sourceCaptureDigest: 'a'.repeat(64), captureDigest: 'b'.repeat(64),
          target: { memberId: 'TEST-carol', name: 'carol', provider: 'opencode',
            modelProviderId: 'test-local', modelId: 'TEST-model', workspace: f.project,
            optionsDigest: 'c'.repeat(64), configurationDigest: 'd'.repeat(64) },
        };
        return { ok: true, liveRosterCapture: view };
      }
      if (input.conversation.phase !== 'continue' || !first || !view || !input.localModelReadinessOrigin)
        throw new Error('TEST unexpected child continuation');
      expect(input.commandId).toBe(first.commandId);
      expect(input.payload).toEqual(first.payload);
      expect(input.binding).toEqual(first.binding);
      expect(input.conversation.captureDigest).toBe(view.captureDigest);
      captureReadinessPreparation(input.localModelReadinessOrigin, {
        kind: 'team', owner: first.binding.owner, contextId: f.contextId,
        commandId: change === 'child-command' ? 'TEST-other-child' : first.commandId,
        selection: { handleId: first.binding.handleId, scope: first.binding.scope,
          payload: change === 'child-payload' ? { ...payload, members: [] } : first.payload,
          liveRosterCapture: view },
        workspaces: [f.project], targets: [{ workspace: f.project, providerId: 'test-local' }],
        anchorCommandId: 'TEST-original-probe', original: { present: false }, admittedAt: Date.now(),
      });
      admissions++;
      return { ok: true, value: f.teams.get(input.teamId)!.connection.replaceRoster({
        commandId: input.commandId, ...payload,
      }) };
    },
  });
  cleanup.push(() => { f.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(f.project, 'opencode.json'), JSON.stringify({ provider: { 'test-local': {
    npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:9999/v1' },
  } } }));
  const inputs = vi.spyOn(readiness, 'captureReadinessInputs').mockReturnValue({
    home: root, environment: {}, readApprovals: async () => {
      throw new Error('TEST local project provider must not consult private-network approval');
    },
  });
  const logical = f.create().record;
  f.prepare(logical, 'TEST-original-launch');
  const child = f.child(logical), target = f.target(logical);
  const payload = captureBackendPayload({ expectedRevision: target.team.connection.readRoster().revision,
    members: [{ name: 'alice', role: 'Researcher' },
      { name: 'carol', providerId: 'opencode', model: 'test-local/TEST-model' }] });
  const router = new BackendOwnerRouter(new FileHandleBindingStore(join(root, 'TEST-bindings')));
  vi.spyOn(router, 'ownerBinding').mockReturnValue(f.profile.owner);
  const request = vi.spyOn(router, 'request').mockImplementation(async (handle, command) => {
    expect(handle.handleId).toBe(logical.binding.handleId);
    if (!command.liveRoster || command.liveRoster.phase === 'read') throw new Error('TEST missing live phase');
    const response = await f.definitions.execute(target, {
      teamId: logical.teamId, method: 'team.roster.replace',
      commandId: command.commandId, payload: command.payload,
      binding: { ...logical.binding, owner: f.profile.owner }, conversation: command.liveRoster,
      ...(command.localModelReadinessOrigin ? { localModelReadinessOrigin: {
        origin: command.localModelReadinessOrigin.origin, remainingMs: command.liveRoster.remainingMs,
      } } : {}),
    });
    if (response?.ok && 'liveRosterCapture' in response && response.projectDefinition) {
      expect(first).toBeDefined();
      const childSelection = { handleId: first!.binding.handleId, scope: first!.binding.scope,
        payload: first!.payload, liveRosterCapture: response.liveRosterCapture };
      // This independently catches the second commitment even if the first Main check fails.
      expect(response.projectDefinition.selectionDigest).toBe(readiness.readinessOriginDigest(childSelection));
      if (change === 'logical-command') response.projectDefinition.logicalCommandId = 'TEST-other-logical';
      if (change === 'logical-payload') response.projectDefinition.logicalRequestDigest =
        readiness.readinessOriginDigest({ commandId: command.commandId,
          payload: { ...replaceRosterPayloadSchema.parse(command.payload), members: [] } });
    }
    if (!response) throw new Error('TEST logical definition was not routed');
    return captureBackendPayload(response);
  });
  const run = (input = payload) => requestWithLocalModelReadiness(async () => router,
    { handleId: logical.binding.handleId },
    { commandId: 'TEST-add-carol', method: 'team.roster.replace', payload: input },
    { owner: f.profile.owner, contextId: f.contextId, scope: logical.binding.scope },
    { requestTimeoutMs: 10000, rosterCommands: { readOriginalIntent: async () => {
      throw new Error('TEST live original must not be read as a new saved intent');
    } } });
  return { f, logical, child, payload, run, inputs, request, childCalls, admissions: () => admissions };
}

it.each([false, true])('keeps the original project Add through both canonical boundaries (reordered=%s)', async reverse => {
  const t = fixture();
  const input = reverse ? reordered(t.payload) : t.payload;
  const result = await t.run(input);
  expect(result).toMatchObject({ ok: true, value: { commandId: 'TEST-add-carol' } });
  expect(t.inputs).toHaveBeenCalledTimes(1);
  expect(t.admissions()).toBe(1);
  expect(t.childCalls.map(row => row.conversation.phase)).toEqual(['capture', 'continue']);
  expect(t.childCalls[0].commandId).not.toBe('TEST-add-carol');
  for (const id of [t.logical.teamId, t.child.teamId])
    expect(t.f.teams.get(id)!.connection.readRoster().members.map(row => row.name))
      .toEqual(['team-lead', 'alice', 'carol']);
  expect(await t.run(input)).toEqual(result);
  expect(t.inputs).toHaveBeenCalledTimes(1);
  expect(t.childCalls).toHaveLength(2);
  expect(t.admissions()).toBe(1);
});

it.each(['logical-payload', 'logical-command'] as const)('refuses %s mismatch before readiness or child continuation', async change => {
  const t = fixture(change);
  await expect(t.run()).rejects.toMatchObject({ code: 'hold', outcome: 'not-dispatched' });
  expect(t.inputs).not.toHaveBeenCalled();
  expect(t.request).toHaveBeenCalledTimes(1);
  expect(t.childCalls).toHaveLength(1);
  expect(t.admissions()).toBe(0);
  expect(t.f.teams.get(t.child.teamId)!.connection.readRoster().members.some(row => row.name === 'carol')).toBe(false);
});

it.each(['child-payload', 'child-command'] as const)('refuses %s mismatch at the original Host preparation boundary', async change => {
  const t = fixture(change);
  await expect(t.run()).rejects.toMatchObject({ code: 'held' });
  expect(t.inputs).toHaveBeenCalledTimes(1);
  expect(t.childCalls).toHaveLength(2);
  expect(t.admissions()).toBe(0);
  expect(t.f.teams.get(t.child.teamId)!.connection.readRoster().members.some(row => row.name === 'carol')).toBe(false);
});
