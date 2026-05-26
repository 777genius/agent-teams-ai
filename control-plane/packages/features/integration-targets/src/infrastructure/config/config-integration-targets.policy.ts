import type { ControlPlaneConfigService } from "@agent-teams-control-plane/platform-config";

import type {
  IntegrationTargetsFeature,
  IntegrationTargetsFeatureGatePolicy,
  IntegrationTargetsSettings,
} from "../../application/ports/policies.js";
import { integrationTargetsFeatureDisabledError } from "../../application/ports/policies.js";

export class ConfigIntegrationTargetsFeatureGatePolicy implements IntegrationTargetsFeatureGatePolicy {
  public constructor(private readonly configService: ControlPlaneConfigService) {}

  public assertEnabled(feature: IntegrationTargetsFeature): Promise<void> {
    if (!this.configService.getConfig().featureGates.integrationTargetsEnabled) {
      throw integrationTargetsFeatureDisabledError(feature);
    }
    return Promise.resolve();
  }
}

export class ConfigIntegrationTargetsSettings implements IntegrationTargetsSettings {
  public constructor(private readonly configService: ControlPlaneConfigService) {}

  public repositoryAvailabilityMaxAgeMs(): number {
    return (
      this.configService.getConfig().integrationTargets
        .repositoryAvailabilityMaxAgeHours *
      60 *
      60 *
      1000
    );
  }
}
