import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { CredentialCommandOwner } from '../dist/management/CredentialCommandOwner.js';
import { ManagementResourceFence } from '../dist/management/ManagementResourceFence.js';
import { OAuthOperationOwner } from '../dist/management/OAuthOperationOwner.js';

import type { ManagementCommandStore, ManagementTarget } from '../src/management/commandRecords.ts';
import type { ProviderOAuthSnapshot } from '../src/management/contracts.ts';
import type { OAuthNativeConversation } from '../src/management/OAuthOperationOwner.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await new Promise<void>((done) => setImmediate(done));
  assert.ok(check(), 'the original operation reaches its expected durable state');
}
const initial = {
  operationId: 'TEST-oauth-one',
  profileId: 'TEST-profile',
  configRevision: 'TEST-config',
  providerId: 'TEST-provider',
  methodIndex: 0,
  fields: { 'TEST-client': 'TEST-private-field' },
};
const lookup = {
  operationId: initial.operationId,
  profileId: initial.profileId,
  configRevision: initial.configRevision,
};
const authorization = {
  authorizationUrl: 'https://TEST.invalid/login?state=TEST-private-state',
  instructions: 'TEST-private-instructions',
  completionMethod: 'code' as const,
};
type Authorization = Awaited<ReturnType<OAuthNativeConversation['authorize']>>;
function fixture(
  options: {
    timeoutMs?: number;
    closeFails?: boolean;
    blockClose?: boolean;
    store?: (base: ManagementCommandStore) => ManagementCommandStore;
  } = {}
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-management-oauth-')));
  const base = new FileManagementCommandStore(root);
  const store = options.store?.(base) ?? base;
  let target: ManagementTarget = {
    profileId: initial.profileId,
    configRevision: initial.configRevision,
    selectionDigest: 'a'.repeat(64),
    resourceId: 'b'.repeat(64),
  };
  let current = true,
    credentialWrites = 0;
  const events: ProviderOAuthSnapshot[] = [];
  const conversations: {
    authorize: ReturnType<typeof deferred<Authorization>>;
    complete: ReturnType<typeof deferred<boolean>>;
    close: ReturnType<typeof deferred<boolean>>;
    authorizeCalls: number;
    completeCalls: number;
    closeCalls: number;
    code: string | undefined;
  }[] = [];
  const fence = new ManagementResourceFence(store.list());
  const assertWriter = () => {
    if (!current) throw new Error('TEST writer revoked');
  };
  const select = (profileId: string, revision: string) => {
    assert.equal(profileId, target.profileId);
    assert.equal(revision, target.configRevision);
    return { ...target };
  };
  const prepare = (input: { operationId: string }) => {
    const native = {
      authorize: deferred<Authorization>(),
      complete: deferred<boolean>(),
      close: deferred<boolean>(),
      authorizeCalls: 0,
      completeCalls: 0,
      closeCalls: 0,
      code: undefined as string | undefined,
    };
    conversations.push(native);
    return {
      timeoutMs: options.timeoutMs ?? 30_000,
      async authorize() {
        assert.equal(base.read(input.operationId)?.phase, 'authorizing');
        native.authorizeCalls++;
        return native.authorize.promise;
      },
      async complete(code: string | undefined) {
        assert.equal(base.read(input.operationId)?.phase, 'completing');
        native.code = code;
        native.completeCalls++;
        return native.complete.promise;
      },
      async close() {
        native.closeCalls++;
        return options.blockClose ? native.close.promise : !options.closeFails;
      },
    };
  };
  const owner = new OAuthOperationOwner({
    store,
    fence,
    assertWriter,
    select,
    prepare,
    onProgress: (event) => events.push(structuredClone(event)),
  });
  const credentials = new CredentialCommandOwner({
    store,
    fence,
    assertCurrent: assertWriter,
    select,
    perform: async () => {
      credentialWrites++;
      return { ok: true, settled: true };
    },
  });
  const extraOwners: OAuthOperationOwner[] = [];
  return {
    owner,
    credentials,
    base,
    store,
    events,
    conversations,
    countWrites: () => credentialWrites,
    revoke: () => {
      current = false;
    },
    changeTarget: () => {
      target = { ...target, selectionDigest: 'c'.repeat(64), resourceId: 'd'.repeat(64) };
    },
    restart() {
      current = false; // Simulate loss of the old exclusive writer before cold recovery.
      const recovered = new OAuthOperationOwner({
        store,
        fence: new ManagementResourceFence(store.list()),
        assertWriter() {},
        select,
        prepare,
        onProgress: (event) => events.push(structuredClone(event)),
      });
      extraOwners.push(recovered);
      return recovered;
    },
    serialized: () =>
      readdirSync(join(root, 'management-commands'))
        .map((name) => readFileSync(join(root, 'management-commands', name), 'utf8'))
        .join('\n'),
    async cleanup() {
      for (const native of conversations) native.close.resolve(true);
      await Promise.allSettled([owner, ...extraOwners].map((entry) => entry.close()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('code OAuth admits once, persists before callback, publishes safe ordered progress and never journals auth material', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  assert.equal(f.owner.start(initial).phase, 'authorizing');
  const native = f.conversations[0]!;
  assert.equal(native.authorizeCalls, 1);
  assert.equal(f.owner.start(initial).phase, 'authorizing');
  assert.equal(f.conversations.length, 1);
  assert.throws(() => f.owner.start({ ...initial, fields: { 'TEST-client': 'TEST-different' } }), {
    code: 'conflict',
  });
  native.authorize.resolve(authorization);
  await until(() => f.owner.read(lookup)?.phase === 'waiting-for-code');
  assert.deepEqual(f.owner.authorization(lookup), {
    authorizationUrl: new URL(authorization.authorizationUrl).href,
    instructions: authorization.instructions,
  });
  const complete = { ...lookup, commandId: 'TEST-code-submit', code: 'TEST-private-code' };
  assert.equal(f.owner.complete(complete).phase, 'completing');
  assert.equal(native.code, complete.code);
  assert.equal(f.owner.complete(complete).phase, 'completing');
  assert.equal(native.completeCalls, 1);
  assert.throws(() => f.owner.complete({ ...complete, code: 'TEST-different' }), {
    code: 'conflict',
  });
  native.complete.resolve(true);
  await until(() => f.owner.read(lookup)?.phase === 'completed');
  assert.equal(f.owner.start(initial).phase, 'completed');
  assert.equal(f.owner.authorization(lookup), null);
  assert.deepEqual(
    f.events.map((event) => event.phase),
    ['authorizing', 'waiting-for-code', 'completing', 'completed']
  );
  assert.deepEqual(
    f.events.map((event) => event.sequence),
    [1, 2, 3, 4]
  );
  const publicAndDurable = JSON.stringify(f.events) + f.serialized();
  for (const secret of [
    'TEST-private-code',
    'TEST-private-state',
    'TEST-private-field',
    'TEST-private-instructions',
    'authorizationUrl',
  ])
    assert.equal(publicAndDurable.includes(secret), false);
});

test('automatic OAuth has the same bound callback identity and rejects an injected authorization code', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.owner.start(initial);
  const native = f.conversations[0]!;
  native.authorize.resolve({ ...authorization, completionMethod: 'auto' });
  await until(() => f.owner.read(lookup)?.phase === 'waiting-for-browser');
  assert.throws(
    () => f.owner.complete({ ...lookup, commandId: 'TEST-auto', code: 'TEST-unexpected' }),
    { code: 'invalid' }
  );
  assert.equal(native.completeCalls, 0);
  f.owner.complete({ ...lookup, commandId: 'TEST-auto' });
  assert.equal(native.code, undefined);
  native.complete.resolve(true);
  await until(() => f.owner.read(lookup)?.phase === 'completed');
});

test('cancel fences before cleanup, retains the namespace until confirmed stop and ignores late authorization after reconnect', async (t) => {
  const f = fixture({ blockClose: true });
  t.after(() => f.cleanup());
  f.owner.start(initial);
  const old = f.conversations[0]!;
  const cancelled = f.owner.cancel(lookup);
  assert.equal(f.owner.read(lookup)?.phase, 'cancelling');
  assert.throws(() => f.owner.start({ ...initial, operationId: 'TEST-replacement' }), {
    code: 'busy',
  });
  await until(() => old.closeCalls === 1);
  old.close.resolve(true);
  assert.equal((await cancelled).phase, 'cancelled');
  const replacement = { ...initial, operationId: 'TEST-replacement' };
  f.owner.start(replacement);
  old.authorize.resolve(authorization);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(f.owner.authorization(lookup), null);
  assert.equal(
    f.owner.read({ ...lookup, operationId: replacement.operationId })?.phase,
    'authorizing'
  );
  assert.equal(
    f.events.filter((event) => event.operationId === initial.operationId).at(-1)?.phase,
    'cancelled'
  );
  await assert.rejects(
    f.credentials.execute({
      commandId: 'TEST-forget',
      profileId: initial.profileId,
      configRevision: initial.configRevision,
      providerId: initial.providerId,
      kind: 'credential.forget',
    }),
    { code: 'busy' }
  );
  f.conversations[1]!.close.resolve(true);
});

test('cancel during callback closes the original target and a late success cannot complete the next account flow', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.owner.start(initial);
  const old = f.conversations[0]!;
  old.authorize.resolve(authorization);
  await until(() => f.owner.read(lookup)?.phase === 'waiting-for-code');
  f.owner.complete({ ...lookup, commandId: 'TEST-code', code: 'TEST-code' });
  f.changeTarget();
  assert.equal((await f.owner.cancel(lookup)).phase, 'cancelled');
  assert.equal(old.closeCalls, 1);
  const next = { ...initial, operationId: 'TEST-other-account' };
  f.owner.start(next);
  old.complete.resolve(true);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(f.owner.read(lookup)?.phase, 'cancelled');
  assert.equal(f.owner.read({ ...lookup, operationId: next.operationId })?.phase, 'authorizing');
  assert.equal(
    f.events.some(
      (event) => event.operationId === initial.operationId && event.phase === 'completed'
    ),
    false
  );
});

test('cold recovery holds the original pending OAuth request and cannot repeat authorization or create a second writer', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.owner.start(initial);
  const recovered = f.restart();
  assert.equal(recovered.read(lookup)?.phase, 'held');
  assert.equal(recovered.start(initial).phase, 'held');
  assert.equal(recovered.authorization(lookup), null);
  assert.throws(() => recovered.start({ ...initial, operationId: 'TEST-new-id' }), {
    code: 'held',
  });
  assert.equal(f.conversations.length, 1);
});

test('unconfirmed OAuth writer cleanup remains held for credential mutations and shutdown', async (t) => {
  const f = fixture({ closeFails: true });
  t.after(() => f.cleanup());
  f.owner.start(initial);
  assert.equal((await f.owner.cancel(lookup)).phase, 'held');
  assert.equal(f.base.read(initial.operationId)?.resourceHeld, true);
  await assert.rejects(
    f.credentials.execute({
      commandId: 'TEST-forget',
      profileId: initial.profileId,
      configRevision: initial.configRevision,
      providerId: initial.providerId,
      kind: 'credential.forget',
    }),
    { code: 'held' }
  );
  assert.equal(f.countWrites(), 0);
  await assert.rejects(f.owner.close(), { code: 'held' });
});

test('completion admission loss stops the original flow without submitting a code', async (t) => {
  const f = fixture({
    store: (base) => ({
      read: (id) => base.read(id),
      list: () => base.list(),
      write(record) {
        if (record.phase === 'completing') throw new Error('TEST journal failure');
        base.write(record);
      },
    }),
  });
  t.after(() => f.cleanup());
  f.owner.start(initial);
  const native = f.conversations[0]!;
  native.authorize.resolve(authorization);
  await until(() => f.owner.read(lookup)?.phase === 'waiting-for-code');
  assert.throws(() =>
    f.owner.complete({ ...lookup, commandId: 'TEST-code', code: 'TEST-sensitive-code' })
  );
  await until(() => f.owner.read(lookup)?.phase === 'held');
  assert.equal(native.completeCalls, 0);
  assert.equal(native.closeCalls, 1);
  assert.equal(f.serialized().includes('TEST-sensitive-code'), false);
});

test('expiration cancels the captured flow and later authorization cannot restore it', async (t) => {
  const f = fixture({ timeoutMs: 25 });
  t.after(() => f.cleanup());
  f.owner.start(initial);
  await until(() => f.owner.read(lookup)?.phase === 'cancelled');
  assert.equal(f.owner.read(lookup)?.reason, 'expired');
  f.conversations[0]!.authorize.resolve(authorization);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(f.owner.authorization(lookup), null);
  assert.equal(f.conversations[0]!.closeCalls, 1);
});

test('revoked writer cannot publish late OAuth progress or overwrite its original claim', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.owner.start(initial);
  f.revoke();
  f.conversations[0]!.authorize.resolve(authorization);
  await until(() => f.conversations[0]!.closeCalls === 1);
  await new Promise<void>((done) => setImmediate(done));
  assert.deepEqual(
    f.events.map((event) => event.phase),
    ['authorizing']
  );
  assert.equal(f.base.read(initial.operationId)?.phase, 'authorizing');
});

