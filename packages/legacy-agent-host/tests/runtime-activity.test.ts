import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
  stat,
  rename,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { RuntimeOwnerError } from '../dist/runtime/contracts.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { CONVERSATION_GAPS, CONVERSATION_LIMITS } from '../dist/runtime/activityContracts.js';
import type { RuntimeBinding, RuntimeOwnerOptions } from '../dist/runtime/contracts.js';
import type {
  RuntimeActivityRecord,
  RuntimeEventStorage,
  RuntimeConversationRecord,
} from '../dist/runtime/activityContracts.js';
import type { Event, Input, Session } from '@agent-teams/provider-session-contracts';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
test('conversation materialization keeps 150 distinct original replies across mixed-ring eviction without nontext or poll IO', async t => {
  const f = await setup(t), owner = f.make();
  const { session, attribution } = await f.open(owner);
  assert.deepEqual(owner.readConversation(binding(), 'messages').gaps, []);
  const path = join(f.root, 'runtime-events', runtimeDigest(binding()) + '.conversation.json');
  await assert.rejects(stat(path), { code: 'ENOENT' }, 'fresh empty marker allocates no derived file');
  session.emit({ ...attribution, kind: 'text', messageRef: 'message-0', block: 2, text: 'last', phase: 'snapshot' });
  await tick();
  const first = owner.readConversation(binding(), 'messages').messages![0]!;
  session.emit({ ...attribution, kind: 'text', messageRef: 'message-0', block: 0, text: 'first', phase: 'complete' });
  session.emit({ ...attribution, kind: 'text', messageRef: 'message-0', block: 2, text: 'last complete', phase: 'complete' });
  session.emit({ ...attribution, kind: 'text', messageRef: 'message-0', block: 2, text: 'stale partial', phase: 'snapshot' });
  for (let index = 1; index < 150; index++) session.emit({ ...attribution, kind: 'text',
    messageRef: 'message-' + index, block: 0, text: 'TEST reply ' + index, phase: 'complete' });
  await tick();
  const kept = owner.readConversation(binding(), 'messages');
  assert.equal(kept.messages!.length, 150);
  assert.equal(kept.messages![0]!.messageId, first.messageId);
  assert.equal(kept.messages![0]!.observedAt, first.observedAt);
  assert.deepEqual(kept.messages![0]!.blocks.map(row => [row.block, row.text]), [[0, 'first'], [2, 'last complete']]);
  const before = await readFile(path, 'utf8');
  for (let index = 0; index < 150; index++) session.emit({ ...attribution, kind: 'text',
    messageRef: 'empty-' + index, block: 0, text: index % 2 ? '' : ' \n\t', phase: 'complete' });
  await tick();
  assert.deepEqual(owner.readConversation(binding(), 'messages'), kept,
    'brand-new blank messages cannot evict visible replies');
  assert.equal(await readFile(path, 'utf8'), before);
  let reads = 0, writes = 0;
  const read = f.store.readConversation.bind(f.store), write = f.store.writeConversation.bind(f.store);
  t.mock.method(f.store, 'readConversation', (target: RuntimeBinding) => { reads++; return read(target); });
  t.mock.method(f.store, 'writeConversation', (value: RuntimeConversationRecord) => { writes++; write(value); });
  for (let index = 0; index < 270; index++) session.emit({ ...attribution, kind: 'tool',
    messageRef: 'message-149', toolRef: 'tool-' + index, name: 'TEST-read', input: { index } });
  session.emit({ ...attribution, kind: 'usage', inputTokens: 4 });
  session.emit({ ...attribution, kind: 'result', outcome: 'succeeded' });
  await tick();
  assert.equal(owner.readActivitySnapshot(binding()).latest.text.length, 0, 'the original mixed ring really evicted the text');
  for (let index = 0; index < 3; index++) assert.equal(owner.readConversation(binding(), 'metadata').revision, kept.revision);
  assert.equal(reads, 0); assert.equal(writes, 0, 'tool/state/usage and marker polls do not open the large file');
  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual(owner.readConversation(binding(), 'messages'), kept);
  assert.ok((await stat(f.path())).size <= f.store.activityLimits.maxBytes);
  const cold = f.make('cold-host');
  assert.deepEqual(cold.readConversation(binding(), 'messages'), kept);
  assert.equal(await readFile(path, 'utf8'), before, 'cold read cannot migrate or rewrite derived history');
  assert.equal(session.submits.length, 1);
});

test('conversation failure never rewrites terminal facts or accepts an older publication as current', async t => {
  const f = await setup(t), owner = f.make();
  const { session, attribution } = await f.open(owner);
  session.emit({ ...attribution, kind: 'text', messageRef: 'retained', block: 0, text: 'before', phase: 'snapshot' });
  await tick();
  const path = join(f.root, 'runtime-events', runtimeDigest(binding()) + '.conversation.json');
  const original = await readFile(path, 'utf8');
  t.mock.method(f.store, 'writeConversation', () => { throw new Error('TEST interrupted derived publication'); });
  session.emit({ ...attribution, kind: 'text', messageRef: 'retained', block: 0, text: 'after', phase: 'complete' });
  session.emit({ ...attribution, kind: 'result', outcome: 'succeeded' });
  await tick();
  assert.equal(owner.readSession(binding()).record!.inputs[0]!.terminal, 'succeeded');
  assert.equal(await readFile(path, 'utf8'), original);
  assert.ok(owner.readConversation(binding(), 'metadata').gaps.includes('storage'));
  assert.throws(() => owner.readConversation(binding(), 'messages'), { code: 'hold' });
  assert.throws(() => f.make('cold').readConversation(binding(), 'messages'), { code: 'hold' });
  assert.equal((await owner.stopCapturedSession(binding())).custody, 'released');
  assert.equal(session.submits.length, 1);
});

