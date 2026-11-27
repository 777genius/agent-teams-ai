// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFilesystemTeamOwner } from '@agent-teams/legacy-agent-host/team/filesystem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { boundProductCommandReceipt } from '../../../packages/legacy-agent-host/dist/team/boundProductCommandReceipt.js';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';

import type { CommandReceipt } from '../../../packages/legacy-agent-host/src/team/contracts';
import type { BackendOperationRequest } from '../../../src/features/agent-backend/contracts/operations';

const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'TEST-delivery-team' };
const delivery = {
  ...binding,
  runId: 'TEST-run',
  memberId: 'TEST-alice',
  generation: 'TEST-generation',
};
const lookup: BackendOperationRequest = {
  handle: { handleId: 'TEST-original-handle' },
  commandId: 'TEST-physical-message',
  operation: 'command.lookup',
  payload: {},
};
let root: string;
let original: CommandReceipt;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-message-delivery-projection-')));
  const owner = createFilesystemTeamOwner({
    root,
    binding,
    members: [{ memberId: delivery.memberId, name: 'alice', role: 'member', delivery }],
    grants: [
      { principalId: 'TEST-human', memberName: 'user', permissions: ['read', 'message.write'] },
    ],
  });
  const human = owner.connect('TEST-human');
  human.execute({
    commandId: lookup.commandId,
    operation: 'message.send',
    payload: { to: 'alice', text: 'TEST original private message', messageId: lookup.commandId },
  });
  original = human.lookup(lookup.commandId)!;
  expect(original.phase).toBe('completed');
  const intents = human.pendingDeliveries();
  expect(intents).toHaveLength(1);
  expect(intents[0]).toMatchObject({
    binding: delivery,
    inputId: original.effects.deliveryId,
    deliveryId: original.effects.deliveryId,
    messageId: original.effects.messageId,
  });
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function raw(): Record<string, unknown> {
  return structuredClone(original) as unknown as Record<string, unknown>;
}
function field(source: Record<string, unknown>, name: string): Record<string, unknown> {
  return source[name] as Record<string, unknown>;
}
function project(value: unknown, request: BackendOperationRequest = lookup) {
  return projectBackendResult(request, { ok: true, value });
}

