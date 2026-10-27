import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
  groupMembers,
  observeOriginalAppReap,
  portOccupied,
  processTable,
  settledGroupMembers,
} from './desktop-backend-observations.ts';
import { bounded } from './desktop-proof-bounds.ts';
import { requestObservedDesktopClose } from './startup-passive-observer.ts';

import type { ChildProcess } from 'node:child_process';
import type { DesktopCdpPort } from './desktop-captured-app.ts';
import type { OwnerRoutingRow } from './desktop-owner-routing-fixture.ts';

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
        assert.equal(
          observedIdentity,
          appIdentity,
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
    const finalTable = processTable();
    hostsAbsent = hosts.every((host) => !finalTable.some((entry) => entry.pid === host.pid));
    assert.deepEqual(remaining, [], 'no next configuration while the captured epoch group remains');
    assert.equal(hostsAbsent, true, 'every captured owner Host is absent before the next epoch');
    assert.equal(await portOccupied(), false);
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
