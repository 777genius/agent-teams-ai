import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as reviewIo from '@agent-teams/task-change-ledger/review-io';
import { afterEach, expect, it, vi } from 'vitest';

import { createOwnerLifecycleIdentity } from '../../../../packages/legacy-agent-host/src/adapters/lifecycle/createOwnerLifecycleIdentity.js';
import { TeamPermanentDeletionCoordinator } from '../../../../packages/legacy-agent-host/src/adapters/lifecycle/TeamPermanentDeletionCoordinator.js';
import { TeamOwnerStore } from '../../../../packages/legacy-agent-host/src/adapters/team/TeamOwnerStore.js';
import { captureNativeInputAuthority } from '../../../../packages/legacy-agent-host/src/composition/captureNativeInputAuthority.js';
import { createHostWorkSyncComposition } from '../../../../packages/legacy-agent-host/src/composition/createHostWorkSyncComposition.js';
import { createRuntimeWorkSyncWake } from '../../../../packages/legacy-agent-host/src/composition/createRuntimeWorkSyncWake.js';
import { createWorkSyncMcpTools } from '../../../../packages/legacy-agent-host/src/mcp/workSyncTools.js';
import {
  deliveryFingerprint,
  runtimeDigest,
} from '../../../../packages/legacy-agent-host/src/runtime/identity.js';
import { createNativeMemberWorkSyncAgendaSource } from '../../../../packages/legacy-agent-host/src/work-sync/createNativeMemberWorkSyncAgendaSource.js';
import { MemberWorkSyncReconciler } from '../../../../packages/legacy-agent-host/src/work-sync/policy/core/application/MemberWorkSyncReconciler.js';
import { MemberWorkSyncReporter } from '../../../../packages/legacy-agent-host/src/work-sync/policy/core/application/MemberWorkSyncReporter.js';
import { createNativeMemberWorkSyncPersistence } from '../../../../packages/legacy-agent-host/src/work-sync/storage/createNativeMemberWorkSyncPersistence.js';
import { createNativeWorkSyncOutbox } from '../../../../packages/legacy-agent-host/src/work-sync/storage/createNativeWorkSyncOutbox.js';
import { MemberWorkSyncStorePaths } from '../../../../packages/legacy-agent-host/src/work-sync/storage/MemberWorkSyncStorePaths.js';
import { MemberWorkSyncWriteQueue } from '../../../../packages/legacy-agent-host/src/work-sync/storage/MemberWorkSyncWriteQueue.js';
import { nativeMcpFixture } from '../nativeMcpFixture.js';

import type { MemberEntry } from '../../../../packages/legacy-agent-host/src/composition/MemberEntry.js';
import type { MemberWorkSyncStatus } from '../../../../packages/legacy-agent-host/src/work-sync/policy/contracts/index.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});

