// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFilesystemTeamOwner } from '@agent-teams/legacy-agent-host/team/filesystem';
import { expect, it, vi } from 'vitest';

import { projectTeamSnapshot } from '../../../src/features/agent-backend/main/adapters/output/projectTeamSnapshot';
import { readHostPagedSnapshot } from '../../../src/features/agent-backend/renderer/readHostPagedSnapshot';
import { TeamProductReadOrder } from '../../../src/features/agent-backend/renderer/TeamProductReadOrder';

import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendConnectionSnapshot } from '../../../src/features/agent-backend/contracts/connections';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-large-message-')));
  const owner = createFilesystemTeamOwner({
    root,
    binding: { backendId: 'TEST-A', teamId: 'TEST-team', teamName: 'test-team' },
    members: [{ memberId: 'alice', name: 'alice', role: 'member' }],
    grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'admin'] }],
  });
  const inbox = join(root, 'teams/test-team/inboxes/user.json');
  mkdirSync(join(root, 'teams/test-team/inboxes'), { recursive: true });
  const message = {
    messageId: 'TEST-large-message',
    from: 'alice',
    timestamp: '2026-01-01T00:00:00.000Z',
    read: false,
    text: '漢'.repeat(140_000),
  };
  writeFileSync(inbox, JSON.stringify([message]));
  const reader = owner.connect('human');
  const connection = { handle: { handleId: 'TEST-Host' } } as BackendConnectionSnapshot['bindings'][number];
  let reads = 0;
  const backend = {
    invoke: vi.fn(async (request: { payload: { cursor?: string } }) => {
      const page = reader.readSnapshot(request.payload.cursor ? { cursor: request.payload.cursor } : {});
      reads++;
      return { ok: true, value: projectTeamSnapshot(page) };
    }),
  } as unknown as Pick<AgentBackendApi, 'invoke'>;
  return { root, reader, inbox, message, connection, backend, calls: () => reads };
}

it('projects all valid Host message parts and publishes only the complete Unicode text', async () => {
  const f = fixture();
  try {
    const result = await readHostPagedSnapshot(
      f.backend, f.connection, () => true, new TeamProductReadOrder()
    );
    result.assertCurrent();
    expect(f.calls()).toBeGreaterThan(1);
    expect(result.data.messages).toHaveLength(1);
    expect(result.data.messages[0]?.text).toBe(f.message.text);
    expect(result.data.messages[0]?.messageId).toBe(f.message.messageId);
    expect(result.data.messageParts).toBeUndefined();
    expect(result.data.messageTotal).toBeUndefined();
    expect(result.data.nextCursor).toBeUndefined();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

it('does not publish a mixed-revision message after canonical history changes between pages', async () => {
  const f = fixture();
  try {
    const originalInvoke = f.backend.invoke;
    let count = 0;
    f.backend.invoke = vi.fn<AgentBackendApi['invoke']>(async (request) => {
      // Count attempted continuations, including Owner refusals on a stale revision.
      const attempt = ++count;
      const result = await originalInvoke(request);
      if (attempt === 1) {
        writeFileSync(f.inbox, JSON.stringify([
          { ...f.message, text: f.message.text + 'changed' },
        ]));
      }
      return result;
    });
    await expect(readHostPagedSnapshot(
      f.backend, f.connection, () => true, new TeamProductReadOrder()
    )).rejects.toThrow();
    expect(count).toBeGreaterThan(1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
