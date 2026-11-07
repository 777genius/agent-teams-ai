type DirectoryState = Readonly<{
  loading: boolean;
  authoritativePending: boolean;
  loaded: boolean;
  error: string | null;
}>;

export type OpenCodeSourceFailureKind = 'status' | 'catalog' | 'directory' | null;

/** A source directory is display evidence, not authority to launch models. */
export function getOpenCodeSidebarSourceState({
  directory,
  catalogLoading,
  catalogUnavailable,
  catalogRefreshFailed,
  scopedLoading,
  bootstrapLoading,
  passiveStatusFailed,
  passiveCatalogFailed,
}: Readonly<{
  directory: DirectoryState | null;
  catalogLoading: boolean;
  catalogUnavailable: boolean;
  catalogRefreshFailed: boolean;
  scopedLoading: boolean;
  bootstrapLoading: boolean;
  passiveStatusFailed: boolean;
  passiveCatalogFailed: boolean;
}>): {
  loading: boolean;
  unavailable: boolean;
  failureKind: OpenCodeSourceFailureKind;
} {
  const loading = directory
    ? directory.loading || directory.authoritativePending
    : catalogLoading || scopedLoading || bootstrapLoading;
  const failureKind: OpenCodeSourceFailureKind = directory?.error
    ? 'directory'
    : directory?.loaded
      ? null
      : passiveStatusFailed
        ? 'status'
        : catalogRefreshFailed || passiveCatalogFailed
          ? 'catalog'
          : null;
  return {
    loading,
    unavailable: directory
      ? Boolean(directory.error)
      : catalogUnavailable || (!loading && failureKind !== null),
    failureKind,
  };
}
