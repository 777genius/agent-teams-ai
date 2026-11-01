export type OpenCodeInstallGeneration = 'v1' | 'v2';
export interface OpenCodeRuntimeInstallOptions {
  generation?: OpenCodeInstallGeneration;
  /** Explicit support repair must preserve the selected native CLI. */
  supportOnly?: boolean;
}
