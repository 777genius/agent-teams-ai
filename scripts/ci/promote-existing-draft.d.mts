export interface PromotionLayout {
  stableAliases: Record<string, string>;
  legacyStableAliases: Record<string, string>;
  legacyUpdaterAliases: Record<string, string>;
  feedSources: {
    windows: string;
    linux: string;
    macArm64Zip: string;
    macArm64Dmg: string;
    macX64Zip: string;
    macX64Dmg: string;
  };
  sourceAssets: string[];
}

export interface PromotionConfig {
  repository: string;
  tag: string;
  version: string;
  dryRun: boolean;
  publishRelease: boolean;
  allowPublishedRecovery: boolean;
  outputDirectory: string | null;
}

export interface UpdaterFeedInput {
  directory: string;
  version: string;
  releaseDate: string;
  feedSources: PromotionLayout['feedSources'];
}

export function getPromotionLayout(version: string): PromotionLayout;
export function parsePromotionConfig(
  environment?: Record<string, string | undefined>
): PromotionConfig;
export function buildUpdaterFeeds(input: UpdaterFeedInput): Promise<Record<string, string>>;
export function promoteExistingDraft(options?: {
  environment?: Record<string, string | undefined>;
  now?: () => Date;
}): Promise<{
  repository: string;
  tag: string;
  targetCommit: string;
  sourceAssets: number;
  aliases: number;
  feeds: string[];
  dryRun: boolean;
  published: boolean;
  outputDirectory?: string;
}>;
