import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostTeamReview } from '../dist/composition/HostTeamReview.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import {
  buildReviewChunkContextHashes,
  buildReviewChunks,
} from '@agent-teams/task-change-ledger/review-text';
import { BOUND_REVIEW_TEAM } from '@agent-teams/task-change-ledger/review-transport';
import type { HostedTeam } from '../dist/composition/MemberEntry.js';
const roots: string[] = [];
const services: ReturnType<typeof createHostTeamReview>[] = [];
afterEach(async () => {
  services.splice(0).forEach((service) => service.dispose());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const before = 'const first = 1;\n' + 'const middle = true;\n'.repeat(12) + 'const last = 1;\n';
const after = before.replace('first = 1', 'first = 2').replace('last = 1', 'last = 2');
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-host-review-')));
  roots.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const filePath = join(workspace, 'value.ts');
  await writeFile(filePath, after);
  interface FixtureTeam {
    owner: import('../dist/team/TeamOwner.js').TeamOwner;
    connection: ReturnType<import('../dist/team/TeamOwner.js').TeamOwner['connect']>;
    taskId: string;
    service: ReturnType<typeof createHostTeamReview>;
    teamName: string;
    reopen(): FixtureTeam;
    setCurrentProbe(probe: () => void): void;
  }
  const create = (teamName: string): FixtureTeam => {
    const binding = { backendId: 'TEST-backend', teamId: teamName, teamName };
    const members = [{ memberId: 'lead-id', name: 'lead', role: 'lead' as const }];
    const grants = [
      {
        principalId: 'TEST-human',
        memberName: 'user',
        permissions: ['read', 'admin', 'task.write'] as ('read' | 'admin' | 'task.write')[],
      },
    ];
    const owner = createFilesystemTeamOwner({ root, binding, members, grants });
    const connection = owner.connect('TEST-human');
    const taskId = connection.execute({
      commandId: 'TEST-create',
      operation: 'task.create',
      payload: { subject: 'Review exact changes' },
    }).effects.taskId;
    const team: HostedTeam = {
      owner,
      connection,
      definition: {
        scope: {
          projectId: 'TEST-project',
          workspaceId: 'TEST-workspace',
          teamId: teamName,
          runId: 'TEST-run',
          memberId: 'TEST-human',
          generation: 'TEST-generation',
        },
        binding,
        members,
        grants,
      },
    };
    let currentProbe = () => {};
    const service = createHostTeamReview({
      team,
      assertCurrent() {
        currentProbe();
      },
      principalId: 'TEST-human',
      ownerStorageRoot: root,
      projectPath: workspace,
      processStartProbe: async () => 1,
    });
    services.push(service);
    return {
      owner,
      connection,
      taskId,
      service,
      teamName,
      reopen: () => create(teamName),
      setCurrentProbe(probe) {
        currentProbe = probe;
      },
    };
  };
  const a = create('test-team-a'),
    b = create('test-team-b');
  const ledger = join(root, 'teams', a.teamName, '.host-evidence', '.board-task-changes');
  await mkdir(join(ledger, 'events'), { recursive: true });
  await mkdir(join(ledger, 'blobs'));
  const ref = async (name: string, content: string) => {
    await writeFile(join(ledger, 'blobs', name), content);
    return { sha256: hash(content), sizeBytes: Buffer.byteLength(content), blobRef: name };
  };
  await writeFile(
    join(ledger, 'events', `${a.taskId}.jsonl`),
    JSON.stringify({
      schemaVersion: 1,
      eventId: 'TEST-event',
      taskId: a.taskId,
      taskRef: a.taskId,
      taskRefKind: 'canonical',
      phase: 'work',
      executionSeq: 1,
      sessionId: 'TEST-session',
      agentId: 'lead-id',
      memberName: 'lead',
      toolUseId: 'TEST-tool',
      source: 'file_edit',
      operation: 'modify',
      confidence: 'exact',
      workspaceRoot: workspace,
      filePath,
      relativePath: 'value.ts',
      timestamp: '2026-10-23T00:00:00.000Z',
      toolStatus: 'succeeded',
      before: await ref('before.txt', before),
      after: await ref('after.txt', after),
      linesAdded: 2,
      linesRemoved: 2,
    }) + '\n'
  );
  return { root, workspace, filePath, a, b, origin: { taskId: a.taskId, memberName: 'lead' } };
}
describe('captured Host review composition', () => {
  it('loads actual canonical evidence and applies mixed decisions to its two exact hunks', async () => {
    const f = await fixture();
    const changes = await f.a.service.getTaskChanges(f.a.taskId);
    assert.strictEqual(changes.provenance?.sourceKind, 'ledger');
    assert.strictEqual(buildReviewChunks(before, after).length, 2);
    const shown = await f.a.service.invoke(
      { method: 'getFileContent', args: [BOUND_REVIEW_TEAM, 'lead', f.filePath, []] },
      f.origin,
      { commandId: 'TEST-apply' }
    );
    assert.strictEqual(shown.method, 'getFileContent');
    if (shown.method !== 'getFileContent') throw new Error('Wrong projection');
    assert.strictEqual(shown.result.originalFullContent, before);
    assert.strictEqual(shown.result.modifiedFullContent, after);
    const result = await f.a.service.invoke(
      {
        method: 'applyDecisions',
        args: [
          {
            teamName: BOUND_REVIEW_TEAM,
            taskId: f.a.taskId,
            memberName: 'lead',
            decisions: [
              {
                filePath: f.filePath,
                fileDecision: 'pending',
                hunkDecisions: { 0: 'accepted', 1: 'rejected' },
                hunkContextHashes: buildReviewChunkContextHashes(before, after),
              },
            ],
          },
        ],
      },
      f.origin,
      { commandId: 'TEST-apply' }
    );
    if (result.method !== 'applyDecisions') throw new Error('Wrong projection');
    assert.partialDeepStrictEqual(result.result, { applied: 1, conflicts: 0, errors: [] });
    assert.strictEqual(
      await readFile(f.filePath, 'utf8'),
      before.replace('first = 1', 'first = 2')
    );
  });
  it('refuses stale disk bytes and originating-task substitution without changing the file', async () => {
    const f = await fixture();
    const external = after + '// external writer\n';
    await writeFile(f.filePath, external);
    const request = {
      method: 'applyDecisions' as const,
      args: [
        {
          teamName: BOUND_REVIEW_TEAM,
          taskId: f.a.taskId,
          memberName: 'lead',
          decisions: [
            { filePath: f.filePath, fileDecision: 'rejected' as const, hunkDecisions: {} },
          ],
        },
      ] as [
        {
          teamName: string;
          taskId: string;
          memberName: string;
          decisions: {
            filePath: string;
            fileDecision: 'rejected';
            hunkDecisions: Record<number, never>;
          }[];
        },
      ],
    };
    const result = await f.a.service.invoke(request, f.origin, { commandId: 'TEST-stale' });
    if (result.method !== 'applyDecisions') throw new Error('Wrong projection');
    assert.strictEqual(result.result.applied, 0);
    assert.ok(result.result.conflicts + result.result.errors.length > 0);
    assert.throws(
      () => f.a.service.invoke(request, { taskId: f.b.taskId, memberName: 'lead' }),
      /originating view/
    );
    assert.strictEqual(await readFile(f.filePath, 'utf8'), external);
  });
  it('cannot read another Team ledger/task, fabricate missing changes, or trust supplied snippets', async () => {
    const f = await fixture();
    await assert.rejects(f.b.service.getTaskChanges(f.a.taskId));
    await assert.rejects(f.b.service.getTaskChanges(f.b.taskId), /evidence is unavailable/);
    const forged = {
      toolUseId: 'forged',
      filePath: f.filePath,
      toolName: 'Edit' as const,
      type: 'edit' as const,
      oldString: 'SECRET',
      newString: 'FORGED',
      replaceAll: false,
      timestamp: '',
      isError: false,
    };
    const result = await f.a.service.invoke(
      { method: 'getFileContent', args: [BOUND_REVIEW_TEAM, 'lead', f.filePath, [forged]] },
      f.origin,
      { commandId: 'TEST-apply' }
    );
    if (result.method !== 'getFileContent') throw new Error('Wrong projection');
    assert.strictEqual(result.result.originalFullContent, before);
    assert.strictEqual(result.result.snippets[0]?.toolUseId, 'TEST-tool');
    const agent = await f.a.service.getAgentChanges('lead');
    assert.equal(agent.totalFiles, 1);
    assert.equal(agent.files[0]!.snippets[0]!.ledger!.actorId, 'lead-id');
    await assert.rejects(f.a.service.getAgentChanges('unknown-member'), /identity is unavailable/);
  });
  it('seals pending reads, rejects revoked principals, and scopes watch/Git paths to the captured workspace', async () => {
    const f = await fixture();
    const watch = await f.a.service.authorizeWatch({
      projectPath: f.workspace,
      filePaths: [f.filePath],
    });
    assert.deepStrictEqual(watch.filePaths, [f.filePath]);
    await assert.rejects(
      f.a.service.authorizeWatch({ projectPath: f.root, filePaths: [f.filePath] })
    );
    const outside = join(f.root, 'outside.txt');
    await writeFile(outside, 'TEST-only');
    const link = join(f.workspace, 'link.txt');
    await symlink(outside, link);
    await assert.rejects(f.a.service.getGitFileLog(f.workspace, link), /outside/);
    const pending = f.a.service.getTaskChanges(f.a.taskId);
    f.a.service.dispose();
    await assert.rejects(pending, /unavailable/);
    f.b.connection.revoke('TEST-human');
    await assert.rejects(f.b.service.getTaskChanges(f.b.taskId));
  });
  it('replays only a settled original command response after reopen without reapplying direct file edits', async () => {
    const f = await fixture();
    const request = {
      method: 'saveEditedFile' as const,
      args: [{ teamName: BOUND_REVIEW_TEAM, ...f.origin }, f.filePath, 'TEST edited\n', after] as [
        { teamName: string; taskId: string; memberName: string },
        string,
        string,
        string,
      ],
    };
    const original = await f.a.service.invoke(request, f.origin, { commandId: 'TEST-direct-edit' });
    assert.partialDeepStrictEqual(original, {
      method: 'saveEditedFile',
      result: { success: true },
    });
    assert.strictEqual(await readFile(f.filePath, 'utf8'), 'TEST edited\n');
    f.a.service.dispose();
    const reopened = f.a.reopen();
    await writeFile(f.filePath, 'TEST later external edit\n');
    assert.deepStrictEqual(
      await reopened.service.invoke(request, f.origin, { commandId: 'TEST-direct-edit' }),
      original
    );
    assert.strictEqual(await readFile(f.filePath, 'utf8'), 'TEST later external edit\n');
    assert.partialDeepStrictEqual(
      await reopened.service.lookupCommand('TEST-direct-edit', f.origin),
      {
        phase: 'completed',
        outcome: 'completed',
        responseAvailable: true,
      }
    );
    await assert.rejects(
      reopened.service.invoke(
        { ...request, args: [request.args[0], f.filePath, 'DIFFERENT', after] },
        f.origin,
        { commandId: 'TEST-direct-edit' }
      ),
      /conflict/
    );
    reopened.connection.revoke('TEST-human');
    await assert.rejects(reopened.service.lookupCommand('TEST-direct-edit', f.origin), /forbidden/);
    await assert.rejects(
      reopened.service.invoke(request, f.origin, { commandId: 'TEST-direct-edit' }),
      /forbidden/
    );
  });
  it('holds a persisted pending command across reopen; Task recovery never replays it and unknown families are not skipped', async () => {
    const f = await fixture();
    const request = {
      method: 'saveEditedFile' as const,
      args: [
        { teamName: f.a.teamName, ...f.origin },
        f.filePath,
        'TEST interrupted edit\n',
        after,
      ] as [{ teamName: string; taskId: string; memberName: string }, string, string, string],
    };
    f.a.owner.reviewCommands('TEST-human').admit('TEST-interrupted', f.origin, request);
    await writeFile(f.filePath, 'TEST interrupted edit\n');
    f.a.service.dispose();
    const reopened = f.a.reopen();
    const wire = {
      ...request,
      args: [
        { ...request.args[0], teamName: BOUND_REVIEW_TEAM },
        ...request.args.slice(1),
      ] as typeof request.args,
    };
    await assert.rejects(
      reopened.service.invoke(wire, f.origin, { commandId: 'TEST-interrupted' }),
      /hold/
    );
    await assert.rejects(
      reopened.service.invoke(wire, f.origin, { commandId: 'TEST-new-id' }),
      /hold/
    );
    assert.deepStrictEqual(await reopened.owner.resumeTaskCommands(), []);
    assert.partialDeepStrictEqual(
      await reopened.service.lookupCommand('TEST-interrupted', f.origin),
      {
        phase: 'prepared',
        outcome: 'unknown',
      }
    );
    assert.strictEqual(await readFile(f.filePath, 'utf8'), 'TEST interrupted edit\n');
    const { TeamOwnerStore } = await import('../dist/adapters/team/TeamOwnerStore.js');
    const { digest } = await import('../dist/team/identity.js');
    const store = new TeamOwnerStore(f.root, f.a.teamName);
    const path = `commands/${digest('TEST-interrupted')}.json`;
    store.write(path, { ...store.read<Record<string, unknown>>(path), family: 'unknown-family' });
    await assert.rejects(reopened.owner.resumeTaskCommands(), /hold/);
  });

  it('keeps an 8MiB authoritative response in a bounded hash-checked artifact, not the scanned command JSON', async () => {
    const f = await fixture();
    const commands = f.a.owner.reviewCommands('TEST-human');
    const request = {
      method: 'executeReviewMutation' as const,
      args: [
        {
          scope: { teamName: f.a.teamName, ...f.origin },
          decisionPersistenceScope: { scopeKey: `task-${f.a.taskId}`, scopeToken: 'TEST-snapshot' },
          kind: 'restore' as const,
          diskSteps: [],
          persistedState: {
            hunkDecisions: {},
            fileDecisions: {},
            reviewActionHistory: [],
            reviewRedoHistory: [],
          },
          expectedDecisionRevision: 0,
        },
      ] as [import('@agent-teams/task-change-ledger/contracts').ExecuteReviewMutationRequest],
    };
    const admitted = commands.admit('TEST-large-result', f.origin, request);
    if (admitted.kind !== 'admitted') throw new Error('Expected new receipt');
    const text = 'x'.repeat(8 * 1024 * 1024);
    const response = {
      kind: 'review-writer' as const,
      method: 'executeReviewMutation' as const,
      result: { decisionRevision: 1, diskPostimages: [{ filePath: f.filePath, content: text }] },
    };
    commands.complete('TEST-large-result', admitted.fingerprint, response);
    const { digest } = await import('../dist/team/identity.js');
    const commandPath = join(
      f.root,
      'teams',
      f.a.teamName,
      '.host-owner',
      'commands',
      `${digest('TEST-large-result')}.json`
    );
    const commandBytes = await readFile(commandPath, 'utf8');
    assert.ok(Buffer.byteLength(commandBytes) < 4096);
    const receipt = JSON.parse(commandBytes) as {
      responseRef: { sha256: string; sizeBytes: number };
    };
    assert.ok(receipt.responseRef.sizeBytes > 8 * 1024 * 1024);
    const reopened = f.a.reopen();
    const looked = await reopened.service.lookupCommand('TEST-large-result', f.origin);
    assert.deepStrictEqual(looked?.response, response);
    assert.deepStrictEqual(looked?.references, { decisionRevision: 1 });
    await assert.rejects(
      reopened.service.lookupCommand('TEST-large-result', {
        taskId: f.b.taskId,
        memberName: 'lead',
      }),
      /conflict/
    );
    const resultPath = join(
      f.root,
      'teams',
      f.a.teamName,
      '.host-owner',
      'command-results',
      `${receipt.responseRef.sha256}.json`
    );
    const resultBytes = await readFile(resultPath, 'utf8');
    await writeFile(resultPath, resultBytes.replace('xxxxxxxx', 'yyyyyyyy'));
    await assert.rejects(reopened.service.lookupCommand('TEST-large-result', f.origin), /hold/);
    await rm(resultPath);
    await symlink(f.filePath, resultPath);
    await assert.rejects(reopened.service.lookupCommand('TEST-large-result', f.origin), /hold/);
  });
  it('cold recovery uses the retained original scope and settles its command only from existing committed WAL facts', async () => {
    const f = await fixture();
    const scope = {
      scopeKey: `task-${f.a.taskId}`,
      scopeToken: 'TEST-OLD-snapshot-not-current-view-token',
    };
    const state = {
      hunkDecisions: {},
      fileDecisions: {},
      reviewActionHistory: [],
      reviewRedoHistory: [],
    };
    const request = {
      method: 'executeReviewMutation' as const,
      args: [
        {
          scope: { teamName: f.a.teamName, ...f.origin },
          decisionPersistenceScope: scope,
          kind: 'reload-external' as const,
          externalFilePath: f.filePath,
          diskSteps: [],
          persistedState: state,
          expectedDecisionRevision: 0,
        },
      ] as [import('@agent-teams/task-change-ledger/contracts').ExecuteReviewMutationRequest],
    };
    const admission = f.a.owner
      .reviewCommands('TEST-human')
      .admit('TEST-old-WAL', f.origin, request);
    if (admission.kind !== 'admitted') throw new Error('Expected original admission');
    const { ReviewMutationJournalStore } =
      await import('@agent-teams/task-change-ledger/review-storage');
    const journal = new ReviewMutationJournalStore(join(f.root, 'teams'));
    const wal = await journal.prepare({
      teamName: f.a.teamName,
      persistenceScope: scope,
      reviewScope: { teamName: f.a.teamName, ...f.origin },
      kind: 'reload-external',
      decisions: [],
      fileContents: [],
      diskSteps: [],
      persistedState: state,
      expectedDecisionRevision: 0,
      commandReceipt: {
        commandId: 'TEST-old-WAL',
        fingerprint: admission.fingerprint,
        origin: f.origin,
      },
    });
    f.a.service.dispose();
    const reopened = f.a.reopen();
    const stateAfter = await reopened.service.recoveryRead(f.origin);
    const original = stateAfter.commands.find((item) => item.commandId === 'TEST-old-WAL');
    assert.partialDeepStrictEqual(original, {
      phase: 'completed',
      outcome: 'completed',
      responseAvailable: false,
      references: { walId: wal.id, decisionRevision: 1 },
    });
    assert.strictEqual((await journal.list(f.a.teamName, scope)).length, 0);
    assert.strictEqual(JSON.stringify(stateAfter).includes(scope.scopeToken), false);
    const lookup = await reopened.service.lookupCommand('TEST-old-WAL', f.origin);
    assert.partialDeepStrictEqual(lookup, { outcome: 'completed', responseAvailable: false });
    assert.strictEqual(await readFile(f.filePath, 'utf8'), after);
  });
  it('keeps an unprovable direct-edit interruption unknown during refresh without changing newer workspace bytes', async () => {
    const f = await fixture();
    const request = {
      method: 'saveEditedFile' as const,
      args: [
        { teamName: f.a.teamName, ...f.origin },
        f.filePath,
        'TEST intended edit\n',
        after,
      ] as [{ teamName: string; taskId: string; memberName: string }, string, string, string],
    };
    f.a.owner.reviewCommands('TEST-human').admit('TEST-unprovable-direct', f.origin, request);
    await writeFile(f.filePath, 'TEST later external bytes\n');
    f.a.service.dispose();
    const reopened = f.a.reopen();
    const state = await reopened.service.recoveryRead(f.origin);
    assert.partialDeepStrictEqual(
      state.commands.find((item) => item.commandId === 'TEST-unprovable-direct'),
      { outcome: 'unknown', phase: 'prepared', responseAvailable: false }
    );
    assert.strictEqual(await readFile(f.filePath, 'utf8'), 'TEST later external bytes\n');
    assert.strictEqual((await reopened.service.getTaskChanges(f.a.taskId)).totalFiles, 1);
  });
  it('holds an original structured reject failure after actual detach and never replays its effects after reopen', async () => {
    const f = await fixture();
    let injected = false;
    f.a.setCurrentProbe(() => {
      if (!injected && !existsSync(f.filePath)) {
        injected = true;
        throw new Error('TEST original reject detached interruption');
      }
    });
    const request = {
      method: 'rejectFile' as const,
      args: [{ teamName: BOUND_REVIEW_TEAM, ...f.origin }, f.filePath] as [
        { teamName: string; taskId: string; memberName: string },
        string,
      ],
    };
    const result = await f.a.service.invoke(request, f.origin, {
      commandId: 'TEST-detached-reject',
    });
    assert.partialDeepStrictEqual(result, { method: 'rejectFile', result: { success: false } });
    assert.equal(injected, true);
    assert.equal(existsSync(f.filePath), false);
    const transaction = readdirSync(f.workspace).find((name) => name.startsWith('.review-txn-'))!;
    assert.equal(await readFile(join(f.workspace, transaction, 'detached'), 'utf8'), after);
    assert.partialDeepStrictEqual(
      await f.a.service.lookupCommand('TEST-detached-reject', f.origin),
      { phase: 'held', outcome: 'unknown', responseAvailable: false }
    );
    f.a.service.dispose();
    const reopened = f.a.reopen();
    await assert.rejects(
      reopened.service.invoke(request, f.origin, { commandId: 'TEST-detached-reject' }),
      { code: 'hold' }
    );
    await assert.rejects(
      reopened.service.invoke(request, f.origin, { commandId: 'TEST-replacement-reject' }),
      { code: 'hold' }
    );
    assert.equal(existsSync(f.filePath), false);
    assert.equal(await readFile(join(f.workspace, transaction, 'detached'), 'utf8'), after);
  });
  it('completes and replays a known reject conflict without retrying effects against newer bytes', async () => {
    const f = await fixture();
    await writeFile(f.filePath, 'TEST independent conflicting bytes\n');
    const request = {
      method: 'rejectFile' as const,
      args: [{ teamName: BOUND_REVIEW_TEAM, ...f.origin }, f.filePath] as [
        { teamName: string; taskId: string; memberName: string },
        string,
      ],
    };
    const result = await f.a.service.invoke(request, f.origin, {
      commandId: 'TEST-known-conflict',
    });
    assert.partialDeepStrictEqual(result, {
      method: 'rejectFile',
      result: { success: false, hadConflicts: true },
    });
    assert.partialDeepStrictEqual(
      await f.a.service.lookupCommand('TEST-known-conflict', f.origin),
      { phase: 'completed', outcome: 'completed', responseAvailable: true }
    );
    f.a.service.dispose();
    const reopened = f.a.reopen();
    await writeFile(f.filePath, after);
    assert.deepEqual(
      await reopened.service.invoke(request, f.origin, { commandId: 'TEST-known-conflict' }),
      result
    );
    assert.equal(await readFile(f.filePath, 'utf8'), after);
  });
  it('completes a prepared-only failure whose exact transaction proves no source detach occurred', async () => {
    const f = await fixture();
    let injected = false;
    f.a.setCurrentProbe(() => {
      const transaction = readdirSync(f.workspace).find((name) => name.startsWith('.review-txn-'));
      if (
        !injected &&
        transaction &&
        existsSync(join(f.workspace, transaction, 'manifest.json')) &&
        !existsSync(join(f.workspace, transaction, 'before.link')) &&
        !existsSync(join(f.workspace, transaction, 'detached'))
      ) {
        injected = true;
        throw new Error('TEST no-detach prepared failure');
      }
    });
    const request = {
      method: 'rejectFile' as const,
      args: [{ teamName: BOUND_REVIEW_TEAM, ...f.origin }, f.filePath] as [
        { teamName: string; taskId: string; memberName: string },
        string,
      ],
    };
    const result = await f.a.service.invoke(request, f.origin, { commandId: 'TEST-prepared-only' });
    assert.partialDeepStrictEqual(result, { method: 'rejectFile', result: { success: false } });
    assert.equal(injected, true);
    assert.equal(await readFile(f.filePath, 'utf8'), after);
    assert.partialDeepStrictEqual(await f.a.service.lookupCommand('TEST-prepared-only', f.origin), {
      phase: 'completed',
      outcome: 'completed',
      responseAvailable: true,
    });
  });
  for (const mode of ['success', 'late-failure', 'prelink-EEXIST'] as const) {
    it(`noScope restored-delete ${mode} retains its actual original publication outcome`, async () => {
      const f = await fixture();
      const eventPath = join(
        f.root,
        'teams',
        f.a.teamName,
        '.host-evidence',
        '.board-task-changes',
        'events',
        `${f.a.taskId}.jsonl`
      );
      const event = JSON.parse(await readFile(eventPath, 'utf8')) as Record<string, unknown>;
      await writeFile(
        eventPath,
        JSON.stringify({
          ...event,
          operation: 'delete',
          after: null,
          beforeState: { exists: true, sha256: hash(before) },
          afterState: { exists: false },
          linesAdded: 0,
          linesRemoved: 14,
        }) + '\n'
      );
      await rm(f.filePath);
      let injected = false;
      f.a.setCurrentProbe(() => {
        if (injected || mode === 'success') return;
        if (mode === 'late-failure' && existsSync(f.filePath)) {
          injected = true;
          throw new Error('TEST create authority lost after actual publication');
        }
        if (
          mode === 'prelink-EEXIST' &&
          readdirSync(f.workspace).some((name) => name.startsWith('.review-create.'))
        ) {
          injected = true;
          writeFileSync(f.filePath, 'TEST independently recreated\n');
        }
      });
      const request = {
        method: 'applyDecisions' as const,
        args: [
          {
            teamName: BOUND_REVIEW_TEAM,
            ...f.origin,
            decisions: [
              { filePath: f.filePath, fileDecision: 'rejected' as const, hunkDecisions: {} },
            ],
          },
        ] as [
          {
            teamName: string;
            taskId: string;
            memberName: string;
            decisions: {
              filePath: string;
              fileDecision: 'rejected';
              hunkDecisions: Record<number, never>;
            }[];
          },
        ],
      };
      const commandId = `TEST-create-${mode}`;
      const result = await f.a.service.invoke(request, f.origin, { commandId });
      assert.equal(result.method, 'applyDecisions');
      if (result.method !== 'applyDecisions') throw new Error('Wrong result');
      assert.equal(result.result.applied, mode === 'success' ? 1 : 0);
      assert.equal(result.result.errors.length, mode === 'success' ? 0 : 1);
      assert.equal(
        await readFile(f.filePath, 'utf8'),
        mode === 'prelink-EEXIST' ? 'TEST independently recreated\n' : before
      );
      const lookup = await f.a.service.lookupCommand(commandId, f.origin);
      assert.partialDeepStrictEqual(
        lookup,
        mode === 'late-failure'
          ? { phase: 'held', outcome: 'unknown', responseAvailable: false }
          : { phase: 'completed', outcome: 'completed', responseAvailable: true }
      );
      if (mode !== 'success') assert.equal(injected, true);
      if (mode === 'prelink-EEXIST') {
        await rm(f.filePath);
        assert.deepEqual(await f.a.service.invoke(request, f.origin, { commandId }), result);
        assert.equal(existsSync(f.filePath), false);
      }
    });
  }
});