test('legacy conversation reads use only dated original input events and never migrate or invent timestamps', async t => {
  const f = await setup(t), owner = f.make();
  const { session, attribution } = await f.open(owner);
  session.emit({ ...attribution, kind: 'text', messageRef: 'dated', block: 0, text: 'original dated reply', phase: 'complete' });
  session.emit({ ...attribution, kind: 'text', messageRef: 'undated', block: 0, text: 'unknown time', phase: 'complete' });
  await tick();
  const activity = JSON.parse(await readFile(f.path(), 'utf8')) as RuntimeActivityRecord;
  delete activity.events.find(row => row.data.messageRef === 'undated')!.observedAt;
  const { digest, ...body } = activity; void digest;
  activity.digest = runtimeDigest(body);
  await writeFile(f.path(), JSON.stringify(activity));
  f.store.fenced(binding(), tx => { const record = tx.get()!; delete record.conversation; tx.put(record); });
  await rm(join(f.root, 'runtime-events', runtimeDigest(binding()) + '.conversation.json'));
  const before = await readFile(f.path(), 'utf8');
  const view = f.make('cold').readConversation(binding(), 'messages');
  assert.deepEqual(view.gaps, ['legacy-history', 'undated']);
  assert.equal(view.messages!.length, 1);
  assert.equal(view.messages![0]!.observedAt, activity.events.find(row => row.data.messageRef === 'dated')!.observedAt);
  assert.equal(await readFile(f.path(), 'utf8'), before);
  assert.equal(f.store.fenced(binding(), tx => tx.get()!.conversation), undefined);
  assert.equal(session.submits.length, 1);
});

test('conversation corrupt, missing, oversized and foreign derived records hold under the original member read grant', async t => {
  const f = await setup(t), owner = f.make();
  const { session, attribution } = await f.open(owner);
  session.emit({ ...attribution, kind: 'text', messageRef: 'exact', block: 0, text: 'original', phase: 'complete' });
  await tick();
  const path = join(f.root, 'runtime-events', runtimeDigest(binding()) + '.conversation.json');
  const original = await readFile(path, 'utf8');
  for (const bytes of ['{', ' '.repeat(8 * 1024 * 1024 + 1), original.replace('TEST-team', 'TEST-foreign-team')]) {
    await writeFile(path, bytes);
    assert.throws(() => owner.readConversation(binding(), 'messages'), { code: 'hold' });
  }
  await rm(path);
  assert.throws(() => owner.readConversation(binding(), 'messages'), { code: 'hold' });
  await writeFile(path, original);
  let allowed = true;
  const reader = f.make('reader', { authorize: () => allowed });
  assert.equal(reader.readConversation(binding(), 'messages').messages!.length, 1);
  allowed = false;
  for (const mode of ['metadata', 'messages'] as const)
    assert.throws(() => reader.readConversation(binding(), mode), { code: 'forbidden' });
  assert.equal(await readFile(path, 'utf8'), original);
});

test('conversation missing original state refuses retained observations without decoding large files or resetting authority', async t => {
  const f = await setup(t), owner = f.make();
  assert.deepEqual(owner.readConversation(binding(), 'messages').messages, [], 'never-created original binding is empty');
  const { session, attribution } = await f.open(owner);
  session.emit({ ...attribution, kind: 'text', messageRef: 'original', block: 0, text: 'retained reply', phase: 'complete' });
  await tick();
  const target = binding(), member = { backendId: target.backendId, teamId: target.teamId, memberId: target.memberId };
  const statePath = join(f.root, 'runtime-sessions', runtimeDigest(member), runtimeDigest(target) + '.json');
  const derivedPath = join(f.root, 'runtime-events', runtimeDigest(target) + '.conversation.json');
  const state = await readFile(statePath), ring = await readFile(f.path()), derived = await readFile(derivedPath);
  const cold = f.make('cold');
  let reads = 0;
  t.mock.method(f.store, 'readConversation', () => { reads++; throw new Error('unexpected large read'); });
  try {
    await rm(statePath);
    for (const only of ['both', 'derived', 'ring'] as const) {
      if (only === 'derived') await rm(f.path());
      if (only === 'ring') { await writeFile(f.path(), ring); await rm(derivedPath); }
      for (const mode of ['metadata', 'messages'] as const)
        assert.throws(() => cold.readConversation(target, mode), { code: 'hold' });
      await assert.rejects(stat(statePath), { code: 'ENOENT' }, 'read cannot recreate lost original authority');
    }
    assert.equal(reads, 0, 'absence check uses only the two exact observation paths');
  } finally {
    await writeFile(statePath, state); await writeFile(f.path(), ring); await writeFile(derivedPath, derived);
  }
  assert.equal(session.submits.length, 1);
});

test('conversation rows require the original input, operation and delivery fingerprint after cold read', async t => {
  const f = await setup(t), owner = f.make();
  const { session, attribution } = await f.open(owner);
  session.emit({ ...attribution, kind: 'text', messageRef: 'original', block: 0, text: 'original reply', phase: 'complete' });
  await tick();
  const target = binding(), member = { backendId: target.backendId, teamId: target.teamId, memberId: target.memberId };
  const path = join(f.root, 'runtime-sessions', runtimeDigest(member), runtimeDigest(target) + '.json');
  const original = await readFile(path, 'utf8'), cold = f.make('cold');
  try {
    for (const mutation of ['missing-input', 'operation', 'fingerprint'] as const) {
      const record = JSON.parse(original);
      if (mutation === 'missing-input') record.inputs = [];
      else if (mutation === 'operation') record.inputs[0].operationRef = 'TEST-foreign-operation';
      else record.inputs[0].intent.content = 'changed without original fingerprint';
      await writeFile(path, JSON.stringify(record));
      assert.throws(() => cold.readConversation(target, 'messages'), { code: 'hold' });
    }
  } finally { await writeFile(path, original); }
  assert.equal(cold.readConversation(target, 'messages').messages!.length, 1);
  assert.equal(session.submits.length, 1);
});

