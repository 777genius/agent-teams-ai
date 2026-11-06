import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileRuntimeStore } from '../../../packages/legacy-agent-host/src/adapters/runtime/FileRuntimeStore';
import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '../../../packages/legacy-agent-host/src/approval/settings';
import { CapturedInteractionPreview } from '../../../packages/legacy-agent-host/src/composition/CapturedInteractionPreview';
import { HostToolApprovalPolicy } from '../../../packages/legacy-agent-host/src/composition/HostToolApprovalPolicy';
import { RuntimeOwner } from '../../../packages/legacy-agent-host/src/runtime/RuntimeOwner';
import { readBackendToolApprovalSettings } from '../../../src/features/agent-backend/contracts/toolApprovals';
import { projectInteractionPreview } from '../../../src/features/agent-backend/main/adapters/output/projectToolApproval';

import type { ToolApprovalSettings } from '../../../packages/legacy-agent-host/src/approval/policy';
import type { MemberEntry } from '../../../packages/legacy-agent-host/src/composition/MemberEntry';
type Session = Awaited<
  ReturnType<ConstructorParameters<typeof RuntimeOwner>[0]['driverFactory']['open']>
>['driver'];
type Event = ReturnType<Session['observe']> extends AsyncIterable<infer Value> ? Value : never;
type Input = Parameters<Session['submit']>[0];
type InteractionReply = Parameters<Session['respondToInteraction']>[1];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose();
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(
  request:
    | { kind: 'permission'; tool: string; input: Record<string, unknown> }
    | { kind: 'question'; questions: unknown }
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-m06-policy-'))),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  let authorized = true,
    revision = 1,
    now = Date.now();
  const queue: Event[] = [],
    submitted: Input[] = [],
    replies: InteractionReply[] = [];
  let waiter: ((value: IteratorResult<Event>) => void) | undefined;
  let ended = false;
  const events = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<Event>> => {
        if (queue.length) return { value: queue.shift()!, done: false };
        if (ended) return { value: undefined, done: true };
        return new Promise((resolve) => {
          waiter = resolve;
        });
      },
    }),
  };
  const binding = {
    backendId: 'TEST-backend',
    teamId: 'TEST-team',
    runId: 'TEST-run',
    memberId: 'TEST-alice',
    generation: 'TEST-generation',
  };
  const config = {
    tenantId: 'TEST-tenant',
    projectId: 'TEST-project',
    sessionId: 'TEST-session',
    generation: 1,
    configRevision: 'TEST-config',
    requiredCapabilities: ['tools'],
  };
  const session: Session = {
    sessionRef: 'TEST-session',
    submit: async (input) => {
      submitted.push(input);
      return {
        ok: true,
        value: {
          inputId: input.inputId,
          operationRef: input.operationRef,
          delivery: 'client-consumed',
          providerAcceptance: 'unknown',
        },
      };
    },
    observe: () => events,
    respondToInteraction: async (_reference, reply) => {
      replies.push(reply);
      return { ok: true, value: undefined };
    },
    interrupt: async () => ({ ok: true, value: { requested: true, terminal: 'unconfirmed' } }),
    checkReadiness: async () => ({ ok: true, value: undefined }),
    checkpoint: () => ({ ok: false, code: 'unsupported' }),
    close: async () => {
      ended = true;
      waiter?.({ value: undefined, done: true });
      waiter = undefined;
      return { logicallyClosed: true, cleanup: 'confirmed' };
    },
  };
  const store = new FileRuntimeStore(root);
  const runtime = new RuntimeOwner({
    store,
    events: store,
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-host',
    authorize: () => true,
    canDispatch: () => true,
    driverFactory: { open: async () => ({ driver: session, capabilities: ['tools'] }) },
  });
  await runtime.openSession({ binding, config });
  runtime.admitDelivery({
    binding,
    deliveryId: 'TEST-input',
    inputId: 'TEST-input',
    messageId: 'TEST-message',
    content: 'TEST original work',
  });
  await runtime.dispatchNext(binding);
  const input = submitted[0]!;
  if (request.kind === 'permission' && request.input.file_path === 'TEST-target')
    request = { ...request, input: { ...request.input, file_path: join(workspace, 'value.txt') } };
  const event = {
    sessionRef: 'TEST-session',
    inputId: input.inputId,
    operationRef: input.operationRef,
    kind: 'interaction',
    interactionRef: 'TEST-interaction',
    request,
  } as Event;
  if (waiter) {
    const complete = waiter;
    waiter = undefined;
    complete({ done: false, value: event });
  } else queue.push(event);
  await tick();
  const team = {
    definition: { binding: { teamId: binding.teamId } },
    owner: {
      withLaunchAuthority: (
        _principal: string,
        _action: string,
        callback: (value: number) => unknown
      ) => {
        if (!authorized) throw new Error('TEST authority revoked');
        return callback(revision);
      },
    },
  };
  const entry = { binding, config, profile: { cwd: workspace }, team } as unknown as MemberEntry;
  const assertCurrent = () => {
    if (!authorized) throw new Error('TEST authority revoked');
  };
  const policy = new HostToolApprovalPolicy({
    principalId: 'TEST-operator',
    runtime,
    assertCurrent,
    kick: () => undefined,
    now: () => now,
  });
  const preview = new CapturedInteractionPreview();
  preview.capture(entry);
  const payload = { inputId: input.inputId, interactionRef: 'TEST-interaction', offset: 0 };
  const read = (overrides = {}) =>
    preview.read({ runtime, entry, input: { ...payload, ...overrides }, assertCurrent });
  cleanups.push(async () => {
    policy.dispose();
    authorized = true;
    await runtime.stopCapturedSession(binding);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    workspace,
    policy,
    entry,
    runtime,
    store,
    replies,
    read,
    settings: (settings: Partial<ToolApprovalSettings>) =>
      policy.settings(entry.team, { ...DEFAULT_TOOL_APPROVAL_SETTINGS, ...settings }),
    pump: () => policy.pump([entry]),
    advance: (ms: number) => {
      now += ms;
    },
    revoke: () => {
      authorized = false;
    },
    revise: () => {
      revision++;
    },
    terminal: () =>
      store.fenced(binding, (tx) => {
        const record = tx.get()!;
        record.inputs[0]!.phase = 'terminal';
        record.inputs[0]!.terminal = 'cancelled';
        tx.put(record);
      }),
  };
}

