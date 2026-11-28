import assert from 'node:assert/strict';
import { command, processTable } from './desktop-backend-observations.ts';
import { runDesktopNativeReviewContinuation } from './desktop-native-review-continuation.ts';
import { runDesktopNativeReviewReadback } from './desktop-native-review-readback.ts';
import { runDesktopNativeReviewUiSmoke } from './desktop-native-review-ui-smoke.ts';
import { runDesktopOpenCodeV2ReviewUiSmoke } from './desktop-opencode-v2-review-ui-smoke.ts';
import { captureDesktopOpenCodeV2ColdMetadata } from './desktop-opencode-v2-cold-metadata.ts';
import type { startOpenCodeV2ReviewModel } from './desktop-opencode-v2-review-model.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
/** Narrow TEST mode dispatch; original UI helpers retain all mutation and readback boundaries. */
export async function runDesktopNativeReview(
  cdp: UiCdpPort,
  options: {
    fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
    model?: Awaited<ReturnType<typeof startNativeTeamModel>>;
    openCodeReviewModel?: Awaited<ReturnType<typeof startOpenCodeV2ReviewModel>>;
    evidence: Record<string, unknown>;
    readback: boolean;
    continuation?: boolean;
    group: number;
    onHostObserved(pid: number): void;
    assertOwnedRenderer(): void;
  }
): Promise<void> {
  if (!options.readback) {
    const model = options.openCodeReviewModel ?? options.model;
    assert.ok(model);
    const selected = {
      ...options,
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
    };
    if (options.openCodeReviewModel) {
      assert.equal(options.model, undefined);
      await runDesktopOpenCodeV2ReviewUiSmoke(cdp, { ...selected, model: options.openCodeReviewModel });
    } else { assert.ok(options.model); await runDesktopNativeReviewUiSmoke(cdp, { ...selected, model: options.model }); }
    return;
  }
  assert.equal(options.model, undefined, 'cold review readback never starts a model oracle');
  assert.equal(options.openCodeReviewModel, undefined, 'cold V2 review never starts inference');
  const metadata = await captureDesktopOpenCodeV2ColdMetadata(cdp, {
    ...options,
    ...options.fixture,
  });
  if (metadata) options.onHostObserved(metadata.hostPid);
  await (
    options.continuation ? runDesktopNativeReviewContinuation : runDesktopNativeReviewReadback
  )(cdp, {
    ...options,
    root: options.fixture.root,
    metadataProcessCount: metadata?.metadataProcessCount ?? 0,
    assertNoNativeChildren: () => {
      if (metadata) return metadata.assertNoRuntimeChildren();
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
