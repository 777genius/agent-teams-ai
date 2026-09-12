import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HmacMemberWorkSyncReportTokenAdapter } from '@features/member-work-sync/main/infrastructure/HmacMemberWorkSyncReportTokenAdapter';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestWorkSyncIdentity } from '../helpers/createTestWorkSyncIdentity';

describe('HmacMemberWorkSyncReportTokenAdapter', () => {
  let root: string;
  let paths: MemberWorkSyncStorePaths;
  let adapter: HmacMemberWorkSyncReportTokenAdapter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'member-work-sync-token-'));
    paths = new MemberWorkSyncStorePaths(root);
    adapter = new HmacMemberWorkSyncReportTokenAdapter(paths, createTestWorkSyncIdentity());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('generates fresh missing keys and keeps a newer live key while clearing cache', async () => {
    const backup = JSON.stringify({ schemaVersion: 1, secret: 'a'.repeat(32) });
    const live = JSON.stringify({
      schemaVersion: 2,
      teamName: 'team-a',
      incarnation: 'inc-a',
      secret: 'b'.repeat(32),
    });
    expect(
      await adapter.restoreBackupSecret('team-a', backup, {
        teamName: 'team-a',
        incarnation: 'inc-a',
      })
    ).toEqual({ rotated: true });
    expect(
      JSON.parse(await readFile(paths.getReportTokenSecretPath('team-a'), 'utf8'))
    ).toMatchObject({ schemaVersion: 2, incarnation: 'inc-a' });
    const request = {
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'f',
      issuedAt: '2026-09-10T00:00:00Z',
    };
    const old = await adapter.create(request);
    await writeFile(paths.getReportTokenSecretPath('team-a'), live);
    expect(
      await adapter.restoreBackupSecret('team-a', backup, {
        teamName: 'team-a',
        incarnation: 'inc-a',
      })
    ).toEqual({ rotated: false });
    expect(await readFile(paths.getReportTokenSecretPath('team-a'), 'utf8')).toBe(live);
    expect(await adapter.create(request)).not.toEqual(old);
    expect(await adapter.create(request)).toEqual(
      await new HmacMemberWorkSyncReportTokenAdapter(paths, createTestWorkSyncIdentity()).create(
        request
      )
    );
  });

  it('refuses malformed live secret without replacing evidence', async () => {
    await mkdir(paths.getTeamDir('team-a'), { recursive: true });
    const target = paths.getReportTokenSecretPath('team-a');
    await writeFile(target, '{broken');
    await expect(
      adapter.restoreBackupSecret(
        'team-a',
        JSON.stringify({ schemaVersion: 1, secret: 'a'.repeat(32) }),
        { teamName: 'team-a', incarnation: 'inc-a' }
      )
    ).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('{broken');
  });

  it('creates a token bound to team, member, fingerprint, and expiry', async () => {
    const issued = await adapter.create({
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'agenda:v1:abc',
      issuedAt: '2026-04-29T00:00:00.000Z',
    });

    expect(issued.expiresAt).toBe('2026-04-29T00:15:00.000Z');
    await expect(
      adapter.verify({
        token: issued.token,
        teamName: 'team-a',
        memberName: 'bob',
        agendaFingerprint: 'agenda:v1:abc',
        nowIso: '2026-04-29T00:14:59.000Z',
      })
    ).resolves.toMatchObject({ ok: true, claims: { expiresAtMs: expect.any(Number) } });
  });

  it('rejects copied, stale, and expired tokens', async () => {
    const issued = await adapter.create({
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'agenda:v1:abc',
      issuedAt: '2026-04-29T00:00:00.000Z',
    });

    await expect(
      adapter.verify({
        token: issued.token,
        teamName: 'team-a',
        memberName: 'alice',
        agendaFingerprint: 'agenda:v1:abc',
        nowIso: '2026-04-29T00:01:00.000Z',
      })
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(
      adapter.verify({
        token: issued.token,
        teamName: 'team-a',
        memberName: 'bob',
        agendaFingerprint: 'agenda:v1:new',
        nowIso: '2026-04-29T00:01:00.000Z',
      })
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(
      adapter.verify({
        token: issued.token,
        teamName: 'team-a',
        memberName: 'bob',
        agendaFingerprint: 'agenda:v1:abc',
        nowIso: '2026-04-29T00:15:00.000Z',
      })
    ).resolves.toEqual({
      ok: false,
      reason: 'expired',
      claims: { expiresAt: issued.expiresAt, expiresAtMs: Date.parse(issued.expiresAt) },
    });
  });

  it('preserves a corrupt token secret and fails closed', async () => {
    await mkdir(paths.getTeamDir('team-a'), { recursive: true });
    const target = paths.getReportTokenSecretPath('team-a');
    await writeFile(target, '{broken', 'utf8');
    await expect(
      adapter.create({
        teamName: 'team-a',
        memberName: 'bob',
        agendaFingerprint: 'f',
        issuedAt: '2026-04-29T00:00:00.000Z',
      })
    ).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('{broken');
  });

  it('uses one durable winner across concurrent adapter instances', async () => {
    const request = {
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'f',
      issuedAt: '2026-04-29T00:00:00.000Z',
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        new HmacMemberWorkSyncReportTokenAdapter(paths, createTestWorkSyncIdentity()).create(
          request
        )
      )
    );
    expect(new Set(results.map((result) => result.token)).size).toBe(1);
    for (const issued of results)
      await expect(
        adapter.verify({ ...request, token: issued.token, nowIso: '2026-04-29T00:01:00.000Z' })
      ).resolves.toMatchObject({ ok: true, claims: { expiresAtMs: expect.any(Number) } });
  });

  it('rejects a valid signed token when verification time is not finite', async () => {
    const request = {
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'f',
      issuedAt: '2026-04-29T00:00:00.000Z',
    };
    const issued = await adapter.create(request);
    await expect(
      adapter.verify({ ...request, token: issued.token, nowIso: 'invalid' })
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('does not cache a failed token secret load forever', async () => {
    const secretPath = paths.getReportTokenSecretPath('team-a');
    await mkdir(secretPath, { recursive: true });

    await expect(
      adapter.create({
        teamName: 'team-a',
        memberName: 'bob',
        agendaFingerprint: 'agenda:v1:abc',
        issuedAt: '2026-04-29T00:00:00.000Z',
      })
    ).rejects.toBeTruthy();

    await rm(secretPath, { recursive: true, force: true });
    await expect(
      adapter.create({
        teamName: 'team-a',
        memberName: 'bob',
        agendaFingerprint: 'agenda:v1:abc',
        issuedAt: '2026-04-29T00:00:00.000Z',
      })
    ).resolves.toMatchObject({
      expiresAt: '2026-04-29T00:15:00.000Z',
    });
  });
  it('rejects old tokens after recreation despite an adapter cache', async () => {
    let incarnation = 'first';
    const port = createTestWorkSyncIdentity();
    port.readCurrent = async () => ({ status: 'identified', identityId: incarnation });
    port.withCurrent = async (_team, expected, operation) =>
      expected === incarnation
        ? { current: true, value: await operation() }
        : { current: false, identity: { status: 'absent' } };
    const bound = new HmacMemberWorkSyncReportTokenAdapter(paths, port);
    const request = {
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'f',
      issuedAt: '2026-04-29T00:00:00Z',
    };
    const old = await bound.create(request);
    incarnation = 'second';
    expect(await bound.verify({ ...request, token: old.token, nowIso: request.issuedAt })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(
      JSON.parse(await readFile(paths.getReportTokenSecretPath('team-a'), 'utf8')).incarnation
    ).toBe('second');
  });

  it('rotates legacy keys once under the trusted fence', async () => {
    const target = paths.getReportTokenSecretPath('team-a');
    await mkdir(paths.getTeamDir('team-a'), { recursive: true });
    await writeFile(target, JSON.stringify({ schemaVersion: 1, secret: 'a'.repeat(32) }));
    const port = createTestWorkSyncIdentity();
    const request = {
      teamName: 'team-a',
      memberName: 'bob',
      agendaFingerprint: 'f',
      issuedAt: '2026-04-29T00:00:00Z',
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        new HmacMemberWorkSyncReportTokenAdapter(paths, port).create(request)
      )
    );
    expect(new Set(results.map((item) => item.token)).size).toBe(1);
    const secret = JSON.parse(await readFile(target, 'utf8'));
    expect(secret).toMatchObject({ schemaVersion: 2, incarnation: 'inc-a' });
    expect(secret.secret).not.toBe('a'.repeat(32));
    const payload = Buffer.from(
      JSON.stringify({ version: 1, ...request, expiresAt: 'not-a-date' })
    ).toString('base64url');
    const signature = createHmac('sha256', secret.secret).update(payload).digest('base64url');
    expect(
      await adapter.verify({
        ...request,
        token: `wrs:v1.${payload}.${signature}`,
        nowIso: request.issuedAt,
      })
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it.each(['unavailable', 'deleting'] as const)(
    'makes no writes for %s identity',
    async (status) => {
      const port = createTestWorkSyncIdentity();
      port.readCurrent = async () => ({ status });
      const bound = new HmacMemberWorkSyncReportTokenAdapter(paths, port);
      await expect(
        bound.create({
          teamName: 'team-a',
          memberName: 'bob',
          agendaFingerprint: 'f',
          issuedAt: '2026-04-29T00:00:00Z',
        })
      ).rejects.toThrow();
      await expect(readFile(paths.getReportTokenSecretPath('team-a'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  );

  it('rejects a foreign bound backup without creating a secret', async () => {
    await expect(
      adapter.restoreBackupSecret(
        'team-a',
        JSON.stringify({
          schemaVersion: 2,
          teamName: 'team-a',
          incarnation: 'foreign',
          secret: 'a'.repeat(32),
        }),
        { teamName: 'team-a', incarnation: 'inc-a' }
      )
    ).rejects.toThrow('identity mismatch');
    await expect(readFile(paths.getReportTokenSecretPath('team-a'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