describe('Host policies through the real Runtime interaction owner', () => {
  it.each([
    ['autoAllowAll', 'Bash', { command: 'TEST unknown command' }],
    [
      'autoAllowFileEdits',
      'Edit',
      { file_path: '/TEST/file', old_string: 'before', new_string: 'after' },
    ],
    ['autoAllowSafeBash', 'Bash', { command: 'git status' }],
  ] as const)(
    'supports %s without changing the exact pending destination',
    async (field, tool, input) => {
      const f = await fixture({ kind: 'permission', tool, input });
      f.settings({ [field]: true });
      await f.pump();
      expect(f.replies).toEqual([{ kind: 'permission', decision: 'allow' }]);
      expect(f.runtime.readSession(f.entry.binding).record!.interactions[0]!.phase).toBe(
        'resolved'
      );
      await f.pump();
      expect(f.replies).toHaveLength(1);
    }
  );
  it('preserves dangerous Bash refusal and default wait, including after authority revision changes', async () => {
    const f = await fixture({
      kind: 'permission',
      tool: 'Bash',
      input: { command: 'git status && rm -rf TEST' },
    });
    f.settings({ autoAllowSafeBash: true });
    await f.pump();
    expect(f.replies).toEqual([]);
    f.settings({ autoAllowAll: true });
    f.revise();
    await f.pump();
    expect(f.replies).toEqual([]);
    expect(f.policy.settings(f.entry.team)).toEqual(DEFAULT_TOOL_APPROVAL_SETTINGS);
  });
  it.each(['allow', 'deny'] as const)(
    'applies timeout %s and timeoutSeconds only to the original active permission',
    async (action) => {
      const f = await fixture({
        kind: 'permission',
        tool: 'Bash',
        input: { command: 'TEST command' },
      });
      f.settings({ timeoutAction: action, timeoutSeconds: 5 });
      await f.pump();
      expect(f.replies).toEqual([]);
      f.advance(4999);
      await f.pump();
      expect(f.replies).toEqual([]);
      f.advance(1);
      await f.pump();
      expect(f.replies).toEqual([{ kind: 'permission', decision: action }]);
    }
  );
  it.each(['revoked', 'terminal'] as const)(
    'cannot apply a timeout after the input becomes %s',
    async (kind) => {
      const f = await fixture({
        kind: 'permission',
        tool: 'Bash',
        input: { command: 'TEST command' },
      });
      f.settings({ timeoutAction: 'allow', timeoutSeconds: 5 });
      await f.pump();
      f.advance(5000);
      if (kind === 'revoked') f.revoke();
      else f.terminal();
      await f.pump();
      expect(f.replies).toEqual([]);
    }
  );
  it('uses question Deny for timeout denial and never invents an answer for auto-Allow', async () => {
    const f = await fixture({
      kind: 'question',
      questions: [{ question: 'TEST?', options: [{ label: 'TEST answer' }] }],
    });
    f.settings({ autoAllowAll: true, timeoutAction: 'allow', timeoutSeconds: 5 });
    await f.pump();
    f.advance(5000);
    await f.pump();
    expect(f.replies).toEqual([]);
    f.settings({ timeoutAction: 'deny', timeoutSeconds: 5 });
    await f.pump();
    f.advance(5000);
    await f.pump();
    expect(f.replies).toEqual([{ kind: 'question', decision: 'deny' }]);
  });
  it.each(['revoked', 'revision', 'policy'] as const)(
    'fences an automatic grant when the original operator authority becomes %s after claim while member authority remains valid',
    async (change) => {
      const f = await fixture({
        kind: 'permission',
        tool: 'Bash',
        input: { command: 'TEST command' },
      });
      f.settings({ autoAllowAll: true });
      const pumping = f.pump();
      if (change === 'revoked') f.revoke();
      else if (change === 'revision') f.revise();
      else f.settings({ autoAllowAll: false });
      await pumping;
      expect(f.replies).toEqual([]);
      expect(f.runtime.readSession(f.entry.binding).record!.interactions[0]!.phase).toBe('unknown');
    }
  );
  it('validates all five own-data preferences without evaluating getters', () => {
    expect(readBackendToolApprovalSettings(DEFAULT_TOOL_APPROVAL_SETTINGS)).toEqual(
      DEFAULT_TOOL_APPROVAL_SETTINGS
    );
    let reads = 0;
    expect(() =>
      readBackendToolApprovalSettings({
        ...DEFAULT_TOOL_APPROVAL_SETTINGS,
        get timeoutAction() {
          reads++;
          return 'allow';
        },
      })
    ).toThrow();
    expect(reads).toBe(0);
    for (const changed of [
      { timeoutSeconds: 4 },
      { timeoutSeconds: 301 },
      { autoAllowAll: 'yes' },
      { timeoutAction: 'other' },
      { extra: true },
    ])
      expect(() =>
        readBackendToolApprovalSettings({ ...DEFAULT_TOOL_APPROVAL_SETTINGS, ...changed })
      ).toThrow();
  });
});

