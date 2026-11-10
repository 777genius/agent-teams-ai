export interface GatewayUsageSourceInfo {
  gatewayUsageRef: string;
  canonicalEndpoint: string;
  allowPrivateNetwork: boolean;
  teamName: string;
  memberName: string;
  agentId?: string;
  firstUsageDay: string;
  hasActiveBinding: boolean;
  lastBoundAt: string;
  lastUnboundAt?: string;
  hasRuntimeArtifact: boolean;
  runtimeArtifactRetiredAt?: string;
}

export interface GatewayModelUsage {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  apiEquivalentUsd: number;
  billableUsd: number;
}

export interface GatewayUsageSourcePort {
  listGatewayUsageSources(): Promise<GatewayUsageSourceInfo[]>;
  readGatewayUsageDay(gatewayUsageRef: string, day: string): Promise<GatewayModelUsage[]>;
}
