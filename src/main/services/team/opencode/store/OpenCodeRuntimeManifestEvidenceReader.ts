import * as path from 'path';

import type { RuntimeStoreManifestEvidence } from '../bridge/OpenCodeBridgeCommandContract';
import type { RuntimeStoreManifestReader } from '../bridge/OpenCodeStateChangingBridgeCommandService';
import { createRuntimeStoreManifestStore } from './RuntimeStoreManifest';

export interface OpenCodeRuntimeManifestEvidenceReaderOptions {
  teamsBasePath: string;
  clock?: () => Date;
}

const OPENCODE_TEAM_RUNTIME_DIR = '.opencode-runtime';
const OPENCODE_RUNTIME_MANIFEST_FILE = 'manifest.json';

export class OpenCodeRuntimeManifestEvidenceReader implements RuntimeStoreManifestReader {
  private readonly teamsBasePath: string;
  private readonly clock: () => Date;

  constructor(options: OpenCodeRuntimeManifestEvidenceReaderOptions) {
    this.teamsBasePath = options.teamsBasePath;
    this.clock = options.clock ?? (() => new Date());
  }

  async read(teamName: string): Promise<RuntimeStoreManifestEvidence> {
    const manifest = await createRuntimeStoreManifestStore({
      filePath: getOpenCodeRuntimeManifestPath(this.teamsBasePath, teamName),
      teamName,
      clock: this.clock,
    }).read();

    return {
      highWatermark: manifest.highWatermark,
      activeRunId: manifest.activeRunId,
      capabilitySnapshotId: manifest.activeCapabilitySnapshotId,
    };
  }
}

export function getOpenCodeTeamRuntimeDirectory(teamsBasePath: string, teamName: string): string {
  return path.join(teamsBasePath, teamName, OPENCODE_TEAM_RUNTIME_DIR);
}

export function getOpenCodeRuntimeManifestPath(teamsBasePath: string, teamName: string): string {
  return path.join(
    getOpenCodeTeamRuntimeDirectory(teamsBasePath, teamName),
    OPENCODE_RUNTIME_MANIFEST_FILE
  );
}
