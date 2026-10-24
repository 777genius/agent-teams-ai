import assert from 'node:assert/strict';
import { command, processTable } from './desktop-backend-observations.ts';
import { runDesktopNativeReviewContinuation } from './desktop-native-review-continuation.ts';
import { runDesktopNativeReviewReadback } from './desktop-native-review-readback.ts';
import { runDesktopNativeReviewUiSmoke } from './desktop-native-review-ui-smoke.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
/** Narrow TEST mode dispatch; original UI helpers retain all mutation and readback boundaries. */
export async function runDesktopNativeReview(
  cdp: UiCdpPort,
  options: {
    fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
    model?: Awaited<ReturnType<typeof startNativeTeamModel>>;
    evidence: Record<string, unknown>;
    readback: boolean;
    continuation?: boolean;
    group: number;
    onHostObserved(pid: number): void;
    assertOwnedRenderer(): void;
  }
): Promise<void> {
  if (!options.readback) {
    assert.ok(options.model);
    await runDesktopNativeReviewUiSmoke(cdp, {
      ...options,
      model: options.model,
      observeOwnedHost: () => {
        const hosts = processTable().filter(
          (row) =>
            row.pgid === options.group &&
            command(row.pid) === `${options.fixture.node} ${options.fixture.hostEntry}`
        );
        assert.equal(hosts.length, 1, 'one exact selected Host before native Launch Submit');
        options.onHostObserved(hosts[0]!.pid);
        options.evidence.hostChildBeforeNativeReview = {
          ...hosts[0],
          observedBeforeShutdown: true,
        };
      },
    });
    return;
  }
  assert.equal(options.model, undefined, 'cold review readback never starts a model oracle');
  await (
    options.continuation ? runDesktopNativeReviewContinuation : runDesktopNativeReviewReadback
  )(cdp, {
    ...options,
    root: options.fixture.root,
    assertNoNativeChildren: () => {
      const table = processTable();
      const hosts = table.filter(
        (row) =>
          row.pgid === options.group &&
          command(row.pid) === `${options.fixture.node} ${options.fixture.hostEntry}`
      );
      assert.equal(hosts.length, 1);
      options.onHostObserved(hosts[0]!.pid);
      assert.deepEqual(
        table.filter((row) => row.ppid === hosts[0]!.pid),
        [],
        'no native child during cold review readback'
      );
    },
  });
}