async function fixture() {
  const f = nativeMcpFixture({ after: (close) => cleanup.push(close) });
  const store = new TeamOwnerStore(f.root, f.binding.teamName);
  const roots = {
    teams: join(f.root, 'teams'),
    tasks: join(f.root, 'tasks'),
    appData: join(f.root, 'appData'),
    backups: join(f.root, 'backups'),
  };
  for (const directory of Object.values(roots)) mkdirSync(directory, { recursive: true });
  const coordinator = new TeamPermanentDeletionCoordinator(
    {
      awaitInitialization: async () => {},
      isInitialized: () => true,
      isShuttingDown: () => false,
      withTeamMutex: async (_name, operation) => operation(),
      registry: () => ({}),
      loadManifest: async () => null,
      saveManifest: async () => {},
      saveRegistryEntry: async () => {},
    },
    roots
  );
  await coordinator.initialize();
  const identity = createOwnerLifecycleIdentity({
    store,
    binding: f.binding,
    coordinator,
    assertWriter() {},
    withReadAuthority: (operation) =>
      f.owner.withLaunchAuthority('native-connection', 'read', operation),
  });
  await identity.publish();
  const authority = captureNativeInputAuthority(f.options);
  let mutations = 0;
  const persistence = createNativeMemberWorkSyncPersistence({
    teamsBasePath: roots.teams,
    teamName: f.binding.teamName,
    memberName: 'alice',
    incarnation: f.binding.teamId,
    identity,
    queue: new MemberWorkSyncWriteQueue(),
    assertCurrent: authority.assertCurrent,
    createMutationId: () => `TEST-original-mutation-${++mutations}`,
  });
  const paths = new MemberWorkSyncStorePaths(roots.teams);
  const status: MemberWorkSyncStatus = {
    teamName: f.binding.teamName,
    memberName: 'alice',
    state: 'caught_up',
    agenda: {
      teamName: f.binding.teamName,
      memberName: 'alice',
      generatedAt: '2026-10-23T00:00:00.000Z',
      fingerprint: 'TEST-agenda-original',
      items: [],
      diagnostics: [],
    },
    evaluatedAt: '2026-10-23T00:00:00.000Z',
    diagnostics: [],
  };
  return { ...f, persistence, paths, status, store, authority, identity };
}

it('publishes original native member status and real metrics, then rejects a stale CAS and foreign member', async () => {
  const f = await fixture();
  const read = await f.persistence.statusMutations.readSnapshot(f.status);
  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error('TEST expected identified empty authority');
  const input = {
    ...f.status,
    expectedToken: read.snapshot.token,
    incarnation: read.snapshot.incarnation,
    mutationId: 'TEST-status-commit',
    nextStatus: f.status,
  };
  const committed = await f.persistence.statusMutations.compareAndWrite(input);
  expect(committed.committed).toBe(true);
  const raw = await readFile(f.paths.getMemberStatusPath(f.binding.teamName, 'alice'), 'utf8');
  const metrics = JSON.parse(
    await readFile(f.paths.getMetricsIndexPath(f.binding.teamName), 'utf8')
  );
  expect(metrics.members.alice.agendaFingerprint).toBe(f.status.agenda.fingerprint);
  expect(metrics.recentEvents).toHaveLength(1);
  expect(await f.persistence.statusMutations.compareAndWrite(input)).toMatchObject({
    committed: false,
    reason: 'conflict',
  });
  expect(await readFile(f.paths.getMemberStatusPath(f.binding.teamName, 'alice'), 'utf8')).toBe(
    raw
  );
  await expect(
    f.persistence.statusMutations.readSnapshot({ ...f.status, memberName: 'other-member' })
  ).rejects.toThrow(/scope/);
  await expect(f.persistence.statusStore.write(f.status)).rejects.toThrow(/conditional/);
});

