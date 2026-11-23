import assert from 'node:assert/strict';
import { ChildProcess, execFileSync } from 'node:child_process';

import {
  groupMembers,
  isCapturedOriginalNodeZombie,
  observeOriginalAppReap,
  portOccupied,
  processTable,
  settledGroupMembers,
} from './desktop-backend-observations.ts';
import { bounded } from './desktop-proof-bounds.ts';
import { requestObservedDesktopClose } from './startup-passive-observer.ts';

import type { DesktopCdpPort } from './desktop-captured-app.ts';
import type { OwnerRoutingRow } from './desktop-owner-routing-fixture.ts';

/** A refused invocation is never signal authority; only original exit and absence may settle it. */
async function observeOriginalEpochNaturalExit(input: {
  app: ChildProcess;
  group: number;
  initialMembers: ReturnType<typeof groupMembers>;
  hosts: readonly { pid: number }[];
  expectedIdentity: string;
  observedIdentity: string;
  deadline: number;
}) {
  const initialMemberCount = input.initialMembers.length, hostCount = input.hosts.length;
  const initialMembers = initialMemberCount <= 256
    ? input.initialMembers.map((member) => ({ ...member })) : [];
  const hostPids = hostCount <= 256 ? input.hosts.map((host) => host.pid) : [];
  const originalPids = new Set(initialMembers.map((member) => member.pid));
  const leader = initialMembers.find((member) => member.pid === input.group);
  const identity = /^([A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+(.+)$/;
  const expected = identity.exec(input.expectedIdentity), observed = identity.exec(input.observedIdentity);
  let remaining: ReturnType<typeof groupMembers> | null = null;
  let originalPidsAbsent: boolean | null = null, hostsAbsent: boolean | null = null;
  const result = (settled: boolean, reason: string) => ({
    settled, reason, initialMemberCount, initialMembers, hostCount, hostPids,
    remaining: remaining?.slice(0, 256) ?? null, remainingCount: remaining?.length ?? null,
    originalPidsAbsent, hostsAbsent, appExitCode: input.app.exitCode, appSignalCode: input.app.signalCode,
    signalAuthority: false,
  });
  if (
    (process.platform !== 'darwin' && process.platform !== 'linux') ||
    !(input.app instanceof ChildProcess) ||
    !Number.isSafeInteger(input.group) || input.group <= 0 || input.app.pid !== input.group ||
    !Number.isFinite(input.deadline) || !expected || !observed || expected[1] !== observed[1] ||
    !/(?:^|\/)node\s+/.test(expected[2]!) || !/(?:^|\s)dev:mcp(?:\s|$)/.test(expected[2]!) ||
    initialMemberCount === 0 || initialMemberCount > 256 || originalPids.size !== initialMemberCount ||
    initialMembers.some((member) => !Number.isSafeInteger(member.pid) || member.pid <= 0 || member.pgid !== input.group) ||
    leader?.ppid !== process.pid || leader.pgid !== input.group ||
    hostCount === 0 || hostCount > 256 || new Set(hostPids).size !== hostCount ||
    hostPids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0 || pid === input.group)
  ) return result(false, 'ineligible-original-epoch-exit-observation');

  // The observed argv stays refused. This read-only path does not classify a display alias as owned.
  while (Date.now() < input.deadline) {
    if (input.app.pid !== input.group || input.app.signalCode !== null ||
        (input.app.exitCode !== null && input.app.exitCode !== 0))
      return result(false, 'original-child-exit-not-natural-zero');
    const table = processTable();
    remaining = table.filter((member) => member.pgid === input.group);
    originalPidsAbsent = initialMembers.every((original) => !table.some((member) => member.pid === original.pid));
    hostsAbsent = hostPids.every((pid) => !table.some((member) => member.pid === pid));
    if (Date.now() >= input.deadline) break;
    if (input.app.pid !== input.group || input.app.signalCode !== null ||
        (input.app.exitCode !== null && input.app.exitCode !== 0))
      return result(false, 'original-child-exit-not-natural-zero');
    if (input.app.exitCode === 0 && remaining.length === 0 && originalPidsAbsent && hostsAbsent)
      return result(true, 'original-natural-exit-and-fresh-absence');
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(100, Math.max(0, input.deadline - Date.now())))
    );
  }
  return result(false, 'original-observation-deadline');
}