for (const stage of ['symlink', 'before-open', 'after-open', 'symlink-before-open', 'disappeared-before-open'] as const) {
  test('conversation finite FD read refuses ' + stage + ' without adopting replacement bytes', async t => {
    const f = await setup(t), owner = f.make();
    const { session, attribution } = await f.open(owner);
    session.emit({ ...attribution, kind: 'text', messageRef: 'original', block: 0, text: 'original reply', phase: 'complete' });
    await tick();
    const path = join(f.root, 'runtime-events', runtimeDigest(binding()) + '.conversation.json');
    const retained = join(f.root, 'TEST-retained-conversation.json'), bytes = await readFile(path);
    const nativeOpen = fs.openSync;
    let originalFd: number | undefined, armed = true;
    const replace = () => {
      fs.renameSync(path, retained);
      if (stage === 'disappeared-before-open') return;
      if (stage === 'symlink' || stage === 'symlink-before-open') fs.symlinkSync(retained, path, 'file');
      else fs.writeFileSync(path, bytes, { flag: 'wx' });
    };
    try {
      if (stage === 'symlink') replace();
      t.mock.method(fs, 'openSync', (...args: Parameters<typeof nativeOpen>) => {
        if (args[0] !== path || !armed) return nativeOpen(...args);
        armed = false;
        if (typeof args[1] === 'number') args[1] &= ~(fs.constants.O_NOFOLLOW ?? 0);
        if (stage !== 'after-open') replace();
        const fd = nativeOpen(...args); originalFd = fd;
        if (stage === 'after-open') replace();
        return fd;
      });
      syncBuiltinESMExports();
      assert.throws(() => owner.readConversation(binding(), 'messages'), { code: 'hold' });
      assert.equal(armed, stage === 'symlink', 'initial aliases refuse before open; races use original open boundary');
      const closedFd = originalFd;
      if (closedFd !== undefined) assert.throws(() => fs.fstatSync(closedFd), { code: 'EBADF' });
      assert.deepEqual(await readFile(retained), bytes, 'original bytes were not overwritten or repaired');
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      await rm(path, { force: true }); await writeFile(path, bytes);
    }
    assert.equal(session.submits.length, 1);
  });
}

test('conversation fresh empty marker refuses a nonempty retained file instead of adopting it', async t => {
  const f = await setup(t), owner = f.make();
  const { session, attribution } = await f.open(owner);
  const target = binding(), member = { backendId: target.backendId, teamId: target.teamId, memberId: target.memberId };
  const path = join(f.root, 'runtime-sessions', runtimeDigest(member), runtimeDigest(target) + '.json');
  const emptyState = await readFile(path);
  session.emit({ ...attribution, kind: 'text', messageRef: 'original', block: 0, text: 'original reply', phase: 'complete' });
  await tick();
  const original = await readFile(path);
  try {
    await writeFile(path, emptyState);
    assert.throws(() => f.make('cold').readConversation(target, 'messages'), { code: 'hold' });
  } finally { await writeFile(path, original); }
});

test('conversation equal text remains input-distinct, existing blocks may clear, and 65 blocks survive count retention', async t => {
  const f = await setup(t), owner = f.make();
  const { session, attribution } = await f.open(owner);
  session.emit({ ...attribution, kind: 'text', messageRef: 'same-native-ref', block: 0, text: 'same reply', phase: 'complete' });
  await tick();
  const first = owner.readConversation(binding(), 'messages').messages![0]!;
  session.emit({ ...attribution, kind: 'text', messageRef: 'same-native-ref', block: 0, text: '', phase: 'complete' });
  await tick();
  const cleared = owner.readConversation(binding(), 'messages').messages![0]!;
  assert.equal(cleared.messageId, first.messageId); assert.equal(cleared.observedAt, first.observedAt);
  assert.equal(cleared.blocks[0]!.text, '', 'an existing visible block may still be cleared');
  session.emit({ ...attribution, kind: 'text', messageRef: 'same-native-ref', block: 0, text: 'same reply', phase: 'complete' });
  session.emit({ ...attribution, kind: 'result', outcome: 'succeeded' });
  await tick();
  await owner.admitDelivery({ binding: binding(), deliveryId: 'TEST-second-input', inputId: 'TEST-second-input',
    messageId: 'TEST-second-message', content: 'TEST second work' });
  await owner.dispatchNext(binding());
  const secondInput = session.submits[1]!, second = { inputId: secondInput.inputId, operationRef: secondInput.operationRef };
  session.emit({ ...second, kind: 'text', messageRef: 'same-native-ref', block: 0, text: 'same reply', phase: 'complete' });
  await tick();
  const distinct = owner.readConversation(binding(), 'messages');
  assert.equal(distinct.messages!.length, 2);
  assert.notEqual(distinct.messages![0]!.messageId, distinct.messages![1]!.messageId);
  const path = join(f.root, 'runtime-events', runtimeDigest(binding()) + '.conversation.json');
  const before = await readFile(path);
  session.emit({ ...second, kind: 'text', messageRef: 'local-command:TEST-cost', block: 0,
    text: 'published by the existing local-command owner', phase: 'complete' });
  await tick();
  assert.deepEqual(owner.readConversation(binding(), 'messages'), distinct);
  assert.deepEqual(await readFile(path), before, 'existing local-command publisher is never duplicated');
  for (let index = 0; index < 149; index++) session.emit({ ...second, kind: 'text', messageRef: 'next-' + index,
    block: 0, text: 'visible reply ' + index, phase: 'complete' });
  await tick();
  const retained = owner.readConversation(binding(), 'messages');
  assert.equal(retained.messages!.length, 150); assert.deepEqual(retained.gaps, ['retention']);
  assert.equal(retained.messages!.some(row => row.messageId === first.messageId), false);
  assert.deepEqual(retained.messages![0], distinct.messages![1], 'oldest distinct reply, not updated block, is evicted');
  for (let block = 1; block <= 64; block++) session.emit({ ...second, kind: 'text', messageRef: 'next-148',
    block, text: 'block ' + block, phase: 'complete' });
  await tick();
  const limited = owner.readConversation(binding(), 'messages');
  assert.equal(limited.messages!.at(-1)!.blocks.length, 65);
  assert.deepEqual(limited.gaps, ['retention']);
  assert.ok((await stat(path)).size <= 8 * 1024 * 1024);
  assert.equal(session.submits.length, 2);
});

