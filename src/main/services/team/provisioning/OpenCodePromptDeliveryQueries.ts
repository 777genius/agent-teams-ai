import {
  createOpenCodePromptDeliveryLedgerStore,
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
} from '../opencode/delivery/OpenCodePromptDeliveryLedger';
import { toOpenCodeRuntimeDeliveryStatus } from '../opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy';
import {
  getOpenCodeLaneScopedRuntimeFilePath,
  readOpenCodeRuntimeLaneIndex,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import type { OpenCodeRuntimeDeliveryStatus } from '@shared/types';

export interface OpenCodeRuntimeDeliveryStorePaths {
  teamsBasePath: string;
}

export type OpenCodePromptDeliveryLedgerPorts = OpenCodeRuntimeDeliveryStorePaths;

export interface OpenCodeRuntimeDeliveryStatusPorts extends OpenCodeRuntimeDeliveryStorePaths {
  createOpenCodePromptDeliveryLedger(
    teamName: string,
    laneId: string
  ): OpenCodePromptDeliveryLedgerStore;
  decideOpenCodeRuntimeDeliveryUserFacingAdvisory(
    record: OpenCodePromptDeliveryLedgerRecord
  ): Promise<{
    record: OpenCodePromptDeliveryLedgerRecord;
    decision: Parameters<typeof toOpenCodeRuntimeDeliveryStatus>[0]['decision'];
  }>;
}

export function createOpenCodePromptDeliveryLedger(
  teamName: string,
  laneId: string,
  ports: OpenCodePromptDeliveryLedgerPorts
): OpenCodePromptDeliveryLedgerStore {
  return createOpenCodePromptDeliveryLedgerStore({
    authorityRoot: ports.teamsBasePath,
    filePath: getOpenCodeLaneScopedRuntimeFilePath({
      teamsBasePath: ports.teamsBasePath,
      teamName,
      laneId,
      fileName: 'opencode-prompt-delivery-ledger.json',
    }),
  });
}

export async function getOpenCodeRuntimeDeliveryStatus(
  teamName: string,
  messageId: string,
  ports: OpenCodeRuntimeDeliveryStatusPorts
): Promise<OpenCodeRuntimeDeliveryStatus | null> {
  const normalizedMessageId = messageId.trim();
  if (!normalizedMessageId) return null;
  const laneIndex = await readOpenCodeRuntimeLaneIndex(ports.teamsBasePath, teamName).catch(
    () => null
  );
  const laneIds = [
    ...new Set(
      Object.values(laneIndex?.lanes ?? {})
        .map((entry) => entry.laneId.trim())
        .filter(Boolean)
    ),
  ];
  let recordForStatus: OpenCodePromptDeliveryLedgerRecord | null = null;
  for (const laneId of laneIds) {
    const records = await ports
      .createOpenCodePromptDeliveryLedger(teamName, laneId)
      .list()
      .catch(() => []);
    for (const record of records) {
      if (
        record.inboxMessageId === normalizedMessageId &&
        (!recordForStatus || isRecordNewer(record, recordForStatus))
      ) {
        recordForStatus = record;
      }
    }
  }
  if (!recordForStatus) return null;
  const { record, decision } =
    await ports.decideOpenCodeRuntimeDeliveryUserFacingAdvisory(recordForStatus);
  return toOpenCodeRuntimeDeliveryStatus({ record, decision });
}

function isRecordNewer(
  candidate: OpenCodePromptDeliveryLedgerRecord,
  current: OpenCodePromptDeliveryLedgerRecord
): boolean {
  const candidateTimestamp = getEffectiveTimestamp(candidate);
  const currentTimestamp = getEffectiveTimestamp(current);
  if (candidateTimestamp === null) return false;
  if (currentTimestamp === null) return true;
  return candidateTimestamp > currentTimestamp;
}

function getEffectiveTimestamp(record: OpenCodePromptDeliveryLedgerRecord): number | null {
  const updatedAt = Date.parse(record.updatedAt);
  if (Number.isFinite(updatedAt)) return updatedAt;
  const createdAt = Date.parse(record.createdAt);
  return Number.isFinite(createdAt) ? createdAt : null;
}
