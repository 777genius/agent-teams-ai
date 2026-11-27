// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFilesystemTeamOwner } from '@agent-teams/legacy-agent-host/team/filesystem';
import { filterTeamMessages } from '@renderer/utils/teamMessageFiltering';
import { afterEach, expect, it } from 'vitest';

import { TeamOwnerStore } from '../../../packages/legacy-agent-host/dist/adapters/team/TeamOwnerStore.js';
import { boundProductCommandReceipt } from '../../../packages/legacy-agent-host/dist/team/boundProductCommandReceipt.js';
import { teamCommandPath } from '../../../packages/legacy-agent-host/dist/team/commandEntries.js';
import { createNativeWorkSyncMessagePorts } from '../../../packages/legacy-agent-host/dist/work-sync/createNativeWorkSyncMessagePorts.js';
import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectTeamMessagesPage } from '../../../src/features/agent-backend/main/adapters/output/projectTeamMessagesPage';
import { projectTeamSnapshot } from '../../../src/features/agent-backend/main/adapters/output/projectTeamSnapshot';

import type { NativeWorkSyncMemberContext } from '../../../packages/legacy-agent-host/dist/composition/nativeWorkSyncContext.js';
import type { NativeMcpAuthorityProof } from '../../../packages/legacy-agent-host/dist/team/NativeMcpAuthority.js';
import type { MemberWorkSyncInboxNudgePort } from '../../../packages/legacy-agent-host/dist/work-sync/policy/core/application/ports.js';
import type { RuntimeSessionRecord } from '@agent-teams/legacy-agent-host/runtime/contracts';
import type { TeamCommand } from '@agent-teams/legacy-agent-host/team/contracts';
import type { InboxMessage } from '@shared/types/team';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

class InterruptedOutbox extends TeamOwnerStore {
  fail = false;
  interrupted = false;
  override write(name: string, value: unknown): void {
    if (this.fail && name.startsWith('outbox/')) {
      this.fail = false;
      this.interrupted = true;
      throw new Error('TEST interrupted after inbox publication');
    }
    super.write(name, value);
  }
}

function visible(messages: InboxMessage[]) {
  return filterTeamMessages(messages, {
    filter: { from: new Set(), to: new Set(), showNoise: true },
    searchQuery: '',
  });
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-work-sync-kind-')));
  roots.push(root);
  const binding = {
    backendId: 'TEST-backend',
    teamId: 'TEST-team',
    teamName: 'test-work-sync-kind',
  };
  const source = {
    backendId: binding.backendId,
    teamId: binding.teamId,
    runId: 'TEST-run',
    memberId: 'TEST-worker',
    generation: 'TEST-generation',
  };
  const options = {
    root,
    binding,
    members: [
      {
        memberId: source.memberId,
        name: 'worker',
        role: 'lead' as const,
        delivery: { ...source, teamName: binding.teamName },
      },
    ],
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'task.write', 'message.write', 'admin'] as const,
      },
      {
        principalId: 'native',
        memberName: 'worker',
        permissions: ['read', 'task.write', 'message.write'] as const,
      },
    ].map((grant) => ({ ...grant, permissions: [...grant.permissions] })),
  };
  const store = new InterruptedOutbox(root, binding.teamName);
  const owner = createFilesystemTeamOwner({ ...options, store });
  const human = owner.connect('human');
  human.execute({
    commandId: 'TEST-original-input',
    operation: 'message.send',
    payload: { to: 'worker', text: 'TEST original task instruction', actionMode: 'do' },
  });
  const original = human.pendingDeliveries()[0]!;
  const request: Parameters<MemberWorkSyncInboxNudgePort['insertIfAbsent']>[0] = {
    teamName: binding.teamName,
    memberName: 'worker',
    messageId: 'TEST-original-nudge',
    payloadHash: hash('TEST-original-nudge-payload'),
    timestamp: '2026-11-27T00:00:00.000Z',
    payload: {
      from: 'system',
      to: 'worker',
      messageKind: 'member_work_sync_nudge',
      source: 'member-work-sync',
      actionMode: 'do',
      workSyncIntent: 'agenda_sync',
      text: 'TEST current work sync instruction',
      taskRefs: [],
    },
  };
  const commandId = 'work-sync-delivery:' + hash(request.messageId);
  const command: TeamCommand = {
    commandId,
    operation: 'message.send',
    payload: {
      to: 'worker',
      text: request.payload.text,
      messageId: commandId,
      actionMode: 'do',
    },
  };
  const commandPath = join(store.directory, teamCommandPath(commandId));
  const inboxPath = join(root, 'teams', binding.teamName, 'inboxes', 'worker.json');
  const proof = owner.captureNativeMcpAuthority('native', source, original, true);
  function ports(currentOwner = owner) {
    const assertCurrent = () => {
      expect(currentOwner.captureNativeMcpAuthority('native', source, original, true)).toEqual(
        proof
      );
    };
    const record: RuntimeSessionRecord = {
      schemaVersion: 1,
      binding: source,
      profileId: 'TEST-profile',
      hostIncarnation: 'TEST-host',
      openFingerprint: hash('TEST-session'),
      phase: 'allocated',
      sealed: false,
      custody: 'owned',
      nativeReady: true,
      sessionRef: 'TEST-session',
      inputs: [],
      interactions: [],
    };
    const member: NativeWorkSyncMemberContext = {
      teamId: binding.teamId,
      teamName: binding.teamName,
      owner: currentOwner,
      providerId: 'anthropic',
      sourceRevision: 'TEST-source',
      captureSource() {
        throw new Error('TEST unexpected input recapture');
      },
      delivery: {
        principalId: 'native',
        readRuntime: () => ({ record, attached: true }),
        captureTeam: (raw) => currentOwner.captureNativeMcpAuthority('native', source, raw, true),
        assertCurrent,
        settleDeliveries: async () => {},
      },
    };
    return createNativeWorkSyncMessagePorts({ member, team: proof, assertCurrent }).inboxNudge!;
  }
  return {
    owner,
    human,
    store,
    request,
    command,
    commandId,
    commandPath,
    inboxPath,
    proof,
    ports,
    reopen: () => createFilesystemTeamOwner(options),
    bytes: () => ({
      command: readFileSync(commandPath, 'utf8'),
      inbox: readFileSync(inboxPath, 'utf8'),
    }),
  };
}

