// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CapturedRosterCommands } from '@features/agent-backend/main/infrastructure/CapturedRosterCommands';
import { ApplicationCommandRunner } from '@features/application-command-ledger';
import {
  InternalStorageApplicationCommandLedgerStore,
  NodeApplicationCommandHasher,
} from '@features/application-command-ledger/main';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import Database from 'better-sqlite3-node';
import { afterEach, expect, it, vi } from 'vitest';

import { InProcessGateway } from '../internal-storage/helpers/InProcessGateway';

import type {
  BackendOperationRequest,
  BackendOperationResult,
} from '@features/agent-backend/contracts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const replacement: BackendOperationRequest = {
  handle: { handleId: 'original-handle' },
  commandId: 'original-save',
  operation: 'team.roster.replace',
  payload: {
    expectedRevision: 'a'.repeat(64),
    members: [],
    savedSettings: { cwd: '/TEST/project', description: 'TEST edit' },
  },
};
const read: BackendOperationRequest = {
  handle: replacement.handle,
  commandId: 'read',
  operation: 'team.roster.read',
  payload: {},
};
const receipt = { commandId: replacement.commandId, revision: 'b'.repeat(64) };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'TEST-captured-roster-'));
  let core: InternalStorageWorkerCore;
  let ledger: InternalStorageApplicationCommandLedgerStore;
  let clock = Date.UTC(2026, 9, 27);
  const reopen = () => {
    core?.close();
    core = new InternalStorageWorkerCore({
      databasePath: join(root, 'app.db'),
      createDatabase: (file) => new Database(file),
    });
    ledger = new InternalStorageApplicationCommandLedgerStore(new InProcessGateway(core));
    return new ApplicationCommandRunner({
      ledger,
      hasher: new NodeApplicationCommandHasher(),
      clock: () => new Date((clock += 1000)),
    });
  };
  let runner = reopen();
  let lookup: BackendOperationResult = { ok: true, value: null };
  let loseResponse = true;
  const dispatch = vi.fn(
    async (request: BackendOperationRequest): Promise<BackendOperationResult> => {
      if (request.operation === 'team.roster.lookup') return structuredClone(lookup);
      if (request.operation === 'team.roster.replace') {
        if (loseResponse) throw new Error('TEST response lost');
        return { ok: true, value: receipt };
      }
      return { ok: true, value: { revision: 'b'.repeat(64), members: [], removedMembers: [] } };
    }
  );
  cleanups.push(() => {
    core.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    commands: () => new CapturedRosterCommands(() => runner),
    dispatch,
    lookup: (value: BackendOperationResult) => {
      lookup = value;
    },
    reply: () => {
      loseResponse = false;
    },
    reopen: () => {
      runner = reopen();
    },
    failBegin: () => {
      vi.spyOn(ledger, 'begin').mockRejectedValueOnce(new Error('TEST disk failed'));
    },
    failComplete: () => {
      vi.spyOn(ledger, 'markCompleted').mockRejectedValueOnce(new Error('TEST completion lost'));
    },
  };
}

it('retains unknown saves across Main reconstruction and never dispatches replacement IDs or same-ID retries', async () => {
  const f = fixture();
  await expect(f.commands().invoke(replacement, undefined, f.dispatch)).rejects.toMatchObject({
    code: 'hold',
  });
  f.reopen();
  await expect(
    f.commands().invoke(
      {
        ...replacement,
        payload: {
          expectedRevision: 'a'.repeat(64),
          members: [],
          savedSettings: { cwd: '/TEST/project', description: 'different' },
        },
      },
      undefined,
      f.dispatch
    )
  ).rejects.toMatchObject({ code: 'hold' });
  await expect(
    f.commands().invoke({ ...replacement, commandId: 'replacement-id' }, undefined, f.dispatch)
  ).rejects.toMatchObject({ code: 'hold' });
  await expect(f.commands().invoke(replacement, undefined, f.dispatch)).rejects.toMatchObject({
    code: 'hold',
  });
  await expect(f.commands().invoke(read, undefined, f.dispatch)).rejects.toMatchObject({
    code: 'hold',
  });
  expect(
    f.dispatch.mock.calls.filter(([request]) => request.operation === 'team.roster.replace')
  ).toHaveLength(1);
  expect(
    f.dispatch.mock.calls.filter(([request]) => request.operation === 'team.roster.read')
  ).toHaveLength(0);
});

