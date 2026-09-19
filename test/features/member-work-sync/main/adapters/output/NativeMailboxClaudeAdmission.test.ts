import { mkdir, writeFile } from 'fs/promises';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { NativeMailboxMemberWorkSyncRuntimeTicketAdmission } from '@features/member-work-sync/main/adapters/output/NativeMailboxMemberWorkSyncRuntimeTicketAdmission';
import { encodeTeamMemberStorageKey } from '@main/services/team/TeamMemberStoragePaths';

async function writeCapability(
  root: string,
  providerId: 'codex' | 'anthropic'
) {
  const memberRoot = join(
    root,
    'team-a',
    'members',
    encodeTeamMemberStorageKey('bob'),
    '.member-work-sync',
    'runtime-admission'
  );
  await mkdir(memberRoot, { recursive: true });
  await writeFile(
    join(memberRoot, 'capability.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      recoveryProtocolVersion: 2,
      teamName: 'team-a',
      teamIncarnation: 'inc-1',
      memberName: 'bob',
      providerId,
      runtimeMode: providerId === 'codex' ? 'app-server' : 'repl',
      runtimeInstanceId: 'runtime-1',
      generation: 1,
      processorReady: true,
    })}\n`
  );
  return memberRoot;
}

describe('Claude native mailbox admission', () => {
  let root = '';

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns not_early for Claude when capability is missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'work-sync-claude-'));
    const admission = new NativeMailboxMemberWorkSyncRuntimeTicketAdmission({
      teamsBasePath: root,
      expectedProviderId: 'anthropic',
      ackTimeoutMs: 50,
    });
    await expect(
      admission.admit({
        teamName: 'team-a',
        memberName: 'bob',
        teamIncarnation: 'inc-1',
        intentId: 'intent-c1',
        admissionPayloadHash: 'hash-a',
        expectedGeneration: 1,
        controlRevision: 1,
      })
    ).resolves.toEqual({ admitted: false, code: 'not_early' });
  });

  it('does not treat a Codex capability as Claude admission', async () => {
    root = await mkdtemp(join(tmpdir(), 'work-sync-claude-'));
    await writeCapability(root, 'codex');
    const admission = new NativeMailboxMemberWorkSyncRuntimeTicketAdmission({
      teamsBasePath: root,
      expectedProviderId: 'anthropic',
      ackTimeoutMs: 50,
    });
    await expect(
      admission.admit({
        teamName: 'team-a',
        memberName: 'bob',
        teamIncarnation: 'inc-1',
        intentId: 'intent-c1',
        admissionPayloadHash: 'hash-a',
        expectedGeneration: 1,
        controlRevision: 1,
        runtimeInstanceId: 'runtime-1',
      })
    ).resolves.toEqual({ admitted: false, code: 'not_early' });
  });

  it('admits Claude through the same mailbox reserve ACK path as Codex', async () => {
    root = await mkdtemp(join(tmpdir(), 'work-sync-claude-'));
    const memberRoot = await writeCapability(root, 'anthropic');
    const admission = new NativeMailboxMemberWorkSyncRuntimeTicketAdmission({
      teamsBasePath: root,
      expectedProviderId: 'anthropic',
      ackTimeoutMs: 400,
    });
    const pending = admission.admit({
      teamName: 'team-a',
      memberName: 'bob',
      teamIncarnation: 'inc-1',
      intentId: 'intent-c1',
      admissionPayloadHash: 'hash-a',
      expectedGeneration: 1,
      runtimeInstanceId: 'runtime-1',
      controlRevision: 1,
    });
    const commandsDir = join(memberRoot, 'runtime-1', 'commands');
    let commandName = '';
    for (let i = 0; i < 20; i += 1) {
      try {
        const { readdir, readFile } = await import('fs/promises');
        const names = await readdir(commandsDir);
        commandName = names.find((name) => name.endsWith('.json')) ?? '';
        if (commandName) {
          const command = JSON.parse(await readFile(join(commandsDir, commandName), 'utf8')) as {
            requestId: string;
            reservationNonce: string;
          };
          await mkdir(join(memberRoot, 'runtime-1', 'acks'), { recursive: true });
          await writeFile(
            join(memberRoot, 'runtime-1', 'acks', commandName),
            `${JSON.stringify({
              schemaVersion: 1,
              requestId: command.requestId,
              op: 'reserve',
              ok: true,
              code: 'reserved',
              intentId: 'intent-c1',
              reservationNonce: command.reservationNonce,
              runtimeInstanceId: 'runtime-1',
              generation: 1,
              controlRevision: 1,
              localAdmissionClosed: false,
            })}\n`
          );
          break;
        }
      } catch {
        // waiting for command publish
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await expect(pending).resolves.toMatchObject({
      admitted: true,
      ticket: { runtimeInstanceId: 'runtime-1', intentId: 'intent-c1' },
    });
  });
});
