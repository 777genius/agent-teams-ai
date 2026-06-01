export const bullQueueAdapterCapabilities = {
  adapterId: "queue.bull",
  queueFamily: "bull-compatible",
  ownsRetries: true,
  ownsLeases: true,
  dependencyMode: "host-provided",
} as const;
