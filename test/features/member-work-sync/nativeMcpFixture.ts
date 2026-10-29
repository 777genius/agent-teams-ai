import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export interface TestCleanup {
  after(callback: () => void): void;
}
import { createFilesystemTeamOwner } from '../../../packages/legacy-agent-host/src/adapters/team/createFilesystemTeamOwner.js';
import {
  deliveryFingerprint,
  runtimeDigest,
} from '../../../packages/legacy-agent-host/src/runtime/identity.js';

import type {
  RuntimeDelivery,
  RuntimeSessionRecord,
} from '../../../packages/legacy-agent-host/src/runtime/contracts.js';

export function nativeMcpFixture(t: TestCleanup, role: 'lead' | 'member' = 'lead') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-native-mcp-authority-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-native-mcp' };
  const source = {
    backendId: binding.backendId,
    teamId: binding.teamId,
    runId: 'TEST-run',
    memberId: 'actual-agent-id',
    generation: '1',
  };
  const owner = createFilesystemTeamOwner({
    root,
    binding,
    members: [
      {
        memberId: source.memberId,
        name: 'alice',
        role,
        delivery: { ...source, teamName: binding.teamName },
      },
      ...(role === 'member'
        ? [{ memberId: 'actual-lead-id', name: 'leader', role: 'lead' as const }]
        : []),
    ],
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'task.write', 'message.write', 'admin'],
      },
      {
        principalId: 'native-connection',
        memberName: 'alice',
        permissions: ['read', 'task.write', 'message.write'],
      },
    ],
  });
  const human = owner.connect('human');
  for (const actionMode of role === 'lead'
    ? (['do', 'ask', 'delegate'] as const)
    : (['do', 'ask'] as const))
    human.execute({
      commandId: `TEST-${actionMode}`,
      operation: 'message.send',
      payload: { to: 'alice', text: `TEST original ${actionMode}`, actionMode },
    });
  function input(mode: string) {
    const raw = human.pendingDeliveries().find((intent) => intent.commandId === `TEST-${mode}`);
    assert.ok(raw);
    return raw;
  }
  const config: NonNullable<RuntimeSessionRecord['config']> = {
    tenantId: 'TEST-backend',
    projectId: 'TEST-project',
    sessionId: 'TEST-session',
    generation: 1,
    configRevision: 'TEST-config',
    requiredCapabilities: ['tools'],
  };
  const initial = input('do');
  let record: RuntimeSessionRecord = {
    schemaVersion: 1,
    binding: source,
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-host',
    config,
    openFingerprint: runtimeDigest({ profileId: 'TEST-profile', config }),
    phase: 'allocated',
    sealed: false,
    custody: 'owned',
    nativeReady: true,
    sessionRef: 'TEST-session-ref',
    inputs: [
      {
        intent: initial,
        fingerprint: deliveryFingerprint(initial),
        operationRef: 'TEST-operation-DO',
        phase: 'consumed',
      },
    ],
    interactions: [],
  };
  let attached = true;
  const options = {
    binding: source,
    profileId: record.profileId,
    hostIncarnation: record.hostIncarnation,
    config,
    readRuntime: () => ({ record, attached }),
    captureTeam: (raw: RuntimeDelivery) =>
      owner.captureNativeMcpAuthority('native-connection', source, raw, true),
    assertCurrent() {},
  };
  return {
    root,
    binding,
    owner,
    human,
    source,
    input,
    options,
    get record() {
      return record;
    },
    set record(next: RuntimeSessionRecord) {
      record = next;
    },
    detach() {
      attached = false;
    },
  };
}
