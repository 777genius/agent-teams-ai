import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifiedHumanDirectSuggestionSource } from '../../dist/team/verifiedHumanDirectSuggestionSource.js';

import type {
  CommandReceipt, DeliveryIntent, TeamGrant, TeamMember,
} from '../../src/team/contracts.ts';

const binding = {
  backendId: 'TEST-owner',
  teamId: 'TEST-team-A',
  teamName: 'TEST-team',
  runId: 'TEST-run-A',
  memberId: 'TEST-member-Bob',
  generation: 'TEST-generation-1',
} as const;
const messageId = 'TEST-original-user-message';
const deliveryId = 'TEST-original-delivery';
const receipt: CommandReceipt = {
  schemaVersion: 1, binding: {
    backendId: binding.backendId, teamId: binding.teamId, teamName: binding.teamName,
  },
  commandId: 'TEST-command-1', principalId: 'TEST-human-principal',
  fingerprint: 'a'.repeat(64), phase: 'completed',
  command: {
    commandId: 'TEST-command-1', operation: 'message.send',
    payload: { to: 'Bob', text: 'Run unit tests' },
  },
  effects: { taskId: '', commentId: '', messageId, deliveryId },
  createdAt: '2026-11-14T12:00:00.000Z',
  deliveryBinding: binding,
  messageRecipientRole: 'member',
  authorityRevision: 1,
};
const intent: DeliveryIntent = {
  schemaVersion: 1, binding, commandId: receipt.commandId,
  principalId: receipt.principalId, messageId, deliveryId,
  inputId: deliveryId, content: 'TEST-original-content',
  authorityRevision: 1, phase: 'admitted',
};
const grant: TeamGrant = {
  principalId: receipt.principalId, memberName: 'user',
  permissions: ['read', 'message.write'],
};
const bob: TeamMember = {
  memberId: binding.memberId, name: 'Bob', role: 'member', delivery: binding,
};
const inbox = [{
  from: 'user', to: 'Bob', text: 'Run unit tests',
  timestamp: receipt.createdAt, messageId, read: false,
}];

function matches(overrides: {
  intent?: DeliveryIntent;
  receipt?: CommandReceipt;
  grant?: TeamGrant;
  members?: TeamMember[];
  inbox?: Array<(typeof inbox)[number] & { groupChatId?: string }>;
} = {}) {
  return verifiedHumanDirectSuggestionSource({
    intent: overrides.intent ?? intent,
    receipt: overrides.receipt ?? receipt,
    grant: overrides.grant ?? grant,
    members: overrides.members ?? [bob],
    inbox: overrides.inbox ?? inbox,
  });
}

test('a saved human direct message is eligible for any teammate role', () => {
  assert.deepEqual(matches(), { memberId: bob.memberId, messageId });
  assert.deepEqual(matches({
    receipt: { ...receipt, messageRecipientRole: 'lead' },
    members: [{ ...bob, role: 'lead' }],
  }), { memberId: bob.memberId, messageId });
});

test('rejects other team, member, owner, generation or direct recipient even with reused IDs', () => {
  for (const key of ['teamId', 'runId', 'memberId', 'generation', 'backendId'] as const) {
    assert.equal(matches({ intent: {
      ...intent, binding: { ...intent.binding, [key]: 'TEST-foreign' },
    } }), null, key);
  }
  assert.equal(matches({ members: [{ ...bob, name: 'Alice' }] }), null);
  assert.equal(matches({ receipt: {
    ...receipt, command: { commandId: receipt.commandId, operation: 'message.send',
      payload: { to: 'Alice', text: 'Run unit tests' } },
  } }), null);
});

test('rejects agent-internal or revoked sender and group/cross-team message provenance', () => {
  assert.equal(matches({ grant: { ...grant, memberName: 'Bob' } }), null);
  assert.equal(matches({ grant: { ...grant, revoked: true } }), null);
  assert.equal(matches({ grant: { ...grant, permissions: ['read'] } }), null);
  assert.equal(matches({ receipt: { ...receipt, group: {} as NonNullable<CommandReceipt['group']> } }), null);
  assert.equal(matches({ receipt: { ...receipt, crossTeam: {} as NonNullable<CommandReceipt['crossTeam']> } }), null);
  assert.equal(matches({ receipt: { ...receipt, phase: 'prepared' } }), null);
  assert.equal(matches({ inbox: [{ ...inbox[0]!, groupChatId: 'TEST-group' }] }), null);
  assert.equal(matches({ inbox: [{ ...inbox[0]!, from: 'Bob' }] }), null);
});

test('outbox/receipt/inbox mismatches fail closed without alternative message inference', () => {
  assert.equal(matches({ intent: { ...intent, messageId: 'TEST-other-message' } }), null);
  assert.equal(matches({ intent: { ...intent, deliveryId: 'TEST-other-delivery' } }), null);
  assert.equal(matches({ receipt: { ...receipt, principalId: 'TEST-other-principal' } }), null);
  assert.equal(matches({ inbox: [{ ...inbox[0]!, text: 'TEST-tampered' }] }), null);
  assert.equal(matches({ inbox: [inbox[0]!, inbox[0]!] }), null);
  assert.equal(matches({ inbox: [] }), null);
});