it('retains the trusted nudge kind across cold replay and hides it on both current frontend reads', async () => {
  const f = fixture();
  await expect(f.ports().insertIfAbsent(f.request)).resolves.toEqual({
    inserted: true,
    messageId: f.commandId,
  });
  const original = f.bytes();
  expect(
    visible(projectTeamSnapshot(f.human.readSnapshot()).messages).some(
      (message) => message.messageId === f.commandId
    )
  ).toBe(false);
  expect(JSON.parse(original.command)).toMatchObject({ workSyncNudge: true, phase: 'completed' });
  const cold = f.reopen();
  await expect(f.ports(cold).insertIfAbsent(f.request)).resolves.toEqual({
    inserted: false,
    messageId: f.commandId,
  });
  expect(f.bytes()).toEqual(original);
  const retained = cold.connect('native').lookup(f.commandId, f.command);
  expect(retained).toMatchObject({ workSyncNudge: true });
  if (!retained) throw new Error('TEST original receipt missing');
  expect(boundProductCommandReceipt(retained)).not.toHaveProperty('workSyncNudge');
  const intent = cold
    .connect('native')
    .pendingDeliveries()
    .find((row) => row.messageId === f.commandId)!;
  for (const action of ['read', 'admit', 'dispatch'] as const)
    expect(cold.authorizeDeliveryIntent(intent, action)).toBe(true);
  expect(
    cold.authorizeDeliveryIntent({ ...intent, content: intent.content + 'TEST changed' })
  ).toBe(false);
  const human = cold.connect('human');
  for (const messages of [
    projectTeamSnapshot(human.readSnapshot()).messages,
    projectTeamMessagesPage(human.readMessagesPage()).messages,
  ]) {
    expect(messages.find((message) => message.messageId === f.commandId)).toMatchObject({
      messageKind: 'member_work_sync_nudge',
    });
    expect(visible(messages).some((message) => message.messageId === f.commandId)).toBe(false);
    expect(
      visible(messages).some((message) => message.text === 'TEST original task instruction')
    ).toBe(true);
  }
  human.revoke('native');
  for (const action of ['read', 'admit', 'dispatch'] as const)
    expect(cold.authorizeDeliveryIntent(intent, action)).toBe(false);
});

it('recovers a marked inbox publication under the original command without duplicating or reclassifying it', async () => {
  const f = fixture();
  f.store.fail = true;
  await expect(f.ports().insertIfAbsent(f.request)).rejects.toThrow('hold');
  expect(f.store.interrupted).toBe(true);
  const held = f.bytes();
  const original = JSON.parse(held.command);
  expect(original).toMatchObject({ workSyncNudge: true, phase: 'held' });
  const cold = f.reopen();
  await expect(f.ports(cold).insertIfAbsent(f.request)).resolves.toEqual({
    inserted: false,
    messageId: f.commandId,
  });
  expect(f.bytes().inbox).toBe(held.inbox);
  expect(JSON.parse(f.bytes().command)).toMatchObject({
    fingerprint: original.fingerprint,
    workSyncNudge: true,
    phase: 'completed',
  });
  expect(
    cold
      .connect('native')
      .pendingDeliveries()
      .filter((row) => row.messageId === f.commandId)
  ).toHaveLength(1);
});

