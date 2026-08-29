interface OpenCodeLaunchCapabilityProtocol {
  opencodeAppManagedBootstrapContractVersion?: number;
  openCodeLaunchAttemptContract?: number;
  openCodeLaunchRequestCorrelationContract?: number;
}

export function validateOpenCodeLaunchCapabilities(input: {
  protocol: OpenCodeLaunchCapabilityProtocol;
  requireAppManagedBootstrap: boolean;
}): string | null {
  if (
    input.requireAppManagedBootstrap &&
    input.protocol.opencodeAppManagedBootstrapContractVersion !== 1
  ) {
    return 'OpenCode app-managed bootstrap is required, but the orchestrator does not advertise contract version 1. Update agent_teams_orchestrator and restart the app.';
  }
  if (input.protocol.openCodeLaunchAttemptContract !== 1) {
    return 'Strict OpenCode launch contract version 1 is required, but the orchestrator does not advertise openCodeLaunchAttemptContract 1. Update agent_teams_orchestrator and restart the app.';
  }
  if (input.protocol.openCodeLaunchRequestCorrelationContract !== 1) {
    return 'Strict OpenCode launch request correlation contract version 1 is required, but the orchestrator does not advertise openCodeLaunchRequestCorrelationContract 1. Update agent_teams_orchestrator and restart the app.';
  }
  return null;
}
