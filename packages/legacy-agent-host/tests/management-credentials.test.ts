import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { CredentialCommandOwner } from '../dist/management/CredentialCommandOwner.js';
import type {
  CredentialCommand,
  CredentialCommandStore,
  CredentialTarget,
} from '../src/management/CredentialCommandOwner.ts';

const command: CredentialCommand = {
  commandId: 'TEST-set',
  profileId: 'TEST-profile',
  configRevision: 'TEST-config',
  providerId: 'TEST-provider',
  kind: 'credential.set',
  key: 'TEST-private-credential',
  metadata: { 'TEST-field': 'TEST-private-metadata' },
};
const target: CredentialTarget = {
  profileId: command.profileId,
  configRevision: command.configRevision,
  selectionDigest: 'a'.repeat(64),
  resourceId: 'b'.repeat(64),
};
const lookup = {
  commandId: command.commandId,
  profileId: command.profileId,
  configRevision: command.configRevision,
};
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-management-credentials-')));
  const store = new FileManagementCommandStore(root);
  let current = true,
    selected = { ...target },
    calls = 0;
  let effect: () => Promise<{ ok: boolean; settled: boolean }> = async () => ({
    ok: true,
    settled: true,
  });
  function owner(storage: CredentialCommandStore = store) {
    return new CredentialCommandOwner({
      store: storage,
      assertCurrent() {
        if (!current) throw new Error('TEST revoked writer');
      },
      select(profileId, configRevision) {
        assert.equal(profileId, selected.profileId);
        assert.equal(configRevision, selected.configRevision);
        return { ...selected };
      },
      async perform(input) {
        calls++;
        assert.equal(
          store.read(input.commandId)?.phase,
          'claimed',
          'native effects follow durable admission'
        );
        return effect();
      },
    });
  }
  return {
    root,
    store,
    owner,
    count: () => calls,
    setEffect: (next: typeof effect) => {
      effect = next;
    },
    revoke: () => {
      current = false;
    },
    changeSelection: () => {
      selected = { ...selected, selectionDigest: 'c'.repeat(64) };
    },
    files: () =>
      readdirSync(join(root, 'management-commands')).map((name) =>
        join(root, 'management-commands', name)
      ),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('credential mutation persists before native action and replay/restart returns the receipt without secrets or redispatch', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const first = await f.owner().execute(command);
  assert.equal(first.phase, 'completed');
  const resumed = f.owner();
  assert.deepEqual(await resumed.execute(command), first);
  assert.deepEqual(resumed.lookup(lookup), first);
  assert.equal(f.count(), 1);
  await assert.rejects(resumed.execute({ ...command, key: 'TEST-different' }), {
    code: 'conflict',
  });
  assert.equal(f.count(), 1);
  const serialized = f
    .files()
    .map((path) => {
      assert.equal(statSync(path).mode & 0o077, 0);
      return readFileSync(path, 'utf8');
    })
    .join('\n');
  for (const value of [command.key, 'TEST-private-metadata']) {
    assert.equal(serialized.includes(value), false);
    assert.equal(JSON.stringify(first).includes(value), false);
  }
  assert.deepEqual(
    Object.keys(first).sort(),
    ['commandId', 'profileId', 'configRevision', 'providerId', 'kind', 'phase'].sort()
  );
  f.changeSelection();
  await assert.rejects(resumed.execute(command), { code: 'conflict' });
  assert.throws(() => resumed.lookup(lookup), { code: 'conflict' });
});

test('one credential namespace serializes native writers; uncertain writer blocks new IDs after restart', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  let finish!: (result: { ok: boolean; settled: boolean }) => void;
  f.setEffect(
    () =>
      new Promise((done) => {
        finish = done;
      })
  );
  const owner = f.owner(),
    pending = owner.execute(command);
  assert.equal(f.count(), 1);
  const next = { ...command, commandId: 'TEST-next' };
  await assert.rejects(owner.execute(next), { code: 'busy' });
  assert.equal((await owner.execute(command)).phase, 'held');
  assert.equal(f.count(), 1);
  finish({ ok: false, settled: false });
  assert.equal((await pending).phase, 'held');
  const restarted = f.owner();
  assert.equal((await restarted.execute(command)).phase, 'held');
  await assert.rejects(restarted.execute(next), { code: 'held' });
  assert.equal(f.count(), 1);
});

test('publication loss never resubmits a completed native effect; a confirmed settled writer permits a separate later intent', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const failing: CredentialCommandStore = {
    read: (id) => f.store.read(id),
    list: () => f.store.list(),
    write(record) {
      if (record.phase === 'completed') throw new Error('TEST final publication loss');
      f.store.write(record);
    },
  };
  const receipt = await f.owner(failing).execute(command);
  assert.equal(receipt.phase, 'held');
  const restarted = f.owner();
  assert.deepEqual(await restarted.execute(command), receipt);
  assert.equal(f.count(), 1);
  assert.equal(f.store.read(command.commandId)?.resourceHeld, false);
  const forgotten = await restarted.execute({
    commandId: 'TEST-forget',
    profileId: command.profileId,
    configRevision: command.configRevision,
    providerId: command.providerId,
    kind: 'credential.forget',
  });
  assert.equal(forgotten.phase, 'completed');
  assert.equal(f.count(), 2);
});

