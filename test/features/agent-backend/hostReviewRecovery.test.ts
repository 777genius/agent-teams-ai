// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFilesystemTeamOwner } from '@agent-teams/legacy-agent-host/team/filesystem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHostTeamReview } from '../../../packages/legacy-agent-host/dist/composition/HostTeamReview.js';
import { createTeamReviewMethods } from '../../../packages/legacy-agent-host/dist/review/createTeamReviewMethods.js';
import {
  reviewReceiptFingerprint,
  teamCommandPath,
} from '../../../packages/legacy-agent-host/dist/team/commandEntries.js';
import { digest } from '../../../packages/legacy-agent-host/dist/team/identity.js';
import { hostTeamSelectionKey } from '../../../src/features/agent-backend/contracts/teamSelection';
import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { createBoundHostReviewApi } from '../../../src/features/agent-backend/renderer/createBoundHostReviewApi';

import type { HostedTeam } from '../../../packages/legacy-agent-host/dist/composition/MemberEntry.js';
import type { ReviewCommandReceipt } from '../../../packages/legacy-agent-host/dist/team/reviewCommandContracts.js';
import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendOwnerRouter } from '../../../src/features/agent-backend/main/application/BackendOwnerRouter';
import type { ReviewAPI } from '../../../src/shared/types/api';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(options: { dropSaveResponse?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-renderer-review-recovery-')));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const filePath = join(workspace, 'file.ts'),
    before = 'const value = 1;\n',
    after = 'const value = 2;\n';
  await writeFile(filePath, after);
  const binding = {
    backendId: 'TEST-backend',
    teamId: 'test-review-team',
    teamName: 'test-review-team',
  };
  const members = [{ memberId: 'TEST-lead', name: 'lead', role: 'lead' as const }];
  const grants = [
    {
      principalId: 'TEST-human',
      memberName: 'user',
      permissions: ['read', 'admin', 'task.write'] as ('read' | 'admin' | 'task.write')[],
    },
  ];
  let service: ReturnType<typeof createHostTeamReview>;
  let owner: ReturnType<typeof createFilesystemTeamOwner>;
  function reopen() {
    service?.dispose();
    owner = createFilesystemTeamOwner({ root, binding, members, grants });
    const connection = owner.connect('TEST-human');
    const taskId = connection.execute({
      commandId: 'TEST-create',
      operation: 'task.create',
      payload: { subject: 'TEST review recovery' },
    }).effects.taskId;
    const team: HostedTeam = {
      owner,
      connection,
      definition: {
        scope: {
          projectId: 'TEST-project',
          workspaceId: 'TEST-workspace',
          teamId: binding.teamId,
          runId: 'TEST-run',
          memberId: 'TEST-human',
          generation: 'TEST-generation',
        },
        binding,
        members,
        grants,
      },
    };
    service = createHostTeamReview({
      team,
      assertCurrent() {},
      principalId: 'TEST-human',
      ownerStorageRoot: root,
      projectPath: workspace,
      processStartProbe: async () => 1,
    });
    return { owner, connection, taskId };
  }
  const initial = reopen(),
    taskId = initial.taskId;
  cleanups.push(async () => {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const ledger = join(root, 'teams', binding.teamName, '.host-evidence', '.board-task-changes');
  await mkdir(join(ledger, 'events'), { recursive: true });
  await mkdir(join(ledger, 'blobs'));
  const ref = async (name: string, content: string) => {
    await writeFile(join(ledger, 'blobs', name), content);
    return {
      sha256: createHash('sha256').update(content).digest('hex'),
      sizeBytes: Buffer.byteLength(content),
      blobRef: name,
    };
  };
  await writeFile(
    join(ledger, 'events', `${taskId}.jsonl`),
    JSON.stringify({
      schemaVersion: 1,
      eventId: 'TEST-event',
      taskId,
      taskRef: taskId,
      taskRefKind: 'canonical',
      phase: 'work',
      executionSeq: 1,
      sessionId: 'TEST-session',
      agentId: 'TEST-lead',
      memberName: 'lead',
      toolUseId: 'TEST-tool',
      source: 'file_edit',
      operation: 'modify',
      confidence: 'exact',
      workspaceRoot: workspace,
      filePath,
      relativePath: 'file.ts',
      timestamp: '2026-10-23T00:00:00.000Z',
      toolStatus: 'succeeded',
      before: await ref('before.txt', before),
      after: await ref('after.txt', after),
      linesAdded: 1,
      linesRemoved: 1,
    }) + '\n'
  );
  const methods = createTeamReviewMethods({
    select(raw) {
      if (
        !raw ||
        typeof raw !== 'object' ||
        !('commandId' in raw) ||
        !('payload' in raw) ||
        typeof raw.commandId !== 'string'
      )
        throw new Error('Invalid TEST envelope');
      return { commandId: raw.commandId, payload: raw.payload, review: service };
    },
  });
  const router = {
    request: vi.fn<BackendOwnerRouter['request']>(async (_handle, command) => {
      const method = methods[command.method];
      if (!method) throw new Error('Unknown TEST route');
      return method.handle(
        { commandId: command.commandId, payload: command.payload },
        { requestId: command.commandId, signal: new AbortController().signal }
      );
    }),
    lookup: vi.fn<BackendOwnerRouter['lookup']>(),
  };
  const facade = new BackendOperationsFacade(router),
    handle = { handleId: 'TEST-original-owner' },
    selection = hostTeamSelectionKey(handle.handleId);
  let dropSaveResponse = options.dropSaveResponse ?? true;
  const backend: AgentBackendApi = {
    getConnections: async () => ({
      state: 'ready',
      bindings: [{ handle, label: 'TEST', members: [] }],
    }),
    invoke: vi.fn<AgentBackendApi['invoke']>(async (request) => {
      const response = await facade.invoke(request);
      if (
        response.ok &&
        dropSaveResponse &&
        request.operation === 'review.invoke' &&
        request.payload.request.method === 'saveEditedFile'
      ) {
        dropSaveResponse = false;
        return { ok: false, code: 'hold', outcome: 'unknown' };
      }
      return response;
    }),
  };
  const legacy = {
    getTaskChanges: vi.fn(),
    loadDecisions: vi.fn(),
    saveEditedFile: vi.fn(),
  } as unknown as ReviewAPI;
  const view = () =>
    createBoundHostReviewApi(legacy, backend, selection, { taskId }, () => () => true);
  return {
    view,
    reopen,
    backend,
    router,
    initial,
    taskId,
    selection,
    filePath,
    after,
    binding,
    root,
  };
}
describe('existing Changes reopen discovers original durable review outcomes', () => {
  it('looks up a lost completed edit after cold reopen without re-dispatching its file write', async () => {
    const f = await fixture();
    await expect(
      f
        .view()
        .saveEditedFile(
          { teamName: f.selection, taskId: f.taskId },
          f.filePath,
          'TEST saved once\n',
          f.after
        )
    ).rejects.toMatchObject({ outcome: 'unknown' });
    expect(await readFile(f.filePath, 'utf8')).toBe('TEST saved once\n');
    const original = vi.mocked(f.backend.invoke).mock.calls[0][0];
    f.reopen();
    const changes = await f.view().getTaskChanges(f.selection, f.taskId);
    expect(changes.taskId).toBe(f.taskId);
    expect(changes.teamName).toBe(f.selection);
    expect(
      vi
        .mocked(f.backend.invoke)
        .mock.calls.some(
          ([request]) =>
            request.operation === 'review.lookup' &&
            request.commandId === original.commandId &&
            request.handle.handleId === original.handle.handleId
        )
    ).toBe(true);
    expect(
      vi
        .mocked(f.backend.invoke)
        .mock.calls.filter(
          ([request]) =>
            request.operation === 'review.invoke' &&
            request.payload.request.method === 'saveEditedFile'
        )
    ).toHaveLength(1);
    expect(await readFile(f.filePath, 'utf8')).toBe('TEST saved once\n');
  });
  it('keeps unprovable original crashes held across reopen and makes no filesystem equality inference', async () => {
    const f = await fixture();
    const origin = { taskId: f.taskId };
    f.initial.owner.reviewCommands('TEST-human').admit('TEST-unprovable', origin, {
      method: 'saveEditedFile',
      args: [
        { teamName: f.binding.teamName, taskId: f.taskId },
        f.filePath,
        'TEST identical bytes\n',
        f.after,
      ],
    });
    await writeFile(f.filePath, 'TEST identical bytes\n');
    const reopened = f.reopen();
    const view = f.view();
    expect((await view.getTaskChanges(f.selection, f.taskId)).files).toHaveLength(1);
    await expect(
      view.loadDecisions(f.selection, `task-${f.taskId}`, 'TEST-current-token')
    ).rejects.toThrow('Original review outcome is still unknown');
    const lookup = await reopened.owner
      .reviewCommands('TEST-human')
      .lookup('TEST-unprovable', origin);
    expect(lookup).toMatchObject({
      phase: 'prepared',
      outcome: 'unknown',
      responseAvailable: false,
    });
    expect(await readFile(f.filePath, 'utf8')).toBe('TEST identical bytes\n');
    reopened.connection.revoke('TEST-human');
    await expect(f.view().getTaskChanges(f.selection, f.taskId)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
  it('hydrates a fresh ledger concurrently without recording read requests as user-effect commands', async () => {
    const f = await fixture({ dropSaveResponse: false });
    const commandDir = join(f.root, 'teams', f.binding.teamName, '.host-owner', 'commands');
    const commands = await readdir(commandDir);
    const view = f.view(),
      key = `task-${f.taskId}`,
      token = 'TEST-fresh-view-token';
    expect(
      await Promise.all([
        view.loadDecisions(f.selection, key, token),
        view.loadDraftHistory(f.selection, key, token),
        view.loadDecisionConflictCandidates(f.selection, key, token),
        view.loadDraftHistoryConflictCandidates(f.selection, key, token),
      ])
    ).toEqual([null, null, [], []]);
    expect(await readdir(commandDir)).toEqual(commands);
  });
  it('hydrates concurrent read observers after an interrupted reader without creating new effect receipts', async () => {
    const f = await fixture({ dropSaveResponse: false });
    const origin = { taskId: f.taskId };
    const scopeKey = `task-${f.taskId}`,
      token = 'TEST-current-view-token';
    // An interrupted observer record from before the finite method classification.
    const oldReader: Omit<ReviewCommandReceipt, 'fingerprint'> = {
      schemaVersion: 1,
      family: 'review',
      binding: f.binding,
      commandId: 'TEST-interrupted-reader',
      principalId: 'TEST-human',
      origin,
      method: 'loadDraftHistory',
      requestDigest: digest({
        method: 'loadDraftHistory',
        args: [f.binding.teamName, scopeKey, token],
      }),
      authorityRevision: 1,
      createdAt: new Date().toISOString(),
      phase: 'prepared',
    };
    await writeFile(
      join(
        f.root,
        'teams',
        f.binding.teamName,
        '.host-owner',
        teamCommandPath(oldReader.commandId)
      ),
      JSON.stringify({ ...oldReader, fingerprint: reviewReceiptFingerprint(oldReader) })
    );
    f.reopen();
    const commandDir = join(f.root, 'teams', f.binding.teamName, '.host-owner', 'commands');
    const beforeCommands = await readdir(commandDir);
    const view = f.view();
    const values = await Promise.all([
      view.loadDecisions(f.selection, scopeKey, token),
      view.loadDraftHistory(f.selection, scopeKey, token),
      view.loadDecisionConflictCandidates(f.selection, scopeKey, token),
      view.loadDraftHistoryConflictCandidates(f.selection, scopeKey, token),
    ]);
    expect(values).toEqual([null, null, [], []]);
    expect(await readdir(commandDir)).toEqual(beforeCommands);
    await expect(
      view.saveEditedFile(
        { teamName: f.selection, taskId: f.taskId },
        f.filePath,
        'TEST edit after read recovery\n',
        f.after
      )
    ).resolves.toEqual({ success: true });
    expect(await readFile(f.filePath, 'utf8')).toBe('TEST edit after read recovery\n');
  });
});
