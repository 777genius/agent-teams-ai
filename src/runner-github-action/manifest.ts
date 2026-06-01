import type { RuntimeAdapterManifest } from "@777genius/subscription-runtime/core";
import { githubActionRunnerCapabilities } from "./capabilities";

export const githubActionRunnerManifest = {
  adapterId: "runner.github-action",
  adapterKind: "runner",
  packageName: "@777genius/subscription-runtime/runner-github-action",
  packageVersion: "0.0.0",
  protocolVersion: 1,
  capabilities: githubActionRunnerCapabilities,
  experimental: false,
  minimumCoreVersion: "0.0.0",
} satisfies RuntimeAdapterManifest<typeof githubActionRunnerCapabilities>;