test('conversation partial storage ports remain explicitly unsupported and cannot publish an unchecked marker', async t => {
  const f = await setup(t);
  let reads = 0, writes = 0;
  const events: RuntimeEventStorage = { activityLimits: f.store.activityLimits,
    readActivity: f.store.readActivity.bind(f.store), writeActivity: f.store.writeActivity.bind(f.store),
    readConversation: () => { reads++; throw new Error('unsupported derived read'); },
    writeConversation: () => { writes++; throw new Error('unsupported derived write'); } };
  const owner = f.make('partial', { events });
  const { session, attribution } = await f.open(owner);
  session.emit({ ...attribution, kind: 'text', messageRef: 'original', block: 0, text: 'original reply', phase: 'complete' });
  session.emit({ ...attribution, kind: 'result', outcome: 'succeeded' });
  await tick();
  const view = owner.readConversation(binding(), 'messages');
  assert.deepEqual(view.gaps, ['unsupported']); assert.deepEqual(view.messages, []);
  assert.equal(reads, 0); assert.equal(writes, 0);
  assert.equal(f.store.fenced(binding(), tx => tx.get()!.conversation), undefined);
  assert.equal(owner.readSession(binding()).record!.inputs[0]!.terminal, 'succeeded');
});

test('conversation exact reserved-envelope budget retains the reply and one extra byte reports loss without evicting it', async t => {
  const f = await setup(t), owner = f.make();
  const { session, attribution } = await f.open(owner);
  for (let index = 0; index < 20; index++) session.emit({ ...attribution, kind: 'usage', inputTokens: index });
  session.emit({ ...attribution, kind: 'text', messageRef: 'original-budget', block: 0, text: 'seed', phase: 'complete' });
  await tick();
  const path = join(f.root, 'runtime-events', runtimeDigest(binding()) + '.conversation.json');
  const original = JSON.parse(await readFile(path, 'utf8')) as RuntimeConversationRecord;
  const nextSequence = f.store.fenced(binding(), tx => tx.get()!.activitySequence!) + 1;
  const envelope = structuredClone(original);
  envelope.sequence = Number.MAX_SAFE_INTEGER; envelope.gaps = [...CONVERSATION_GAPS];
  envelope.messages[0]!.blocks[0]!.sequence = nextSequence;
  envelope.messages[0]!.blocks[0]!.text = '';
  const text = 'x'.repeat(CONVERSATION_LIMITS.bytes - Buffer.byteLength(JSON.stringify(envelope, null, 2)));
  envelope.messages[0]!.blocks[0]!.text = text;
  assert.equal(Buffer.byteLength(JSON.stringify(envelope, null, 2)), CONVERSATION_LIMITS.bytes);
  session.emit({ ...attribution, kind: 'text', messageRef: 'original-budget', block: 0, text, phase: 'complete' });
  await tick();
  const fitted = owner.readConversation(binding(), 'messages');
  assert.equal(fitted.messages![0]!.blocks[0]!.text, text);
  assert.deepEqual(fitted.gaps, []);
  assert.equal(fitted.messages![0]!.observedAt, original.messages[0]!.observedAt);
  assert.ok((await stat(path)).size <= CONVERSATION_LIMITS.bytes);
  session.emit({ ...attribution, kind: 'text', messageRef: 'original-budget', block: 0, text: text + 'x', phase: 'complete' });
  session.emit({ ...attribution, kind: 'result', outcome: 'succeeded' });
  await tick();
  const lost = owner.readConversation(binding(), 'messages');
  assert.deepEqual(lost.gaps, ['oversized']);
  assert.deepEqual(lost.messages, fitted.messages, 'one oversized replacement cannot discard the last valid reply');
  assert.ok((await stat(path)).size <= CONVERSATION_LIMITS.bytes, 'the loss marker still fits the same file budget');
  assert.equal(owner.readSession(binding()).record!.inputs[0]!.terminal, 'succeeded');
  assert.deepEqual(f.make('cold').readConversation(binding(), 'messages'), lost);
  assert.equal(session.submits.length, 1);
});
const binding = (memberId = 'TEST-A'): RuntimeBinding => ({
  backendId: 'TEST-backend',
  teamId: 'TEST-team',
  runId: 'TEST-run',
  memberId,
  generation: 'generation-1',
});
type WithoutSession<T> = T extends unknown ? Omit<T, 'sessionRef'> : never;
class ControlledSession implements Session {
  readonly sessionRef: string;
  readonly submits: Input[] = [];
  private queue: Event[] = [];
  private waiter: ((result: IteratorResult<Event>) => void) | undefined;
  private ended = false;
  constructor(ref: string) {
    this.sessionRef = ref;
  }
  submit: Session['submit'] = async (input) => {
    this.submits.push(input);
    return {
      ok: true,
      value: {
        inputId: input.inputId,
        operationRef: input.operationRef,
        delivery: 'client-consumed',
        providerAcceptance: 'unknown',
      },
    };
  };
  observe = (): AsyncIterable<Event> => ({
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const event = this.queue.shift();
        if (event) return Promise.resolve({ done: false, value: event });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    }),
  });
  emit(data: WithoutSession<Event>): void {
    this.raw({ ...data, sessionRef: this.sessionRef } as Event);
  }
  raw(event: Event): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ done: false, value: event });
    } else this.queue.push(event);
  }
  end(): void {
    this.ended = true;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
  }
  respondToInteraction: Session['respondToInteraction'] = async () => ({
    ok: true,
    value: undefined,
  });
  interrupt: Session['interrupt'] = async () => ({
    ok: true,
    value: { requested: true, terminal: 'unconfirmed' },
  });
  checkpoint: Session['checkpoint'] = () => ({ ok: false, code: 'unsupported' });
  checkReadiness: Session['checkReadiness'] = async () => ({ ok: true, value: undefined });
  close: Session['close'] = async () => {
    this.end();
    return { logicallyClosed: true, cleanup: 'confirmed' };
  };
}
async function setup(
  t: { after(fn: () => Promise<void>): void },
  limits: ConstructorParameters<typeof FileRuntimeStore>[1] = {}
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-runtime-activity-'))),
    store = new FileRuntimeStore(root, limits),
    sessions: ControlledSession[] = [];
  const make = (hostIncarnation = 'host-1', overrides: Partial<RuntimeOwnerOptions> = {}) =>
    new RuntimeOwner({
      store,
      events: store,
      hostIncarnation,
      profileId: 'TEST-profile',
      authorize: () => true,
      canDispatch: () => true,
      driverFactory: {
        open: async () => {
          const driver = new ControlledSession(`TEST-native-${sessions.length}`);
          sessions.push(driver);
          return { driver, capabilities: ['tools'] };
        },
      },
      ...overrides,
    });
  t.after(async () => {
    for (const session of sessions) session.end();
    await tick();
    await rm(root, { recursive: true, force: true });
  });
  async function open(owner: RuntimeOwner, target = binding()) {
    await owner.openSession({
      binding: target,
      config: {
        tenantId: 'TEST-tenant',
        projectId: 'TEST-project',
        sessionId: target.memberId,
        generation: 1,
        configRevision: 'config-1',
        requiredCapabilities: ['tools'],
      },
    });
    await owner.admitDelivery({
      binding: target,
      deliveryId: `input-${target.memberId}`,
      inputId: `input-${target.memberId}`,
      messageId: 'message',
      content: 'TEST work',
    });
    await owner.dispatchNext(target);
    const session = sessions.at(-1)!;
    const input = session.submits[0]!;
    return { session, attribution: { inputId: input.inputId, operationRef: input.operationRef } };
  }
  return {
    root,
    store,
    sessions,
    make,
    open,
    path: (target = binding()) => join(root, 'runtime-events', `${runtimeDigest(target)}.json`),
  };
}

