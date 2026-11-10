export interface DistributionOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  guard?: () => Promise<void>;
  packageInvocation?: (invocation: { args: string[] }) => Promise<void>;
}
export function main(argv: string[], options?: DistributionOptions): Promise<void>;
