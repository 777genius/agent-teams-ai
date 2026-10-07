let readEnvironment: (() => Record<string, string>) | null = null;

/** App composition binds this after the exact control listener is available. */
export function configureDesktopMcpEnvironment(factory: () => Record<string, string>): () => void {
  readEnvironment = factory;
  return () => {
    if (readEnvironment === factory) readEnvironment = null;
  };
}

/** Called once for an actual owned child spawn, never for snapshots or health checks. */
export function getDesktopMcpChildEnvironment(
  launchEnvironment?: Record<string, string>
): Record<string, string> {
  return { ...launchEnvironment, ...readEnvironment?.() };
}

/** A policy read must never materialize a spawn environment or advance generation. */
export function isDesktopMcpEnvironmentBound(): boolean {
  return readEnvironment !== null;
}