test('snapshot and replay share a fence/cursor; persisted text/tools/usage/interaction state survives restart with explicit incarnation gap', async (t) => {
  const f = await setup(t);
  const owner = f.make();
  const { session, attribution } = await f.open(owner);
  const before = owner.readActivitySnapshot(binding());
  assert.ok(before.cursor.sequence > 0);
  session.emit({
    ...attribution,
    kind: 'text',
    messageRef: 'message-A',
    block: 0,
    text: 'first snapshot',
    phase: 'snapshot',
  });
  await tick();
  session.emit({
    ...attribution,
    kind: 'text',
    messageRef: 'message-A',
    block: 0,
    text: 'completed text',
    phase: 'complete',
  });
  session.emit({
    ...attribution,
    kind: 'tool',
    messageRef: 'message-A',
    toolRef: 'tool-A',
    name: 'TEST-read',
    input: { path: 'TEST-file' },
  });
  session.emit({
    ...attribution,
    kind: 'tool-result',
    toolRef: 'tool-A',
    content: { ok: true },
    isError: false,
  });
  session.emit({
    ...attribution,
    kind: 'usage',
    inputTokens: 12,
    outputTokens: 4,
    cumulativeCostUsd: 0.25,
  });
  session.emit({
    ...attribution,
    kind: 'interaction',
    interactionRef: 'permission-A',
    request: { kind: 'permission', tool: 'TEST-read', input: { path: 'TEST-file' } },
  });
  session.emit({ kind: 'compaction', sourceRef: 'boundary-A', reason: 'automatic' });
  await tick();
  const snapshot = owner.readActivitySnapshot(binding());
  assert.equal(snapshot.latest.text.length, 1);
  assert.equal(snapshot.latest.text[0]?.data.text, 'completed text');
  assert.equal(snapshot.latest.tools.length, 2);
  assert.equal(snapshot.latest.usage[0]?.data.inputTokens, 12);
  assert.equal(snapshot.latest.interactions[0]?.data.interactionRef, 'permission-A');
  assert.equal(snapshot.state?.interactions[0]?.phase, 'pending');
  assert.equal(snapshot.latest.compaction?.data.sourceRef, 'boundary-A');
  const replay = owner.readActivityFeed(binding(), before.cursor);
  assert.ok(
    replay.events.some(
      (event) => event.data.kind === 'text' && event.data.text === 'completed text'
    )
  );
  assert.equal(replay.cursor.sequence, snapshot.cursor.sequence);
  assert.equal(typeof snapshot.lastObservedAt, 'string');
  assert.equal(snapshot.lastObservedAt, replay.events.at(-1)?.observedAt);
  const empty = owner.readActivityFeed(binding(), snapshot.cursor);
  assert.deepEqual(empty.events, []);
  await owner.respondToInteraction(binding(), attribution.inputId, 'permission-A', {
    kind: 'permission',
    decision: 'deny',
  });
  const changed = owner.readActivityFeed(binding(), snapshot.cursor);
  assert.ok(changed.cursor.sequence > snapshot.cursor.sequence);
  assert.ok(changed.events.some((event) => event.data.kind === 'state'));
  assert.equal(owner.readActivitySnapshot(binding()).state?.interactions[0]?.phase, 'resolved');
  const restarted = f.make('host-2');
  const recovered = restarted.readActivitySnapshot(binding());
  assert.equal(recovered.cursor.sequence, changed.cursor.sequence);
  assert.equal(recovered.lastObservedAt, changed.events.at(-1)?.observedAt);
  assert.equal(recovered.latest.text[0]?.data.text, 'completed text');
  assert.equal(recovered.gap?.reason, 'incarnation');
  assert.equal(restarted.readActivityFeed(binding(), changed.cursor).gap?.reason, 'incarnation');
  assert.equal(f.sessions.length, 1, 'read recovery must not allocate/adopt a provider');
});

