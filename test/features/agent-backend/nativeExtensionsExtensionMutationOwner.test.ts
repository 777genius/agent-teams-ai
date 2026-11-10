import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { FileManagementCommandStore } from '../../../packages/legacy-agent-host/src/adapters/providers/FileManagementCommandStore';
import { ExtensionMutationOwner } from '../../../packages/legacy-agent-host/src/extensions/ExtensionMutationOwner';
import { ManagementResourceFence } from '../../../packages/legacy-agent-host/src/management/ManagementResourceFence';
import type {
  ManagementCommandStore,
  ManagementTarget,
  StoredManagementCommand,
} from '../../../packages/legacy-agent-host/src/management/commandRecords';

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const targetId = 'a'.repeat(64);
const target: ManagementTarget = {
  profileId: 'TEST-profile',
  configRevision: 'TEST-revision',
  selectionDigest: 'b'.repeat(64),
  resourceId: 'c'.repeat(64),
};
const command = {
  action: 'mcp.install',
  scope: 'global',
  serverName: 'TEST-server',
  installSpec: { type: 'http', url: 'https://TEST.invalid/mcp', transportType: 'http' },
  envValues: { TEST_TOKEN: 'TEST-journal-secret' },
  headers: [{ key: 'Authorization', value: 'Bearer TEST-header-secret' }],
};
const input = {
  profileId: target.profileId,
  configRevision: target.configRevision,
  targetId,
  panel: 'mcp',
  scope: 'global',
  commandId: 'TEST-original-command',
  command,
};
const query = {
  profileId: input.profileId,
  configRevision: input.configRevision,
  targetId,
  panel: 'mcp',
  scope: 'global',
  commandId: input.commandId,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-extension-command-store-')));
  roots.push(root);
  const store = new FileManagementCommandStore(root),
    result = deferred<{ ok: boolean; settled: boolean }>();
  let current = true;
  const perform = vi.fn(async () => {
    expect(store.read(input.commandId)).toMatchObject({
      phase: 'claimed',
      resourceHeld: true,
      kind: 'extension.mutation',
    });
    return result.promise;
  });
  const owner = (selected: ManagementCommandStore = store) =>
    new ExtensionMutationOwner({
      store: selected,
      fence: new ManagementResourceFence(selected.list()),
      assertCurrent: () => {
        if (!current) throw new Error('TEST owner revoked');
      },
      select: (choice) => {
        if (
          choice.profileId !== target.profileId ||
          choice.configRevision !== target.configRevision ||
          choice.targetId !== targetId
        )
          throw new Error('TEST foreign selection');
        return { ...target };
      },
      perform,
    });
  return {
    root,
    store,
    result,
    perform,
    owner: owner(),
    reopen: () => owner(new FileManagementCommandStore(root)),
    create: owner,
    revoke: () => {
      current = false;
    },
  };
}
it('durably admits before the first effect, never journals credentials, and replays only the original completed command', async () => {
  const f = fixture();
  const pending = f.owner.execute(input);
  expect(f.perform).toHaveBeenCalledTimes(1);
  expect(f.owner.lookup(query)).toMatchObject({ commandId: input.commandId, phase: 'held' });
  const path = join(
    f.root,
    'management-commands',
    readdirSync(join(f.root, 'management-commands'))[0]!
  );
  const saved = readFileSync(path, 'utf8');
  expect(saved).not.toContain('TEST-journal-secret');
  expect(saved).not.toContain('TEST-header-secret');
  expect(saved).not.toContain('TEST.invalid');
  f.result.resolve({ ok: true, settled: true });
  expect(await pending).toMatchObject({ phase: 'completed' });
  expect(await f.owner.execute(input)).toMatchObject({
    commandId: input.commandId,
    phase: 'completed',
  });
  expect(f.perform).toHaveBeenCalledTimes(1);
});
it('cold recovery finds the exact unresolved intent and cannot replace its command or dispatch again', async () => {
  const f = fixture();
  const first = f.owner.execute(input);
  const cold = f.reopen();
  expect(
    cold.pending({
      profileId: input.profileId,
      configRevision: input.configRevision,
      targetId,
      panel: 'mcp',
      scope: 'global',
      command,
    })
  ).toMatchObject({ commandId: input.commandId, phase: 'held' });
  expect(await cold.execute({ ...input, commandId: 'TEST-replacement-forbidden' })).toMatchObject({
    commandId: input.commandId,
    phase: 'held',
  });
  expect(f.perform).toHaveBeenCalledTimes(1);
  expect(f.store.read('TEST-replacement-forbidden')).toBeUndefined();
  f.result.resolve({ ok: false, settled: false });
  await first;
});
it('cannot change an original command payload, owner, target or explicit scope', async () => {
  const f = fixture();
  const first = f.owner.execute(input);
  await expect(
    f.owner.execute({ ...input, command: { ...command, scope: 'user' } })
  ).rejects.toThrow();
  await expect(f.owner.execute({ ...input, targetId: 'd'.repeat(64) })).rejects.toThrow();
  await expect(f.owner.execute({ ...input, configRevision: 'TEST-substituted' })).rejects.toThrow();
  expect(f.perform).toHaveBeenCalledTimes(1);
  f.result.resolve({ ok: false, settled: true });
  await first;
});
it('late success after original authority revocation cannot overwrite the durable held claim', async () => {
  const f = fixture();
  const first = f.owner.execute(input);
  f.revoke();
  f.result.resolve({ ok: true, settled: true });
  expect(await first).toMatchObject({ commandId: input.commandId, phase: 'held' });
  expect(new FileManagementCommandStore(f.root).read(input.commandId)).toMatchObject({
    phase: 'claimed',
    resourceHeld: true,
  });
  expect(f.perform).toHaveBeenCalledTimes(1);
});
it('a lost final publication retains the original released-but-unconfirmed intent without retrying it', async () => {
  const f = fixture();
  const store: ManagementCommandStore = {
    read: (id) => f.store.read(id),
    list: () => f.store.list(),
    write(row: StoredManagementCommand) {
      if (row.kind === 'extension.mutation' && row.phase === 'completed')
        throw new Error('TEST lost final acknowledgement');
      f.store.write(row);
    },
  };
  const owner = f.create(store);
  const first = owner.execute(input);
  f.result.resolve({ ok: true, settled: true });
  expect(await first).toMatchObject({ phase: 'held' });
  const cold = f.reopen();
  expect(await cold.execute({ ...input, commandId: 'TEST-never-retry' })).toMatchObject({
    commandId: input.commandId,
    phase: 'held',
  });
  expect(f.perform).toHaveBeenCalledTimes(1);
  expect(f.store.read('TEST-never-retry')).toBeUndefined();
});

it('a known failed exit admits only an explicit new request, while UNKNOWN blocks changed replacement intent', async () => {
  const f = fixture();
  const known = new ExtensionMutationOwner({
    store: f.store,
    assertCurrent: () => {},
    select: () => target,
    perform: async () => ({ ok: false, settled: true, completed: true }),
  });
  expect(await known.execute(input)).toMatchObject({ phase: 'failed' });
  expect(await known.execute({ ...input, commandId: 'TEST-explicit-retry' })).toMatchObject({
    phase: 'failed',
  });
  expect([...f.store.list()]).toHaveLength(2);
  const g = fixture();
  const first = g.owner.execute(input);
  g.result.resolve({ ok: false, settled: true });
  await first;
  await expect(
    g
      .reopen()
      .execute({
        ...input,
        commandId: 'TEST-changed-replacement',
        command: { ...command, serverName: 'TEST-other-server' },
      })
  ).rejects.toThrow();
  expect(g.store.read('TEST-changed-replacement')).toBeUndefined();
  expect(g.perform).toHaveBeenCalledOnce();
});
