import { describe, expect, it } from "vitest";

import * as publicApi from "../index";
import * as controlledAgentState from "../controlled-agent-state";
import * as integrationAttempts from "../integration-attempts";
import * as runEventOrchestratorState from "../run-event-orchestrator-state";
import * as runEvents from "../run-events";
import * as runObservationHistory from "../run-observation-history";
import * as sessionCustody from "../session-custody";
import * as sessionLeases from "../session-leases";
import * as workerAccountCapacity from "../worker-account-capacity";
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
    expect(publicApi.LocalFileRunEventOrchestratorStateStore).toBe(
      runEventOrchestratorState.LocalFileRunEventOrchestratorStateStore,
    );
    expect(publicApi.LocalFileRunObservationHistoryStore).toBe(
      runObservationHistory.LocalFileRunObservationHistoryStore,
    );
    expect(publicApi.LocalFileWorkerAccountCapacityStore).toBe(
      workerAccountCapacity.LocalFileWorkerAccountCapacityStore,
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
    expect(publicApi.createLocalFileBackendRuntimeAdapters).toBe(
      sessionCustody.createLocalFileBackendRuntimeAdapters,
    );
    expect(publicApi.decodeLocalFileBackendEncryptionKey).toBe(
      sessionCustody.decodeLocalFileBackendEncryptionKey,
    );
  });
});