test('bounded retention/paging gives explicit gap and cannot return a future or another member cursor', async (t) => {
  const f = await setup(t, { activity: { maxBytes: 8192, maxEvents: 5, maxEventBytes: 2048 } });
  const owner = f.make();
  const { session, attribution } = await f.open(owner);
  const original = owner.readActivitySnapshot(binding());
  for (let index = 0; index < 12; index++)
    session.emit({
      ...attribution,
      kind: 'text',
      messageRef: `message-${index}`,
      block: 0,
      text: 'x'.repeat(1024),
      phase: 'complete',
    });
  await tick();
  const snapshot = owner.readActivitySnapshot(binding());
  assert.ok(snapshot.retainedFrom > original.cursor.sequence);
  assert.equal(snapshot.gap?.reason, 'retention');
  assert.ok((await stat(f.path())).size <= 8192);
  assert.equal(owner.readActivityFeed(binding(), original.cursor).gap?.reason, 'retention');
  assert.equal(
    owner.readActivityFeed(binding(), {
      ...snapshot.cursor,
      sequence: snapshot.cursor.sequence + 1,
    }).gap?.reason,
    'cursor'
  );
  await f.open(owner, binding('TEST-B'));
  assert.equal(owner.readActivityFeed(binding('TEST-B'), snapshot.cursor).gap?.reason, 'cursor');
  const fresh = owner.readActivityFeed(binding(), {
    ...snapshot.cursor,
    sequence: snapshot.retainedFrom - 1,
  });
  assert.ok(fresh.events.length <= 5);
  assert.ok(fresh.events.every((event) => event.inputId === attribution.inputId));
  const retained = JSON.parse(await readFile(f.path(), 'utf8')) as RuntimeActivityRecord;
  assert.equal(retained.sequence, snapshot.cursor.sequence);
  assert.ok(retained.events.length <= 5);
});

test('wrong native/session/input/operation attribution is never assigned to this member or a neighboring input', async (t) => {
  const f = await setup(t);
  const owner = f.make();
  const a = await f.open(owner);
  const b = await f.open(owner, binding('TEST-B'));
  a.session.raw({
    ...a.attribution,
    sessionRef: b.session.sessionRef,
    kind: 'text',
    messageRef: 'wrong-session',
    block: 0,
    text: 'MUST-NOT-LEAK',
    phase: 'complete',
  });
  a.session.emit({ ...b.attribution, kind: 'usage', inputTokens: 999 });
  a.session.emit({
    inputId: a.attribution.inputId,
    operationRef: 'wrong-operation',
    kind: 'text',
    messageRef: 'wrong-operation',
    block: 0,
    text: 'MUST-NOT-LEAK',
    phase: 'complete',
  });
  a.session.emit({ kind: 'diagnostic', code: 'dependency-unavailable' });
  a.session.emit({ inputId: b.attribution.inputId, kind: 'diagnostic', code: 'unavailable' });
  await tick();
  const snapshot = owner.readActivitySnapshot(binding());
  assert.deepEqual(snapshot.latest.text, []);
  assert.deepEqual(snapshot.latest.usage, []);
  assert.equal(snapshot.gap?.reason, 'unattributed');
  const feed = owner.readActivityFeed(binding(), {
    ...snapshot.cursor,
    sequence: snapshot.retainedFrom - 1,
  });
  assert.ok(!JSON.stringify(feed).includes('MUST-NOT-LEAK'));
  assert.ok(
    feed.events.some((event) => event.data.kind === 'diagnostic' && event.inputId === undefined)
  );
  assert.ok(
    feed.events.some(
      (event) =>
        event.data.kind === 'diagnostic' &&
        event.data.code === 'unavailable' &&
        event.inputId === undefined &&
        event.operationRef === undefined
    )
  );
  assert.deepEqual(owner.readActivitySnapshot(binding('TEST-B')).latest.usage, []);
});

