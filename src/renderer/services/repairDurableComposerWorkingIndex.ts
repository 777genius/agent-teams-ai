import {
  composerDraftAddressKey,
  composerWorkingIndexKey,
  sameComposerDraftAddress,
} from '@renderer/utils/composerDraftIdentity';

import { composerDraftReadwrite, requestValue } from './composerDraftIndexedDb';
import { isComposerWorkingRecord as isWorkingRecord } from './composerDraftRecovery';
import {
  composerWorkingSummary as workingSummaryFor,
  nextWorkingSummaries,
  readComposerWorkingIndex,
  sameComposerWorkingSummary,
  workingIndexRecord,
} from './composerDraftWorkingSummary';

import type { ComposerDraftAddress } from '@renderer/types/composerDraft';

export async function repairDurableComposerWorkingIndex(
  address: ComposerDraftAddress
): Promise<boolean | null> {
  return composerDraftReadwrite(async (store) => {
    const workingKey = composerDraftAddressKey(address);
    const indexKey = composerWorkingIndexKey(address.contextId, address.teamName);
    const [latestRaw, indexRaw] = await Promise.all([
      requestValue(store.get(workingKey)),
      requestValue(store.get(indexKey)),
    ]);
    const latest =
      isWorkingRecord(latestRaw) && sameComposerDraftAddress(latestRaw.address, address)
        ? latestRaw
        : null;
    const current = readComposerWorkingIndex(indexRaw);
    if (current.unsupported) return null;
    const key = composerDraftAddressKey(address);
    const expected = latest ? workingSummaryFor(latest) : null;
    const existing = current.summaries.find(
      (summary) => composerDraftAddressKey(summary.address) === key
    );
    if (sameComposerWorkingSummary(existing, expected)) return false;
    const summaries = nextWorkingSummaries(indexRaw, address, latest);
    if (!summaries) return false;
    store.put(workingIndexRecord(summaries), indexKey);
    return true;
  });
}