it('revocation inside original member metadata atomic publication prevents status and every later index write', async () => {
  const f = await fixture();
  const read = await f.persistence.statusMutations.readSnapshot(f.status);
  if (!read.ok) throw new Error('TEST expected empty canonical authority');
  const original = reviewIo.atomicWriteAsync;
  let intercepted = false;
  vi.spyOn(reviewIo, 'atomicWriteAsync').mockImplementation(async (path, data, options) => {
    if (path.endsWith('member.meta.json')) {
      intercepted = true;
      await Promise.resolve();
      f.human.revoke('native-connection');
    }
    return original(path, data, options);
  });
  expect(
    await f.persistence.statusMutations.compareAndWrite({
      teamName: f.status.teamName,
      memberName: f.status.memberName,
      incarnation: read.snapshot.incarnation,
      expectedToken: read.snapshot.token,
      mutationId: 'TEST-revoked-publication',
      nextStatus: f.status,
    })
  ).toMatchObject({ committed: 'unknown' });
  expect(intercepted).toBe(true);
  for (const path of [
    join(f.paths.getMemberDir(f.binding.teamName, 'alice'), 'member.meta.json'),
    f.paths.getMemberStatusPath(f.binding.teamName, 'alice'),
    f.paths.getMetricsIndexPath(f.binding.teamName),
  ])
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps a committed status when metrics projection is corrupt, preserves corrupt bytes, and cannot follow a replacement marker', async () => {
  const f = await fixture();
  const read = await f.persistence.statusMutations.readSnapshot(f.status);
  if (!read.ok) throw new Error('TEST expected empty canonical authority');
  mkdirSync(join(f.paths.getTeamDir(f.binding.teamName), 'indexes'), { recursive: true });
  const metricsPath = f.paths.getMetricsIndexPath(f.binding.teamName);
  await writeFile(metricsPath, 'TEST original corrupt projection\n');
  const result = await f.persistence.statusMutations.compareAndWrite({
    teamName: f.status.teamName,
    memberName: f.status.memberName,
    incarnation: read.snapshot.incarnation,
    expectedToken: read.snapshot.token,
    mutationId: 'TEST-real-status-projection-gap',
    nextStatus: f.status,
  });
  expect(result).toMatchObject({ committed: true, projectionDegraded: ['metrics'] });
  expect(await readFile(metricsPath, 'utf8')).toBe('TEST original corrupt projection\n');
  f.store.fenced(() => {
    const config = f.store.read<Record<string, unknown>>('../config.json')!;
    f.store.write('../config.json', { ...config, _backupIdentityId: 'TEST-replaced-incarnation' });
  });
  expect(await f.persistence.statusMutations.readSnapshot(f.status)).toMatchObject({
    ok: false,
    reason: 'unavailable',
  });
  expect(f.store.read<Record<string, unknown>>('../config.json')!._backupIdentityId).toBe(
    'TEST-replaced-incarnation'
  );
});

it('original status/report use cases publish a durable accepted receipt and real indexes through the authenticated native command', async () => {
  const f = await fixture();
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const now = () => new Date(f.status.evaluatedAt);
  const agendaSource = createNativeMemberWorkSyncAgendaSource({
    owner: f.owner,
    authority: f.authority,
    teamName: f.binding.teamName,
    sourceRevision: runtimeDigest({ binding: f.source, configuration: f.record.config }),
    providerId: 'anthropic',
    now,
    hash,
  });
  const deps = {
    ...f.persistence,
    agendaSource,
    hash: { sha256Hex: hash },
    clock: { now },
    lifecycle: {
      isTeamActive: () => {
        f.authority.assertCurrent();
        f.identity.assertWorkAllowed();
        return true;
      },
      isMemberActive: () => {
        f.authority.assertCurrent();
        return true;
      },
    },
  };
  const commands = f.owner.workSyncCommands('native-connection');
  const status = await new MemberWorkSyncReconciler(deps).execute(f.status);
  expect(status.reportToken).toBeTruthy();
  const request = {
    teamName: f.binding.teamName,
    memberName: 'alice',
    state: 'caught_up' as const,
    agendaFingerprint: status.agenda.fingerprint,
    reportToken: status.reportToken,
    taskIds: [],
    source: 'mcp' as const,
  };
  let executions = 0;
  const effect = async (original: { receivedAt: string }) => {
    executions++;
    const result = await new MemberWorkSyncReporter(deps).execute(request, {
      receivedAt: original.receivedAt,
    });
    expect(result.accepted).toBe(true);
    return JSON.parse(JSON.stringify(result));
  };
  const first = await commands.execute(
    'TEST-native-report',
    'report',
    JSON.parse(JSON.stringify(request)),
    f.authority,
    effect
  );
  expect(first).toMatchObject({ accepted: true });
  const receipt = commands.lookup('TEST-native-report')!;
  expect(receipt.nativeInput.original).toEqual(f.authority.original);
  expect(receipt.nativeInput.team.source).toEqual(f.source);
  expect(receipt.inputAuthority).toBe(f.authority.fingerprint);
  expect(
    await commands.execute(
      'TEST-native-report',
      'report',
      JSON.parse(JSON.stringify(request)),
      f.authority,
      effect
    )
  ).toEqual(first);
  expect(executions).toBe(1);
  const journal = JSON.parse(
    await readFile(f.paths.getMemberReportsPath(f.binding.teamName, 'alice'), 'utf8')
  );
  const rows = Object.values(journal.intents);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: 'accepted',
    journal: { incarnation: f.binding.teamId, receipt: { incarnation: f.binding.teamId } },
  });
  const pending = JSON.parse(
    await readFile(f.paths.getPendingReportsIndexPath(f.binding.teamName), 'utf8')
  );
  expect(Object.values(pending.items)).toMatchObject([{ memberName: 'alice', status: 'accepted' }]);
});

