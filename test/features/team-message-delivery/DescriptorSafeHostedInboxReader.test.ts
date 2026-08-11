import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseTeamIdentityRecord,
  type TeamIdentityRecord,
} from '@features/internal-storage/contracts';
import { DescriptorSafeHostedInboxReader } from '@features/team-message-delivery/main/infrastructure/DescriptorSafeHostedInboxReader';
import { parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import { afterEach, describe, expect, it } from 'vitest';

const TEAM_NAME = 'sandbox-hosted-team';
const TEAM_ID = parseTeamId(`team_${'a'.repeat(32)}`);
const FOREIGN_TEAM_ID = parseTeamId(`team_${'f'.repeat(32)}`);
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'b'.repeat(32)}`);
const CREATED_AT = '2026-08-11T00:00:00.000Z';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function identityText(teamId = TEAM_ID, createdAt = CREATED_AT): string {
  return `${JSON.stringify({ schemaVersion: 1, teamId, createdAt }, null, 2)}\n`;
}

function directoryFingerprint(
  canonicalPath: string,
  directory: Awaited<ReturnType<typeof stat>>
): string {
  return sha256(
    JSON.stringify({
      schemaVersion: 1,
      canonicalPath,
      device: directory.dev.toString(),
      inode: directory.ino.toString(),
    })
  );
}

describe('DescriptorSafeHostedInboxReader', () => {
  let sandboxRoot: string | null = null;

  afterEach(async () => {
    if (sandboxRoot !== null) await rm(sandboxRoot, { recursive: true, force: true });
    sandboxRoot = null;
  });

  async function createTeamRoot(options: { readonly withInbox?: boolean } = {}): Promise<{
    readonly identity: TeamIdentityRecord;
    readonly identityPath: string;
    readonly inboxesPath: string;
    readonly teamRoot: string;
    readonly teamsRoot: string;
  }> {
    sandboxRoot = await mkdtemp(join(tmpdir(), 'hosted-inbox-reader-'));
    const teamsRoot = join(sandboxRoot, 'teams');
    const teamRoot = join(teamsRoot, TEAM_NAME);
    const inboxesPath = join(teamRoot, 'inboxes');
    const identityPath = join(teamRoot, 'team.identity.json');
    await mkdir(teamRoot, { recursive: true });
    await Promise.all([chmod(sandboxRoot, 0o700), chmod(teamsRoot, 0o700), chmod(teamRoot, 0o700)]);
    const serializedIdentity = identityText();
    await writeFile(identityPath, serializedIdentity, { encoding: 'utf8', mode: 0o600 });
    if (options.withInbox === true) {
      await mkdir(inboxesPath, { mode: 0o700 });
      await writeFile(
        join(inboxesPath, 'user.json'),
        JSON.stringify([
          {
            from: 'team-lead',
            to: 'user',
            text: 'Durable identity-bound message.',
            timestamp: '2026-08-11T00:00:02.000Z',
            read: false,
            messageId: 'durable-message-0001',
          },
        ]),
        { encoding: 'utf8', mode: 0o600 }
      );
    }
    const teamDirectory = await stat(teamRoot, { bigint: true });
    const identity = parseTeamIdentityRecord({
      teamId: TEAM_ID,
      state: 'active',
      legacyKey: TEAM_NAME,
      directoryFingerprint: directoryFingerprint(teamRoot, teamDirectory),
      workspaceBinding: { workspaceId: WORKSPACE_ID, generation: 1 },
      adoptionIntentId: `adoption_${'c'.repeat(32)}`,
      identityChecksum: sha256(serializedIdentity),
      createdAt: CREATED_AT,
      activatedAt: '2026-08-11T00:00:01.000Z',
      tombstonedAt: null,
    });
    return { identity, identityPath, inboxesPath, teamRoot, teamsRoot };
  }

  it('accepts an inbox only through its durable directory fingerprint and identity checksum anchor', async () => {
    const { identity, teamsRoot } = await createTeamRoot({ withInbox: true });

    const result = await new DescriptorSafeHostedInboxReader({ teamsRoot }).getMessagesWindow(
      identity,
      { limit: 10 }
    );

    expect(result).toMatchObject({
      messages: [
        {
          messageId: 'durable-message-0001',
          text: 'Durable identity-bound message.',
          hostedInboxTarget: 'user',
        },
      ],
      truncated: false,
      sourceRevision: expect.stringMatching(/^[0-9a-f]{64}$/u),
      sourceMessageCount: 1,
    });
  });

  it('projects an absent inbox directory as stable empty only after validating its identity anchor', async () => {
    const { identity, teamsRoot } = await createTeamRoot();
    const result = await new DescriptorSafeHostedInboxReader({ teamsRoot }).getMessagesWindow(
      identity,
      { limit: 10 }
    );

    expect(result).toEqual({
      messages: [],
      truncated: false,
      sourceRevision: expect.stringMatching(/^[0-9a-f]{64}$/u),
      sourceMessageCount: 0,
    });
  });

  it('fails closed if the inbox directory appears during the absence proof', async () => {
    const { identity, teamsRoot, inboxesPath } = await createTeamRoot();
    const reader = new DescriptorSafeHostedInboxReader({
      teamsRoot,
      beforeFinalValidation: async () => {
        await mkdir(inboxesPath, { mode: 0o700 });
      },
    });

    await expect(reader.getMessagesWindow(identity, { limit: 10 })).rejects.toThrow(
      'hosted-inbox-path-appeared'
    );
  });

  it('rejects a team directory replaced before descriptor open even when its anchor bytes match', async () => {
    const { identity, identityPath, teamRoot, teamsRoot } = await createTeamRoot();
    const displacedRoot = `${teamRoot}.displaced`;
    const serializedIdentity = identityText();
    await rename(teamRoot, displacedRoot);
    await mkdir(teamRoot, { mode: 0o700 });
    await writeFile(identityPath, serializedIdentity, { encoding: 'utf8', mode: 0o600 });

    await expect(
      new DescriptorSafeHostedInboxReader({ teamsRoot }).getMessagesWindow(identity, { limit: 10 })
    ).rejects.toThrow('hosted-inbox-team-directory-fingerprint-mismatch');
  });

  it('rejects a foreign identity anchor even when the durable checksum points to its bytes', async () => {
    const { identity, identityPath, teamsRoot } = await createTeamRoot();
    const foreign = identityText(FOREIGN_TEAM_ID);
    await writeFile(identityPath, foreign, { encoding: 'utf8', mode: 0o600 });
    const checksumBoundIdentity = parseTeamIdentityRecord({
      ...identity,
      identityChecksum: sha256(foreign),
    });

    await expect(
      new DescriptorSafeHostedInboxReader({ teamsRoot }).getMessagesWindow(checksumBoundIdentity, {
        limit: 10,
      })
    ).rejects.toThrow('hosted-inbox-team-identity-invalid');
  });

  it('rejects an identity checksum that does not match the canonical identity file', async () => {
    const { identity, teamsRoot } = await createTeamRoot();
    const mismatchedIdentity = parseTeamIdentityRecord({
      ...identity,
      identityChecksum: 'd'.repeat(64),
    });

    await expect(
      new DescriptorSafeHostedInboxReader({ teamsRoot }).getMessagesWindow(mismatchedIdentity, {
        limit: 10,
      })
    ).rejects.toThrow('hosted-inbox-team-identity-invalid');
  });

  it('rejects an absent team identity anchor', async () => {
    const { identity, identityPath, teamsRoot } = await createTeamRoot();
    await rm(identityPath);

    await expect(
      new DescriptorSafeHostedInboxReader({ teamsRoot }).getMessagesWindow(identity, { limit: 10 })
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a corrupt identity anchor even when its checksum is the durable expectation', async () => {
    const { identity, identityPath, teamsRoot } = await createTeamRoot();
    const corrupt = '{not-canonical-json\n';
    await writeFile(identityPath, corrupt, { encoding: 'utf8', mode: 0o600 });
    const checksumBoundIdentity = parseTeamIdentityRecord({
      ...identity,
      identityChecksum: sha256(corrupt),
    });

    await expect(
      new DescriptorSafeHostedInboxReader({ teamsRoot }).getMessagesWindow(checksumBoundIdentity, {
        limit: 10,
      })
    ).rejects.toBeInstanceOf(SyntaxError);
  });

  it('rejects identity-anchor replacement during an otherwise valid inbox read', async () => {
    const { identity, identityPath, teamsRoot } = await createTeamRoot({ withInbox: true });
    const replacementPath = `${identityPath}.replacement`;
    await writeFile(replacementPath, identityText(), { encoding: 'utf8', mode: 0o600 });
    const reader = new DescriptorSafeHostedInboxReader({
      teamsRoot,
      beforeFinalValidation: async () => {
        await rename(replacementPath, identityPath);
      },
    });

    await expect(reader.getMessagesWindow(identity, { limit: 10 })).rejects.toThrow(
      /hosted-inbox-(?:file-invalid|path-substituted)/u
    );
  });
});