test('failed initial publication never starts authorization or reserves a native writer indefinitely', async (t) => {
  const f = fixture({
    store: (base) => ({
      read: (id) => base.read(id),
      list: () => base.list(),
      write(record) {
        if (record.kind === 'oauth') throw new Error('TEST initial journal failure');
        base.write(record);
      },
    }),
  });
  t.after(() => f.cleanup());
  assert.throws(() => f.owner.start(initial));
  assert.equal(f.conversations[0]?.authorizeCalls, 0);
  assert.equal(f.base.read(initial.operationId), undefined);
  await f.credentials.execute({
    commandId: 'TEST-set',
    profileId: initial.profileId,
    configRevision: initial.configRevision,
    providerId: initial.providerId,
    kind: 'credential.set',
    key: 'TEST-key',
  });
  assert.equal(f.countWrites(), 1);
});

test('unsafe authorization URLs never leave the captured flow and cause confirmed cleanup', async (t) => {
  for (const url of ['file:///TEST-private', 'https://TEST-user:TEST-password@TEST.invalid/']) {
    const f = fixture();
    t.after(() => f.cleanup());
    f.owner.start(initial);
    f.conversations[0]!.authorize.resolve({ ...authorization, authorizationUrl: url });
    await until(() => f.owner.read(lookup)?.phase === 'held');
    assert.equal(f.owner.authorization(lookup), null);
    assert.equal(f.conversations[0]!.closeCalls, 1);
    assert.equal(JSON.stringify(f.events).includes(url), false);
  }
});

test('orderly shutdown cancels the owned pending flow durably and cold recovery permits a separate new intent', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.owner.start(initial);
  await f.owner.close();
  assert.equal(f.base.read(initial.operationId)?.phase, 'cancelled');
  assert.equal(f.base.read(initial.operationId)?.resourceHeld, false);
  const recovered = f.restart();
  assert.equal(recovered.start(initial).phase, 'cancelled');
  assert.equal(f.conversations.length, 1);
  assert.equal(
    recovered.start({ ...initial, operationId: 'TEST-new-after-shutdown' }).phase,
    'authorizing'
  );
  f.conversations[0]!.authorize.resolve(authorization);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(recovered.read(lookup)?.phase, 'cancelled');
  assert.equal(f.conversations[0]!.closeCalls, 1);
});