it('reads actual canonical Task obligations and refuses corrupt kanban before any status publication', async () => {
  const f = await fixture();
  const created = f.human.execute({
    commandId: 'TEST-real-task-obligation',
    operation: 'task.create',
    payload: { subject: 'TEST canonical native agenda', owner: 'alice' },
  });
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const agendaSource = createNativeMemberWorkSyncAgendaSource({
    owner: f.owner,
    authority: f.authority,
    teamName: f.binding.teamName,
    sourceRevision: runtimeDigest({ binding: f.source, configuration: f.record.config }),
    providerId: 'anthropic',
    now: () => new Date(f.status.evaluatedAt),
    hash,
  });
  const read = await agendaSource.loadAgenda(f.status);
  expect(read.agenda.items).toMatchObject([
    { subject: 'TEST canonical native agenda', assignee: 'alice', kind: 'work' },
  ]);
  expect(created).toBeTruthy();
  expect(read.agenda.sourceRevision).not.toContain(f.authority.original.inputId);
  const path = join(f.root, 'teams', f.binding.teamName, 'kanban-state.json');
  await writeFile(path, 'TEST retained invalid kanban\n');
  await expect(agendaSource.loadAgenda(f.status)).rejects.toThrow(/Kanban safety state is corrupt/);
  await expect(
    readFile(f.paths.getMemberStatusPath(f.binding.teamName, 'alice'))
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path, 'utf8')).toBe('TEST retained invalid kanban\n');
});

it('bound MCP status/report follow-up settles one original command and cannot recapture ASK after identity await', async () => {
  const f = await fixture();
  let replaceInput = false;
  const feature = createHostWorkSyncComposition({
    teamsBasePath: join(f.root, 'teams'),
    identity: async () => {
      await Promise.resolve();
      if (replaceInput) {
        const next = f.input('ask');
        f.record.inputs = [
          {
            intent: next,
            fingerprint: deliveryFingerprint(next),
            operationRef: 'TEST-next-ASK',
            phase: 'consumed',
          },
        ];
      }
      return f.identity;
    },
    assertCurrent() {},
  });
  try {
    const port = feature.member({
      teamId: f.binding.teamId,
      teamName: f.binding.teamName,
      owner: f.owner,
      providerId: 'anthropic',
      sourceRevision: runtimeDigest({ binding: f.source, configuration: f.record.config }),
      captureSource: () => captureNativeInputAuthority(f.options),
    });
    const tools = createWorkSyncMcpTools(port);
    const statusTool = tools.find((tool) => tool.definition.name === 'member_work_sync_status')!;
    const reportTool = tools.find((tool) => tool.definition.name === 'member_work_sync_report')!;
    expect(() =>
      statusTool.invoke({ commandId: 'TEST-invalid-MCP', memberName: 'other-member' })
    ).toThrow(/invalid/);
    expect(
      f.owner.workSyncCommands('native-connection').lookup('TEST-invalid-MCP')
    ).toBeUndefined();
    const status = JSON.parse(
      JSON.stringify(await statusTool.invoke({ commandId: 'TEST-MCP-status' }))
    );
    expect(status).toMatchObject({
      statusOnlyIncomplete: true,
      nextRequiredToolCall: { tool: 'member_work_sync_report' },
    });
    expect(status.nextRequiredToolCall.arguments).not.toHaveProperty('teamName');
    expect(status.nextRequiredToolCall.arguments).not.toHaveProperty('memberName');
    const report = await reportTool.invoke(status.nextRequiredToolCall.arguments);
    expect(report).toMatchObject({ accepted: true });
    expect(await reportTool.invoke(status.nextRequiredToolCall.arguments)).toEqual(report);
    const command = f.owner
      .workSyncCommands('native-connection')
      .lookup(status.nextRequiredToolCall.arguments.commandId)!;
    expect(command.nativeInput.original).toEqual(f.authority.original);
    expect(command.phase).toBe('completed');
    expect(JSON.stringify(report)).not.toContain('nativeInput');
    replaceInput = true;
    await expect(statusTool.invoke({ commandId: 'TEST-MCP-original-replaced' })).rejects.toThrow(
      /forbidden|hold/
    );
    expect(
      f.owner.workSyncCommands('native-connection').lookup('TEST-MCP-original-replaced')
    ).toBeUndefined();
  } finally {
    await feature.close();
  }
});

