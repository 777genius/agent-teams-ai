import { describe, expect, it } from "vitest";

import * as publicApi from "../index";
import * as controlledAgentState from "../controlled-agent-state";
import * as integrationAttempts from "../integration-attempts";
import * as runEvents from "../run-events";
import * as runObservationHistory from "../run-observation-history";
import * as safeExecution from "../safe-execution";
import * as sessionCustody from "../session-custody";
import * as sessionLeases from "../session-leases";
import * as workerAccountCapacity from "../worker-account-capacity";
import * as workerAccountLeases from "../worker-account-leases";
import * as workerControlInbox from "../worker-control-inbox";

describe("store-local-file boundary modules", () => {
  it("keeps public exports stable while delegating to feature-owned modules", () => {
    expect(publicApi.LocalEncryptedFileStore).toBe(
      sessionCustody.LocalEncryptedFileStore,
    );
    expect(publicApi.localEncryptedFileStoreCapabilities).toBe(
      sessionCustody.localEncryptedFileStoreCapabilities,
    );
    expect(publicApi.LocalFileLeaseStore).toBe(
      sessionLeases.LocalFileLeaseStore,
    );
    expect(publicApi.localFileLeaseStoreCapabilities).toBe(
      sessionLeases.localFileLeaseStoreCapabilities,
    );
    expect(publicApi.LocalFileRunEventStore).toBe(
      runEvents.LocalFileRunEventStore,
    );
    expect(publicApi.LocalFileRunEventProjectionStateStore).toBe(
      runEvents.LocalFileRunEventProjectionStateStore,
    );
    expect(publicApi.LocalFileRunEventDeliveryCursorStore).toBe(
      runEvents.LocalFileRunEventDeliveryCursorStore,
    );
    expect(publicApi.LocalFileRunObservationHistoryStore).toBe(
      runObservationHistory.LocalFileRunObservationHistoryStore,
    );
    expect(publicApi.LocalFileWorkerAccountCapacityStore).toBe(
      workerAccountCapacity.LocalFileWorkerAccountCapacityStore,
    );
    expect(publicApi.LocalFileWorkerAccountLeaseStore).toBe(
      workerAccountLeases.LocalFileWorkerAccountLeaseStore,
    );
    expect(publicApi.LocalFileWorkerControlInboxStore).toBe(
      workerControlInbox.LocalFileWorkerControlInboxStore,
    );
    expect(publicApi.LocalControlledAgentStateStore).toBe(
      controlledAgentState.LocalControlledAgentStateStore,
    );
    expect(publicApi.LocalIntegrationAttemptStore).toBe(
      integrationAttempts.LocalIntegrationAttemptStore,
    );
    expect(publicApi.LocalFileWorkspaceLockStore).toBe(
      safeExecution.LocalFileWorkspaceLockStore,
    );
    expect(publicApi.LocalFileAttemptJournal).toBe(
      safeExecution.LocalFileAttemptJournal,
    );
    expect(publicApi.createLocalFileSafeExecutionStores).toBe(
      safeExecution.createLocalFileSafeExecutionStores,
    );
    expect(publicApi.createLocalFileBackendRuntimeAdapters).toBe(
      sessionCustody.createLocalFileBackendRuntimeAdapters,
    );
    expect(publicApi.decodeLocalFileBackendEncryptionKey).toBe(
      sessionCustody.decodeLocalFileBackendEncryptionKey,
    );
  });
});
