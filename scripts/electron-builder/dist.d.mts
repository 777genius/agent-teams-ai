export interface DistributionOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  guard?: () => Promise<void>;
  packageInvocation?: (invocation: { args: string[] }) => Promise<void>;
  stageGit?: (platform: string) => Promise<unknown>;
}
export function main(argv: string[], options?: DistributionOptions): Promise<void>;