it('settles the original accepted WorkSync outbox through the sole Team message writer only after the original input is terminal', async () => {
  const startedAt = Date.now();
  const phase = (value: string) =>
    console.info(
      JSON.stringify({
        test: 'settles the original accepted WorkSync outbox',
        phase: value,
        elapsedMs: Date.now() - startedAt,
      })
    );
  const f = await fixture();
  phase('fixture-ready');
  f.human.execute({
    commandId: 'TEST-actual-assigned-work',
    operation: 'task.create',
    payload: { subject: 'TEST WorkSync delivery obligation', owner: 'alice' },
  });
  const feature = createHostWorkSyncComposition({
    teamsBasePath: join(f.root, 'teams'),
    identity: async () => f.identity,
    assertCurrent() {},
  });
  let handoffs = 0;
  const port = feature.member({
    teamId: f.binding.teamId,
    teamName: f.binding.teamName,
    owner: f.owner,
    providerId: 'opencode',
    sourceRevision: runtimeDigest({ binding: f.source, configuration: f.record.config }),
    captureSource: () => captureNativeInputAuthority(f.options),
    delivery: {
      principalId: 'native-connection',
      readRuntime: f.options.readRuntime,
      captureTeam: f.options.captureTeam,
      assertCurrent() {},
      async settleDeliveries() {
        // Controlled native boundary: observe the real SAME Team message/outbox before a handoff is acknowledged.
        const pending = f.owner.connect('native-connection').pendingDeliveries();
        expect(pending).toHaveLength(1);
        const intent = pending[0]!;
        expect(intent.principalId).toBe('native-connection');
        expect(intent.binding).toEqual({ ...f.source, teamName: f.binding.teamName });
        expect(intent.commandId).toMatch(/^work-sync-delivery:/);
        const receipt = f.owner.connect('native-connection').lookup(intent.commandId)!;
        expect(receipt.command.operation).toBe('message.send');
        expect(receipt.result).toMatchObject({
          message: { from: 'alice', to: 'alice', actionMode: 'do' },
        });
        handoffs++;
      },
    },
  });
  try {
    await port.status('TEST-native-status-with-outbox', { forceNudge: true });
    phase('original-status-settled');
    const outboxPath = f.paths.getMemberOutboxPath(f.binding.teamName, 'alice');
    const before = await readFile(outboxPath, 'utf8');
    const file = JSON.parse(before);
    const items = Object.values(file.items) as {
      nativeWorkSync: { commandId: string; inputAuthority: string };
      status: string;
    }[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      status: 'pending',
      nativeWorkSync: {
        commandId: 'TEST-native-status-with-outbox',
        inputAuthority: f.authority.fingerprint,
      },
    });
    await port.settleAccepted();
    expect(await readFile(outboxPath, 'utf8')).toBe(before);
    expect(handoffs).toBe(0);
    f.record.inputs[0]!.phase = 'terminal';
    const ask = f.input('ask');
    f.record.inputs.push({
      intent: ask,
      fingerprint: deliveryFingerprint(ask),
      operationRef: 'TEST-next-ASK',
      phase: 'consumed',
    });
    await port.settleAccepted();
    expect(await readFile(outboxPath, 'utf8')).toBe(before);
    expect(handoffs).toBe(0);
    f.record.inputs[1]!.phase = 'terminal';
    await port.settleAccepted();
    phase('one-original-handoff-observed');
    expect(handoffs).toBe(1);
    const delivered = JSON.parse(await readFile(outboxPath, 'utf8'));
    expect(Object.values(delivered.items)).toMatchObject([{ status: 'delivered' }]);
    await port.settleAccepted();
    phase('one-original-handoff-observed');
    expect(handoffs).toBe(1);
    expect(f.owner.connect('native-connection').pendingDeliveries()).toHaveLength(1);
  } finally {
    await feature.close();
  }
}, 45_000);

