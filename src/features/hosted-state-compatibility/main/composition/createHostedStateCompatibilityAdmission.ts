import { EvaluateHostedStateStartup } from '../../core/application';
import { inspectBuiltArtifactStateManifest } from '../../core/domain';
import {
  NodeBuiltArtifactStateManifestAdapter,
  NodeHostedStateMetadataAdapter,
} from '../infrastructure/NodeHostedStateCompatibilityAdapters';

import type { HostedStateAdmission } from '../../contracts';
import type {
  HostedOfflineRestoreRotationProof,
  HostedOfflineRestoreRotationRequest,
  HostedStateCompatibilityRuntime,
} from '../application';

export interface HostedStateCompatibilityAdmissionOptions {
  readonly artifactDirectory: string;
  readonly stateDirectory: string;
  readonly expectedDeploymentId: string;
  readonly runtime: HostedStateCompatibilityRuntime;
}

export class HostedStateStartupRefusedError extends Error {
  constructor(
    readonly admission: HostedStateAdmission | null,
    readonly diagnostic: string
  ) {
    super(`hosted-state-startup-refused:${diagnostic}`);
    this.name = 'HostedStateStartupRefusedError';
  }
}

export interface HostedStateCompatibilityAdmissionComposition {
  /** Must resolve before any network listener or mutable storage backend is constructed. */
  admitBeforeListenerExposure(): Promise<Extract<HostedStateAdmission, { status: 'read_write' }>>;
  /** Narrow operations-lane seam; this feature does not own shutdown or runtime rotation. */
  inspectPendingOfflineRestoreRotation(): Promise<HostedOfflineRestoreRotationRequest | null>;
  completeOfflineRestoreRotation(proof: HostedOfflineRestoreRotationProof): Promise<void>;
}

export function createHostedStateCompatibilityAdmission(
  options: HostedStateCompatibilityAdmissionOptions
): HostedStateCompatibilityAdmissionComposition {
  const artifact = new NodeBuiltArtifactStateManifestAdapter(
    options.artifactDirectory,
    options.runtime
  );
  const state = new NodeHostedStateMetadataAdapter(options.stateDirectory, options.runtime);
  return Object.freeze({
    async admitBeforeListenerExposure() {
      try {
        const envelope = await artifact.readBuiltArtifactManifest();
        const manifestInspection = inspectBuiltArtifactStateManifest(envelope.manifest);
        if (manifestInspection.status === 'invalid') {
          throw new HostedStateStartupRefusedError(null, 'artifact_manifest_invalid');
        }
        if ((await artifact.verify(envelope)).status !== 'verified') {
          throw new HostedStateStartupRefusedError(null, 'artifact_manifest_integrity_failed');
        }
        await state.initializeEmptyState(
          options.expectedDeploymentId,
          manifestInspection.manifest.hostedStateSchemaVersion
        );
        if (await state.readPendingRestoreRotation()) {
          throw new HostedStateStartupRefusedError(null, 'offline_restore_rotation_pending');
        }
        const admission = await new EvaluateHostedStateStartup({
          artifactManifestReader: artifact,
          artifactIntegrityProbe: artifact,
          stateHeaderReader: state,
          migrationJournalReader: state,
        }).execute();
        if (admission.status !== 'read_write') {
          throw new HostedStateStartupRefusedError(admission, admission.status);
        }
        const header = await state.readStateHeader();
        if (header.deploymentId !== options.expectedDeploymentId) {
          throw new HostedStateStartupRefusedError(null, 'state_deployment_mismatch');
        }
        return admission;
      } catch (error) {
        if (error instanceof HostedStateStartupRefusedError) throw error;
        throw new HostedStateStartupRefusedError(null, 'state_metadata_invalid');
      }
    },
    inspectPendingOfflineRestoreRotation: () => state.readPendingRestoreRotation(),
    completeOfflineRestoreRotation: (proof: HostedOfflineRestoreRotationProof) =>
      state.completePendingRestoreRotation(proof),
  });
}
