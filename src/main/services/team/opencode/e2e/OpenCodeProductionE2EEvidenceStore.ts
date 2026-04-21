import * as path from 'path';

import {
  OPENCODE_PRODUCTION_E2E_EVIDENCE_SCHEMA_VERSION,
  validateNullableOpenCodeProductionE2EEvidence,
  validateOpenCodeProductionE2EEvidence,
  type OpenCodeProductionE2EEvidence,
} from './OpenCodeProductionE2EEvidence';
import { VersionedJsonStore } from '../store/VersionedJsonStore';

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

export class OpenCodeProductionE2EEvidenceStore {
  private readonly filePath: string;
  private readonly store: VersionedJsonStore<OpenCodeProductionE2EEvidence | null>;

  constructor(options: OpenCodeProductionE2EEvidenceStoreOptions) {
    this.filePath = options.filePath;
    this.store = new VersionedJsonStore<OpenCodeProductionE2EEvidence | null>({
      filePath: options.filePath,
      schemaVersion: OPENCODE_PRODUCTION_E2E_EVIDENCE_SCHEMA_VERSION,
      defaultData: () => null,
      validate: validateNullableOpenCodeProductionE2EEvidence,
      clock: options.clock,
      quarantineDir: path.dirname(options.filePath),
    });
  }

  async read(): Promise<OpenCodeProductionE2EEvidenceStoreReadResult> {
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

    return {
      ok: true,
      evidence: result.data,
      artifactPath: this.filePath,
      diagnostics:
        result.status === 'missing'
          ? ['OpenCode production E2E evidence artifact has not been written yet']
          : [],
    };
  }

  async write(evidence: OpenCodeProductionE2EEvidence): Promise<void> {
    const validated = validateOpenCodeProductionE2EEvidence(evidence);
    await this.store.updateLocked(() => ({
      ...validated,
      artifactPath: validated.artifactPath ?? this.filePath,
    }));
  }
}
