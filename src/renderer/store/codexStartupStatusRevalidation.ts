import type { CliInstallerSlice } from './slices/cliInstallerSlice';
import type {
  CodexAccountElectronApi,
  CodexAccountSnapshotDto,
} from '@features/codex-account/contracts';
import type { StoreApi } from 'zustand';

type StatusStore = Pick<StoreApi<CliInstallerSlice>, 'getState' | 'subscribe'>;
type AccountApi = Pick<
  CodexAccountElectronApi,
  'getCodexAccountSnapshot' | 'onCodexAccountSnapshotChanged'
>;

/** A cold passive probe can run before the managed account context is cached.
 * Account readiness only requests fresh runtime evidence; it never grants authority.
 */
export function installCodexStartupStatusRevalidation(
  store: StatusStore,
  accountApi: AccountApi
): () => void {
  let disposed = false;
  let queued = false;
  let accountReady = false;
  let rechecked = false;
  let snapshotReadStarted = false;
  let snapshotRevision = 0;

  const applySnapshot = (snapshot: CodexAccountSnapshotDto): void => {
    accountReady =
      snapshot.effectiveAuthMode === 'chatgpt' &&
      snapshot.launchAllowed &&
      snapshot.login.status === 'idle';
    if (!accountReady) rechecked = false;
    scheduleCheck();
  };

  const check = (): void => {
    if (disposed || rechecked) return;
    const state = store.getState();
    const provider = state.cliStatus?.providers.find((item) => item.providerId === 'codex');
    if (
      state.cliStatus?.flavor !== 'agent_teams_orchestrator' ||
      !state.cliStatus.installed ||
      state.cliStatusLoading ||
      state.cliProviderStatusLoading.codex ||
      provider?.statusCheckOutcome !== 'authoritative' ||
      provider.verificationState !== 'unknown' ||
      provider.authenticated
    )
      return;

    if (accountReady) {
      rechecked = true;
      void state.fetchCliProviderStatus('codex', { checkReason: 'runtime_event' }).catch(() => {
        // The store owns errors. Repeated rate-limit pushes must not create a retry loop.
      });
    } else if (!snapshotReadStarted) {
      // Read only after an inconclusive startup probe, including when the account
      // was already warm before this listener attached. Avoid extra cold-start work.
      snapshotReadStarted = true;
      const revision = snapshotRevision;
      void accountApi
        .getCodexAccountSnapshot()
        .then((snapshot) => {
          if (!disposed && revision === snapshotRevision) applySnapshot(snapshot);
        })
        .catch(() => undefined);
    }
  };

  function scheduleCheck(): void {
    if (disposed || queued) return;
    queued = true;
    // Let the completed status request retire its in-flight deduplication entry
    // before starting the recheck; otherwise it would join the old unknown read.
    queueMicrotask(() => {
      queued = false;
      check();
    });
  }

  const unsubscribeAccount = accountApi.onCodexAccountSnapshotChanged((_event, snapshot) => {
    snapshotRevision += 1;
    applySnapshot(snapshot);
  });
  const unsubscribeStore = store.subscribe(scheduleCheck);
  scheduleCheck();

  return () => {
    disposed = true;
    unsubscribeAccount();
    unsubscribeStore();
  };
}