it('refuses deferred adoption after source replacement or original unknown input while preserving the original accepted receipt and outbox', async () => {
  const f = await fixture();
  f.human.execute({
    commandId: 'TEST-required-work',
    operation: 'task.create',
    payload: { subject: 'TEST immutable WorkSync origin', owner: 'alice' },
  });
  const feature = createHostWorkSyncComposition({
    teamsBasePath: join(f.root, 'teams'),
    identity: async () => f.identity,
    assertCurrent() {},
  });
  const port = feature.member({
    teamId: f.binding.teamId,
    teamName: f.binding.teamName,
    owner: f.owner,
    providerId: 'opencode',
    sourceRevision: runtimeDigest({ binding: f.source, configuration: f.record.config }),
    captureSource: () => captureNativeInputAuthority(f.options),
    delivery: {
      principalId: 'native-connection',
      readRuntime: f.options.readRuntime,
      captureTeam: f.options.captureTeam,
      assertCurrent() {},
      async settleDeliveries() {
        throw new Error('TEST forbidden handoff');
      },
    },
  });
  try {
    await port.status('TEST-old-source-outbox', { forceNudge: true });
    const outboxPath = f.paths.getMemberOutboxPath(f.binding.teamName, 'alice');
    const before = await readFile(outboxPath, 'utf8');
    const original = f.owner.workSyncCommands('native-connection').lookup('TEST-old-source-outbox');
    f.record.inputs[0]!.phase = 'unknown';
    await port.settleAccepted();
    expect(await readFile(outboxPath, 'utf8')).toBe(before);
    f.record.inputs[0]!.phase = 'terminal';
    f.record.config = { ...f.record.config!, configRevision: 'TEST-replaced-native-config' };
    await expect(port.settleAccepted()).rejects.toThrow(/hold/);
    expect(await readFile(outboxPath, 'utf8')).toBe(before);
    expect(f.owner.workSyncCommands('native-connection').lookup('TEST-old-source-outbox')).toEqual(
      original
    );
    expect(f.owner.connect('native-connection').pendingDeliveries()).toHaveLength(0);
  } finally {
    await feature.close();
  }
});