/** Only this owner-proof epoch: the ordinary harness identity/signal rules remain unchanged. */
export async function finishDesktopOwnerRoutingEpoch(options: {
  app: ChildProcess;
  group: number;
  appIdentity: string;
  cdp: DesktopCdpPort | undefined;
  hosts: readonly { pid: number }[];
  epoch: OwnerRoutingRow;
  assertOwned(): void;
}) {
  const { app, group, appIdentity, cdp, hosts, epoch } = options;
  let quitAttempted = false;
  let remaining: ReturnType<typeof groupMembers> | null = null;
  let hostsAbsent: boolean | null = null;
  let signalAttempted = false;
  let naturalExit: Awaited<ReturnType<typeof observeOriginalEpochNaturalExit>> | undefined;
  const pause = () => new Promise<void>((done) => setTimeout(done, 100));
  try {
    if (cdp) {
      await requestObservedDesktopClose(cdp, {
        assertOwnedRenderer: options.assertOwned,
        onAttempt: () => {
          quitAttempted = true;
        },
        listenerPresent: () => processTable().some((entry) => entry.pid === epoch.cdpListener),
        evidence: epoch,
        key: 'failureQuit',
      });
      await bounded(cdp.close(), 3000, 'disconnect exact owner epoch renderer');
    }
    const hostDeadline = Date.now() + 20_000;
    while (
      Date.now() < hostDeadline &&
      hosts.some((host) => processTable().some((entry) => entry.pid === host.pid))
    )
      await pause();
    const observationDeadline = Date.now() + 3000;
    remaining = await settledGroupMembers(group, observationDeadline);
    if (remaining.length) {
      assert.ok(
        appIdentity && remaining.some((entry) => entry.pid === group),
        'original epoch leader absent; retain debt without signaling'
      );
      const observedIdentity = execFileSync(
        '/bin/ps',
        ['-p', String(group), '-o', 'lstart=,command='],
        { encoding: 'utf8', timeout: 3000 }
      ).trim();
      if (observedIdentity !== appIdentity && hosts.length) {
        const reaped = await observeOriginalAppReap({
          child: app,
          group,
          hostPid: hosts[0]!.pid,
          initialMembers: remaining,
          expectedIdentity: appIdentity,
          observedIdentity,
          deadline: observationDeadline,
        });
        epoch.originalAppReap = reaped;
        if (reaped.settled) remaining = reaped.remaining!;
      }
      if (remaining.length) {
        let originalZombie = false;
        if (observedIdentity !== appIdentity) {
          // No command-alias shortcut: a macOS zombie is still the original
          // unreaped child with its captured birth, group, and harness parent.
          // Any live changed command or missing evidence refuses all signals.
          const state = execFileSync(
            '/bin/ps',
            ['-p', String(group), '-o', 'stat='],
            { encoding: 'utf8', timeout: 3000 }
          ).trim();
          originalZombie = isCapturedOriginalNodeZombie({
            expectedIdentity: appIdentity,
            observedIdentity,
            state,
            childPid: app.pid,
            group,
            leader: groupMembers(group).find((entry) => entry.pid === group),
            parentPid: process.pid,
          });
          if (originalZombie) {
            epoch.originalZombieGuard = { group, state, status: 'verified-original-zombie' };
          }
        }
        if (observedIdentity !== appIdentity && !originalZombie) {
          naturalExit = await observeOriginalEpochNaturalExit({
            app, group, initialMembers: remaining, hosts,
            expectedIdentity: appIdentity, observedIdentity, deadline: observationDeadline,
          });
          epoch.originalNaturalExit = naturalExit;
          if (naturalExit.settled) remaining = naturalExit.remaining!;
        }
        if (remaining.length) {
          assert.ok(
            observedIdentity === appIdentity || originalZombie,
            'original epoch invocation identity remains current'
          );
          signalAttempted = true;
          try {
            process.kill(-group, 'SIGTERM');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline && (remaining = groupMembers(group)).length) await pause();
        }
      }
    }
    if (naturalExit?.settled)
      assert.ok(Date.now() < observationDeadline, 'original natural-exit deadline before final census');
    const finalTable = processTable();
    hostsAbsent = hosts.every((host) => !finalTable.some((entry) => entry.pid === host.pid));
    if (naturalExit?.settled) {
      remaining = finalTable.filter((entry) => entry.pgid === group);
      const originalPidsAbsent = naturalExit.initialMembers.every((original) =>
        !finalTable.some((entry) => entry.pid === original.pid));
      const originalHostsAbsent = naturalExit.hostPids.every((pid) =>
        !finalTable.some((entry) => entry.pid === pid));
      epoch.originalNaturalExitFinal = {
        originalPidsAbsent, originalHostsAbsent, remainingCount: remaining.length,
        appExitCode: app.exitCode, appSignalCode: app.signalCode,
      };
      assert.ok(app.pid === group && app.exitCode === 0 && app.signalCode === null,
        'original retained child still exited naturally before the next epoch');
      assert.equal(originalPidsAbsent, true, 'every original epoch PID remains absent in the final census');
      assert.equal(originalHostsAbsent, true, 'every original owner Host remains absent in the final census');
    }
    assert.deepEqual(remaining, [], 'no next configuration while the captured epoch group remains');
    assert.equal(hostsAbsent, true, 'every captured owner Host is absent before the next epoch');
    if (naturalExit?.settled)
      assert.ok(Date.now() < observationDeadline, 'original natural-exit deadline after final census');
    assert.equal(await portOccupied(), false);
    if (naturalExit?.settled)
      assert.ok(Date.now() < observationDeadline, 'original natural-exit deadline after port qualification');
  } catch (error) {
    epoch.cleanupFailure =
      error instanceof Error ? error.message.slice(0, 4000) : 'epoch cleanup unavailable';
    throw error;
  } finally {
    epoch.cleanup = {
      remaining,
      hosts,
      hostsAbsent,
      appExitCode: app.exitCode,
      appSignalCode: app.signalCode,
      quitAttempted,
      signalAttempted,
      scope:
        'Guarded original app close and established exact-identity wrapper cleanup; no universal natural-exit qualification',
    };
  }
}
