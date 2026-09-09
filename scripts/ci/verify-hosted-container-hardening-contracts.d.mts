import type { HostedContainerHardeningMount } from './verify-hosted-container-hardening.mjs';

export const DEFAULT_RENDER_ENVIRONMENT: Readonly<Record<string, string> & { CLAUDE_DIR: string }>;

export function mountMatches(
  mount: HostedContainerHardeningMount,
  contract: {
    type: string;
    target: string;
    readOnly?: boolean;
    source?: string;
    sourceParentTarget?: string;
    sourceSuffix?: string;
    absoluteSource?: boolean;
    createHostPath?: boolean;
    copyUpRequired?: boolean;
  },
  mounts?: HostedContainerHardeningMount[]
): boolean;