test('oversized/unsupported projection data cannot abort later permission and terminal/control persistence', async (t) => {
  const f = await setup(t);
  const owner = f.make();
  const { session, attribution } = await f.open(owner);
  session.emit({
    ...attribution,
    kind: 'text',
    messageRef: 'huge',
    block: 0,
    text: 'SECRET-large'.repeat(4000),
    phase: 'complete',
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  session.emit({
    ...attribution,
    kind: 'tool',
    messageRef: 'message',
    toolRef: 'tool',
    name: 'TEST-tool',
    input: cyclic,
  });
  let getterCalls = 0;
  const unsafePayload = {};
  Object.defineProperty(unsafePayload, 'payload', {
    enumerable: true,
    get() {
      getterCalls++;
      return 'MUST-NOT-LEAK';
    },
  });
  session.emit({
    ...attribution,
    kind: 'tool',
    messageRef: 'getter',
    toolRef: 'getter',
    name: 'TEST-getter',
    input: unsafePayload,
  });
  session.raw({
    ...attribution,
    sessionRef: session.sessionRef,
    kind: 'vendor-event',
    rawSecret: 'MUST-NOT-LEAK',
  } as unknown as Event);
  session.emit({
    ...attribution,
    kind: 'interaction',
    interactionRef: 'permission',
    request: { kind: 'permission', tool: 'TEST-tool', input: 'oversized'.repeat(4096) },
  });
  await tick();
  assert.equal(owner.readSession(binding()).record?.interactions[0]?.phase, 'pending');
  await owner.respondToInteraction(binding(), attribution.inputId, 'permission', {
    kind: 'permission',
    decision: 'deny',
  });
  session.emit({ ...attribution, kind: 'result', outcome: 'succeeded' });
  await tick();
  assert.equal(owner.readSession(binding()).record?.inputs[0]?.terminal, 'succeeded');
  const snapshot = owner.readActivitySnapshot(binding());
  assert.equal(snapshot.state?.interactions[0]?.phase, 'resolved');
  assert.equal(getterCalls, 0);
  assert.ok(!JSON.stringify(snapshot).includes('MUST-NOT-LEAK'));
  assert.equal(snapshot.gap?.reason, 'oversized');
  assert.ok(!JSON.stringify(snapshot).includes('SECRET-large'));
  assert.equal((await owner.stopCapturedSession(binding())).custody, 'released');
});

test('projection write failure exposes a gap while observer continues to durable terminal and later observations', async (t) => {
  const f = await setup(t);
  let fail = false;
  const events: RuntimeEventStorage = {
    activityLimits: f.store.activityLimits,
    readActivity: (target) => f.store.readActivity(target),
    writeActivity: (record) => {
      if (fail) throw new Error('TEST projection unavailable');
      f.store.writeActivity(record);
    },
  };
  const owner = f.make('host-1', { events });
  const { session, attribution } = await f.open(owner);
  const before = owner.readActivitySnapshot(binding());
  fail = true;
  session.emit({
    ...attribution,
    kind: 'text',
    messageRef: 'unpersisted',
    block: 0,
    text: 'lost projection',
    phase: 'complete',
  });
  session.emit({ ...attribution, kind: 'result', outcome: 'succeeded' });
  await tick();
  assert.equal(owner.readSession(binding()).record?.inputs[0]?.terminal, 'succeeded');
  const degraded = owner.readActivitySnapshot(binding());
  assert.equal(degraded.gap?.reason, 'storage');
  assert.ok(degraded.cursor.sequence > before.cursor.sequence);
  const restarted = f.make('host-2');
  assert.equal(restarted.readActivitySnapshot(binding()).gap?.reason, 'state-unpublished');
  fail = false;
  session.emit({ kind: 'diagnostic', code: 'unavailable' });
  await tick();
  const recovered = owner.readActivitySnapshot(binding());
  assert.ok(recovered.cursor.sequence > degraded.cursor.sequence);
  assert.equal(recovered.gap?.reason, 'storage');
  const feed = owner.readActivityFeed(binding(), degraded.cursor);
  assert.ok(feed.events.some((event) => event.data.kind === 'gap'));
  assert.ok(feed.events.some((event) => event.data.kind === 'diagnostic'));
  assert.equal(
    owner.readActivityFeed(binding(), recovered.cursor).gap,
    undefined,
    'a fresh snapshot cursor acknowledges historical gaps instead of looping rehydrate'
  );
});

for (const corruption of ['corrupt', 'digest', 'missing', 'symlink', 'oversize'] as const) {
  test(`projection ${corruption} is HOLD rather than a reset cursor and cannot stop terminal persistence`, async (t) => {
    const f = await setup(t, { activity: { maxBytes: 8192, maxEvents: 8, maxEventBytes: 2048 } });
    const owner = f.make();
    const { session, attribution } = await f.open(owner);
    const before = owner.readActivitySnapshot(binding());
    const path = f.path();
    if (corruption === 'corrupt') await writeFile(path, '{broken');
    if (corruption === 'digest') {
      const record = JSON.parse(await readFile(path, 'utf8')) as RuntimeActivityRecord;
      record.events[0]!.data = { kind: 'text', text: 'CORRUPT-PAYLOAD' };
      await writeFile(path, JSON.stringify(record));
    }
    if (corruption === 'missing') await rm(path);
    if (corruption === 'oversize') await writeFile(path, ' '.repeat(8193));
    if (corruption === 'symlink') {
      const external = join(f.root, 'TEST-external');
      await rename(path, external);
      await symlink(external, path);
    }
    assert.throws(
      () => owner.readActivitySnapshot(binding()),
      (error) => error instanceof RuntimeOwnerError && error.code === 'hold'
    );
    session.emit({ ...attribution, kind: 'result', outcome: 'succeeded' });
    await tick();
    assert.equal(owner.readSession(binding()).record?.inputs[0]?.terminal, 'succeeded');
    assert.ok(
      (owner.readSession(binding()).record?.activitySequence ?? 0) > before.cursor.sequence
    );
    if (corruption === 'missing') {
      const recovered = owner.readActivitySnapshot(binding());
      assert.equal(recovered.gap?.reason, 'storage');
      assert.ok(recovered.cursor.sequence > before.cursor.sequence);
    }
  });
}

test('current read grant gates snapshots/replay and a consumer without event storage stays explicitly unsupported', async (t) => {
  const f = await setup(t);
  let granted = true;
  const owner = f.make('host-1', { authorize: () => granted });
  const { session, attribution } = await f.open(owner);
  const snapshot = owner.readActivitySnapshot(binding());
  granted = false;
  assert.throws(
    () => owner.readActivitySnapshot(binding()),
    (error) => error instanceof RuntimeOwnerError && error.code === 'forbidden'
  );
  assert.throws(
    () => owner.readActivityFeed(binding(), snapshot.cursor),
    (error) => error instanceof RuntimeOwnerError && error.code === 'forbidden'
  );
  session.emit({ ...attribution, kind: 'result', outcome: 'succeeded' });
  await tick();
  granted = true;
  assert.equal(owner.readSession(binding()).record?.inputs[0]?.terminal, 'succeeded');
  const { events: ignored, ...options } = {
    store: f.store,
    events: f.store,
    hostIncarnation: 'host-2',
    profileId: 'TEST-profile',
    authorize: () => true,
    driverFactory: {
      open: async () => {
        throw new Error('TEST no allocation');
      },
    },
  };
  void ignored;
  const withoutEvents = new RuntimeOwner(options);
  assert.equal(withoutEvents.readActivitySnapshot(binding()).gap?.reason, 'unsupported');
});

test('bounded feed pages replay each retained event once and snapshot marks a truncated latest view', async (t) => {
  const f = await setup(t);
  const owner = f.make();
  const { session, attribution } = await f.open(owner);
  for (let index = 0; index < 70; index++)
    session.emit({
      ...attribution,
      kind: 'text',
      messageRef: `message-${index}`,
      block: 0,
      text: 'x'.repeat(4096),
      phase: 'complete',
    });
  await tick();
  const snapshot = owner.readActivitySnapshot(binding());
  assert.equal(snapshot.gap?.reason, 'retention');
  assert.ok(snapshot.latest.text.length < 70);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 1024 * 1024);
  let cursor = { ...snapshot.cursor, sequence: snapshot.retainedFrom - 1 },
    pages = 0;
  const ids = new Set<string>();
  let texts = 0;
  for (;;) {
    const page = owner.readActivityFeed(binding(), cursor);
    pages++;
    assert.ok(page.events.length <= 64);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 160 * 1024);
    assert.ok(page.cursor.sequence > cursor.sequence);
    for (const event of page.events) {
      assert.ok(!ids.has(event.eventId));
      ids.add(event.eventId);
      if (event.data.kind === 'text') texts++;
    }
    cursor = page.cursor;
    if (!page.hasMore) break;
  }
  assert.ok(pages > 1);
  assert.equal(texts, 70);
  assert.equal(cursor.sequence, snapshot.cursor.sequence);
});