it('holds a retained unavailable original without adopting it or blocking an independent accepted intent', async () => {
  const startedAt = Date.now();
  const phase = (value: string) =>
    console.info(
      JSON.stringify({
        test: 'holds a retained unavailable original',
        phase: value,
        elapsedMs: Date.now() - startedAt,
      })
    );
  const f = await fixture();
  phase('fixture-ready');
  f.human.execute({
    commandId: 'TEST-first-obligation',
    operation: 'task.create',
    payload: { subject: 'TEST first obligation', owner: 'alice' },
  });
  const feature = createHostWorkSyncComposition({
    teamsBasePath: join(f.root, 'teams'),
    identity: async () => f.identity,
    assertCurrent() {},
  });
  let handoffs = 0;
  const port = feature.member({
    teamId: f.binding.teamId,
    teamName: f.binding.teamName,
    owner: f.owner,
    providerId: 'opencode',
    sourceRevision: runtimeDigest({ binding: f.source, configuration: f.record.config }),
    captureSource: () => captureNativeInputAuthority(f.options),
    delivery: {
      principalId: 'native-connection',
      readRuntime: f.options.readRuntime,
      captureTeam: f.options.captureTeam,
      assertCurrent() {},
      async settleDeliveries() {
        handoffs++;
      },
    },
  });
  try {
    await port.status('TEST-unavailable-old-origin', { forceNudge: true });
    phase('original-status-settled');
    const outboxPath = f.paths.getMemberOutboxPath(f.binding.teamName, 'alice');
    const first = JSON.parse(await readFile(outboxPath, 'utf8'));
    const firstId = Object.keys(first.items)[0]!;
    f.human.execute({
      commandId: 'TEST-second-obligation',
      operation: 'task.create',
      payload: { subject: 'TEST second obligation', owner: 'alice' },
    });
    f.human.execute({
      commandId: 'TEST-independent-next-DO',
      operation: 'message.send',
      payload: { to: 'alice', text: 'TEST independent next work', actionMode: 'do' },
    });
    const next = f.human
      .pendingDeliveries()
      .find((row) => row.commandId === 'TEST-independent-next-DO')!;
    // Controlled retention boundary: the old original Runtime input is unavailable, not silently relabeled as the new DO.
    f.record.inputs = [
      {
        intent: next,
        fingerprint: deliveryFingerprint(next),
        operationRef: 'TEST-independent-operation',
        phase: 'consumed',
      },
    ];
    await port.status('TEST-independent-new-origin', { forceNudge: true });
    phase('independent-status-settled');
    f.record.inputs[0]!.phase = 'terminal';
    expect(await port.settleAccepted()).toEqual({
      held: [{ commandId: 'TEST-unavailable-old-origin', code: 'hold' }],
    });
    const final = JSON.parse(await readFile(outboxPath, 'utf8'));
    expect(final.items[firstId]).toEqual(first.items[firstId]);
    const newRows = Object.entries(final.items)
      .filter(([id]) => id !== firstId)
      .map(([, row]) => row);
    expect(newRows).toMatchObject([
      { status: 'delivered', nativeWorkSync: { commandId: 'TEST-independent-new-origin' } },
    ]);
    phase('one-original-handoff-observed');
    expect(handoffs).toBe(1);
    expect(f.owner.connect('native-connection').pendingDeliveries()).toHaveLength(1);
  } finally {
    await feature.close();
  }
}, 45_000);

