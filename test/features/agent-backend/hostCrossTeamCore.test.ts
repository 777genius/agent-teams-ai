// @vitest-environment node
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { withFileLock } from '@main/services/team/fileLock';
import { createFilesystemTeamOwner } from '../../../packages/legacy-agent-host/src/adapters/team/createFilesystemTeamOwner';
import { CrossTeamOutbox } from '../../../packages/legacy-agent-host/src/cross-team/CrossTeamOutbox';
import { CascadeGuard } from '../../../packages/legacy-agent-host/src/cross-team/CascadeGuard';
import { createHostCrossTeamCoordinator } from '../../../packages/legacy-agent-host/src/cross-team/HostCrossTeamCoordinator';
import { digest } from '../../../packages/legacy-agent-host/src/team/identity';

import type {
  BackendCrossTeamSend,
  CapturedCrossTeamIdentity,
} from '../../../packages/legacy-agent-host/src/cross-team/contracts';
import type { CommandReceipt } from '../../../packages/legacy-agent-host/src/team/contracts';
import type { OwnerState } from '../../../packages/legacy-agent-host/src/team/ownerState';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-cross-team-')));
  roots.push(root);
  const names = ['alpha', 'beta', 'gamma'];
  const definitions = names.map((name) => {
    const binding = { backendId: 'TEST-host', teamId: name, teamName: name };
    return {
      root,
      binding,
      members: [
        {
          name: 'lead',
          memberId: 'lead',
          role: 'lead' as const,
          delivery: { ...binding, runId: `${name}-run`, generation: '1', memberId: 'lead' },
        },
      ],
      grants: [
        {
          principalId: 'human',
          memberName: 'user',
          permissions: ['read', 'message.write', 'admin'] as ('read' | 'message.write' | 'admin')[],
        },
        {
          principalId: 'lead-native',
          memberName: 'lead',
          permissions: ['read', 'message.write'] as ('read' | 'message.write')[],
        },
      ],
    };
  });
  let teams = new Map<string, ReturnType<typeof createFilesystemTeamOwner>>();
  const owners = () =>
    new Map(
      definitions.map((definition) => [
        definition.binding.teamName,
        createFilesystemTeamOwner({
          ...definition,
          crossTeamSourceAuthority(intent) {
            try {
              const commands = teams
                .get(intent.pair.source.teamId)!
                .crossTeamCommands(intent.pair.source.principalId);
              const original = commands.lookup(intent.commandId);
              if (!original || digest(original.intent) !== digest(intent)) return false;
              commands.assertCurrent(original);
              return true;
            } catch {
              return false;
            }
          },
        }),
      ])
    );
  teams = owners();
  let failOutbox = true;
  const outbox = new CrossTeamOutbox({
    filePath: (name) => join(root, 'teams', name, 'sent-cross-team.json'),
    withFileLock,
    async atomicWrite(path, text, options) {
      if (failOutbox) {
        failOutbox = false;
        throw new Error('TEST source outbox publication failed after target effect');
      }
      await atomicWriteAsync(path, text, options);
    },
  });
  const request: BackendCrossTeamSend = {
    target: { handleId: 'beta' },
    fromMember: 'user',
    text: 'TEST original message',
    messageId: 'TEST-message',
    conversationId: 'TEST-conversation',
  };
  const coordinator = () =>
    createHostCrossTeamCoordinator({
      commands: teams.get('alpha')!.crossTeamCommands('human'),
      outbox,
      cascade: new CascadeGuard(),
      appendSenderCopy(intent) {
        const commands = teams.get('alpha')!.crossTeamCommands('human');
        commands.appendSenderCopy(commands.lookup(intent.commandId)!);
      },
      assertCurrent() {},
      captureOriginal(input): CapturedCrossTeamIdentity {
      if (!('handleId' in input.target)) throw new Error('TEST fixture requires its captured Desktop handle');
        return {
          ownerId: 'TEST-host',
          ownerRevision: '1',
          ownerFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          contextId: 'TEST-context',
          source: {
            resourceRef: 'TEST-alpha-resource',
            teamResourceRef: 'TEST-alpha-team-resource',
            scope: {
              projectId: 'TEST-project',
              workspaceId: 'TEST-workspace',
              teamId: 'alpha',
              runId: 'alpha-run',
              memberId: null,
              generation: null,
            },
            handleId: 'alpha',
            teamId: 'alpha',
            teamName: 'alpha',
            principalId: 'human',
            grantRevision: 1,
            actor: 'user',
            runId: 'alpha-run',
          },
          target: {
            resourceRef: `TEST-${input.target.handleId}-resource`,
            teamResourceRef: `TEST-${input.target.handleId}-team-resource`,
            scope: {
              projectId: 'TEST-project',
              workspaceId: 'TEST-workspace',
              teamId: input.target.handleId,
              runId: `${input.target.handleId}-run`,
              memberId: null,
              generation: null,
            },
            handleId: input.target.handleId,
            teamId: input.target.handleId,
            teamName: input.target.handleId,
            principalId: 'human',
            grantRevision: 1,
            actor: 'user',
            recipient: {
              name: 'lead',
              memberId: 'lead',
              runId: `${input.target.handleId}-run`,
              generation: '1',
            },
          },
        };
      },
      target(original) {
        const owner = teams.get(original.teamId)!;
        const connection = owner.connect('human');
        const project = (receipt: CommandReceipt | undefined) => {
          if (!receipt) return undefined;
          const intent = receipt.crossTeam;
          if (!intent) throw new Error('TEST missing private target receipt context');
          if (
            receipt.command.operation !== 'message.send' ||
            receipt.command.payload.text !== intent.request.text
          )
            throw new Error('TEST exact target receipt mismatch');
          return {
            commandId: receipt.commandId,
            messageId: receipt.effects.messageId,
            authorityFingerprint: intent.authorityFingerprint,
            phase: receipt.phase,
          };
        };
        return {
          assertOriginal() {
            owner.withLaunchAuthority('human', 'read', () => {});
          },
          lookup: (id) => project(connection.lookup(id)),
          receive(intent) {
            return project(owner.receiveCrossTeam('human', intent))!;
          },
        };
      },
    });
  const inbox = (name: string) => {
    try {
      return JSON.parse(
        readFileSync(join(root, 'teams', name, 'inboxes', 'lead.json'), 'utf8')
      ) as unknown[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  return {
    root,
    request,
    coordinator,
    inbox,
    outbox,
    teams: () => teams,
    restart: () => {
      teams = owners();
    },
    source: () => teams.get('alpha')!.crossTeamCommands('human'),
  };
}

describe('original source cross-Team command authority', () => {
  it('persists original pair before a real target inbox effect and rejects changed target after missing source outbox', async () => {
    const f = fixture();
    await expect(
      f.coordinator().send('TEST-message', digest(f.request), f.request)
    ).rejects.toThrow('TEST source outbox');
    expect(f.inbox('beta')).toHaveLength(1);
    expect(await f.outbox.read('alpha')).toEqual([]);
    expect(f.source().lookup('TEST-message')?.intent.pair.target.teamId).toBe('beta');
    f.restart();
    const changed = { ...f.request, target: { handleId: 'gamma' } };
    await expect(f.coordinator().send('TEST-message', digest(changed), changed)).rejects.toThrow();
    expect(f.inbox('gamma')).toEqual([]);
    await expect(
      f.coordinator().send('TEST-message', digest(f.request), f.request)
    ).resolves.toMatchObject({ phase: 'completed' });
    expect(f.inbox('beta')).toHaveLength(1);
    expect(f.teams().get('beta')!.connect('human').pendingDeliveries()).toHaveLength(1);
    expect(await f.outbox.read('alpha')).toHaveLength(1);
  });

  it('rejects changed bytes under the original identity and keeps the original source intent inspectable', async () => {
    const f = fixture();
    await expect(
      f.coordinator().send('TEST-message', digest(f.request), f.request)
    ).rejects.toThrow();
    const changed = { ...f.request, text: 'TEST changed bytes' };
    await expect(f.coordinator().send('TEST-message', digest(changed), changed)).rejects.toThrow();
    expect(f.inbox('beta')).toHaveLength(1);
    const original = f.source().lookup('TEST-message');
    expect(original?.phase).toBe('prepared');
    expect(original?.intent.request.text).toBe(f.request.text);
  });

  it('does not require a new write grant to look up the original partial command', async () => {
    const f = fixture();
    await expect(
      f.coordinator().send('TEST-message', digest(f.request), f.request)
    ).rejects.toThrow();
    const path = join(f.root, 'teams', 'alpha', '.host-owner', 'state.json');
    const state: OwnerState = JSON.parse(readFileSync(path, 'utf8'));
    for (const grant of state.grants) {
      if (grant.principalId === 'human') {
        grant.permissions = ['read', 'admin'];
        grant.revision = (grant.revision ?? 1) + 1;
      }
    }
    writeFileSync(path, JSON.stringify(state, null, 2));
    const original = f.coordinator().lookup('TEST-message');
    expect(original?.source.intent.pair.target.teamId).toBe('beta');
    expect(original?.source.authorityRevision).toBe(1);
    await expect(
      f.coordinator().send('TEST-message', digest(f.request), f.request)
    ).rejects.toThrow();
    expect(await f.outbox.read('alpha')).toEqual([]);
  });
  it('keeps ordinary callers unable to forge or replay private cross-Team provenance', async () => {
    const f = fixture();
    await expect(
      f.coordinator().send('TEST-message', digest(f.request), f.request)
    ).rejects.toThrow();
    const original = f.source().lookup('TEST-message')!.intent;
    const target = f.teams().get('beta')!.connect('human');
    const receipt = target.lookup(original.targetCommandId)!;
    expect(receipt.crossTeam?.authorityFingerprint).toBe(original.authorityFingerprint);
    expect(receipt.command.operation).toBe('message.send');
    expect(() => target.execute(receipt.command)).toThrow('conflict');
    if (receipt.command.operation !== 'message.send') throw new Error('TEST wrong command');
    expect(receipt.command.payload.messageId).toBe(original.targetCommandId);
    expect(() =>
      target.execute({
        ...receipt.command,
        commandId: 'TEST-forged',
        payload: { ...receipt.command.payload, messageId: 'TEST-forged', crossTeam: original },
      } as never)
    ).toThrow();
    expect(f.inbox('beta')).toHaveLength(1);
    expect(f.inbox('beta')[0]).toMatchObject({
      from: 'alpha.user',
      source: 'cross_team',
      messageId: 'TEST-message',
    });
  });

  it('revokes pending native target admission when original source write authority is revoked', async () => {
    const f = fixture();
    await expect(
      f.coordinator().send('TEST-message', digest(f.request), f.request)
    ).rejects.toThrow();
    const target = f.teams().get('beta')!;
    const pending = target.connect('human').pendingDeliveries()[0]!;
    expect(target.authorizeDeliveryIntent(pending, 'admit')).toBe(true);
    const path = join(f.root, 'teams', 'alpha', '.host-owner', 'state.json');
    const state: OwnerState = JSON.parse(readFileSync(path, 'utf8'));
    for (const grant of state.grants)
      if (grant.principalId === 'human') {
        grant.permissions = ['read', 'admin'];
        grant.revision = (grant.revision ?? 1) + 1;
      }
    writeFileSync(path, JSON.stringify(state, null, 2));
    expect(target.authorizeDeliveryIntent(pending, 'admit')).toBe(false);
    expect(target.authorizeDeliveryIntent(pending, 'dispatch')).toBe(false);
    expect(f.inbox('beta')).toHaveLength(1);
  });
});