describe('preview reads the captured pending interaction workspace only', () => {
  it('preserves the original2MiB preview through bounded checked chunks and a final byte hash', async () => {
    const f = await fixture({
      kind: 'permission',
      tool: 'Edit',
      input: { file_path: 'TEST-target', old_string: 'before', new_string: 'after' },
    });
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 11, 'x');
    writeFileSync(join(f.workspace, 'value.txt'), bytes);
    let result = f.read();
    expect(result.truncated).toBe(true);
    const parts = [result.file!.base64],
      hash = result.file!.sha256,
      source = result.sourceFingerprint;
    let count = 1;
    while (result.file!.nextOffset !== null) {
      result = f.read({
        offset: result.file!.nextOffset,
        expectedSha256: hash,
        expectedSource: source,
      });
      projectInteractionPreview(result, {
        offset: result.file!.offset,
        expectedSha256: hash,
        expectedSource: source,
      });
      parts.push(result.file!.base64);
      count++;
    }
    const actual = Buffer.from(parts.join(''), 'base64');
    expect(actual.equals(bytes.subarray(0, 2 * 1024 * 1024))).toBe(true);
    expect(count).toBe(6);
    expect(createHash('sha256').update(actual).digest('hex')).toBe(hash);
    expect(f.replies).toEqual([]);
  });
  it('handles new files and binary content without exposing bytes outside the grant', async () => {
    const f = await fixture({
      kind: 'permission',
      tool: 'Write',
      input: { file_path: 'TEST-target', content: 'after' },
    });
    expect(f.read()).toMatchObject({ file: null, exists: false, isBinary: false });
    writeFileSync(join(f.workspace, 'value.txt'), Buffer.from([1, 0, 2]));
    expect(f.read()).toMatchObject({ file: null, exists: true, isBinary: true, truncated: false });
  });
  it('rejects wrong refs, revoked or terminal inputs, symlinks and same-path workspace replacement', async () => {
    const f = await fixture({
      kind: 'permission',
      tool: 'Write',
      input: { file_path: 'TEST-target', content: 'after' },
    });
    writeFileSync(join(f.root, 'outside.txt'), 'PRIVATE TEST outside');
    symlinkSync(join(f.root, 'outside.txt'), join(f.workspace, 'value.txt'));
    expect(() => f.read()).toThrow();
    rmSync(join(f.workspace, 'value.txt'));
    writeFileSync(join(f.workspace, 'value.txt'), 'before');
    expect(() => f.read({ interactionRef: 'other' })).toThrow();
    expect(() => f.read({ inputId: 'other' })).toThrow();
    renameSync(f.workspace, f.workspace + '-original');
    mkdirSync(f.workspace);
    writeFileSync(join(f.workspace, 'value.txt'), 'before');
    expect(() => f.read()).toThrow();
    const terminal = await fixture({
      kind: 'permission',
      tool: 'Write',
      input: { file_path: 'TEST-target', content: 'after' },
    });
    writeFileSync(join(terminal.workspace, 'value.txt'), 'before');
    terminal.terminal();
    expect(() => terminal.read()).toThrow();
    const revoked = await fixture({
      kind: 'permission',
      tool: 'Write',
      input: { file_path: 'TEST-target', content: 'after' },
    });
    revoked.revoke();
    expect(() => revoked.read()).toThrow();
  });
  it('refuses out-of-workspace native paths and a replaced source between chunks even for identical bytes', async () => {
    const external = await fixture({
      kind: 'permission',
      tool: 'Write',
      input: { file_path: '/TEST-foreign/value.txt', content: 'after' },
    });
    expect(() => external.read()).toThrow();
    const f = await fixture({
      kind: 'permission',
      tool: 'Write',
      input: { file_path: 'TEST-target', content: 'after' },
    });
    const data = Buffer.alloc(500_000, 'x'),
      path = join(f.workspace, 'value.txt');
    writeFileSync(path, data);
    const first = f.read();
    writeFileSync(join(f.workspace, 'replacement.txt'), data);
    renameSync(join(f.workspace, 'replacement.txt'), path);
    expect(() =>
      f.read({
        offset: first.file!.nextOffset!,
        expectedSha256: first.file!.sha256,
        expectedSource: first.sourceFingerprint,
      })
    ).toThrow();
  });
});