it.each(['completed', 'held'] as const)(
  'preserves the original pre-marker %s command during cold retry',
  async (phase) => {
    const f = fixture();
    if (phase === 'held') {
      f.store.fail = true;
      expect(() => f.owner.connect('native').execute(f.command)).toThrow('hold');
      expect(f.store.interrupted).toBe(true);
    } else expect(f.owner.connect('native').execute(f.command).phase).toBe('completed');
    const original = f.bytes();
    expect(JSON.parse(original.command)).not.toHaveProperty('workSyncNudge');
    const cold = f.reopen();
    expect(
      cold.connect('native').execute(f.command, undefined, () => {
        throw new Error('TEST must not reclassify an existing receipt');
      }).phase
    ).toBe('completed');
    await expect(f.ports(cold).insertIfAbsent(f.request)).resolves.toEqual({
      inserted: false,
      messageId: f.commandId,
    });
    expect(f.bytes().inbox).toBe(original.inbox);
    if (phase === 'completed') expect(f.bytes().command).toBe(original.command);
    else
      expect(JSON.parse(f.bytes().command)).toMatchObject({
        ...JSON.parse(original.command),
        phase: 'completed',
      });
    expect(JSON.parse(f.bytes().command)).not.toHaveProperty('workSyncNudge');
    const messages = projectTeamSnapshot(cold.connect('human').readSnapshot()).messages;
    expect(messages.find((message) => message.messageId === f.commandId)).not.toHaveProperty(
      'messageKind'
    );
    expect(visible(messages).some((message) => message.messageId === f.commandId)).toBe(true);
  }
);

it('keeps private classification out of both public schemas', () => {
  const f = fixture();
  expect(() =>
    parseBackendOperation({ handle: { handleId: 'TEST-handle' }, ...f.command })
  ).not.toThrow();
  for (const extra of [{ messageKind: 'member_work_sync_nudge' }, { workSyncNudge: true }]) {
    expect(() =>
      f.owner
        .connect('native')
        .execute({ ...f.command, payload: { ...f.command.payload, ...extra } } as TeamCommand)
    ).toThrow('invalid');
    expect(() =>
      parseBackendOperation({
        handle: { handleId: 'TEST-handle' },
        ...f.command,
        payload: { ...f.command.payload, ...extra },
      })
    ).toThrow();
  }
  expect(() =>
    f.owner.connect('native').execute({ ...f.command, workSyncNudge: true } as TeamCommand)
  ).toThrow('invalid');
  expect(f.owner.connect('native').lookup(f.commandId)).toBeUndefined();
});

it.each(['principal', 'member', 'revision', 'binding', 'mode'] as const)(
  'refuses a mismatched trusted %s proof before publication',
  (field) => {
    const f = fixture();
    const proof = structuredClone(f.proof);
    const changed = {
      ...proof,
      ...(field === 'principal' ? { principalId: 'foreign' } : {}),
      ...(field === 'member' ? { memberName: 'foreign' } : {}),
      ...(field === 'revision' ? { authorityRevision: proof.authorityRevision + 1 } : {}),
      ...(field === 'binding' ? { source: { ...proof.source, generation: 'TEST-other' } } : {}),
      ...(field === 'mode' ? { mode: 'ask' } : {}),
    } as NativeMcpAuthorityProof;
    expect(() => f.owner.connect('native').execute(f.command, undefined, () => changed)).toThrow(
      'forbidden'
    );
    expect(f.owner.connect('native').lookup(f.commandId)).toBeUndefined();
  }
);

it('does not let a human use a native marker or continue after revocation during an awaited handoff', async () => {
  const f = fixture();
  expect(() => f.human.execute(f.command, undefined, () => f.proof)).toThrow('forbidden');
  await expect(
    f.ports().insertIfAbsent({
      ...f.request,
      shouldAbort: async () => {
        f.human.revoke('native');
        return false;
      },
    })
  ).rejects.toThrow('forbidden');
  expect(f.human.lookup(f.commandId)).toBeUndefined();
});

it('rejects a corrupt retained classification instead of silently changing the original message kind', async () => {
  const f = fixture();
  await f.ports().insertIfAbsent(f.request);
  const receipt = JSON.parse(f.bytes().command);
  writeFileSync(f.commandPath, JSON.stringify({ ...receipt, workSyncNudge: false }));
  expect(() => f.owner.connect('native').lookup(f.commandId)).toThrow('hold');
});
