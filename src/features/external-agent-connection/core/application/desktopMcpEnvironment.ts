let readEnvironment: (() => Record<string, string>) | null = null;
let readAvailability: (() => boolean) | null = null;

/** App composition binds this after the exact control listener is available. */
export function configureDesktopMcpEnvironment(factory: () => Record<string, string>, available: () => boolean = () => true): () => void {
  readEnvironment = factory;
  readAvailability = available;
  return () => {
    if (readEnvironment === factory) {
      readEnvironment = null;
      readAvailability = null;
    }
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

/** Pure lifecycle read: never resolves a child environment or changes generation. */
export function isDesktopMcpControlAvailable(): boolean {
  return readEnvironment !== null && readAvailability?.() === true;
}
