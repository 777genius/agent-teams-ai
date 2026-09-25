import {
  HostedTaskBoardMutationGrantAuthority,
  parseProductTaskGrantEvidence,
  sameProductTaskRunPin,
} from '@main/composition/hosted/hostedTaskBoardMutationGrantAuthority';
import { createQueryContext, parseBootId, parseDeploymentId } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

import type { HostedTaskMutationCommand } from '@features/team-task-board/main/hosted';

const context = () =>
  createQueryContext({
    actorId: 'actor_task-grant-test',
    sessionId: 'session_task-grant-test',
    deploymentId: parseDeploymentId(`deployment_${'a'.repeat(32)}`),
    bootId: parseBootId(`boot_${'b'.repeat(32)}`),
    requestId: 'request_task-grant-test',
    authorizedScope: 'scope_task-grant-test',
    deadlineAtMs: Date.now() + 60_000,
    signal: new AbortController().signal,
  });

describe('Product task mutation grant', () => {
  it('captures the current v35 run pin and retains legacy evidence only for parsing', async () => {
    const grant = { grantRevision: 'a'.repeat(64), identityChecksum: 'b'.repeat(64) };
    const runPin = {
      runId: `run_${'c'.repeat(32)}`,
      deploymentId: `deployment_${'a'.repeat(32)}`,
      bootId: `boot_${'b'.repeat(32)}`,
      ownerAuthority: 'owner-authority_test',
      ownerGeneration: 3,
      ownerSessionId: 'owner-session_test',
      restoreGeneration: 1,
      mountGeneration: 4,
    };
    const authority = new HostedTaskBoardMutationGrantAuthority({
      assertCurrent: async () => runPin,
    });
    const query = context();
    authority.bind(query, { ownerEffectFence: grant, revalidate: async () => true });
    await authority.assertCurrent({} as HostedTaskMutationCommand, query);
    const evidence = authority.evidenceFor(query);
    expect(evidence).toEqual({ ...grant, runPin });
    expect(parseProductTaskGrantEvidence(JSON.parse(JSON.stringify(evidence)))).toEqual(evidence);
    expect(parseProductTaskGrantEvidence(grant)).toEqual(grant);
    const unpinned = new HostedTaskBoardMutationGrantAuthority({
      assertCurrent: async () => undefined as never,
    });
    const unpinnedQuery = context();
    unpinned.bind(unpinnedQuery, { ownerEffectFence: grant, revalidate: async () => true });
    await expect(unpinned.assertCurrent({} as HostedTaskMutationCommand, unpinnedQuery)).rejects.toThrow(
      'hosted-task-board-run-pin-invalid'
    );
  });

  it('round-trips a stopped-team pin without a run and keeps it distinct from a run pin', async () => {
    const grant = { grantRevision: 'a'.repeat(64), identityChecksum: 'b'.repeat(64) };
    const runPin = {
      runId: null,
      deploymentId: `deployment_${'a'.repeat(32)}`,
      bootId: `boot_${'b'.repeat(32)}`,
      ownerAuthority: 'owner-authority_test',
      ownerGeneration: 3,
      ownerSessionId: 'owner-session_test',
      restoreGeneration: 1,
      mountGeneration: 4,
    };
    const authority = new HostedTaskBoardMutationGrantAuthority({
      assertCurrent: async () => runPin,
    });
    const query = context();
    authority.bind(query, { ownerEffectFence: grant, revalidate: async () => true });
    await authority.assertCurrent({} as HostedTaskMutationCommand, query);
    const evidence = authority.evidenceFor(query);
    expect(evidence).toEqual({ ...grant, runPin });
    const persisted = parseProductTaskGrantEvidence(JSON.parse(JSON.stringify(evidence)));
    expect(persisted).toEqual(evidence);
    expect(sameProductTaskRunPin(persisted.runPin, runPin)).toBe(true);
    expect(
      sameProductTaskRunPin(persisted.runPin, { ...runPin, runId: `run_${'c'.repeat(32)}` })
    ).toBe(false);
    expect(sameProductTaskRunPin(undefined, runPin)).toBe(false);
    expect(() =>
      parseProductTaskGrantEvidence({ ...grant, runPin: { ...runPin, runId: 'run_invalid' } })
    ).toThrow('hosted-task-board-run-pin-invalid');
  });

  it('rejects an epoch change under the same grant during publication', async () => {
    const grant = { grantRevision: 'a'.repeat(64), identityChecksum: 'b'.repeat(64) };
    let ownerGeneration = 4;
    const authority = new HostedTaskBoardMutationGrantAuthority({
      assertCurrent: async () => ({
        runId: `run_${'c'.repeat(32)}`,
        deploymentId: `deployment_${'a'.repeat(32)}`,
        bootId: `boot_${'b'.repeat(32)}`,
        ownerAuthority: 'owner-authority_test',
        ownerGeneration,
        ownerSessionId: 'owner-session_test',
        restoreGeneration: 1,
        mountGeneration: 1,
      }),
    });
    const query = context();
    authority.bind(query, { ownerEffectFence: grant, revalidate: async () => true });
    await authority.assertCurrent({} as HostedTaskMutationCommand, query);
    ownerGeneration = 5;
    await expect(authority.assertCurrent({} as HostedTaskMutationCommand, query)).rejects.toThrow(
      'hosted-task-board-run-pin-stale'
    );
    expect(authority.evidenceFor(query)?.runPin?.ownerGeneration).toBe(4);
  });

  it('rejects revocation while the current member authority read is pending', async () => {
    const runPin = {
      runId: `run_${'e'.repeat(32)}`,
      deploymentId: `deployment_${'a'.repeat(32)}`,
      bootId: `boot_${'b'.repeat(32)}`,
      ownerAuthority: 'owner-authority_test',
      ownerGeneration: 1,
      ownerSessionId: 'owner-session_test',
      restoreGeneration: 1,
      mountGeneration: 1,
    };
    let releaseRead!: () => void;
    let reachedRead!: () => void;
    const waiting = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      reachedRead = resolve;
    });
    let granted = true;
    const authority = new HostedTaskBoardMutationGrantAuthority({
      assertCurrent: async () => {
        reachedRead();
        await waiting;
        return { ...runPin, runId: `run_${'e'.repeat(32)}` };
      },
    });
    const query = context();
    authority.bind(query, {
      ownerEffectFence: { grantRevision: 'c'.repeat(64), identityChecksum: 'd'.repeat(64) },
      revalidate: async () => granted,
    });
    const command = {} as HostedTaskMutationCommand;
    const pending = authority.assertCurrent(command, query);
    await reached;
    granted = false;
    releaseRead();
    await expect(pending).rejects.toThrow('hosted-task-board-grant-stale');
    authority.release(query);
    await expect(authority.assertCurrent(command, query)).rejects.toThrow(
      'hosted-task-board-grant-stale'
    );
  });
});
