import {
  getOpenCodeRuntimeManifestPath,
  withOpenCodeRuntimeLaneLifecycleLock,
} from './OpenCodeRuntimeManifestEvidenceReader';
import { createRuntimeStoreManifestStore } from './RuntimeStoreManifest';

import type { OpenCodeLaunchAuthorityWriter } from '../bridge/OpenCodeStateChangingBridgeCommandService';

export class OpenCodeRuntimeLaunchAuthorityWriter implements OpenCodeLaunchAuthorityWriter {
  constructor(private readonly options: { teamsBasePath: string }) {}

  async publish(input: Parameters<OpenCodeLaunchAuthorityWriter['publish']>[0]): Promise<void> {
    await withOpenCodeRuntimeLaneLifecycleLock({ ...this.options, ...input }, async () => {
      const store = createRuntimeStoreManifestStore({
        filePath: getOpenCodeRuntimeManifestPath(
          this.options.teamsBasePath,
          input.teamName,
          input.laneId
        ),
        teamName: input.teamName,
      });
      await store.setActiveRun({
        runId: input.runId,
        expectedRunId: input.runId,
        capabilitySnapshotId: input.capabilitySnapshotId,
        behaviorFingerprint: input.behaviorFingerprint,
      });
    });
  }
}
