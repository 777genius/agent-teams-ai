import * as path from 'path';

import { VersionedJsonStore } from '../store/VersionedJsonStore';

import {
  isOpenCodeProductionE2EEvidenceCollection,
  OPENCODE_PRODUCTION_E2E_EVIDENCE_SCHEMA_VERSION,
  type OpenCodeProductionE2EEvidence,
  type OpenCodeProductionE2EEvidenceCollection,
  type OpenCodeProductionE2EEvidenceStoreData,
  validateOpenCodeProductionE2EEvidence,
  validateOpenCodeProductionE2EEvidenceStoreData,
} from './OpenCodeProductionE2EEvidence';

export interface OpenCodeProductionE2EEvidenceStoreReadResult {
  ok: boolean;
  evidence: OpenCodeProductionE2EEvidence | null;
  artifactPath: string;
  diagnostics: string[];
}

export interface OpenCodeProductionE2EEvidenceStoreOptions {
  filePath: string;
  clock?: () => Date;
}

export interface OpenCodeProductionE2EEvidenceStoreReadOptions {
  /**
   * Preferred exact raw model id when a matching project-scoped proof exists.
   * Production proof is primarily scoped to the runtime/project integration, not
   * to a mandatory per-model whitelist.
   */
  selectedModel?: string | null;
  projectPathFingerprint?: string | null;
  opencodeVersion?: string | null;
  binaryFingerprint?: string | null;
  capabilitySnapshotId?: string | null;
}

export class OpenCodeProductionE2EEvidenceStore {
  private readonly filePath: string;
  private readonly store: VersionedJsonStore<OpenCodeProductionE2EEvidenceStoreData>;

  constructor(options: OpenCodeProductionE2EEvidenceStoreOptions) {
    this.filePath = options.filePath;
    this.store = new VersionedJsonStore<OpenCodeProductionE2EEvidenceStoreData>({
      filePath: options.filePath,
      schemaVersion: OPENCODE_PRODUCTION_E2E_EVIDENCE_SCHEMA_VERSION,
      defaultData: () => null,
      validate: validateOpenCodeProductionE2EEvidenceStoreData,
      clock: options.clock,
      quarantineDir: path.dirname(options.filePath),
    });
  }

  async read(
    options: OpenCodeProductionE2EEvidenceStoreReadOptions = {}
  ): Promise<OpenCodeProductionE2EEvidenceStoreReadResult> {
    const result = await this.store.read();
    if (!result.ok) {
      return {
        ok: false,
        evidence: null,
        artifactPath: this.filePath,
        diagnostics: [
          `OpenCode production E2E evidence store is unreadable: ${result.message}`,
          ...(result.quarantinePath
            ? [`Quarantined corrupt evidence at ${result.quarantinePath}`]
            : []),
        ],
      };
    }

    const selection = selectEvidence(result.data, options);
    return {
      ok: true,
      evidence: selection.evidence,
      artifactPath: this.filePath,
      diagnostics: [
        ...selection.diagnostics,
        ...(result.status === 'missing'
          ? ['OpenCode production E2E evidence artifact has not been written yet']
          : []),
      ],
    };
  }

  async write(evidence: OpenCodeProductionE2EEvidence): Promise<void> {
    const validated = validateOpenCodeProductionE2EEvidence(evidence);
    await this.store.updateLocked((current) => {
      const nextEvidence = {
        ...validated,
        artifactPath: validated.artifactPath ?? this.filePath,
      };
      return upsertEvidence(current, nextEvidence);
    });
  }
}

