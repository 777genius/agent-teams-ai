interface RefreshCliStatusOptions {
  multimodelEnabled: boolean;
  bootstrapCliStatus: (options?: { multimodelEnabled?: boolean }) => Promise<void>;
  fetchCliStatus: () => Promise<void>;
}

export function refreshCliStatusForCurrentMode({
  multimodelEnabled,
  bootstrapCliStatus,
  fetchCliStatus,
}: RefreshCliStatusOptions): Promise<void> {
  if (multimodelEnabled) {
    return bootstrapCliStatus({ multimodelEnabled: true });
  }

  return fetchCliStatus();
}