it('quiet canonical scheduler retries retained outbox after nextAttemptAt and stops its captured wake on disposal', async () => {
  const startedAt=performance.now();
  const phase=(value:string)=>console.info(JSON.stringify({test:'quiet-native-outbox',phase:value,elapsedMs:Math.round(performance.now()-startedAt)}));
  const f = await fixture();
  phase('fixture-ready');
  f.human.execute({
    commandId: 'TEST-quiet-task',
    operation: 'task.create',
    payload: { subject: 'TEST quiet retry task', owner: 'alice' },
  });
  const feature = createHostWorkSyncComposition({
    teamsBasePath: join(f.root, 'teams'),
    identity: async () => f.identity,
    assertCurrent() {},
  });
  let handoffs = 0;
  const port = feature.member({
    teamId: f.binding.teamId,
    teamName: f.binding.teamName,
    owner: f.owner,
    providerId: 'opencode',
    sourceRevision: runtimeDigest({ binding: f.source, configuration: f.record.config }),
    captureSource: () => captureNativeInputAuthority(f.options),
    delivery: {
      principalId: 'native-connection',
      readRuntime: f.options.readRuntime,
      captureTeam: f.options.captureTeam,
      assertCurrent() {},
      async settleDeliveries() {
        handoffs++;
      },
    },
  });
  let wake: ReturnType<typeof createRuntimeWorkSyncWake> | undefined;
  try {
    await port.status('TEST-quiet-origin', { forceNudge: true });
    phase('original-status-settled');
    const original = f.owner.workSyncCommands('native-connection').lookup('TEST-quiet-origin')!;
    const outbox = createNativeWorkSyncOutbox({
      teamsBasePath: join(f.root, 'teams'),
      teamName: f.binding.teamName,
      memberName: 'alice',
      queue: new MemberWorkSyncWriteQueue(),
      original,
      withPublication: f.persistence.withOriginalPublication,
    });
    const now = new Date();
    const [claimed] = await outbox.claimDue({
      teamName: f.binding.teamName,
      claimedBy: 'TEST-first-transient-attempt',
      nowIso: now.toISOString(),
      limit: 1,
    });
    expect(claimed).toBeDefined();
    await outbox.markFailed({
      teamName: f.binding.teamName,
      id: claimed!.id,
      attemptGeneration: claimed!.attemptGeneration,
      error: 'TEST-transient-runtime-busy',
      retryable: true,
      nowIso: now.toISOString(),
      nextAttemptAt: new Date(now.getTime() + 90_000).toISOString(),
    });
    phase('retryable-state-retained');
    f.record.inputs[0]!.phase = 'terminal';
    let current = true;
    let scheduled: Promise<unknown> | undefined;
    const entry = {
      delivery: { teamName: f.binding.teamName },
      settleWorkSync: () => {
        scheduled = port.settleAccepted();
        return scheduled as ReturnType<typeof port.settleAccepted>;
      },
    } as MemberEntry;
    // Drive only the scheduler wake; filesystem retry timers must remain real.
    const timers: (() => void)[] = [];
    const systemTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, milliseconds, ...args) => {
      if (milliseconds === 60_000) {
        timers.push(() => handler(...args));
        return systemTimeout(() => {}, 0);
      }
      return systemTimeout(handler, milliseconds, ...args);
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    const tick = async () => {
      const timer = timers.shift();
      expect(timer).toBeDefined();
      timer!();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(scheduled).toBeDefined();
      await scheduled;
      await new Promise<void>(resolve => setImmediate(resolve));
    };
    vi.setSystemTime(now);
    wake = createRuntimeWorkSyncWake({
      entries: new Map([['TEST-original-entry', entry]]),
      isCurrent: () => current,
      isSealed: () => false,
    });
    vi.setSystemTime(now.getTime() + 60_000);
    await tick();
    phase('pre-due-timer-settled');
    expect(handoffs).toBe(0);
    const outboxPath = f.paths.getMemberOutboxPath(f.binding.teamName, 'alice');
    expect(Object.values(JSON.parse(await readFile(outboxPath, 'utf8')).items)).toMatchObject([
      { status: 'failed_retryable', attemptGeneration: 1 },
    ]);
    scheduled = undefined;
    vi.setSystemTime(now.getTime() + 120_000);
    await tick();
    phase('due-timer-delivered');
    expect(handoffs).toBe(1);
    expect(Object.values(JSON.parse(await readFile(outboxPath, 'utf8')).items)).toMatchObject([
      {
        status: 'delivered',
        attemptGeneration: 2,
        nativeWorkSync: { commandId: 'TEST-quiet-origin' },
      },
    ]);
    current = false;
    await wake.dispose();
    for (const timer of timers.splice(0)) timer();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(handoffs).toBe(1);
  } finally {
    await wake?.dispose();
    vi.useRealTimers();
    await feature.close();
  }
}, 90_000);