function selectEvidence(
  data: OpenCodeProductionE2EEvidenceStoreData,
  options: OpenCodeProductionE2EEvidenceStoreReadOptions
): {
  evidence: OpenCodeProductionE2EEvidence | null;
  diagnostics: string[];
} {
  if (!data) {
    return { evidence: null, diagnostics: [] };
  }

  if (!isOpenCodeProductionE2EEvidenceCollection(data)) {
    return { evidence: data, diagnostics: [] };
  }

  const modelId = options.selectedModel?.trim() ?? '';
  const projectPathFingerprint = options.projectPathFingerprint?.trim() ?? '';
  const entries = Object.values(data.entriesByModel);
  const pickBestForRuntime = (
    candidates: OpenCodeProductionE2EEvidence[]
  ): OpenCodeProductionE2EEvidence | null => {
    const runtimeMatched = candidates.filter((entry) => runtimeIdentityMatches(entry, options));
    return pickNewestEvidence(runtimeMatched.length > 0 ? runtimeMatched : candidates);
  };

  if (projectPathFingerprint) {
    const pathEntries = entries.filter(
      (entry) => entry.projectPathFingerprint === projectPathFingerprint
    );
    if (pathEntries.length === 0) {
      return {
        evidence: null,
        diagnostics: [
          'OpenCode production E2E evidence artifact has no entry for the current working directory',
        ],
      };
    }

    if (modelId) {
      const exactModelMatch = pickBestForRuntime(
        pathEntries.filter((entry) => entry.selectedModel === modelId)
      );
      if (exactModelMatch) {
        return {
          evidence: exactModelMatch,
          diagnostics: [],
        };
      }
    }

    return {
      evidence: pickBestForRuntime(pathEntries),
      diagnostics: [],
    };
  }

  if (modelId) {
    const exactModelEntries = entries.filter((entry) => entry.selectedModel === modelId);
    if (exactModelEntries.length === 0) {
      return {
        evidence: null,
        diagnostics: [
          `OpenCode production E2E evidence artifact has no entry for selected model ${modelId}`,
        ],
      };
    }

    return {
      evidence: pickNewestEvidence(exactModelEntries),
      diagnostics: [],
    };
  }

  if (entries.length === 1) {
    return { evidence: entries[0] ?? null, diagnostics: [] };
  }

  return {
    evidence: null,
    diagnostics:
      entries.length === 0
        ? ['OpenCode production E2E evidence artifact has no model entries']
        : [
            `OpenCode production E2E evidence artifact contains ${entries.length} model entries; selected model is required`,
          ],
  };
}

function upsertEvidence(
  current: OpenCodeProductionE2EEvidenceStoreData,
  evidence: OpenCodeProductionE2EEvidence
): OpenCodeProductionE2EEvidenceCollection {
  const entriesByModel: Record<string, OpenCodeProductionE2EEvidence> = {};
  if (isOpenCodeProductionE2EEvidenceCollection(current)) {
    Object.assign(entriesByModel, current.entriesByModel);
  } else if (current) {
    entriesByModel[current.selectedModel] = current;
  }

  entriesByModel[buildEvidenceKey(evidence)] = evidence;
  return {
    collectionSchemaVersion: 1,
    entriesByModel,
  };
}

function buildEvidenceKey(evidence: OpenCodeProductionE2EEvidence): string {
  return [evidence.selectedModel, evidence.projectPathFingerprint ?? 'global'].join('::');
}

function runtimeIdentityMatches(
  evidence: OpenCodeProductionE2EEvidence,
  options: OpenCodeProductionE2EEvidenceStoreReadOptions
): boolean {
  const expectedVersion = options.opencodeVersion?.trim() ?? '';
  if (expectedVersion && evidence.version !== expectedVersion) {
    return false;
  }

  const expectedBinaryFingerprint = options.binaryFingerprint?.trim() ?? '';
  if (expectedBinaryFingerprint && evidence.binaryFingerprint !== expectedBinaryFingerprint) {
    return false;
  }

  const expectedCapabilitySnapshotId = options.capabilitySnapshotId?.trim() ?? '';
  if (
    expectedCapabilitySnapshotId &&
    evidence.capabilitySnapshotId !== expectedCapabilitySnapshotId
  ) {
    return false;
  }

  return true;
}

function pickNewestEvidence(
  entries: OpenCodeProductionE2EEvidence[]
): OpenCodeProductionE2EEvidence | null {
  if (entries.length === 0) {
    return null;
  }

  return entries.slice(1).reduce<OpenCodeProductionE2EEvidence>((latest, entry) => {
    const latestAt = Date.parse(latest.createdAt);
    const entryAt = Date.parse(entry.createdAt);
    if (!Number.isFinite(entryAt)) {
      return latest;
    }
    if (!Number.isFinite(latestAt) || entryAt >= latestAt) {
      return entry;
    }
    return latest;
  }, entries[0]!);
}