it('reconciles only the original owner command and expected payload before allowing reopened hydration', async () => {
  const f = fixture();
  await expect(f.commands().invoke(replacement, undefined, f.dispatch)).rejects.toThrow();
  f.reopen();
  f.lookup({ ok: true, value: receipt });
  await expect(f.commands().invoke(read, undefined, f.dispatch)).resolves.toMatchObject({
    ok: true,
  });
  expect(f.dispatch).toHaveBeenCalledWith({
    handle: replacement.handle,
    commandId: replacement.commandId,
    operation: 'team.roster.lookup',
    payload: { expected: replacement.payload },
  });
  expect(
    f.dispatch.mock.calls.filter(([request]) => request.operation === 'team.roster.replace')
  ).toHaveLength(1);
});

it('requires current Host authority even for a completed Main replay', async () => {
  const f = fixture();
  f.reply();
  await expect(f.commands().invoke(replacement, undefined, f.dispatch)).resolves.toEqual({
    ok: true,
    value: receipt,
  });
  f.reopen();
  f.lookup({ ok: false, code: 'forbidden', outcome: 'not-dispatched' });
  await expect(f.commands().invoke(replacement, undefined, f.dispatch)).rejects.toThrow();
  expect(
    f.dispatch.mock.calls.filter(([request]) => request.operation === 'team.roster.replace')
  ).toHaveLength(1);
});

it('does not dispatch when intent persistence fails and recovers lost completion through lookup', async () => {
  const f = fixture();
  f.reply();
  f.failBegin();
  await expect(f.commands().invoke(replacement, undefined, f.dispatch)).rejects.toThrow();
  expect(f.dispatch).not.toHaveBeenCalled();
  f.failComplete();
  await expect(f.commands().invoke(replacement, undefined, f.dispatch)).rejects.toThrow();
  f.reopen();
  f.lookup({ ok: true, value: receipt });
  await expect(f.commands().invoke(read, undefined, f.dispatch)).resolves.toMatchObject({
    ok: true,
  });
  expect(
    f.dispatch.mock.calls.filter(([request]) => request.operation === 'team.roster.replace')
  ).toHaveLength(1);
});

it('does not disclose a late lookup after the captured actor is revoked', async () => {
  const f = fixture();
  await expect(f.commands().invoke(replacement, undefined, f.dispatch)).rejects.toThrow();
  let current = true;
  f.dispatch.mockImplementationOnce(async () => {
    current = false;
    return { ok: true, value: receipt };
  });
  await expect(
    f.commands().invoke(read, { isCurrent: () => current }, f.dispatch)
  ).rejects.toMatchObject({ code: 'forbidden' });
});

it('keeps reads available without the ledger but refuses roster mutations before dispatch', async () => {
  const commands = new CapturedRosterCommands(() => null);
  const dispatch = vi.fn(async (): Promise<BackendOperationResult> => ({ ok: true, value: null }));
  await expect(commands.invoke(read, undefined, dispatch)).resolves.toEqual({
    ok: true,
    value: null,
  });
  await expect(commands.invoke(replacement, undefined, dispatch)).rejects.toMatchObject({
    code: 'unavailable',
  });
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it('does not retain a typed pre-admission refusal as debt after reopen', async () => {
  const f = fixture();
  f.dispatch.mockResolvedValueOnce({ ok: false, code: 'conflict', outcome: 'rejected' });
  await expect(f.commands().invoke(replacement, undefined, f.dispatch)).resolves.toEqual({
    ok: false,
    code: 'conflict',
    outcome: 'rejected',
  });
  f.reopen();
  await expect(f.commands().invoke(read, undefined, f.dispatch)).resolves.toMatchObject({
    ok: true,
  });
  const next = { ...replacement, commandId: 'new-confirmed-intent' };
  f.dispatch.mockResolvedValueOnce({ ok: true, value: { ...receipt, commandId: next.commandId } });
  await expect(f.commands().invoke(next, undefined, f.dispatch)).resolves.toMatchObject({
    ok: true,
  });
  expect(
    f.dispatch.mock.calls.filter(([request]) => request.operation === 'team.roster.replace')
  ).toHaveLength(2);
  expect(
    f.dispatch.mock.calls.filter(([request]) => request.operation === 'team.roster.lookup')
  ).toHaveLength(0);
});