test('late native reply after writer revocation does not publish over the retained claim', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.setEffect(async () => {
    f.revoke();
    return { ok: true, settled: true };
  });
  assert.equal((await f.owner().execute(command)).phase, 'held');
  assert.equal(f.store.read(command.commandId)?.phase, 'claimed');
  assert.equal(f.store.read(command.commandId)?.resourceHeld, true);
});

test('corrupt, public or symlinked credential receipts refuse recovery without resetting state', async (t) => {
  for (const fault of ['corrupt', 'mode', 'symlink', 'directory'] as const) {
    const f = fixture();
    t.after(f.cleanup);
    await f.owner().execute(command);
    const path = f.files()[0]!;
    if (fault === 'corrupt')
      writeFileSync(path, readFileSync(path, 'utf8').replace('"completed"', '"held"'), {
        mode: 0o600,
      });
    if (fault === 'mode') chmodSync(path, 0o644);
    if (fault === 'symlink') {
      const other = join(f.root, 'TEST-other');
      renameSync(path, other);
      symlinkSync(other, path);
    }
    if (fault === 'directory') {
      renameSync(join(f.root, 'management-commands'), join(f.root, 'TEST-moved'));
      mkdirSync(join(f.root, 'management-commands'), { mode: 0o700 });
    }
    assert.throws(() => f.owner());
    assert.equal(f.count(), 1);
  }
});

test('credential refresh is admitted once and a changed original selection cannot publish success', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const refresh: CredentialCommand = { ...lookup, providerId: 'codex', kind: 'credential.refresh' };
  const owner = f.owner();
  f.setEffect(async () => {
    f.changeSelection();
    return { ok: true, settled: true };
  });
  assert.equal((await owner.execute(refresh)).phase, 'held');
  assert.equal(f.count(), 1);
  await assert.rejects(owner.execute(refresh), /Provider management command conflict/);
  assert.equal(f.count(), 1, 'unknown original mutation is not resent with the changed binding');
});

test('unsupported credential actions reject before a journal claim or a native call', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const owner = new CredentialCommandOwner({
    store: f.store,
    select: () => target,
    assertCurrent() {},
    validate() {
      throw new Error('TEST unsupported before admission');
    },
    async perform() {
      assert.fail('no native effect');
    },
  });
  await assert.rejects(
    owner.execute({ ...lookup, providerId: 'codex', kind: 'credential.refresh' }),
    /unsupported before admission/
  );
  assert.equal(f.store.read(lookup.commandId), undefined);
});


test('refresh reuse is durable across aliases/restarts, never extends rotation age, and logout or a different namespace cannot reuse it', async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  let effects = 0;
  const owner = () => new CredentialCommandOwner({
    store: f.store,
    assertCurrent() {},
    select(profileId, configRevision) {
      return { ...target, profileId, configRevision,
        resourceId: profileId === 'TEST-independent' ? 'd'.repeat(64) : target.resourceId };
    },
    async perform() {
      effects++;
      return { ok: true, settled: true };
    },
  });
  const refresh = (profileId: string, commandId: string) => ({
    profileId, configRevision: 'TEST-config', commandId, providerId: 'codex',
    kind: 'credential.refresh' as const, reuseWindowMs: 30_000,
  });
  assert.equal((await owner().execute(refresh('TEST-A', 'TEST-first'))).phase, 'completed');
  t.mock.timers.tick(10_000);
  const aliased = refresh('TEST-B', 'TEST-alias');
  assert.equal((await owner().execute(aliased)).phase, 'completed');
  assert.equal(effects, 1, 'same native namespace reuses the original rotation after Host restart');
  assert.equal(f.store.read('TEST-alias')?.profileId, 'TEST-B', 'receipt retains its own selection');
  t.mock.timers.setTime(90_000);
  await owner().execute(refresh('TEST-B', 'TEST-clock-rollback'));
  assert.equal(effects, 1, 'wall-clock rollback must not force an immediate second rotation');
  t.mock.timers.setTime(131_000);
  await owner().execute(refresh('TEST-A', 'TEST-expired'));
  assert.equal(effects, 2, 'a reused receipt must not extend the original rotation window');
  await owner().execute({ profileId: 'TEST-B', configRevision: 'TEST-config',
    commandId: 'TEST-logout', providerId: 'codex', kind: 'credential.forget' });
  await owner().execute(refresh('TEST-A', 'TEST-after-logout'));
  assert.equal(effects, 4, 'logout through an alias invalidates all same-namespace reuse');
  await owner().execute(refresh('TEST-independent', 'TEST-other-namespace'));
  assert.equal(effects, 5);
});