describe('original Host message delivery projection', () => {
  it('acknowledges a large accepted message and recovers its original delivery without repeating the effect', () => {
    const owner = createFilesystemTeamOwner({
      root: join(root, 'large-message'), binding,
      members: [{ memberId: delivery.memberId, name: 'alice', role: 'member', delivery }],
      grants: [{ principalId: 'TEST-human', memberName: 'user', permissions: ['read', 'message.write'] }],
    });
    const human = owner.connect('TEST-human');
    const command = {
      commandId: 'TEST-large-message', operation: 'message.send' as const,
      payload: { to: 'alice', text: '界'.repeat(160_000), summary: '文'.repeat(140_000),
        messageId: 'TEST-large-message' },
    };
    expect(Buffer.byteLength(JSON.stringify(command))).toBeGreaterThan(768 * 1024);
    expect(Buffer.byteLength(JSON.stringify(command))).toBeLessThan(1024 * 1024 - 4096);
    const receipt = human.execute(command);
    expect(receipt.phase).toBe('completed');
    const saved = structuredClone(receipt);
    for (const operation of ['message.send', 'command.lookup'] as const) {
      const response = boundProductCommandReceipt(
        operation === 'command.lookup' ? human.lookup(command.commandId)! : receipt
      );
      expect(Buffer.byteLength(JSON.stringify({ ok: true, value: response }))).toBeLessThan(768 * 1024);
      const request: BackendOperationRequest =
        operation === 'message.send'
          ? { ...lookup, commandId: command.commandId, operation, payload: command.payload }
          : { ...lookup, commandId: command.commandId, operation, payload: {} };
      expect(project(response, request)).toEqual({
        ok: true, value: {
          commandId: command.commandId, operation: 'message.send', phase: 'completed',
          messageId: receipt.effects.messageId, deliveryId: receipt.effects.deliveryId,
          ...(operation === 'command.lookup' ? { messageDelivery: {
            memberId: delivery.memberId, generation: delivery.generation,
            inputId: receipt.effects.deliveryId,
          } } : {}),
        },
      });
    }
    expect(human.lookup(command.commandId)).toEqual(saved);
    expect(saved.result).toMatchObject({ message: { text: command.payload.text, summary: command.payload.summary } });
    expect(human.pendingDeliveries()).toHaveLength(1);
  });

  it('projects only the original canonical recipient and input from a real persisted lookup', () => {
    const source = raw();
    source.privatePath = '/TEST/private/owner';
    source.configuration = { secret: 'TEST-private-config' };
    field(source, 'deliveryBinding').privateConfiguration = 'TEST-private-binding';
    field(source, 'result').privateToken = 'TEST-private-token';
    const before = structuredClone(source);
    expect(project(source)).toEqual({
      ok: true,
      value: {
        commandId: lookup.commandId,
        operation: 'message.send',
        phase: 'completed',
        messageId: original.effects.messageId,
        deliveryId: original.effects.deliveryId,
        messageDelivery: {
          memberId: delivery.memberId,
          generation: delivery.generation,
          inputId: original.effects.deliveryId,
        },
      },
    });
    expect(source).toEqual(before);
  });

  it('keeps an ordinary mutation ACK unchanged and does not project lookup-only identity', () => {
    const request: BackendOperationRequest = {
      ...lookup,
      operation: 'message.send',
      payload: { to: 'alice', text: 'TEST original private message', messageId: lookup.commandId },
    };
    expect(project(raw(), request)).toEqual({
      ok: true,
      value: {
        commandId: lookup.commandId,
        operation: 'message.send',
        phase: 'completed',
        messageId: original.effects.messageId,
        deliveryId: original.effects.deliveryId,
      },
    });
  });

  it('keeps absent delivery binding unavailable without resolving a current recipient', () => {
    const source = raw();
    delete source.deliveryBinding;
    expect(project(source)).toEqual({
      ok: true,
      value: {
        commandId: lookup.commandId,
        operation: 'message.send',
        phase: 'completed',
        messageId: original.effects.messageId,
        deliveryId: original.effects.deliveryId,
      },
    });
  });

  it('does not adopt prepared delivery effects for a Host-local /cost result', () => {
    const source = raw();
    field(field(source, 'command'), 'payload').text = '/cost';
    field(field(source, 'command'), 'payload').nativeCommand = true;
    source.hostCommand = { kind: 'cost', TEST: 'private prepared local reply' };
    delete field(source, 'result').deliveryId;
    expect(project(source)).toEqual({
      ok: true,
      value: {
        commandId: lookup.commandId,
        operation: 'message.send',
        phase: 'completed',
        messageId: original.effects.messageId,
      },
    });
  });

  it.each(['prepared', 'applying', 'held', 'rejected'] as const)(
    'does not turn a %s receipt into a native delivery locator',
    (phase) => {
      const source = raw();
      source.phase = phase;
      const result = project(source);
      expect(result).toMatchObject({ ok: true, value: { phase } });
      if (result.ok) expect(result.value).not.toHaveProperty('messageDelivery');
    }
  );

  it.each(['backendId', 'teamId', 'teamName'] as const)(
    'rejects a delivery from another original %s',
    (key) => {
      const source = raw();
      field(source, 'deliveryBinding')[key] = `TEST-foreign-${key}`;
      expect(() => project(source)).toThrow('Wrong original message delivery binding');
    }
  );

  it.each(['backendId', 'teamId', 'teamName', 'runId', 'memberId', 'generation'] as const)(
    'rejects missing or unbounded %s identity',
    (key) => {
      for (const invalid of [
        undefined,
        '',
        null,
        'x'.repeat(257),
        'TEST\0identity',
        'TEST\nidentity',
      ]) {
        const source = raw();
        field(source, 'deliveryBinding')[key] = invalid;
        expect(() => project(source)).toThrow();
      }
    }
  );

  it.each([
    ['result', 'messageId'],
    ['result', 'deliveryId'],
    ['effects', 'messageId'],
    ['effects', 'deliveryId'],
  ] as const)('rejects mismatched actual %s.%s instead of adopting another effect', (part, key) => {
    const source = raw();
    field(source, part)[key] = 'TEST-other-effect';
    expect(() => project(source)).toThrow();
    field(source, part)[key] = '';
    expect(() => project(source)).toThrow();
  });

  it('rejects an original command or supplied message identity mismatch', () => {
    const commandChanged = raw();
    field(commandChanged, 'command').commandId = 'TEST-other-command';
    expect(() => project(commandChanged)).toThrow('Wrong original message command');
    const messageChanged = raw();
    field(field(messageChanged, 'command'), 'payload').messageId = 'TEST-other-message';
    expect(() => project(messageChanged)).toThrow('Wrong original message effect');
  });

  it('rejects malformed binding objects while leaving unrelated receipt operations unchanged', () => {
    for (const invalid of [null, [], 'TEST-not-a-binding']) {
      const source = raw();
      source.deliveryBinding = invalid;
      expect(() => project(source)).toThrow();
    }
    const request: BackendOperationRequest = {
      ...lookup,
      operation: 'task.update',
      payload: { taskId: 'TEST-task', subject: 'TEST updated' },
    };
    const source = {
      commandId: request.commandId,
      phase: 'completed',
      command: { operation: 'task.update' },
      deliveryBinding: null,
      result: { id: 'TEST-task', status: 'pending', subject: 'TEST updated' },
    };
    expect(project(source, request)).toEqual({
      ok: true,
      value: {
        commandId: request.commandId,
        phase: 'completed',
        operation: 'task.update',
        task: source.result,
      },
    });
    expect(project(null)).toEqual({ ok: true, value: null });
  });
});
