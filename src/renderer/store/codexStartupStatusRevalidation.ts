import type { CliInstallerSlice } from './slices/cliInstallerSlice';
import type {
  CodexAccountElectronApi,
  CodexAccountSnapshotDto,
} from '@features/codex-account/contracts';
import type { StoreApi } from 'zustand';

type StatusStore = Pick<StoreApi<CliInstallerSlice>, 'getState' | 'setState' | 'subscribe'>;
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
  let accountLookupPending = false;
  let recheckPending = false;

  const setPending = (pending: boolean): void => {
    if (store.getState().codexStatusRecoveryPending !== pending) {
      store.setState({ codexStatusRecoveryPending: pending });
    }
  };
  const updatePending = (): void => {
    if (disposed) return;
    const state = store.getState();
    const provider = state.cliStatus?.providers.find((item) => item.providerId === 'codex');
    const recoveryCandidate =
      state.cliStatus?.flavor === 'agent_teams_orchestrator' &&
      state.cliStatus.installed &&
      provider?.statusCheckOutcome === 'authoritative' &&
      provider.verificationState === 'unknown' &&
      !provider.authenticated;
    setPending(
      recheckPending ||
        Boolean(
          recoveryCandidate &&
          (accountLookupPending || !snapshotReadStarted || (accountReady && !rechecked))
        )
    );
  };

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
      recheckPending = true;
      updatePending();
      void state
        .fetchCliProviderStatus('codex', { checkReason: 'runtime_event' })
        .catch(() => {
          // The store owns errors. Repeated account pushes must not create a retry loop.
        })
        .finally(() => {
          recheckPending = false;
          updatePending();
        });
    } else if (!snapshotReadStarted) {
      // Read only after an inconclusive startup probe, including when the account
      // was already warm before this listener attached. Avoid extra cold-start work.
      snapshotReadStarted = true;
      accountLookupPending = true;
      updatePending();
      const revision = snapshotRevision;
      void accountApi
        .getCodexAccountSnapshot()
        .then((snapshot) => {
          if (!disposed && revision === snapshotRevision) applySnapshot(snapshot);
        })
        .catch(() => undefined)
        .finally(() => {
          accountLookupPending = false;
          scheduleCheck();
        });
    }
  };

  function scheduleCheck(): void {
    if (disposed) return;
    // Publish the recovery gap synchronously, before scheduling its account read.
    updatePending();
    if (queued) return;
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
    setPending(false);
  };
}
