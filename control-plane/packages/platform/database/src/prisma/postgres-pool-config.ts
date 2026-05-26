import type { ControlPlaneConfig } from "@agent-teams-control-plane/platform-config";

export type PostgresPoolConfig = Readonly<{
  connectionString: string;
  max: number;
}>;

export function buildPostgresPoolConfig(
  database: ControlPlaneConfig["database"],
): PostgresPoolConfig {
  if (database.url === undefined) {
    throw new Error("Database client requested without CONTROL_PLANE_DATABASE_URL.");
  }

  return {
    connectionString: withSslMode(database.url, database.sslMode),
    max: database.poolMax,
  };
}

function withSslMode(
  databaseUrl: string,
  sslMode: ControlPlaneConfig["database"]["sslMode"],
): string {
  const url = new URL(databaseUrl);

  const explicitSslMode = url.searchParams.get("sslmode");
  const effectiveSslMode = explicitSslMode ?? sslMode;

  if (explicitSslMode === null) {
    url.searchParams.set("sslmode", sslMode);
  }
  if (effectiveSslMode !== "disable" && !url.searchParams.has("uselibpqcompat")) {
    url.searchParams.set("uselibpqcompat", "true");
  }

  return url.toString();
}
