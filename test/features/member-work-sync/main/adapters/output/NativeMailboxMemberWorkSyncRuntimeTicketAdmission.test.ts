import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { NativeMailboxMemberWorkSyncRuntimeTicketAdmission } from '@features/member-work-sync/main/adapters/output/NativeMailboxMemberWorkSyncRuntimeTicketAdmission';
import { encodeTeamMemberStorageKey } from '@main/services/team/TeamMemberStoragePaths';

describe('NativeMailboxMemberWorkSyncRuntimeTicketAdmission', () => {
  let root = '';

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns not_early when capability is missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'work-sync-native-'));
    const admission = new NativeMailboxMemberWorkSyncRuntimeTicketAdmission({
      teamsBasePath: root,
      expectedProviderId: 'codex',
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

  it('admits after a reserved ACK and cancels with the same nonce', async () => {
    root = await mkdtemp(join(tmpdir(), 'work-sync-native-'));
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
        providerId: 'codex',
        runtimeMode: 'app-server',
        runtimeInstanceId: 'runtime-1',
        generation: 1,
        processorReady: true,
      })}\n`
    );
    const admission = new NativeMailboxMemberWorkSyncRuntimeTicketAdmission({
      teamsBasePath: root,
      expectedProviderId: 'codex',
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
        const { readdir } = await import('fs/promises');
        const names = await readdir(commandsDir);
        commandName = names.find((name) => name.endsWith('.json')) ?? '';
        if (commandName) break;
      } catch {
        // waiting for command publish
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(commandName).toBeTruthy();
    const command = JSON.parse(
      await (await import('fs/promises')).readFile(join(commandsDir, commandName), 'utf8')
    ) as { requestId: string; reservationNonce: string };
    await mkdir(join(memberRoot, 'runtime-1', 'acks'), { recursive: true });
    await writeFile(
      join(memberRoot, 'runtime-1', 'acks', `${command.requestId}.json`),
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
    await expect(pending).resolves.toMatchObject({
      admitted: true,
      ticket: {
        ticketId: command.reservationNonce,
        runtimeInstanceId: 'runtime-1',
        intentId: 'intent-c1',
      },
    });
  });

  it('handshakes with the caller incarnation instead of unspecified capability', async () => {
    root = await mkdtemp(join(tmpdir(), 'work-sync-native-'));
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
        teamIncarnation: 'unspecified',
        memberName: 'bob',
        providerId: 'codex',
        runtimeMode: 'app-server',
        runtimeInstanceId: 'runtime-1',
        generation: 1,
        processorReady: true,
      })}\n`
    );
    const admission = new NativeMailboxMemberWorkSyncRuntimeTicketAdmission({
      teamsBasePath: root,
      expectedProviderId: 'codex',
      ackTimeoutMs: 400,
    });
    const pending = admission.syncControl({
      teamName: 'team-a',
      memberName: 'bob',
      teamIncarnation: 'inc-live',
      runtimeInstanceId: 'runtime-1',
      controlRevision: 1,
      stopped: false,
    });
    const commandsDir = join(memberRoot, 'runtime-1', 'commands');
    let commandName = '';
    for (let i = 0; i < 20; i += 1) {
      try {
        const { readdir } = await import('fs/promises');
        const names = await readdir(commandsDir);
        commandName = names.find((name) => name.endsWith('.json')) ?? '';
        if (commandName) break;
      } catch {
        // waiting for command publish
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(commandName).toBeTruthy();
    const command = JSON.parse(
      await (await import('fs/promises')).readFile(join(commandsDir, commandName), 'utf8')
    ) as {
      requestId: string;
      op: string;
      scope: { teamIncarnation: string };
    };
    expect(command.op).toBe('sync_control');
    expect(command.scope.teamIncarnation).toBe('inc-live');
    await mkdir(join(memberRoot, 'runtime-1', 'acks'), { recursive: true });
    await writeFile(
      join(memberRoot, 'runtime-1', 'acks', `${command.requestId}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        requestId: command.requestId,
        op: 'sync_control',
        ok: true,
        code: 'open',
        runtimeInstanceId: 'runtime-1',
        generation: 1,
        controlRevision: 1,
        localAdmissionClosed: false,
      })}\n`
    );
    await expect(pending).resolves.toEqual({
      ok: true,
      code: 'open',
      controlRevision: 1,
    });
  });

  it('cancels the same nonce when reserve ACK times out', async () => {
    root = await mkdtemp(join(tmpdir(), 'work-sync-native-'));
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
        providerId: 'codex',
        runtimeMode: 'app-server',
        runtimeInstanceId: 'runtime-1',
        generation: 1,
        processorReady: true,
      })}\n`
    );
    const admission = new NativeMailboxMemberWorkSyncRuntimeTicketAdmission({
      teamsBasePath: root,
      expectedProviderId: 'codex',
      ackTimeoutMs: 40,
    });
    await expect(
      admission.admit({
        teamName: 'team-a',
        memberName: 'bob',
        teamIncarnation: 'inc-1',
        intentId: 'intent-c1',
        admissionPayloadHash: 'hash-a',
        expectedGeneration: 1,
        runtimeInstanceId: 'runtime-1',
        controlRevision: 1,
      })
    ).resolves.toEqual({ admitted: false, code: 'unknown' });
    const { readdir, readFile } = await import('fs/promises');
    const commandsDir = join(memberRoot, 'runtime-1', 'commands');
    const names = await readdir(commandsDir);
    const commands = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => JSON.parse(await readFile(join(commandsDir, name), 'utf8')) as {
          op: string;
          reservationNonce?: string;
        })
    );
    const reserve = commands.find((command) => command.op === 'reserve');
    const cancel = commands.find((command) => command.op === 'cancel');
    expect(reserve?.reservationNonce).toBeTruthy();
    expect(cancel?.reservationNonce).toBe(reserve?.reservationNonce);
  });

  it('refuses reserve against a different runtime instance', async () => {
    root = await mkdtemp(join(tmpdir(), 'work-sync-native-'));
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
        providerId: 'codex',
        runtimeMode: 'app-server',
        runtimeInstanceId: 'runtime-new',
        generation: 1,
        processorReady: true,
      })}\n`
    );
    const admission = new NativeMailboxMemberWorkSyncRuntimeTicketAdmission({
      teamsBasePath: root,
      expectedProviderId: 'codex',
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
        runtimeInstanceId: 'runtime-old',
        controlRevision: 1,
      })
    ).resolves.toEqual({ admitted: false, code: 'instance_mismatch' });
  });
});
