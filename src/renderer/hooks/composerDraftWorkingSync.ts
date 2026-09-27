import { sameComposerDraftAddress } from '@renderer/utils/composerDraftIdentity';

import type {
  ComposerDraftAddress,
  ComposerDraftRepository,
  ComposerWorkingRecord,
} from '@renderer/types/composerDraft';

interface Ref<T> {
  current: T;
}
type LoadedWorking = Awaited<ReturnType<ComposerDraftRepository['loadWorking']>>;

export async function loadWorkingAfterEvents(
  repository: ComposerDraftRepository,
  address: ComposerDraftAddress,
  eventVersion: Ref<number>,
  isCurrent: () => boolean
): Promise<{ loaded: LoadedWorking; observedVersion: number }> {
  let observedVersion: number;
  let loaded: LoadedWorking;
  do {
    observedVersion = eventVersion.current;
    loaded = await repository.loadWorking(address);
  } while (observedVersion !== eventVersion.current && isCurrent());
  return { loaded, observedVersion };
}

export function subscribeToComposerWorkingChanges(options: {
  repository: ComposerDraftRepository;
  addressRef: Ref<ComposerDraftAddress>;
  addressKeyRef: Ref<string>;
  mountedRef: Ref<boolean>;
  hydratedRef: Ref<boolean>;
  workingEventVersionRef: Ref<number>;
  loadGenerationRef: Ref<number>;
  localEditCounterRef: Ref<number>;
  pendingSaveRef: Ref<{ addressKey: string } | null>;
  heldAttemptSaveRef: Ref<{ addressKey: string } | null>;
  activePersistenceByAddressRef: Ref<Map<string, number>>;
  attemptAddressKeyRef: Ref<string | null>;
  syncPendingByAddressRef: Ref<Map<string, Promise<void>>>;
  onClearedRevision: (key: string, revision: string) => void;
  apply: (working: ComposerWorkingRecord, key: string, loaded: LoadedWorking) => void;
}): () => void {
  const { repository } = options;
  return repository.subscribe((event) => {
    if (
      event.kind !== 'working' ||
      !event.address ||
      !sameComposerDraftAddress(event.address, options.addressRef.current)
    )
      return;
    const version = ++options.workingEventVersionRef.current;
    const address = options.addressRef.current;
    const key = options.addressKeyRef.current;
    const generation = options.loadGenerationRef.current;
    const editCounter = options.localEditCounterRef.current;
    const load = repository
      .loadWorking(address)
      .then((loaded) => {
        if (
          !options.mountedRef.current ||
          version !== options.workingEventVersionRef.current ||
          generation !== options.loadGenerationRef.current ||
          key !== options.addressKeyRef.current
        )
          return;
        if (
          loaded.working.content == null &&
          (editCounter !== options.localEditCounterRef.current ||
            options.pendingSaveRef.current?.addressKey === key ||
            options.heldAttemptSaveRef.current?.addressKey === key ||
            options.activePersistenceByAddressRef.current.has(key))
        ) {
          options.onClearedRevision(key, loaded.working.workingRevision);
          return;
        }
        if (
          !options.hydratedRef.current ||
          editCounter !== options.localEditCounterRef.current ||
          options.pendingSaveRef.current?.addressKey === key ||
          options.heldAttemptSaveRef.current?.addressKey === key ||
          options.attemptAddressKeyRef.current === key
        )
          return;
        options.apply(loaded.working, key, loaded);
      })
      .catch(() => undefined);
    options.syncPendingByAddressRef.current.set(key, load);
    void load.finally(() => {
      if (options.syncPendingByAddressRef.current.get(key) === load) {
        options.syncPendingByAddressRef.current.delete(key);
      }
    });
  });
}