test('open/checkpoint/control/seal/reconcile state mutations advance the same cursor without a second business log', async (t) => {
  const f = await setup(t);
  const owner = f.make('host-1', { checkpoints: f.store });
  const unopened = owner.readActivitySnapshot(binding());
  assert.equal(unopened.cursor.sequence, 0);
  const { session, attribution } = await f.open(owner);
  let snapshot = owner.readActivitySnapshot(binding());
  assert.ok(snapshot.cursor.sequence > unopened.cursor.sequence);
  session.emit({ ...attribution, kind: 'result', outcome: 'succeeded' });
  await tick();
  assert.equal(
    (await owner.captureCheckpoint({ binding: binding(), checkpointId: 'unsupported' })).status,
    'unsupported'
  );
  let next = owner.readActivitySnapshot(binding());
  assert.ok(next.cursor.sequence > snapshot.cursor.sequence);
  assert.equal(next.state?.checkpoints[0]?.status, 'unsupported');
  snapshot = next;
  await owner.stopCapturedSession(binding());
  next = owner.readActivitySnapshot(binding());
  assert.ok(next.cursor.sequence > snapshot.cursor.sequence);
  assert.equal(next.state?.sealed, true);
  assert.equal(next.state?.custody, 'released');
  const other = await f.open(owner, binding('TEST-B'));
  const before = owner.readActivitySnapshot(binding('TEST-B'));
  await owner.interrupt(binding('TEST-B'), other.attribution.inputId);
  const interrupted = owner.readActivityFeed(binding('TEST-B'), before.cursor);
  assert.ok(interrupted.events.length >= 2);
  const replaced = f.make('host-2');
  replaced.reconcileSession(binding('TEST-B'));
  const held = replaced.readActivitySnapshot(binding('TEST-B'));
  assert.ok(held.cursor.sequence > interrupted.cursor.sequence);
  assert.equal(held.state?.custody, 'unknown');
  assert.equal(held.state?.phase, 'held');
});

test('event namespace symlink is rejected without touching external files or blocking terminal facts', async (t) => {
  const f = await setup(t);
  const owner = f.make();
  const { session, attribution } = await f.open(owner);
  const directory = join(f.root, 'runtime-events'),
    external = join(f.root, 'TEST-external-events');
  await rename(directory, external);
  await writeFile(join(external, 'sentinel'), 'unchanged');
  await symlink(external, directory, 'dir');
  assert.throws(
    () => owner.readActivitySnapshot(binding()),
    (error) => error instanceof RuntimeOwnerError && error.code === 'hold'
  );
  session.emit({ ...attribution, kind: 'result', outcome: 'succeeded' });
  await tick();
  assert.equal(owner.readSession(binding()).record?.inputs[0]?.terminal, 'succeeded');
  assert.equal(await readFile(join(external, 'sentinel'), 'utf8'), 'unchanged');
});

test('enabling projections on an existing unprojected session preserves an explicit historical gap', async (t) => {
  const f = await setup(t);
  const legacy = new RuntimeOwner({
    store: f.store,
    hostIncarnation: 'old-host',
    profileId: 'TEST-profile',
    authorize: () => true,
    canDispatch: () => true,
    driverFactory: {
      open: async () => {
        const session = new ControlledSession('TEST-unprojected-native');
        f.sessions.push(session);
        return { driver: session, capabilities: ['tools'] };
      },
    },
  });
  await f.open(legacy);
  const owner = f.make('new-host');
  const before = owner.readActivitySnapshot(binding());
  assert.equal(before.cursor.sequence, 0);
  assert.equal(before.lastObservedAt, undefined);
  assert.equal(before.gap?.reason, 'retention');
  owner.reconcileSession(binding());
  const after = owner.readActivitySnapshot(binding());
  assert.ok(after.cursor.sequence > 0);
  assert.equal(after.gap?.reason, 'retention');
  assert.equal(after.state?.custody, 'unknown');
  assert.equal(f.sessions.length, 1);
  const feed = owner.readActivityFeed(binding(), after.cursor);
  assert.equal(feed.gap, undefined);
  assert.deepEqual(feed.events, []);
});

test('private child activity shares the original Runtime input/fence and snapshot without settling root control or accepting foreign provenance', async t => {
  const f = await setup(t), owner = f.make(), { session, attribution } = await f.open(owner);
  const before = owner.readActivitySnapshot(binding());
  const data = { kind: 'subagent' as const, childId: `child-${'a'.repeat(64)}`, parentToolRef: `tool-${'b'.repeat(64)}`, phase: 'completed' };
  owner.observeProviderActivity(binding(), session.sessionRef, { ...attribution, data });
  const snapshot = owner.readActivitySnapshot(binding());
  assert.equal(snapshot.latest.subagents.length, 1); assert.equal(snapshot.latest.subagents[0]?.inputId, attribution.inputId);
  assert.ok(snapshot.cursor.sequence > before.cursor.sequence); assert.equal(owner.readSession(binding()).record?.inputs[0]?.phase, 'consumed');
  assert.equal(owner.readSession(binding()).record?.interactions.length, 0);
  owner.observeProviderActivity(binding(), 'foreign-native', { ...attribution, data });
  assert.equal(owner.readActivitySnapshot(binding()).cursor.sequence, snapshot.cursor.sequence);
  owner.observeProviderActivity(binding(), session.sessionRef, { inputId: 'foreign-input', operationRef: 'foreign-operation', data });
  const feed = owner.readActivityFeed(binding(), snapshot.cursor); assert.ok(feed.events.some(event => event.data.kind === 'gap' && event.data.reason === 'unattributed'));
  await owner.stopCapturedSession(binding());
  const closed = owner.readActivitySnapshot(binding());
  owner.observeProviderActivity(binding(), session.sessionRef, { ...attribution, data });
  assert.equal(owner.readActivitySnapshot(binding()).cursor.sequence, closed.cursor.sequence, 'sealed parent cannot publish late child activity');
});
