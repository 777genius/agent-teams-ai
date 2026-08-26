import { TeamDataService } from '@main/services/team/TeamDataService';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import * as atomicWrite from '@main/utils/atomicWrite';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE = {
  version: 1 as const,
  providerBackendId: 'inherited' as const,
  model: 'inherited' as const,
  effort: 'inherited' as const,
};

const EXPLICIT_BACKEND_MEMBER_RUNTIME_SELECTION_PROVENANCE = {
  version: 1 as const,
  providerBackendId: 'explicit' as const,
  model: 'inherited' as const,
  effort: 'inherited' as const,
};

describe('TeamDataService roster authorization transactions', () => {
  let sandbox = '';
  const teamName = 'transaction-team';
  const firstId = '11111111-1111-4111-8111-111111111111';
  const secondId = '22222222-2222-4222-8222-222222222222';
  const exactProof = {
    authorityId: 'test-authority',
    generation: 7,
    completedAt: '2026-08-21T00:00:00.000Z',
    expiresAt: '2026-08-21T00:01:00.000Z',
    requestDigest: 'exact-model-selection',
  };
  const launchFingerprint = 'exact-launch-request';

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'roster-auth-transaction-'));
    setClaudeBasePathOverride(sandbox);
    await fs.mkdir(path.join(sandbox, 'teams', teamName), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setClaudeBasePathOverride(null);
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('restores the exact durable snapshot and removes transaction-introduced tombstones', async () => {
    const metaPath = path.join(sandbox, 'teams', teamName, 'members.meta.json');
    const exactOriginal = `${JSON.stringify(
      {
        version: 1,
        providerBackendId: 'original-backend',
        members: [
          {
            name: 'alice',
            role: 'Reviewer',
            agentId: 'agent-alice',
            cwd: '/sandbox/alice',
            joinedAt: 123,
            color: 'blue',
            sessionId: 'session-alice',
            customMetadata: { preserved: true },
          },
          {
            name: 'retired',
            role: 'Historian',
            agentId: 'retired-agent',
            removedAt: 456,
            sessionId: 'retired-session',
          },
        ],
      },
      null,
      2
    )}\n`;
    await fs.writeFile(metaPath, exactOriginal, 'utf8');
    const service = new TeamDataService();

    await expect(
      service.beginRosterAuthorizationTransaction(teamName, firstId, {
        members: [
          {
            runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
            name: 'bob',
            role: 'Implementer',
          },
        ],
      })
    ).resolves.toMatchObject({ status: 'applied' });
    const applied = JSON.parse(await fs.readFile(metaPath, 'utf8')) as {
      members: Array<Record<string, unknown>>;
    };
    expect(applied.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'alice', removedAt: expect.any(Number) }),
        expect.objectContaining({ name: 'bob' }),
      ])
    );

    await expect(
      service.rollbackRosterAuthorizationTransaction(teamName, firstId)
    ).resolves.toMatchObject({
      status: 'rolled-back',
    });
    expect(await fs.readFile(metaPath, 'utf8')).toBe(exactOriginal);
    const restored = JSON.parse(await fs.readFile(metaPath, 'utf8')) as {
      members: Array<Record<string, unknown>>;
    };
    expect(restored.members).toHaveLength(2);
    expect(restored.members[0]).toMatchObject({
      agentId: 'agent-alice',
      sessionId: 'session-alice',
      customMetadata: { preserved: true },
    });
    expect(restored.members.some((member) => member.name === 'bob')).toBe(false);
  });

  it('preserves a current root through add, update, remove, and roster authorization', async () => {
    const metaPath = path.join(sandbox, 'teams', teamName, 'members.meta.json');
    await fs.writeFile(
      metaPath,
      JSON.stringify({
        version: 2,
        providerBackendId: 'api',
        members: [{ name: 'alice', providerId: 'codex', providerBackendId: 'api' }],
      })
    );
    const service = new TeamDataService();
    const expectCurrentRoot = async (): Promise<void> => {
      expect(JSON.parse(await fs.readFile(metaPath, 'utf8'))).toMatchObject({
        version: 2,
        providerBackendId: 'api',
      });
    };

    await service.addMember(teamName, {
      runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
      name: 'bob',
      providerId: 'codex',
    });
    await expectCurrentRoot();
    await service.updateMemberRole(teamName, 'bob', 'Reviewer');
    await expectCurrentRoot();
    await service.removeMember(teamName, 'bob');
    await expectCurrentRoot();
    await service.beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [
        {
          runtimeSelectionProvenance: EXPLICIT_BACKEND_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'alice',
          providerId: 'codex',
          providerBackendId: 'adapter',
        },
      ],
    });
    await expectCurrentRoot();
    expect(JSON.parse(await fs.readFile(metaPath, 'utf8'))).toMatchObject({
      members: expect.arrayContaining([expect.objectContaining({ providerBackendId: 'adapter' })]),
    });
  });

  it('upgrades a legacy roster before durably storing a newly selected backend', async () => {
    const metaPath = path.join(sandbox, 'teams', teamName, 'members.meta.json');
    await fs.writeFile(
      metaPath,
      JSON.stringify({
        version: 1,
        providerBackendId: 'api',
        members: [{ name: 'alice', providerId: 'codex', providerBackendId: 'api' }],
      })
    );

    await new TeamDataService().beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [
        {
          runtimeSelectionProvenance: EXPLICIT_BACKEND_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'alice',
          providerId: 'codex',
          providerBackendId: 'adapter',
        },
      ],
    });
    expect(JSON.parse(await fs.readFile(metaPath, 'utf8'))).toMatchObject({
      version: 2,
      providerBackendId: 'codex-native',
      members: [{ providerBackendId: 'adapter' }],
    });
  });

  it('resolves omitted providers before accepting compatible add and roster backends', async () => {
    const teamDir = path.join(sandbox, 'teams', teamName);
    await fs.writeFile(
      path.join(teamDir, 'team.meta.json'),
      JSON.stringify({ version: 2, cwd: '/tmp/fake', providerId: 'codex', createdAt: 1 })
    );
    const service = new TeamDataService();

    await service.addMember(teamName, {
      runtimeSelectionProvenance: EXPLICIT_BACKEND_MEMBER_RUNTIME_SELECTION_PROVENANCE,
      name: 'alice',
      providerBackendId: 'api',
    });
    await expect(new TeamMembersMetaStore().getMembers(teamName)).resolves.toMatchObject([
      { name: 'alice', providerId: 'codex', providerBackendId: 'api' },
    ]);
    await service.beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [
        {
          runtimeSelectionProvenance: EXPLICIT_BACKEND_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'alice',
          providerBackendId: 'adapter',
        },
      ],
    });
    await expect(new TeamMembersMetaStore().getMembers(teamName)).resolves.toMatchObject([
      { name: 'alice', providerId: 'codex', providerBackendId: 'adapter' },
    ]);
  });

  it.each(['add', 'roster'] as const)(
    'rejects a provider-omitted incompatible backend during %s without substitution',
    async (operation) => {
      const teamDir = path.join(sandbox, 'teams', teamName);
      await fs.writeFile(
        path.join(teamDir, 'team.meta.json'),
        JSON.stringify({ version: 2, cwd: '/tmp/fake', providerId: 'codex', createdAt: 1 })
      );
      const service = new TeamDataService();
      const action =
        operation === 'add'
          ? service.addMember(teamName, {
              runtimeSelectionProvenance: EXPLICIT_BACKEND_MEMBER_RUNTIME_SELECTION_PROVENANCE,
              name: 'alice',
              providerBackendId: 'opencode-cli',
            })
          : service.beginRosterAuthorizationTransaction(teamName, firstId, {
              members: [
                {
                  runtimeSelectionProvenance: EXPLICIT_BACKEND_MEMBER_RUNTIME_SELECTION_PROVENANCE,
                  name: 'alice',
                  providerBackendId: 'opencode-cli',
                },
              ],
            });
      await expect(action).rejects.toThrow('incompatible with the inherited providerId');
      await expect(new TeamMembersMetaStore().getMembers(teamName)).resolves.toEqual([]);
    }
  );

  it('rejects concurrent store mutation while applied and fails closed on an external CAS conflict', async () => {
    const service = new TeamDataService();
    const store = new TeamMembersMetaStore();
    await store.writeMembers(teamName, [{ name: 'alice', agentId: 'agent-alice' }]);
    await service.beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [
        { runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE, name: 'bob' },
      ],
    });
    await expect(
      store.writeMembers(teamName, [{ name: 'concurrent', agentId: 'newer-agent' }])
    ).rejects.toThrow('Roster is busy');
    await fs.writeFile(
      path.join(sandbox, 'teams', teamName, 'members.meta.json'),
      JSON.stringify({ version: 1, members: [{ name: 'concurrent', agentId: 'newer-agent' }] }),
      'utf8'
    );

    await expect(
      service.rollbackRosterAuthorizationTransaction(teamName, firstId)
    ).resolves.toMatchObject({
      status: 'conflict',
    });
    expect(await store.getMembers(teamName)).toEqual([
      expect.objectContaining({ name: 'concurrent', agentId: 'newer-agent' }),
    ]);
  });

  it('keeps rollback and commit idempotent with restart-readable terminal outcomes', async () => {
    const service = new TeamDataService();
    await service.beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [
        {
          runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'alice',
        },
      ],
    });
    await expect(
      service.rollbackRosterAuthorizationTransaction(teamName, firstId)
    ).resolves.toMatchObject({ status: 'rolled-back' });
    await expect(
      new TeamDataService().rollbackRosterAuthorizationTransaction(teamName, firstId)
    ).resolves.toMatchObject({ status: 'rolled-back' });
    await expect(
      new TeamDataService().getRosterAuthorizationTransactionOutcome(teamName, firstId)
    ).resolves.toMatchObject({ status: 'rolled-back' });

    await service.beginRosterAuthorizationTransaction(teamName, secondId, {
      members: [
        { runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE, name: 'bob' },
      ],
    });
    await service.rosterAuthorizationTransactions.prepare(
      teamName,
      secondId,
      secondId,
      exactProof,
      launchFingerprint
    );
    const invoked = await service.rosterAuthorizationTransactions.prepareLaunchInvocationIntent(
      teamName,
      secondId
    );
    await service.rosterAuthorizationTransactions.recordLaunchDispatched(teamName, secondId);
    await fs.writeFile(
      path.join(sandbox, 'teams', teamName, 'bootstrap-state.json'),
      JSON.stringify({
        runId: secondId,
        members: [{ name: 'bob', status: 'bootstrap_confirmed' }],
      })
    );
    await expect(
      service.rosterAuthorizationTransactions.recordLaunchResult(teamName, secondId, {
        transactionId: secondId,
        teamName,
        rosterFingerprint: invoked.targetFingerprint!,
        rosterRevision: invoked.rosterRevision!,
        launchCommandId: invoked.launchCommandId!,
        executionProof: exactProof,
        launchRequestFingerprint: launchFingerprint,
        runId: secondId,
        attemptId: invoked.launchCommandId!,
        launchStatus: 'started',
      })
    ).resolves.toMatchObject({ status: 'committed' });
    await expect(
      new TeamDataService().commitRosterAuthorizationTransaction(teamName, secondId)
    ).resolves.toMatchObject({ status: 'committed' });
    await expect(
      new TeamDataService().getRosterAuthorizationTransactionOutcome(teamName, secondId)
    ).resolves.toMatchObject({ status: 'committed' });
    expect(await new TeamMembersMetaStore().getMembers(teamName)).toEqual([
      expect.objectContaining({ name: 'bob', removedAt: undefined }),
    ]);

    const ledger = JSON.parse(
      await fs.readFile(
        path.join(
          sandbox,
          'teams',
          teamName,
          '.roster-authorization-transactions',
          `${secondId}.json`
        ),
        'utf8'
      )
    ) as Record<string, unknown>;
    expect(ledger).not.toHaveProperty('priorRawBase64');
  });

  it('replays only the exact durable prepare binding across restart', async () => {
    const service = new TeamDataService();
    const begun = await service.beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [
        {
          runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'alice',
          role: 'Builder',
        },
      ],
    });
    const prepared = await service.rosterAuthorizationTransactions.prepare(
      teamName,
      firstId,
      firstId,
      exactProof,
      launchFingerprint
    );

    expect(prepared).toMatchObject({
      status: 'prepared',
      targetFingerprint: begun.targetFingerprint,
      rosterRevision: begun.rosterRevision,
      launchBinding: {
        transactionId: firstId,
        teamName,
        rosterFingerprint: begun.targetFingerprint,
        rosterRevision: begun.rosterRevision,
        launchCommandId: firstId,
        executionProof: exactProof,
        launchRequestFingerprint: launchFingerprint,
      },
    });
    await expect(
      new TeamDataService().rosterAuthorizationTransactions.prepare(
        teamName,
        firstId,
        firstId,
        { ...exactProof },
        launchFingerprint
      )
    ).resolves.toMatchObject({
      status: 'prepared',
      launchBinding: {
        executionProof: exactProof,
        launchRequestFingerprint: launchFingerprint,
      },
    });
  });

  it.each([
    {
      name: 'proof-only',
      proof: { ...exactProof, generation: exactProof.generation + 1 },
      fingerprint: launchFingerprint,
    },
    {
      name: 'proof-expiry-only',
      proof: { ...exactProof, expiresAt: '2026-08-21T00:02:00.000Z' },
      fingerprint: launchFingerprint,
    },
    {
      name: 'request-only',
      proof: exactProof,
      fingerprint: `${launchFingerprint}-changed`,
    },
  ])('rejects a $name prepare change without replacing durable binding A', async (changed) => {
    const service = new TeamDataService();
    await service.beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [
        {
          runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'alice',
        },
      ],
    });
    await service.rosterAuthorizationTransactions.prepare(
      teamName,
      firstId,
      firstId,
      exactProof,
      launchFingerprint
    );

    await expect(
      new TeamDataService().rosterAuthorizationTransactions.prepare(
        teamName,
        firstId,
        firstId,
        changed.proof,
        changed.fingerprint
      )
    ).resolves.toMatchObject({
      status: 'conflict',
      message: expect.stringContaining('different immutable launch binding'),
    });
    await expect(
      new TeamDataService().rosterAuthorizationTransactions.prepare(
        teamName,
        firstId,
        firstId,
        exactProof,
        launchFingerprint
      )
    ).resolves.toMatchObject({
      status: 'prepared',
      launchBinding: {
        executionProof: exactProof,
        launchRequestFingerprint: launchFingerprint,
      },
    });
  });

  it('rejects a changed roster under the same transaction identity', async () => {
    const service = new TeamDataService();
    await service.beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [
        {
          runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'alice',
        },
      ],
    });
    await service.rosterAuthorizationTransactions.prepare(
      teamName,
      firstId,
      firstId,
      exactProof,
      launchFingerprint
    );

    await expect(
      new TeamDataService().beginRosterAuthorizationTransaction(teamName, firstId, {
        members: [
          {
            runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
            name: 'bob',
          },
        ],
      })
    ).resolves.toMatchObject({ status: 'conflict', message: 'Transaction ID was reused' });
    await expect(new TeamMembersMetaStore().getMembers(teamName)).resolves.toEqual([
      expect.objectContaining({ name: 'alice' }),
    ]);
  });

  it('serializes concurrent A/B prepares and preserves exactly one durable winner', async () => {
    const service = new TeamDataService();
    await service.beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [
        {
          runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'alice',
        },
      ],
    });
    const proofB = { ...exactProof, generation: exactProof.generation + 1 };
    const [resultA, resultB] = await Promise.all([
      service.rosterAuthorizationTransactions.prepare(
        teamName,
        firstId,
        firstId,
        exactProof,
        'request-a'
      ),
      new TeamDataService().rosterAuthorizationTransactions.prepare(
        teamName,
        firstId,
        firstId,
        proofB,
        'request-b'
      ),
    ]);

    expect([resultA.status, resultB.status].sort()).toEqual(['conflict', 'prepared']);
    const winner = resultA.status === 'prepared' ? resultA : resultB;
    const loserProof = resultA.status === 'prepared' ? proofB : exactProof;
    const loserFingerprint = resultA.status === 'prepared' ? 'request-b' : 'request-a';
    await expect(
      new TeamDataService().rosterAuthorizationTransactions.prepare(
        teamName,
        firstId,
        firstId,
        winner.launchBinding!.executionProof,
        winner.launchBinding!.launchRequestFingerprint
      )
    ).resolves.toMatchObject({ status: 'prepared', launchBinding: winner.launchBinding });
    await expect(
      new TeamDataService().rosterAuthorizationTransactions.prepare(
        teamName,
        firstId,
        firstId,
        loserProof,
        loserFingerprint
      )
    ).resolves.toMatchObject({ status: 'conflict' });
  });

  it.each(['before', 'after'] as const)(
    'recovers a crash %s the durable prepare write without rebinding',
    async (failurePoint) => {
      const service = new TeamDataService();
      await service.beginRosterAuthorizationTransaction(teamName, firstId, {
        members: [
          {
            runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
            name: 'alice',
          },
        ],
      });
      const originalAtomicWrite = atomicWrite.atomicWriteAsync;
      const write = vi
        .spyOn(atomicWrite, 'atomicWriteAsync')
        .mockImplementation(async (...args) => {
          const [filePath, contents] = args;
          const isPreparedWrite =
            String(filePath).includes('.roster-authorization-transactions') &&
            typeof contents === 'string' &&
            JSON.parse(contents).status === 'prepared';
          if (isPreparedWrite && failurePoint === 'before') {
            throw new Error('crash-before-prepare-write');
          }
          const result = await originalAtomicWrite(...args);
          if (isPreparedWrite && failurePoint === 'after') {
            throw new Error('crash-after-prepare-write');
          }
          return result;
        });

      await expect(
        service.rosterAuthorizationTransactions.prepare(
          teamName,
          firstId,
          firstId,
          exactProof,
          launchFingerprint
        )
      ).rejects.toThrow(`crash-${failurePoint}-prepare-write`);
      write.mockRestore();

      const restarted = new TeamDataService();
      if (failurePoint === 'before') {
        await expect(
          restarted.rosterAuthorizationTransactions.prepare(
            teamName,
            firstId,
            firstId,
            { ...exactProof, generation: exactProof.generation + 1 },
            'request-b'
          )
        ).resolves.toMatchObject({
          status: 'prepared',
          launchBinding: { launchRequestFingerprint: 'request-b' },
        });
      } else {
        await expect(
          restarted.rosterAuthorizationTransactions.prepare(
            teamName,
            firstId,
            firstId,
            exactProof,
            launchFingerprint
          )
        ).resolves.toMatchObject({
          status: 'prepared',
          launchBinding: { executionProof: exactProof },
        });
        await expect(
          restarted.rosterAuthorizationTransactions.prepare(
            teamName,
            firstId,
            firstId,
            { ...exactProof, generation: exactProof.generation + 1 },
            'request-b'
          )
        ).resolves.toMatchObject({ status: 'conflict' });
      }
    }
  );

  it('commits only accepted launches and rolls back duplicate or known-not-started outcomes', async () => {
    const cases = [
      {
        id: firstId,
        response: { runId: firstId, launchStatus: 'started' as const },
        status: 'committed',
      },
      { id: secondId, response: { runId: 'run-partial' }, status: 'launch-unknown' },
      {
        id: '33333333-3333-4333-8333-333333333333',
        response: { runId: 'run-existing', launchStatus: 'already_running' as const },
        status: 'launch-unknown',
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        response: { runId: 'run-launching', launchStatus: 'already_launching' as const },
        status: 'launch-unknown',
      },
    ];
    const memberNames = ['alpha', 'bravo', 'charlie', 'delta'];
    for (const [index, entry] of cases.entries()) {
      const caseTeamName = `${teamName}-${index}`;
      await fs.mkdir(path.join(sandbox, 'teams', caseTeamName), { recursive: true });
      const service = new TeamDataService();
      await service.beginRosterAuthorizationTransaction(caseTeamName, entry.id, {
        members: [
          {
            runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
            name: memberNames[index],
          },
        ],
      });
      await expect(
        service.rosterAuthorizationTransactions.prepare(
          caseTeamName,
          entry.id,
          entry.id,
          exactProof,
          launchFingerprint
        )
      ).resolves.toMatchObject({ status: 'prepared' });
      const invoked = await service.rosterAuthorizationTransactions.prepareLaunchInvocationIntent(
        caseTeamName,
        entry.id
      );
      await service.rosterAuthorizationTransactions.recordLaunchDispatched(caseTeamName, entry.id);
      if (entry.status === 'committed') {
        await fs.writeFile(
          path.join(sandbox, 'teams', caseTeamName, 'bootstrap-state.json'),
          JSON.stringify({
            runId: entry.id,
            members: [{ name: memberNames[index], status: 'bootstrap_confirmed' }],
          })
        );
      }
      await expect(
        service.rosterAuthorizationTransactions.recordLaunchResult(caseTeamName, entry.id, {
          transactionId: entry.id,
          teamName: caseTeamName,
          rosterFingerprint: invoked.targetFingerprint!,
          rosterRevision: invoked.rosterRevision!,
          launchCommandId: invoked.launchCommandId!,
          executionProof: exactProof,
          launchRequestFingerprint: launchFingerprint,
          runId: entry.response.runId,
          attemptId: invoked.launchCommandId!,
          launchStatus: entry.response.launchStatus as 'started',
        })
      ).resolves.toMatchObject({ status: entry.status });
      const journal = JSON.parse(
        await fs.readFile(
          path.join(
            sandbox,
            'teams',
            caseTeamName,
            '.roster-authorization-transactions',
            `${entry.id}.json`
          ),
          'utf8'
        )
      ) as Record<string, unknown>;
      if (entry.status === 'committed') {
        expect(journal).not.toHaveProperty('priorRawBase64');
      } else {
        expect(journal).toHaveProperty('priorRawBase64');
      }
    }
  });

  it('keeps an unknown launch reserved without retry, commit, or automatic rollback', async () => {
    const service = new TeamDataService();
    await service.beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [
        {
          runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'alice',
        },
      ],
    });
    await service.rosterAuthorizationTransactions.prepare(
      teamName,
      firstId,
      firstId,
      exactProof,
      launchFingerprint
    );
    await expect(
      service.rosterAuthorizationTransactions.prepareLaunchInvocationIntent(teamName, firstId)
    ).resolves.toMatchObject({ status: 'prepared' });
    await service.rosterAuthorizationTransactions.recordUnknownLaunchTransport(
      teamName,
      firstId,
      'transport outcome uncertain'
    );
    await expect(
      new TeamDataService().getRosterAuthorizationTransactionOutcome(teamName, firstId)
    ).resolves.toMatchObject({ status: 'launch-unknown' });
    await expect(
      new TeamMembersMetaStore().writeMembers(teamName, [{ name: 'concurrent' }])
    ).rejects.toThrow('Roster is busy');
    await expect(
      service.rollbackRosterAuthorizationTransaction(teamName, firstId)
    ).resolves.toMatchObject({ status: 'launch-unknown' });
    await expect(
      service.commitRosterAuthorizationTransaction(teamName, firstId)
    ).resolves.toMatchObject({ status: 'launch-unknown' });
  });

  it('preserves a fresh applied reservation when another UUID competes', async () => {
    const service = new TeamDataService();
    await service.beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [
        {
          runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'abandoned',
        },
      ],
    });

    await expect(
      new TeamDataService().beginRosterAuthorizationTransaction(teamName, secondId, {
        members: [
          {
            runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
            name: 'replacement',
          },
        ],
      })
    ).rejects.toThrow('busy with recoverable transaction');
    await expect(
      service.getRosterAuthorizationTransactionOutcome(teamName, firstId)
    ).resolves.toMatchObject({ status: 'applied' });
  });

  it('preserves a fresh prepared reservation when another UUID competes', async () => {
    const service = new TeamDataService();
    await service.beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [
        {
          runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'prepared-abandoned',
        },
      ],
    });
    await service.rosterAuthorizationTransactions.prepare(
      teamName,
      firstId,
      firstId,
      exactProof,
      launchFingerprint
    );

    await expect(
      new TeamDataService().beginRosterAuthorizationTransaction(teamName, secondId, {
        members: [
          {
            runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
            name: 'replacement',
          },
        ],
      })
    ).rejects.toThrow('busy with recoverable transaction');
    await expect(
      new TeamDataService().getRosterAuthorizationTransactionOutcome(teamName, firstId)
    ).resolves.toMatchObject({ status: 'prepared' });
  });

  it('recovers a durable succeeded command after a crash before transaction commit', async () => {
    const service = new TeamDataService();
    await service.beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [
        {
          runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'alice',
        },
      ],
    });
    await service.rosterAuthorizationTransactions.prepare(
      teamName,
      firstId,
      firstId,
      exactProof,
      launchFingerprint
    );
    const invoked = await service.rosterAuthorizationTransactions.prepareLaunchInvocationIntent(
      teamName,
      firstId
    );
    await service.rosterAuthorizationTransactions.recordLaunchDispatched(teamName, firstId);
    await fs.writeFile(
      path.join(sandbox, 'teams', teamName, 'bootstrap-state.json'),
      JSON.stringify({
        runId: firstId,
        members: [{ name: 'alice', status: 'bootstrap_confirmed' }],
      })
    );
    const originalAtomicWrite = atomicWrite.atomicWriteAsync;
    const write = vi.spyOn(atomicWrite, 'atomicWriteAsync').mockImplementation(async (...args) => {
      const [filePath, contents] = args;
      if (
        String(filePath).includes('.roster-authorization-transactions') &&
        typeof contents === 'string' &&
        JSON.parse(contents).status === 'committed'
      ) {
        throw new Error('crash-before-transaction-commit');
      }
      return originalAtomicWrite(...args);
    });
    await expect(
      service.rosterAuthorizationTransactions.recordLaunchResult(teamName, firstId, {
        transactionId: firstId,
        teamName,
        rosterFingerprint: invoked.targetFingerprint!,
        rosterRevision: invoked.rosterRevision!,
        launchCommandId: invoked.launchCommandId!,
        executionProof: exactProof,
        launchRequestFingerprint: launchFingerprint,
        runId: firstId,
        attemptId: invoked.launchCommandId!,
        launchStatus: 'started',
      })
    ).rejects.toThrow('crash-before-transaction-commit');
    write.mockRestore();

    await expect(
      new TeamDataService().getRosterAuthorizationTransactionOutcome(teamName, firstId)
    ).resolves.toMatchObject({
      status: 'committed',
      launchRunId: firstId,
    });
  });

  it('rejects a launch result whose transaction binding or attempt identity is mismatched', async () => {
    const service = new TeamDataService();
    await service.beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [
        {
          runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'alice',
        },
      ],
    });
    await service.rosterAuthorizationTransactions.prepare(
      teamName,
      firstId,
      firstId,
      exactProof,
      launchFingerprint
    );
    const invoked = await service.rosterAuthorizationTransactions.prepareLaunchInvocationIntent(
      teamName,
      firstId
    );

    await expect(
      service.rosterAuthorizationTransactions.recordLaunchResult(teamName, firstId, {
        transactionId: secondId,
        teamName,
        rosterFingerprint: invoked.targetFingerprint!,
        rosterRevision: invoked.rosterRevision!,
        launchCommandId: invoked.launchCommandId!,
        executionProof: exactProof,
        launchRequestFingerprint: launchFingerprint,
        runId: 'arbitrary-run',
        attemptId: '',
        launchStatus: 'started',
      })
    ).resolves.toMatchObject({
      status: 'launch-unknown',
      message: expect.stringContaining('binding'),
    });
    await expect(
      new TeamDataService().beginRosterAuthorizationTransaction(teamName, secondId, {
        members: [
          {
            runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
            name: 'bob',
          },
        ],
      })
    ).rejects.toThrow('busy with recoverable transaction');
  });

  it('keeps legacy launch records with omitted exact proof fields unknown', async () => {
    const service = new TeamDataService();
    await service.beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [
        {
          runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'alice',
        },
      ],
    });
    const prepared = await service.rosterAuthorizationTransactions.prepare(teamName, firstId);
    expect(prepared).toMatchObject({ status: 'prepared' });
    expect(prepared.launchBinding).toBeUndefined();
    const replayed = await new TeamDataService().rosterAuthorizationTransactions.prepare(
      teamName,
      firstId
    );
    expect(replayed).toMatchObject({ status: 'prepared' });
    expect(replayed.launchBinding).toBeUndefined();
    await expect(
      new TeamDataService().rosterAuthorizationTransactions.prepare(
        teamName,
        firstId,
        firstId,
        exactProof,
        launchFingerprint
      )
    ).resolves.toMatchObject({ status: 'conflict' });
    await service.rosterAuthorizationTransactions.prepareLaunchInvocationIntent(teamName, firstId);
    await service.rosterAuthorizationTransactions.recordLaunchDispatched(teamName, firstId);

    await expect(
      service.rosterAuthorizationTransactions.recordLaunchResult(teamName, firstId, {
        transactionId: firstId,
        teamName,
        rosterFingerprint: prepared.targetFingerprint!,
        rosterRevision: prepared.rosterRevision!,
        launchCommandId: firstId,
        runId: firstId,
        attemptId: firstId,
        launchStatus: 'started',
      })
    ).resolves.toMatchObject({
      status: 'launch-unknown',
      message: expect.stringContaining('exact request binding'),
    });
  });

  it('reconciles crashes before and after the durable roster publish idempotently', async () => {
    const beforePublishStore = new TeamMembersMetaStore();
    vi.spyOn(beforePublishStore, 'writeDurableRawCasUnderLock').mockRejectedValueOnce(
      new Error('crash-before-roster-publish')
    );
    const beforePublish = new TeamDataService(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      beforePublishStore
    );
    await expect(
      beforePublish.beginRosterAuthorizationTransaction(teamName, firstId, {
        members: [
          {
            runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
            name: 'alice',
          },
        ],
      })
    ).rejects.toThrow('crash-before-roster-publish');
    await expect(
      new TeamDataService().getRosterAuthorizationTransactionOutcome(teamName, firstId)
    ).resolves.toMatchObject({ status: 'rolled-back' });

    const afterPublishStore = new TeamMembersMetaStore();
    const durableWrite = afterPublishStore.writeDurableRawCasUnderLock.bind(afterPublishStore);
    vi.spyOn(afterPublishStore, 'writeDurableRawCasUnderLock').mockImplementationOnce(
      async (nextTeamName, raw, expectedFingerprint, transactionId) => {
        await durableWrite(nextTeamName, raw, expectedFingerprint, transactionId);
        throw new Error('crash-after-roster-publish');
      }
    );
    const afterPublish = new TeamDataService(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      afterPublishStore
    );
    await expect(
      afterPublish.beginRosterAuthorizationTransaction(teamName, secondId, {
        members: [
          {
            runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
            name: 'bob',
          },
        ],
      })
    ).rejects.toThrow('crash-after-roster-publish');
    await expect(
      new TeamDataService().getRosterAuthorizationTransactionOutcome(teamName, secondId)
    ).resolves.toMatchObject({ status: 'applied' });
    await expect(
      new TeamDataService().getRosterAuthorizationTransactionOutcome(teamName, secondId)
    ).resolves.toMatchObject({ status: 'applied' });
  });

  it('does not journal terminal rollback until strict parent-directory durability succeeds', async () => {
    const service = new TeamDataService();
    await service.beginRosterAuthorizationTransaction(teamName, firstId, {
      members: [
        {
          runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'alice',
        },
      ],
    });
    const sync = vi
      .spyOn(atomicWrite, 'syncDirectoryDurably')
      .mockRejectedValueOnce(Object.assign(new Error('fsync failed'), { code: 'EIO' }));
    await expect(service.rollbackRosterAuthorizationTransaction(teamName, firstId)).rejects.toThrow(
      'fsync failed'
    );
    const journalPath = path.join(
      sandbox,
      'teams',
      teamName,
      '.roster-authorization-transactions',
      `${firstId}.json`
    );
    expect(JSON.parse(await fs.readFile(journalPath, 'utf8'))).toMatchObject({
      status: 'applied',
      priorRawBase64: null,
    });
    sync.mockRestore();
    await expect(
      new TeamDataService().getRosterAuthorizationTransactionOutcome(teamName, firstId)
    ).resolves.toMatchObject({ status: 'rolled-back' });
    expect(JSON.parse(await fs.readFile(journalPath, 'utf8'))).not.toHaveProperty('priorRawBase64');
  });
});
