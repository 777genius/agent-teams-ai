import { evaluateHostedStateAdmission } from '../domain';

import type { HostedStateAdmission } from '../../contracts';
import type {
  BuiltArtifactStateManifestIntegrityProbePort,
  BuiltArtifactStateManifestReaderPort,
  HostedStateHeaderReaderPort,
  HostedStateMigrationJournalReaderPort,
} from './ports';

export interface EvaluateHostedStateStartupDependencies {
  readonly artifactManifestReader: BuiltArtifactStateManifestReaderPort;
  readonly artifactIntegrityProbe: BuiltArtifactStateManifestIntegrityProbePort;
  readonly stateHeaderReader: HostedStateHeaderReaderPort;
  readonly migrationJournalReader: HostedStateMigrationJournalReaderPort;
}

export class EvaluateHostedStateStartup {
  constructor(private readonly dependencies: EvaluateHostedStateStartupDependencies) {}

  async execute(): Promise<HostedStateAdmission> {
    const [artifact, stateHeader, migrationJournal] = await Promise.all([
      this.dependencies.artifactManifestReader.readBuiltArtifactManifest(),
      this.dependencies.stateHeaderReader.readStateHeader(),
      this.dependencies.migrationJournalReader.readMigrationJournal(),
    ]);
    const artifactIntegrity = await this.dependencies.artifactIntegrityProbe.verify(artifact);
    return evaluateHostedStateAdmission({
      artifactManifest: artifact.manifest,
      artifactIntegrity: artifactIntegrity.status === 'verified' ? 'verified' : 'failed',
      stateHeader,
      migrationJournal,
    });
  }
}
